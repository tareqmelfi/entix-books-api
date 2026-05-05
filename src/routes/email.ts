/**
 * Email send routes · /api/email/*
 *
 * POST /api/email/invoices/:id/send   — send invoice email to customer
 * POST /api/email/quotes/:id/send     — send quote email to customer
 * POST /api/email/credit-notes/:id/send — (when ready)
 *
 * Body: { to?: string, message?: string, payLink?: string }
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireAuth, requireOrg } from '../auth.js'
import { prisma } from '../db.js'
import { sendInvoiceEmail, sendQuoteEmail } from '../lib/email.js'

export const emailRoutes = new Hono()

emailRoutes.use('/*', requireAuth, requireOrg)

const sendSchema = z.object({
  to: z.string().email().optional(),
  message: z.string().max(1000).optional(),
  payLink: z.string().url().optional(),
})

emailRoutes.post('/invoices/:id/send', zValidator('json', sendSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const body = c.req.valid('json')

  const invoice = await prisma.invoice.findFirst({
    where: { id, orgId },
    include: { contact: true, lines: true, org: true },
  })
  if (!invoice) return c.json({ error: 'not_found' }, 404)

  const recipient = body.to || invoice.contact?.email
  if (!recipient) return c.json({ error: 'no_recipient', message: 'العميل ليس لديه بريد · أضف to في الطلب' }, 400)

  const r = await sendInvoiceEmail({
    to: recipient,
    invoice: {
      number: invoice.invoiceNumber,
      issueDate: invoice.issueDate.toISOString(),
      dueDate: invoice.dueDate.toISOString(),
      total: Number(invoice.total),
      amountPaid: Number(invoice.amountPaid || 0),
      currency: invoice.currency,
      notes: invoice.notes,
      lines: invoice.lines.map((l) => ({
        description: l.description,
        quantity: Number(l.quantity),
        unitPrice: Number(l.unitPrice),
        total: Number(l.subtotal),
      })),
    },
    customer: {
      displayName: invoice.contact?.displayName || '—',
      email: invoice.contact?.email,
      taxId: invoice.contact?.taxId,
    },
    org: {
      name: (invoice as any).org?.name || 'Entix Books',
      taxId: (invoice as any).org?.taxId || null,
    },
    payLink: body.payLink,
    message: body.message,
  })

  if (!r.ok) return c.json({ error: 'send_failed', message: r.error }, 500)

  // Mark invoice as SENT if it was DRAFT
  if (invoice.status === 'DRAFT') {
    await prisma.invoice.update({ where: { id }, data: { status: 'SENT' } })
  }

  return c.json({ ok: true, emailId: r.id, sentTo: recipient })
})

emailRoutes.post('/quotes/:id/send', zValidator('json', sendSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const body = c.req.valid('json')

  const quote = await prisma.quote.findFirst({
    where: { id, orgId },
    include: { contact: true, lines: true, org: true },
  })
  if (!quote) return c.json({ error: 'not_found' }, 404)

  const recipient = body.to || quote.contact?.email
  if (!recipient) return c.json({ error: 'no_recipient', message: 'العميل ليس لديه بريد · أضف to في الطلب' }, 400)

  const r = await sendQuoteEmail({
    to: recipient,
    quote: {
      number: quote.quoteNumber,
      issueDate: quote.issueDate.toISOString(),
      validUntil: quote.validUntil.toISOString(),
      total: Number(quote.total),
      currency: quote.currency,
      notes: quote.notes,
      lines: quote.lines.map((l) => ({
        description: l.description,
        quantity: Number(l.quantity),
        unitPrice: Number(l.unitPrice),
        total: Number(l.subtotal),
      })),
    },
    customer: {
      displayName: quote.contact?.displayName || '—',
      email: quote.contact?.email,
      taxId: quote.contact?.taxId,
    },
    org: {
      name: (quote as any).org?.name || 'Entix Books',
      taxId: (quote as any).org?.taxId || null,
    },
    acceptLink: body.payLink, // reuse field name in body for accept link
    message: body.message,
  })

  if (!r.ok) return c.json({ error: 'send_failed', message: r.error }, 500)

  if (quote.status === 'DRAFT') {
    await prisma.quote.update({ where: { id }, data: { status: 'SENT' } })
  }

  return c.json({ ok: true, emailId: r.id, sentTo: recipient })
})
