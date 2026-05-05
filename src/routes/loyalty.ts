/**
 * Loyalty · per-Contact points · earn + redeem + tiers (UX-53)
 *
 * GET    /api/loyalty/accounts                   list accounts
 * GET    /api/loyalty/accounts/:contactId        single account · or 404 (auto-enrol via POST)
 * POST   /api/loyalty/accounts                   { contactId } · enrol or noop if exists
 * POST   /api/loyalty/accounts/:contactId/earn   { points, source?, description? }
 * POST   /api/loyalty/accounts/:contactId/redeem { points, source?, description? }
 * POST   /api/loyalty/accounts/:contactId/adjust { points, description? } (admin · positive or negative)
 * GET    /api/loyalty/accounts/:contactId/transactions
 *
 * Tier rules · derived from lifetime points:
 *   BRONZE   0+
 *   SILVER   1,000+
 *   GOLD     5,000+
 *   PLATINUM 25,000+
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../db.js'

export const loyaltyRoutes = new Hono()

const TIER_THRESHOLDS: { tier: string; min: number }[] = [
  { tier: 'PLATINUM', min: 25000 },
  { tier: 'GOLD', min: 5000 },
  { tier: 'SILVER', min: 1000 },
  { tier: 'BRONZE', min: 0 },
]

function tierForLifetime(lifetime: number): string {
  for (const t of TIER_THRESHOLDS) if (lifetime >= t.min) return t.tier
  return 'BRONZE'
}

loyaltyRoutes.get('/accounts', async (c) => {
  const orgId = c.get('orgId') as string
  const tier = c.req.query('tier')
  const where: any = { orgId }
  if (tier) where.tier = tier
  const items = await prisma.loyaltyAccount.findMany({
    where,
    orderBy: { lifetime: 'desc' },
    take: 200,
    include: { transactions: { take: 5, orderBy: { createdAt: 'desc' } } },
  })
  // Pull contact names in one batch
  const contactIds = items.map((a) => a.contactId)
  const contacts = contactIds.length
    ? await prisma.contact.findMany({ where: { id: { in: contactIds }, orgId }, select: { id: true, displayName: true, email: true, phone: true } })
    : []
  const contactById = new Map(contacts.map((c) => [c.id, c]))
  return c.json({ items: items.map((a) => ({ ...a, contact: contactById.get(a.contactId) })) })
})

loyaltyRoutes.get('/accounts/:contactId', async (c) => {
  const orgId = c.get('orgId') as string
  const contactId = c.req.param('contactId')
  const account = await prisma.loyaltyAccount.findFirst({
    where: { orgId, contactId },
    include: { transactions: { orderBy: { createdAt: 'desc' }, take: 50 } },
  })
  if (!account) return c.json({ error: 'not_enrolled' }, 404)
  return c.json(account)
})

const enrolSchema = z.object({ contactId: z.string() })
loyaltyRoutes.post('/accounts', zValidator('json', enrolSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const { contactId } = c.req.valid('json')
  // Verify contact belongs to org
  const contact = await prisma.contact.findFirst({ where: { id: contactId, orgId } })
  if (!contact) return c.json({ error: 'invalid_contact' }, 400)
  const existing = await prisma.loyaltyAccount.findUnique({ where: { contactId } })
  if (existing) return c.json(existing)
  const account = await prisma.loyaltyAccount.create({ data: { orgId, contactId } })
  return c.json(account, 201)
})

const txSchema = z.object({
  points: z.number().int().positive(),
  source: z.string().optional(),
  description: z.string().optional(),
})

async function ensureAccount(orgId: string, contactId: string) {
  let acc = await prisma.loyaltyAccount.findUnique({ where: { contactId } })
  if (!acc) {
    const contact = await prisma.contact.findFirst({ where: { id: contactId, orgId } })
    if (!contact) return null
    acc = await prisma.loyaltyAccount.create({ data: { orgId, contactId } })
  }
  return acc
}

loyaltyRoutes.post('/accounts/:contactId/earn', zValidator('json', txSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const contactId = c.req.param('contactId')
  const { points, source, description } = c.req.valid('json')
  const acc = await ensureAccount(orgId, contactId)
  if (!acc) return c.json({ error: 'invalid_contact' }, 400)
  const result = await prisma.$transaction(async (tx) => {
    await tx.loyaltyTransaction.create({
      data: { accountId: acc.id, type: 'EARN', points, source, description },
    })
    const newLifetime = acc.lifetime + points
    return tx.loyaltyAccount.update({
      where: { id: acc.id },
      data: {
        balance: { increment: points },
        lifetime: { increment: points },
        tier: tierForLifetime(newLifetime),
      },
    })
  })
  return c.json(result)
})

loyaltyRoutes.post('/accounts/:contactId/redeem', zValidator('json', txSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const contactId = c.req.param('contactId')
  const { points, source, description } = c.req.valid('json')
  const acc = await ensureAccount(orgId, contactId)
  if (!acc) return c.json({ error: 'invalid_contact' }, 400)
  if (acc.balance < points) return c.json({ error: 'insufficient_balance', balance: acc.balance }, 400)
  const result = await prisma.$transaction(async (tx) => {
    await tx.loyaltyTransaction.create({
      data: { accountId: acc.id, type: 'REDEEM', points: -points, source, description },
    })
    return tx.loyaltyAccount.update({
      where: { id: acc.id },
      data: { balance: { decrement: points } },
    })
  })
  return c.json(result)
})

const adjustSchema = z.object({
  points: z.number().int(),
  description: z.string().optional(),
})
loyaltyRoutes.post('/accounts/:contactId/adjust', zValidator('json', adjustSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const contactId = c.req.param('contactId')
  const { points, description } = c.req.valid('json')
  const acc = await ensureAccount(orgId, contactId)
  if (!acc) return c.json({ error: 'invalid_contact' }, 400)
  if (acc.balance + points < 0) return c.json({ error: 'would_go_negative' }, 400)
  const result = await prisma.$transaction(async (tx) => {
    await tx.loyaltyTransaction.create({
      data: { accountId: acc.id, type: 'ADJUST', points, source: 'manual', description },
    })
    const newLifetime = points > 0 ? acc.lifetime + points : acc.lifetime
    return tx.loyaltyAccount.update({
      where: { id: acc.id },
      data: {
        balance: { increment: points },
        lifetime: points > 0 ? { increment: points } : undefined,
        tier: tierForLifetime(newLifetime),
      },
    })
  })
  return c.json(result)
})

loyaltyRoutes.get('/accounts/:contactId/transactions', async (c) => {
  const orgId = c.get('orgId') as string
  const contactId = c.req.param('contactId')
  const acc = await prisma.loyaltyAccount.findFirst({ where: { orgId, contactId } })
  if (!acc) return c.json({ items: [], total: 0 })
  const items = await prisma.loyaltyTransaction.findMany({
    where: { accountId: acc.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  return c.json({ items, total: items.length })
})
