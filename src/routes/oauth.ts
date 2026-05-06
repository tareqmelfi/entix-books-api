/**
 * OAuth flows for payment provider connections (UX-137)
 *
 * Replaces the paste-secret-key flow with a "Connect" button that
 * redirects the merchant to Stripe / PayPal, completes OAuth, and
 * stores the resulting access_token + connected_account_id without
 * the user ever touching a secret key.
 *
 *   GET  /api/oauth/stripe/start?orgId=...  →  302 to Stripe Connect URL (auth-required)
 *   GET  /api/oauth/stripe/callback?code=&state=  →  exchange + store + redirect (public)
 *   POST /api/oauth/stripe/disconnect       →  revoke + clear stored tokens
 *
 *   GET  /api/oauth/paypal/start?orgId=...  →  302 to PayPal Partner Referrals (auth-required)
 *   GET  /api/oauth/paypal/callback         →  store merchantIdInPayPal + redirect
 *
 * Moyasar / Tamara / Tabby do NOT expose OAuth · they keep the manual
 * paste flow in the existing PaymentsTab.
 *
 * State token uses HMAC-SHA256 (no jose/jsonwebtoken dep needed).
 */
import { Hono } from 'hono'
import crypto from 'node:crypto'
import { prisma } from '../db.js'
import { auth } from '../auth.js'

export const oauthRoutes = new Hono()

/** Resolve session inline · works without requireAuth middleware so the public callback can coexist. */
async function getSessionUser(c: any): Promise<{ userId: string; email: string } | null> {
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return null
    return { userId: session.user.id, email: session.user.email }
  } catch {
    return null
  }
}

const STATE_SECRET =
  process.env.OAUTH_STATE_SECRET ||
  process.env.BETTER_AUTH_SECRET ||
  'entix-oauth-fallback-DEV-ONLY'

const STRIPE_CLIENT_ID = process.env.STRIPE_CLIENT_ID || '' // ca_xxx from Stripe Connect settings
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '' // sk_live_xxx (platform key)
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || ''
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || ''
const PAYPAL_MODE = (process.env.PAYPAL_MODE || 'live') as 'live' | 'sandbox'

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://entix.io'
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || 'https://api.entix.io'

// ── HMAC state · prevents CSRF + ties callback to original org/user ──────────
function signState(payload: { orgId: string; userId: string; provider: string; nonce?: string }): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, nonce: payload.nonce || crypto.randomBytes(8).toString('hex'), t: Date.now() }),
  ).toString('base64url')
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}
function verifyState(state: string): { orgId: string; userId: string; provider: string; t: number } | null {
  const [body, sig] = state.split('.')
  if (!body || !sig) return null
  const expected = crypto.createHmac('sha256', STATE_SECRET).update(body).digest('base64url')
  // timing-safe compare
  if (sig.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'))
    // 10-minute TTL
    if (Date.now() - parsed.t > 10 * 60 * 1000) return null
    return parsed
  } catch {
    return null
  }
}

// ── Stripe Connect Standard OAuth ────────────────────────────────────────────
//   docs: https://stripe.com/docs/connect/oauth-reference
oauthRoutes.get('/stripe/start', async (c) => {
  const session = await getSessionUser(c)
  if (!session?.userId) return c.json({ error: 'unauthorized' }, 401)
  const orgId = c.req.query('orgId')
  if (!orgId) return c.json({ error: 'orgId_required' }, 400)
  if (!STRIPE_CLIENT_ID) {
    return c.json(
      { error: 'stripe_not_configured', message: 'STRIPE_CLIENT_ID env var غير معدّ في الخادم' },
      503,
    )
  }

  // Verify caller is a member of this org
  const member = await prisma.orgMembership.findFirst({
    where: { orgId, userId: session.userId },
    select: { id: true },
  })
  if (!member) return c.json({ error: 'forbidden' }, 403)

  const state = signState({ orgId, userId: session.userId, provider: 'stripe' })
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: STRIPE_CLIENT_ID,
    scope: 'read_write',
    state,
    redirect_uri: `${API_PUBLIC_URL}/api/oauth/stripe/callback`,
  })

  // Pre-fill what we know about the merchant to speed up onboarding
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { name: true, country: true, currency: true, email: true },
  })
  if (org?.email) params.set('stripe_user[email]', org.email)
  if (org?.country) params.set('stripe_user[country]', org.country)
  if (org?.currency) params.set('stripe_user[currency]', org.currency.toLowerCase())
  if (org?.name) params.set('stripe_user[business_name]', org.name)

  return c.redirect(`https://connect.stripe.com/oauth/authorize?${params}`, 302)
})

oauthRoutes.get('/stripe/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')
  const errorDesc = c.req.query('error_description')

  const fail = (reason: string) =>
    c.redirect(`${FRONTEND_URL}/app/settings?tab=payments&oauth=stripe&status=error&reason=${encodeURIComponent(reason)}`)

  if (error) return fail(errorDesc || error)
  if (!code || !state) return fail('missing_code_or_state')

  const verified = verifyState(state)
  if (!verified || verified.provider !== 'stripe') return fail('invalid_state')

  if (!STRIPE_SECRET) return fail('stripe_secret_not_configured')

  // Exchange code → access_token
  const tokenRes = await fetch('https://connect.stripe.com/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code }),
  })
  if (!tokenRes.ok) {
    const detail = await tokenRes.text()
    console.error('[oauth/stripe] token exchange failed', detail.slice(0, 400))
    return fail('token_exchange_failed')
  }
  const tok = (await tokenRes.json()) as {
    access_token?: string
    refresh_token?: string
    stripe_user_id?: string
    stripe_publishable_key?: string
    livemode?: boolean
    scope?: string
  }
  if (!tok.access_token || !tok.stripe_user_id) return fail('invalid_token_response')

  // Merge into Organization.paymentSettings (JSON column)
  const org = await prisma.organization.findUnique({
    where: { id: verified.orgId },
    select: { paymentSettings: true },
  })
  const existing = (org?.paymentSettings as any) || {}
  const merged = {
    ...existing,
    stripe: {
      enabled: true,
      mode: tok.livemode === false ? 'test' : 'live',
      // Replace paste-secret fields with OAuth-issued tokens
      connectedAccountId: tok.stripe_user_id,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || null,
      publishableKey: tok.stripe_publishable_key || existing.stripe?.publishableKey || '',
      scope: tok.scope || 'read_write',
      connectedAt: new Date().toISOString(),
      connectedBy: verified.userId,
    },
  }
  await prisma.organization.update({
    where: { id: verified.orgId },
    data: { paymentSettings: merged },
  })

  return c.redirect(
    `${FRONTEND_URL}/app/settings?tab=payments&oauth=stripe&status=success&account=${encodeURIComponent(tok.stripe_user_id)}`,
  )
})

oauthRoutes.post('/stripe/disconnect', async (c) => {
  const session = await getSessionUser(c)
  if (!session?.userId) return c.json({ error: 'unauthorized' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { orgId?: string }
  const orgId = body.orgId
  if (!orgId) return c.json({ error: 'orgId_required' }, 400)
  const member = await prisma.orgMembership.findFirst({
    where: { orgId, userId: session.userId },
    select: { id: true },
  })
  if (!member) return c.json({ error: 'forbidden' }, 403)

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { paymentSettings: true },
  })
  const existing = (org?.paymentSettings as any) || {}
  const acct = existing?.stripe?.connectedAccountId

  // Tell Stripe we no longer act on this account
  if (acct && STRIPE_SECRET) {
    try {
      await fetch('https://connect.stripe.com/oauth/deauthorize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STRIPE_SECRET}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: STRIPE_CLIENT_ID,
          stripe_user_id: acct,
        }),
      })
    } catch (e) {
      console.warn('[oauth/stripe] deauthorize failed (continuing anyway)', e)
    }
  }

  const merged = {
    ...existing,
    stripe: { enabled: false, publishableKey: '', secretKey: '', connectedAccountId: null, accessToken: null },
  }
  await prisma.organization.update({ where: { id: orgId }, data: { paymentSettings: merged } })
  return c.json({ ok: true, disconnected: acct })
})

// ── PayPal Partner Referrals (Marketplace flow) ──────────────────────────────
//   docs: https://developer.paypal.com/docs/multiparty/seller-onboarding/before-payment/
oauthRoutes.get('/paypal/start', async (c) => {
  const session = await getSessionUser(c)
  if (!session?.userId) return c.json({ error: 'unauthorized' }, 401)
  const orgId = c.req.query('orgId')
  if (!orgId) return c.json({ error: 'orgId_required' }, 400)
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    return c.json(
      { error: 'paypal_not_configured', message: 'PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET env vars غير معدّة' },
      503,
    )
  }
  const member = await prisma.orgMembership.findFirst({
    where: { orgId, userId: session.userId },
    select: { id: true },
  })
  if (!member) return c.json({ error: 'forbidden' }, 403)

  const state = signState({ orgId, userId: session.userId, provider: 'paypal' })
  const apiBase =
    PAYPAL_MODE === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com'
  const dashBase =
    PAYPAL_MODE === 'sandbox' ? 'https://www.sandbox.paypal.com' : 'https://www.paypal.com'

  // 1) Get PayPal access token (platform credentials)
  const tokRes = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!tokRes.ok) {
    return c.json({ error: 'paypal_token_failed', detail: await tokRes.text() }, 502)
  }
  const tok = (await tokRes.json()) as { access_token: string }

  // 2) Create a partner referral
  const refRes = await fetch(`${apiBase}/v2/customer/partner-referrals`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tracking_id: state,
      operations: [
        {
          operation: 'API_INTEGRATION',
          api_integration_preference: {
            rest_api_integration: {
              integration_method: 'PAYPAL',
              integration_type: 'THIRD_PARTY',
              third_party_details: { features: ['PAYMENT', 'REFUND'] },
            },
          },
        },
      ],
      products: ['EXPRESS_CHECKOUT'],
      legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
      partner_config_override: {
        return_url: `${API_PUBLIC_URL}/api/oauth/paypal/callback?state=${encodeURIComponent(state)}`,
      },
    }),
  })
  if (!refRes.ok) {
    const detail = await refRes.text()
    console.error('[oauth/paypal] referral failed', detail.slice(0, 400))
    return c.json({ error: 'paypal_referral_failed', detail }, 502)
  }
  const ref = (await refRes.json()) as { links?: Array<{ rel: string; href: string }> }
  const action = ref.links?.find((l) => l.rel === 'action_url')
  if (!action) return c.json({ error: 'no_action_url', detail: ref }, 502)
  void dashBase
  return c.redirect(action.href, 302)
})

oauthRoutes.get('/paypal/callback', async (c) => {
  const merchantId = c.req.query('merchantIdInPayPal') || c.req.query('merchant_id_in_paypal')
  const state = c.req.query('state')
  const fail = (reason: string) =>
    c.redirect(`${FRONTEND_URL}/app/settings?tab=payments&oauth=paypal&status=error&reason=${encodeURIComponent(reason)}`)

  if (!state) return fail('missing_state')
  const verified = verifyState(state)
  if (!verified || verified.provider !== 'paypal') return fail('invalid_state')
  if (!merchantId) return fail('missing_merchant_id')

  const orgRow = await prisma.organization.findUnique({
    where: { id: verified.orgId },
    select: { paymentSettings: true },
  })
  const existing = (orgRow?.paymentSettings as any) || {}
  const merged = {
    ...existing,
    paypal: {
      ...(existing.paypal || {}),
      enabled: true,
      mode: PAYPAL_MODE,
      merchantIdInPayPal: merchantId,
      connectedAt: new Date().toISOString(),
      connectedBy: verified.userId,
    },
  }
  await prisma.organization.update({ where: { id: verified.orgId }, data: { paymentSettings: merged } })

  return c.redirect(
    `${FRONTEND_URL}/app/settings?tab=payments&oauth=paypal&status=success&merchant=${encodeURIComponent(merchantId)}`,
  )
})

// ── Status endpoint · what's connected, what's not ───────────────────────────
oauthRoutes.get('/status', async (c) => {
  const session = await getSessionUser(c)
  if (!session?.userId) return c.json({ error: 'unauthorized' }, 401)
  const orgId = c.req.query('orgId')
  if (!orgId) return c.json({ error: 'orgId_required' }, 400)
  const member = await prisma.orgMembership.findFirst({
    where: { orgId, userId: session.userId },
    select: { id: true },
  })
  if (!member) return c.json({ error: 'forbidden' }, 403)

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { paymentSettings: true },
  })
  const ps = (org?.paymentSettings as any) || {}
  return c.json({
    stripe: {
      configured: !!STRIPE_CLIENT_ID,
      connected: !!ps?.stripe?.connectedAccountId,
      accountId: ps?.stripe?.connectedAccountId || null,
      mode: ps?.stripe?.mode || null,
      connectedAt: ps?.stripe?.connectedAt || null,
    },
    paypal: {
      configured: !!PAYPAL_CLIENT_ID,
      connected: !!ps?.paypal?.merchantIdInPayPal,
      merchantId: ps?.paypal?.merchantIdInPayPal || null,
      mode: ps?.paypal?.mode || null,
      connectedAt: ps?.paypal?.connectedAt || null,
    },
    moyasar: {
      configured: true, // always available · paste flow
      connected: !!ps?.moyasar?.secretKey,
    },
  })
})
