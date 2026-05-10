/**
 * Entix Books API · Hono server
 * Port 3000 internally · exposed at api.entix.io via Coolify Traefik
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { prisma } from './db.js'
import { auth, requireAuth, requireOrg } from './auth.js'
import { contactsRoutes } from './routes/contacts.js'
import { orgsRoutes } from './routes/orgs.js'
import { invoicesRoutes } from './routes/invoices.js'
import { accountsRoutes } from './routes/accounts.js'
import { meRoutes } from './routes/me.js'
import { expensesRoutes } from './routes/expenses.js'
import { quotesRoutes } from './routes/quotes.js'
import { vouchersRoutes } from './routes/vouchers.js'
import { ocrRoutes } from './routes/ocr.js'
import { agentRoutes } from './routes/agent.js'
import { dashboardRoutes } from './routes/dashboard.js'
import { billsRoutes } from './routes/bills.js'
import { bankAccountsRoutes } from './routes/bank-accounts.js'
import { branchesRoutes, costCentersRoutes, projectsRoutes, fixedAssetsRoutes, productsRoutes } from './routes/orgScoped.js'
import { notificationsRoutes } from './routes/notifications.js'
import { signRoutes } from './routes/sign.js'
import { emailRoutes } from './routes/email.js'
import { loyaltyRoutes } from './routes/loyalty.js'
import { zatcaRoutes } from './routes/zatca.js'
import { bankImportRoutes } from './routes/bank-import.js'
import { currencyRoutes } from './routes/currency.js'
import { fiscalPeriodsRoutes } from './routes/fiscal-periods.js'
import { paymentLinksRoutes } from './routes/payment-links.js'
import { portalRoutes, portalAdminRoutes } from './routes/portal.js'
import { payrollRoutes } from './routes/payroll.js'
import { inventoryRoutes } from './routes/inventory.js'
import { agentAdvancedRoutes } from './routes/agent-advanced.js'
import { agentExtractRoutes } from './routes/agent-extract.js'
import { plaidRoutes } from './routes/plaid.js'
import { brokersRoutes } from './routes/brokers.js'
import { aiBillingRoutes } from './routes/ai-billing.js'
import { inboxRoutes, inboxWebhookRoutes } from './routes/inbox.js'
import { journalsRoutes } from './routes/journals.js'
import { oauthRoutes } from './routes/oauth.js'

const app = new Hono()

// ── Middleware ──────────────────────────────────────────────────────────────
app.use('*', logger())
app.use('*', secureHeaders())
app.use(
  '*',
  cors({
    origin: (origin) => {
      const allowed = [
        'https://entix.io',
        'https://www.entix.io',
        'http://localhost:3001',
        'http://localhost:5173',
      ]
      return allowed.includes(origin || '') ? origin || '*' : ''
    },
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Org-Id'],
    exposeHeaders: ['X-Total-Count'],
  }),
)

// ── Public routes ───────────────────────────────────────────────────────────
app.get('/', (c) =>
  c.json({
    name: 'entix-books-api',
    version: '0.1.0',
    status: 'ok',
    docs: 'https://entix.io/docs/api',
  }),
)

app.get('/health', async (c) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    return c.json({ status: 'ok', db: 'connected' })
  } catch (e) {
    return c.json({ status: 'degraded', db: 'error', detail: String(e) }, 503)
  }
})

// What auth providers does the frontend show buttons for?
app.get('/auth-providers', (c) =>
  c.json({
    emailPassword: true,
    google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  }),
)

// ── better-auth handler · /api/auth/* (sign-up · sign-in · sign-out · session) ──
app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw))

// ── Auth-only routes ────────────────────────────────────────────────────────
app.route('/me', meRoutes)
app.route('/orgs', orgsRoutes)

// Org-scoped routes (require auth + org membership)
const orgScoped = new Hono()
orgScoped.use('*', requireAuth)
orgScoped.use('*', requireOrg)
orgScoped.route('/contacts', contactsRoutes)
orgScoped.route('/invoices', invoicesRoutes)
orgScoped.route('/accounts', accountsRoutes)
orgScoped.route('/expenses', expensesRoutes)
orgScoped.route('/quotes', quotesRoutes)
orgScoped.route('/vouchers', vouchersRoutes)
orgScoped.route('/ocr', ocrRoutes)
orgScoped.route('/agent', agentRoutes)
orgScoped.route('/dashboard', dashboardRoutes)
orgScoped.route('/bills', billsRoutes)
orgScoped.route('/bank-accounts', bankAccountsRoutes)
orgScoped.route('/branches', branchesRoutes)
orgScoped.route('/cost-centers', costCentersRoutes)
orgScoped.route('/projects', projectsRoutes)
orgScoped.route('/fixed-assets', fixedAssetsRoutes)
orgScoped.route('/products', productsRoutes)
orgScoped.route('/notifications', notificationsRoutes)
orgScoped.route('/loyalty', loyaltyRoutes)
orgScoped.route('/zatca', zatcaRoutes)
orgScoped.route('/bank-import', bankImportRoutes)
orgScoped.route('/currency', currencyRoutes)
orgScoped.route('/fiscal-periods', fiscalPeriodsRoutes)
orgScoped.route('/payment-links', paymentLinksRoutes)
orgScoped.route('/portal-admin', portalAdminRoutes)
orgScoped.route('/payroll', payrollRoutes)
orgScoped.route('/inventory', inventoryRoutes)
orgScoped.route('/agent', agentAdvancedRoutes)
orgScoped.route('/agent', agentExtractRoutes)
orgScoped.route('/plaid', plaidRoutes)
orgScoped.route('/brokers', brokersRoutes)
orgScoped.route('/inbox', inboxRoutes)
orgScoped.route('/journals', journalsRoutes)
app.route('/api', orgScoped)

// Inbound email webhook · public · validated by X-Inbox-Token header
app.route('/api/inbox', inboxWebhookRoutes)
app.route('/api/portal', portalRoutes)

// Sign routes mounted at top level so the webhook (POST /api/sign/webhook)
// is reachable WITHOUT auth · auth is applied per-subroute inside sign.ts
app.route('/api/sign', signRoutes)

// OAuth routes (Stripe Connect · PayPal Partner Referrals · status)
// Mounted at top level · /callback is public (Stripe/PayPal redirects), /start /disconnect /status check session inline
app.route('/api/oauth', oauthRoutes)

// Email send routes (Resend wrapper · branded templates) · auth handled inside
app.route('/api/email', emailRoutes)

// AI billing routes (BYOK + hosted credits + admin)
// Auth handled per-subroute inside ai-billing.ts (requireOrg for self · requireAdmin for cross-org)
app.route('/api/ai-billing', aiBillingRoutes)

// ── Error handler ──────────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error('[error]', err)
  return c.json(
    {
      error: 'internal_error',
      detail: err.message, // exposed temporarily for debugging UX-184
    },
    500,
  )
})

app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404))

const port = Number(process.env.PORT || 3000)
console.log(`[entix-books-api] starting on :${port}`)
console.log(`[entix-books-api] auth: better-auth · email/password`)

serve({
  fetch: app.fetch,
  port,
})
