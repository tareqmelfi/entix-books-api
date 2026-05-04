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
import { requireAuth, requireOrg } from './auth.js'
import { contactsRoutes } from './routes/contacts.js'
import { orgsRoutes } from './routes/orgs.js'
import { invoicesRoutes } from './routes/invoices.js'
import { accountsRoutes } from './routes/accounts.js'
import { meRoutes } from './routes/me.js'

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
app.route('/api', orgScoped)

// ── Error handler ──────────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error('[error]', err)
  return c.json(
    {
      error: 'internal_error',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    },
    500,
  )
})

app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404))

const port = Number(process.env.PORT || 3000)
console.log(`[entix-books-api] starting on :${port}`)
console.log(
  `[entix-books-api] auth mode: ${process.env.LOGTO_ENDPOINT ? 'logto' : 'DEMO (no Logto)'}`,
)

serve({
  fetch: app.fetch,
  port,
})
