/**
 * Admin password reset · UX-204 · gated by ADMIN_RESET_TOKEN env
 * POST /api/admin/reset-password   { email, newPassword }
 */
import { Hono } from 'hono'
import { prisma } from '../db.js'
import { auth } from '../auth.js'

export const adminResetRoutes = new Hono()

adminResetRoutes.post('/reset-password', async (c) => {
  const tokenHeader = c.req.header('X-Admin-Token')
  const expected = process.env.ADMIN_RESET_TOKEN
  if (!expected || tokenHeader !== expected) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid_body' }, 400) }
  const { email, newPassword } = body || {}
  if (!email || !newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    return c.json({ error: 'email_and_8char_password_required' }, 400)
  }

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) return c.json({ error: 'user_not_found' }, 404)

  // Use better-auth's internal hashPassword via $context
  const ctx: any = (auth as any).$context
  const hash = await (ctx.password ? ctx.password.hash(newPassword) : (ctx as any).password.hash(newPassword))

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
        userId: user.id,
        accountId: user.id,
        providerId: 'credential',
        password: hash,
      },
    })
  }
  return c.json({ ok: true, email, userId: user.id })
})
