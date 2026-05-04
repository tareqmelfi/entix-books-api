/**
 * Logto JWT auth middleware for Hono
 *
 * Verifies the JWT against Logto's JWKS (signing keys) and attaches
 * the user identity to context. In demo mode (no Logto creds set),
 * accepts any request and attaches a demo user.
 */
import type { MiddlewareHandler } from 'hono'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { prisma } from './db.js'

const LOGTO_ENDPOINT = process.env.LOGTO_ENDPOINT
const LOGTO_API_RESOURCE = process.env.LOGTO_API_RESOURCE || 'https://api.entix.io'
const DEMO_MODE = !LOGTO_ENDPOINT

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null

function getJWKS() {
  if (!LOGTO_ENDPOINT) throw new Error('LOGTO_ENDPOINT not set')
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${LOGTO_ENDPOINT}/oidc/jwks`))
  }
  return jwks
}

export type AuthContext = {
  userId: string
  email: string
  logtoUserId: string
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext
  }
}

/**
 * Require valid Logto JWT.
 * Demo mode (when LOGTO_ENDPOINT not set): auto-creates demo user, no auth needed.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  // DEMO MODE — bypass auth, use a demo user
  if (DEMO_MODE) {
    let user = await prisma.user.findUnique({ where: { email: 'demo@entix.io' } })
    if (!user) {
      user = await prisma.user.create({
        data: {
          logtoUserId: 'demo-no-logto',
          email: 'demo@entix.io',
          name: 'Demo User',
          locale: 'ar',
        },
      })
    }
    c.set('auth', {
      userId: user.id,
      email: user.email,
      logtoUserId: user.logtoUserId,
    })
    return next()
  }

  const authHeader = c.req.header('Authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return c.json({ error: 'unauthorized', detail: 'missing token' }, 401)

  try {
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: `${LOGTO_ENDPOINT}/oidc`,
      audience: LOGTO_API_RESOURCE,
    })

    const sub = payload.sub
    if (!sub) return c.json({ error: 'unauthorized', detail: 'no sub' }, 401)

    // Mirror user from Logto into local DB on first sight
    let user = await prisma.user.findUnique({ where: { logtoUserId: sub } })
    if (!user) {
      const email = (payload.email as string) || `${sub}@logto.local`
      user = await prisma.user.create({
        data: {
          logtoUserId: sub,
          email,
          name: (payload.name as string) || null,
          avatarUrl: (payload.picture as string) || null,
        },
      })
    }

    c.set('auth', {
      userId: user.id,
      email: user.email,
      logtoUserId: user.logtoUserId,
    })
    await next()
  } catch (e) {
    return c.json(
      { error: 'unauthorized', detail: e instanceof Error ? e.message : 'invalid token' },
      401,
    )
  }
}

/**
 * Resolve current org from the X-Org-Id header.
 * Verifies the user is a member.
 */
export const requireOrg: MiddlewareHandler = async (c, next) => {
  const auth = c.get('auth')
  if (!auth) return c.json({ error: 'unauthorized' }, 401)

  const orgId = c.req.header('X-Org-Id')
  if (!orgId) return c.json({ error: 'missing X-Org-Id header' }, 400)

  const membership = await prisma.orgMembership.findUnique({
    where: { userId_orgId: { userId: auth.userId, orgId } },
  })
  if (!membership) return c.json({ error: 'not a member of this org' }, 403)

  c.set('orgId', orgId)
  c.set('orgRole', membership.role)
  await next()
}

declare module 'hono' {
  interface ContextVariableMap {
    orgId: string
    orgRole: string
  }
}
