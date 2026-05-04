/**
 * Authentication · better-auth setup
 *
 * Provides:
 *  - Email/password sign-up + sign-in
 *  - Server-side sessions (DB-backed)
 *  - /api/auth/* HTTP handler (mounted in server.ts)
 *  - Hono middleware: requireAuth · requireOrg
 *
 * No external auth service · no monthly cost.
 * Uses Postgres tables: User · auth_session · auth_account · auth_verification
 */
import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import type { MiddlewareHandler } from 'hono'
import { prisma } from './db.js'

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://entix.io'
const API_URL = process.env.API_URL || 'https://api.entix.io'

export const auth = betterAuth({
  appName: 'Entix Books',
  baseURL: API_URL,

  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),

  // Map our custom prisma models to the names better-auth expects internally
  session: {
    modelName: 'authSession',
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh once per day
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  account: {
    modelName: 'authAccount',
  },
  verification: {
    modelName: 'verification',
  },
  user: {
    additionalFields: {
      phone: { type: 'string', required: false },
      locale: { type: 'string', required: false, defaultValue: 'ar' },
    },
  },

  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    requireEmailVerification: false, // V0.1 — turn on later when SMTP is wired
  },

  // Google OAuth · only enabled when both env vars are set
  socialProviders: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        },
      }
    : {},

  trustedOrigins: [
    'https://entix.io',
    'https://www.entix.io',
    'http://localhost:3001',
    'http://localhost:5173',
  ],

  advanced: {
    cookiePrefix: 'entix',
    useSecureCookies: process.env.NODE_ENV === 'production',
    crossSubDomainCookies: {
      enabled: true,
      domain: '.entix.io',
    },
  },

  rateLimit: {
    enabled: true,
    window: 60,
    max: 60,
  },
})

// ── Hono middleware ──────────────────────────────────────────────────────────
export type AuthContext = {
  userId: string
  email: string
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext
    orgId: string
    orgRole: string
  }
}

/**
 * Require an authenticated user (better-auth session cookie or Bearer token).
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  c.set('auth', { userId: session.user.id, email: session.user.email })
  await next()
}

/**
 * Resolve the active org from the X-Org-Id header.
 * Verifies the user is a member.
 */
export const requireOrg: MiddlewareHandler = async (c, next) => {
  const a = c.get('auth')
  if (!a) return c.json({ error: 'unauthorized' }, 401)

  const orgId = c.req.header('X-Org-Id')
  if (!orgId) return c.json({ error: 'missing X-Org-Id header' }, 400)

  const m = await prisma.orgMembership.findUnique({
    where: { userId_orgId: { userId: a.userId, orgId } },
  })
  if (!m) return c.json({ error: 'not a member of this org' }, 403)

  c.set('orgId', orgId)
  c.set('orgRole', m.role)
  await next()
}
