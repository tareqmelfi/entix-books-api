/**
 * Payment Links · Stripe + PayPal + Moyasar (KSA)
 *
 * POST /api/payment-links/invoice/:id   create a one-time payment link for the invoice
 * GET  /api/payment-links/invoice/:id   retrieve existing link
 * POST /api/payment-links/webhook/:provider   provider webhook handler (mark invoice paid)
 *
 * Per-org config is stored on Organization.paymentSettings JSON.
 * Multi-currency: invoice can be in any currency · we forward as-is to provider.
 */
import { Hono } from 'hono'
import { prisma } from '../db.js'

export const paymentLinksRoutes = new Hono()

interface PaymentSettings {
  stripe?: { enabled?: boolean; publishableKey?: string; secretKey?: string }
  paypal?: { enabled?: boolean; clientId?: string; clientSecret?: string; mode?: 'live' | 'sandbox' }
  moyasar?: { enabled?: boolean; publishableKey?: string; secretKey?: string }
}

async function createStripeLink(secretKey: string, opts: {
  amount: number; currency: string; description: string; invoiceNumber: string; orgId: string; invoiceId: string;
}) {
  const params = new URLSearchParams()
  params.append('line_items[0][price_data][currency]', opts.currency.toLowerCase())
  params.append('line_items[0][price_data][product_data][name]', opts.description)
  params.append('line_items[0][price_data][unit_amount]', String(Math.round(opts.amount * 100)))
  params.append('line_items[0][quantity]', '1')
  params.append('metadata[invoice_id]', opts.invoiceId)
  params.append('metadata[org_id]', opts.orgId)
  params.append('metadata[invoice_number]', opts.invoiceNumber)

  const res = await fetch('https://api.stripe.com/v1/payment_links', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`stripe_error: ${res.status} · ${err.slice(0, 200)}`)
  }
  const data = await res.json() as any
  return { url: data.url as string, id: data.id as string, provider: 'stripe' as const }
}

async function createPayPalLink(opts: {
  clientId: string; clientSecret: string; mode: 'live' | 'sandbox';
  amount: number; currency: string; description: string; invoiceNumber: string;
}) {
  const base = opts.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'
  // Get OAuth token
  const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!tokenRes.ok) throw new Error(`paypal_token: ${tokenRes.status}`)
  const tokenData = await tokenRes.json() as any
  const accessToken = tokenData.access_token

  // Create order
  const orderRes = await fetch(`${base}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: opts.invoiceNumber,
        description: opts.description.slice(0, 127),
        amount: { currency_code: opts.currency, value: opts.amount.toFixed(2) },
      }],
    }),
  })
  if (!orderRes.ok) {
    const err = await orderRes.text()
    throw new Error(`paypal_order: ${orderRes.status} · ${err.slice(0, 200)}`)
  }
  const orderData = await orderRes.json() as any
  const approveLink = orderData.links?.find((l: any) => l.rel === 'approve')?.href
  if (!approveLink) throw new Error('paypal_no_approve_link')
  return { url: approveLink, id: orderData.id as string, provider: 'paypal' as const }
}

async function createMoyasarLink(secretKey: string, opts: {
  amount: number; currency: string; description: string; invoiceNumber: string;
}) {
  // Moyasar Invoices API: amount in halalas (lowest unit)
  const res = await fetch('https://api.moyasar.com/v1/invoices', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: Math.round(opts.amount * 100),
      currency: opts.currency,
      description: opts.description,
      callback_url: `https://api.entix.io/api/payment-links/webhook/moyasar`,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`moyasar_error: ${res.status} · ${err.slice(0, 200)}`)
  }
  const data = await res.json() as any
  return { url: data.url as string, id: data.id as string, provider: 'moyasar' as const }
}

paymentLinksRoutes.post('/invoice/:id', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const provider = (body.provider || 'auto') as 'stripe' | 'paypal' | 'moyasar' | 'auto'

  const invoice = await prisma.invoice.findFirst({
    where: { id, orgId },
    include: { contact: true, org: true },
  }) as any
  if (!invoice) return c.json({ error: 'not_found' }, 404)

  const org = invoice.org
  const settings = (org.paymentSettings || {}) as PaymentSettings

  // Auto-pick provider: prefer Moyasar for SAR, Stripe for USD/EUR, PayPal as fallback
  let chosen: 'stripe' | 'paypal' | 'moyasar' | null = null
  if (provider === 'auto') {
    if (invoice.currency === 'SAR' && settings.moyasar?.enabled) chosen = 'moyasar'
    else if (settings.stripe?.enabled) chosen = 'stripe'
    else if (settings.paypal?.enabled) chosen = 'paypal'
    else if (settings.moyasar?.enabled) chosen = 'moyasar'
  } else {
    chosen = provider
  }
  if (!chosen) return c.json({ error: 'no_provider_configured', message: 'فعّل بوابة دفع من الإعدادات' }, 400)

  const remaining = Number(invoice.total) - Number(invoice.amountPaid)
  if (remaining <= 0) return c.json({ error: 'already_paid' }, 400)

  const description = `${invoice.org.name} · فاتورة ${invoice.invoiceNumber} · ${invoice.contact?.displayName || ''}`.trim()

  try {
    let result
    if (chosen === 'stripe') {
      if (!settings.stripe?.secretKey) return c.json({ error: 'stripe_not_configured' }, 400)
      result = await createStripeLink(settings.stripe.secretKey, {
        amount: remaining, currency: invoice.currency, description,
        invoiceNumber: invoice.invoiceNumber, orgId, invoiceId: id,
      })
    } else if (chosen === 'paypal') {
      if (!settings.paypal?.clientId || !settings.paypal?.clientSecret) {
        return c.json({ error: 'paypal_not_configured' }, 400)
      }
      result = await createPayPalLink({
        clientId: settings.paypal.clientId, clientSecret: settings.paypal.clientSecret,
        mode: settings.paypal.mode || 'live',
        amount: remaining, currency: invoice.currency, description,
        invoiceNumber: invoice.invoiceNumber,
      })
    } else if (chosen === 'moyasar') {
      if (!settings.moyasar?.secretKey) return c.json({ error: 'moyasar_not_configured' }, 400)
      result = await createMoyasarLink(settings.moyasar.secretKey, {
        amount: remaining, currency: invoice.currency, description,
        invoiceNumber: invoice.invoiceNumber,
      })
    } else {
      return c.json({ error: 'invalid_provider' }, 400)
    }

    // Save link metadata on invoice
    await prisma.invoice.update({
      where: { id },
      data: {
        paymentLinkUrl: result.url,
        paymentLinkProvider: result.provider,
        paymentLinkId: result.id,
      } as any,
    })

    return c.json(result)
  } catch (e: any) {
    return c.json({ error: 'provider_error', message: e?.message || 'unknown' }, 502)
  }
})

paymentLinksRoutes.get('/invoice/:id', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const inv = await prisma.invoice.findFirst({
    where: { id, orgId },
    select: { paymentLinkUrl: true, paymentLinkProvider: true, paymentLinkId: true } as any,
  }) as any
  if (!inv) return c.json({ error: 'not_found' }, 404)
  if (!inv.paymentLinkUrl) return c.json({ error: 'no_link' }, 404)
  return c.json({
    url: inv.paymentLinkUrl,
    provider: inv.paymentLinkProvider,
    id: inv.paymentLinkId,
  })
})

// Webhook receivers — public, no auth (provider signs the request)
paymentLinksRoutes.post('/webhook/:provider', async (c) => {
  const provider = c.req.param('provider')
  const body = await c.req.json().catch(() => ({}))

  // Stripe: { type: 'checkout.session.completed', data: { object: { metadata: { invoice_id, org_id }, amount_total } } }
  // PayPal: PURCHASE.CAPTURE.COMPLETED
  // Moyasar: { id, status: 'paid', amount, callback_url }
  let invoiceId: string | undefined
  let amount: number | undefined
  let succeeded = false
  if (provider === 'stripe') {
    const obj = body?.data?.object
    invoiceId = obj?.metadata?.invoice_id
    amount = obj?.amount_total ? Number(obj.amount_total) / 100 : undefined
    succeeded = body?.type === 'checkout.session.completed' || body?.type === 'payment_link.paid'
  } else if (provider === 'paypal') {
    invoiceId = body?.resource?.custom_id || body?.resource?.invoice_id
    amount = Number(body?.resource?.amount?.value || 0)
    succeeded = body?.event_type === 'PAYMENT.CAPTURE.COMPLETED'
  } else if (provider === 'moyasar') {
    succeeded = body?.status === 'paid'
    amount = Number(body?.amount || 0) / 100
    // Need to look up by paymentLinkId
    if (body?.id) {
      const inv = await prisma.invoice.findFirst({ where: { paymentLinkId: body.id } as any })
      if (inv) invoiceId = inv.id
    }
  }

  if (succeeded && invoiceId && amount) {
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        amountPaid: { increment: amount },
        status: 'PAID',
      },
    })
  }
  return c.json({ ok: true })
})
