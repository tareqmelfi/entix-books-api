/**
 * Notifications · in-app feed for the bell dropdown
 * GET    /api/notifications           — list (with ?unread=1 filter, ?limit=)
 * GET    /api/notifications/count     — unread count for badge
 * PATCH  /api/notifications/:id/read  — mark single as read
 * POST   /api/notifications/mark-all-read
 * DELETE /api/notifications/:id
 *
 * Helper exported: createNotification(orgId, payload) — called from other routes
 * (invoice send, voucher created, sign signed, etc.)
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireAuth, requireOrg } from '../auth.js'
import { prisma } from '../db.js'

export const notificationsRoutes = new Hono()

notificationsRoutes.use('*', requireAuth, requireOrg)

// GET /api/notifications?unread=1&limit=50
notificationsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId') as string
  const auth = c.get('auth') as { userId: string }
  const unread = c.req.query('unread') === '1'
  const limit = Math.min(Number(c.req.query('limit') || '50'), 200)

  const where: any = {
    orgId,
    OR: [{ userId: null }, { userId: auth.userId }],
  }
  if (unread) where.readAt = null

  const items = await prisma.notification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return c.json({ items, count: items.length })
})

// GET /api/notifications/count
notificationsRoutes.get('/count', async (c) => {
  const orgId = c.get('orgId') as string
  const auth = c.get('auth') as { userId: string }
  const unread = await prisma.notification.count({
    where: {
      orgId,
      readAt: null,
      OR: [{ userId: null }, { userId: auth.userId }],
    },
  })
  return c.json({ unread })
})

// PATCH /api/notifications/:id/read
notificationsRoutes.patch('/:id/read', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const n = await prisma.notification.findFirst({ where: { id, orgId } })
  if (!n) return c.json({ error: 'not_found' }, 404)
  if (n.readAt) return c.json(n)
  const updated = await prisma.notification.update({
    where: { id },
    data: { readAt: new Date() },
  })
  return c.json(updated)
})

// POST /api/notifications/mark-all-read
notificationsRoutes.post('/mark-all-read', async (c) => {
  const orgId = c.get('orgId') as string
  const auth = c.get('auth') as { userId: string }
  const result = await prisma.notification.updateMany({
    where: {
      orgId,
      readAt: null,
      OR: [{ userId: null }, { userId: auth.userId }],
    },
    data: { readAt: new Date() },
  })
  return c.json({ updated: result.count })
})

// DELETE /api/notifications/:id
notificationsRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const n = await prisma.notification.findFirst({ where: { id, orgId } })
  if (!n) return c.json({ error: 'not_found' }, 404)
  await prisma.notification.delete({ where: { id } })
  return c.json({ ok: true })
})

// Manual create (for testing · admin tooling)
const createSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  link: z.string().optional(),
  refType: z.string().optional(),
  refId: z.string().optional(),
  userId: z.string().optional(),
})
notificationsRoutes.post('/', zValidator('json', createSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const data = c.req.valid('json')
  const n = await prisma.notification.create({ data: { orgId, ...data } })
  return c.json(n, 201)
})

// ── Helper exported for other routes ───────────────────────────────────────
export async function createNotification(
  orgId: string,
  payload: {
    type: string
    title: string
    body?: string
    link?: string
    refType?: string
    refId?: string
    userId?: string | null
  },
) {
  try {
    return await prisma.notification.create({
      data: {
        orgId,
        type: payload.type,
        title: payload.title,
        body: payload.body ?? null,
        link: payload.link ?? null,
        refType: payload.refType ?? null,
        refId: payload.refId ?? null,
        userId: payload.userId ?? null,
      },
    })
  } catch (e) {
    console.error('[notifications] create failed', e)
    return null
  }
}
