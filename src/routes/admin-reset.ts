/**
 * Admin password reset · UX-204 · gated by ADMIN_RESET_TOKEN env
 * POST /api/admin/reset-password   { email, newPassword }
 */
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { prisma } from '../db.js'
import { auth } from '../auth.js'

export const adminResetRoutes = new Hono()

// In-memory rate limiter: max 5 requests per IP per minute
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60_000
const rateBuckets = new Map<string, { count: number; windowStart: number }>()

// Periodic cleanup of expired buckets to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now()
  for (const [ip, bucket] of rateBuckets) {
    if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateBuckets.delete(ip)
    }
  }
}, RATE_LIMIT_WINDOW_MS * 2).unref()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const bucket = rateBuckets.get(ip)
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, windowStart: now })
    return false
  }
  bucket.count += 1
  return bucket.count > RATE_LIMIT_MAX
}

adminResetRoutes.post('/reset-password', async (c) => {
  // cf-connecting-ip is set by Cloudflare and cannot be spoofed by clients.
  // For x-forwarded-for, take the LAST hop (appended by our trusted proxy).
  const ip =
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-real-ip') ||
    c.req.header('x-forwarded-for')?.split(',').pop()?.trim() ||
    'unknown'
  if (isRateLimited(ip)) {
    return c.json({ error: 'too_many_requests' }, 429)
  }

  const tokenHeader = c.req.header('X-Admin-Token')
  const expected = process.env.ADMIN_RESET_TOKEN
  if (!expected || tokenHeader !== expected) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid_body' }, 400) }
  const { email, newPassword } = body || {}
  if (
    !email ||
    typeof email !== 'string' ||
    !newPassword ||
    typeof newPassword !== 'string' ||
    newPassword.length < 8
  ) {
    return c.json({ error: 'email_and_8char_password_required' }, 400)
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) return c.json({ error: 'user_not_found' }, 404)

    // Use better-auth's internal hashPassword via $context (it is a Promise — must await)
    // Internal/undocumented API — tested with better-auth@1.6.11; re-verify on upgrade
    const ctx: any = await (auth as any).$context
    const hash: string = await ctx.password.hash(newPassword)

    // Find or create the email/password authAccount
    const existing = await prisma.authAccount.findFirst({
      where: { userId: user.id, providerId: 'credential' },
    })
    if (existing) {
      await prisma.authAccount.update({
        where: { id: existing.id },
        data: { password: hash },
      })
    } else {
      await prisma.authAccount.create({
        data: {
          id: randomUUID(),
          userId: user.id,
          accountId: user.id,
          providerId: 'credential',
          password: hash,
        },
      })
    }
    return c.json({ ok: true, email })
  } catch (err) {
    console.error('[admin-reset] database_error:', err)
    return c.json({ error: 'database_error' }, 500)
  }
})
