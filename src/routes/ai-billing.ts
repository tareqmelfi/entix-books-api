/**
 * AI Billing routes · BYOK + hosted credits.
 *
 * Org-scoped (read + own-config):
 *   GET    /api/ai-billing            — current org's billing config + usage
 *   PATCH  /api/ai-billing            — switch mode · set BYOK key · etc (OWNER/ADMIN)
 *   GET    /api/ai-billing/usage      — usage logs (paginated)
 *
 * Admin-only (cross-org):
 *   GET    /api/ai-billing/admin/orgs       — list all orgs with spend
 *   POST   /api/ai-billing/admin/topup      — add credits to an org
 *   POST   /api/ai-billing/admin/disable    — disable AI for an org
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { requireAuth, requireOrg } from '../auth.js'
import { prisma } from '../db.js'
import { encryptSecret, maskKey } from '../lib/crypto.js'

export const aiBillingRoutes = new Hono()

aiBillingRoutes.use('*', requireAuth)

// Utility · ensure billing record exists for an org (lazy create on first access)
async function ensureBilling(orgId: string) {
  let b = await prisma.aiBilling.findUnique({ where: { orgId } })
  if (!b) {
    b = await prisma.aiBilling.create({
      data: { orgId, mode: 'HOSTED_FREE', monthlyAllocation: new Prisma.Decimal(5) },
    })
  }
  return b
}

// ── Org-self-service ────────────────────────────────────────────────────────

aiBillingRoutes.get('/', requireOrg, async (c) => {
  const orgId = c.get('orgId') as string
  const b = await ensureBilling(orgId)
  return c.json({
    mode: b.mode,
    byokProvider: b.byokProvider,
    byokKeyHint: b.byokKeyHint, // never the actual key
    monthlyAllocation: b.monthlyAllocation,
    creditBalance: b.creditBalance,
    spentThisPeriod: b.spentThisPeriod,
    periodResetAt: b.periodResetAt,
    disabled: b.disabled,
    disabledReason: b.disabledReason,
    // helpful UI hints
    percentUsed: Number(b.spentThisPeriod) / Math.max(Number(b.monthlyAllocation), 0.01),
  })
})

const patchSchema = z.object({
  mode: z.enum(['BYOK', 'HOSTED_FREE', 'HOSTED_PRO', 'HOSTED_BUSINESS', 'PAYG']).optional(),
  byokProvider: z.enum(['openrouter', 'anthropic']).optional(),
  byokKey: z.string().min(20).optional(), // raw key · we encrypt before storing
  clearByok: z.boolean().optional(),
})

aiBillingRoutes.patch('/', requireOrg, zValidator('json', patchSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const auth = c.get('auth') as { userId: string }
  // Authz: must be OWNER/ADMIN of this org
  const m = await prisma.orgMembership.findUnique({
    where: { userId_orgId: { userId: auth.userId, orgId } },
  })
  if (!m || (m.role !== 'OWNER' && m.role !== 'ADMIN')) {
    return c.json({ error: 'forbidden' }, 403)
  }

  await ensureBilling(orgId)
  const data = c.req.valid('json')
  const updates: any = {}

  if (data.mode) {
    updates.mode = data.mode
    // Mode-driven defaults
    if (data.mode === 'HOSTED_FREE') updates.monthlyAllocation = new Prisma.Decimal(5)
    if (data.mode === 'HOSTED_PRO') updates.monthlyAllocation = new Prisma.Decimal(30)
    if (data.mode === 'HOSTED_BUSINESS') updates.monthlyAllocation = new Prisma.Decimal(100)
  }

  if (data.clearByok) {
    updates.byokKeyEncrypted = null
    updates.byokKeyHint = null
    updates.byokProvider = null
  } else if (data.byokKey) {
    updates.byokKeyEncrypted = encryptSecret(data.byokKey)
    updates.byokKeyHint = maskKey(data.byokKey)
    if (data.byokProvider) updates.byokProvider = data.byokProvider
  }

  const b = await prisma.aiBilling.update({ where: { orgId }, data: updates })
  return c.json({
    mode: b.mode,
    byokProvider: b.byokProvider,
    byokKeyHint: b.byokKeyHint,
    monthlyAllocation: b.monthlyAllocation,
    creditBalance: b.creditBalance,
    spentThisPeriod: b.spentThisPeriod,
    disabled: b.disabled,
  })
})

aiBillingRoutes.get('/usage', requireOrg, async (c) => {
  const orgId = c.get('orgId') as string
  const limit = Math.min(Number(c.req.query('limit') || '100'), 500)
  const items = await prisma.aiUsageLog.findMany({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  // Aggregate by endpoint + by model
  const byEndpoint: Record<string, { count: number; cost: number }> = {}
  const byModel: Record<string, { count: number; cost: number }> = {}
  for (const item of items) {
    const cost = Number(item.costUsd)
    byEndpoint[item.endpoint] = byEndpoint[item.endpoint] || { count: 0, cost: 0 }
    byEndpoint[item.endpoint].count += 1
    byEndpoint[item.endpoint].cost += cost
    byModel[item.model] = byModel[item.model] || { count: 0, cost: 0 }
    byModel[item.model].count += 1
    byModel[item.model].cost += cost
  }
  return c.json({ items, byEndpoint, byModel })
})

// ── Admin (cross-org) · gated by requireAdmin middleware ────────────────────
// For now: any authenticated user with email matching ADMIN_EMAILS env list.
// TODO: proper RBAC + audit log

function isAdminEmail(email: string): boolean {
  const list = (process.env.ADMIN_EMAILS || 'tareq@fc.sa').split(',').map((s) => s.trim().toLowerCase())
  return list.includes(email.toLowerCase())
}

async function requireAdmin(c: any, next: any) {
  const auth = c.get('auth') as { userId: string }
  const u = await prisma.user.findUnique({ where: { id: auth.userId } })
  if (!u || !isAdminEmail(u.email)) {
    return c.json({ error: 'admin_only' }, 403)
  }
  return next()
}

aiBillingRoutes.get('/admin/orgs', requireAdmin, async (c) => {
  const billings = await prisma.aiBilling.findMany({
    include: { org: { select: { id: true, name: true, slug: true, country: true, createdAt: true } } },
    orderBy: { spentThisPeriod: 'desc' },
  })
  const totalSpend = billings.reduce((s, b) => s + Number(b.spentThisPeriod), 0)
  return c.json({ items: billings, totalSpend, count: billings.length })
})

const topupSchema = z.object({
  orgId: z.string().min(1),
  amountUsd: z.number().positive(),
  note: z.string().optional(),
})

aiBillingRoutes.post('/admin/topup', requireAdmin, zValidator('json', topupSchema), async (c) => {
  const data = c.req.valid('json')
  await ensureBilling(data.orgId)
  const b = await prisma.aiBilling.update({
    where: { orgId: data.orgId },
    data: { creditBalance: { increment: new Prisma.Decimal(data.amountUsd) } },
  })
  console.log(`[admin] topup ${data.orgId} +$${data.amountUsd}${data.note ? ` · ${data.note}` : ''}`)
  return c.json({ orgId: data.orgId, newBalance: b.creditBalance })
})

const disableSchema = z.object({
  orgId: z.string().min(1),
  disabled: z.boolean(),
  reason: z.string().optional(),
})

aiBillingRoutes.post('/admin/disable', requireAdmin, zValidator('json', disableSchema), async (c) => {
  const data = c.req.valid('json')
  await ensureBilling(data.orgId)
  const b = await prisma.aiBilling.update({
    where: { orgId: data.orgId },
    data: { disabled: data.disabled, disabledReason: data.reason || null },
  })
  return c.json({ orgId: data.orgId, disabled: b.disabled, disabledReason: b.disabledReason })
})

aiBillingRoutes.get('/admin/usage-summary', requireAdmin, async (c) => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const logs = await prisma.aiUsageLog.findMany({
    where: { createdAt: { gte: since } },
    select: { orgId: true, endpoint: true, model: true, costUsd: true, source: true },
  })
  const byOrg: Record<string, { count: number; cost: number }> = {}
  const byModel: Record<string, { count: number; cost: number }> = {}
  let totalCost = 0
  for (const l of logs) {
    const cost = Number(l.costUsd)
    totalCost += cost
    byOrg[l.orgId] = byOrg[l.orgId] || { count: 0, cost: 0 }
    byOrg[l.orgId].count += 1
    byOrg[l.orgId].cost += cost
    byModel[l.model] = byModel[l.model] || { count: 0, cost: 0 }
    byModel[l.model].count += 1
    byModel[l.model].cost += cost
  }
  return c.json({ since, totalCost, totalRequests: logs.length, byOrg, byModel })
})
