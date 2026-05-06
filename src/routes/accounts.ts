import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../db.js'
import { INDUSTRY_TEMPLATES, buildCoaForIndustry, BASE_COA, type AccountSeed } from '../lib/coa-templates.js'

export const accountsRoutes = new Hono()

const accountSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(120),
  nameAr: z.string().optional().nullable(),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
  subtype: z.string().optional().nullable(),
  parentId: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
})

// GET /accounts — full chart of accounts (no pagination · usually < 200 rows)
// Auto-seeds BASE_COA on first read if the org has no accounts (so new orgs aren't empty).
accountsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  let accounts = await prisma.account.findMany({
    where: { orgId, isActive: true },
    orderBy: { code: 'asc' },
  })

  if (accounts.length === 0) {
    // Seed BASE_COA (no industry add-on) so org has a working chart immediately
    const seeds: AccountSeed[] = BASE_COA
    const created: Record<string, string> = {}
    for (const seed of seeds) {
      try {
        const a = await prisma.account.create({
          data: {
            orgId,
            code: seed.code,
            name: seed.name,
            nameAr: seed.nameAr,
            type: seed.type as any,
            subtype: seed.subtype || null,
            description: seed.description || null,
          },
        })
        created[seed.code] = a.id
      } catch { /* ignore unique-violation race */ }
    }
    // Wire up parents (best-effort)
    for (const seed of seeds) {
      if (!seed.parentCode) continue
      const childId = created[seed.code]
      const parentId = created[seed.parentCode]
      if (childId && parentId) {
        try { await prisma.account.update({ where: { id: childId }, data: { parentId } }) } catch {}
      }
    }
    accounts = await prisma.account.findMany({
      where: { orgId, isActive: true },
      orderBy: { code: 'asc' },
    })
  }

  return c.json({ items: accounts, total: accounts.length })
})

accountsRoutes.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const a = await prisma.account.findFirst({ where: { id: c.req.param('id'), orgId } })
  if (!a) return c.json({ error: 'not found' }, 404)
  return c.json(a)
})

accountsRoutes.post('/', zValidator('json', accountSchema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')
  try {
    const a = await prisma.account.create({ data: { ...data, orgId } })
    return c.json(a, 201)
  } catch (e: any) {
    if (e.code === 'P2002') return c.json({ error: 'code_already_exists' }, 409)
    throw e
  }
})

accountsRoutes.patch('/:id', zValidator('json', accountSchema.partial()), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.account.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  const data = c.req.valid('json')
  const a = await prisma.account.update({ where: { id }, data })
  return c.json(a)
})

accountsRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.account.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  // Block delete if has journal entries · soft delete only
  const hasJournals = await prisma.journalLine.findFirst({ where: { accountId: id } })
  if (hasJournals) {
    return c.json({ error: 'has_journals', message: 'الحساب مستخدم في قيود · يمكن إخفاؤه فقط (تعطيل)' }, 400)
  }
  await prisma.account.update({ where: { id }, data: { isActive: false } })
  return c.body(null, 204)
})

// ─── Industry Templates ──────────────────────────────────────────────────────

/** GET /accounts/templates · list available industry templates */
accountsRoutes.get('/templates/list', async (c) => {
  return c.json({
    templates: INDUSTRY_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      nameAr: t.nameAr,
      description: t.description,
      icon: t.icon,
      accountCount: t.extras.length,
    })),
    baseCount: BASE_COA.length,
  })
})

/** POST /accounts/templates/apply · install BASE + industry-specific accounts */
const applyTplSchema = z.object({
  industryId: z.string().nullable().optional(),
  /** If true · skip codes that already exist · default true */
  skipExisting: z.boolean().default(true),
})
accountsRoutes.post('/templates/apply', zValidator('json', applyTplSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const { industryId, skipExisting } = c.req.valid('json')

  const existing = await prisma.account.findMany({ where: { orgId }, select: { code: true } })
  const existingCodes = new Set(existing.map((e) => e.code))

  const seeds: AccountSeed[] = buildCoaForIndustry(industryId || null)

  // First pass · create all accounts without parent
  const created: Record<string, string> = {} // code → id
  const skipped: string[] = []
  for (const seed of seeds) {
    if (skipExisting && existingCodes.has(seed.code)) {
      skipped.push(seed.code)
      continue
    }
    try {
      const a = await prisma.account.create({
        data: {
          orgId,
          code: seed.code,
          name: seed.name,
          nameAr: seed.nameAr,
          type: seed.type as any,
          subtype: seed.subtype || null,
          description: seed.description || null,
        },
      })
      created[seed.code] = a.id
    } catch (e: any) {
      if (e.code !== 'P2002') throw e
      skipped.push(seed.code)
    }
  }

  // Second pass · link parents
  let linked = 0
  for (const seed of seeds) {
    if (!seed.parentCode) continue
    const childId = created[seed.code]
    if (!childId) continue
    let parentId = created[seed.parentCode]
    if (!parentId) {
      // Parent might have already existed (skipped) · find by code
      const p = await prisma.account.findFirst({
        where: { orgId, code: seed.parentCode },
        select: { id: true },
      })
      if (p) parentId = p.id
    }
    if (parentId) {
      await prisma.account.update({ where: { id: childId }, data: { parentId } })
      linked++
    }
  }

  return c.json({
    ok: true,
    industryId: industryId || null,
    created: Object.keys(created).length,
    skipped: skipped.length,
    linked,
    message: `تم إنشاء ${Object.keys(created).length} حساب · ${linked} رابط أبوي · ${skipped.length} مكرر`,
  })
})

// ─── Bulk Import ─────────────────────────────────────────────────────────────
// POST /accounts/import · accepts an array of rows · auto-detects type from
// code prefix if missing · links parents by parentCode · returns summary.
const importRowSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(120),
  nameAr: z.string().optional().nullable(),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']).optional(),
  parentCode: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
})
const importSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(2000),
  skipExisting: z.boolean().default(true),
})

function inferTypeFromCode(code: string): 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE' | null {
  const first = code.charAt(0)
  if (first === '1') return 'ASSET'
  if (first === '2') return 'LIABILITY'
  if (first === '3') return 'EQUITY'
  if (first === '4') return 'REVENUE'
  if (first === '5' || first === '6' || first === '7') return 'EXPENSE'
  return null
}

accountsRoutes.post('/import', zValidator('json', importSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const { rows, skipExisting } = c.req.valid('json')

  const existing = await prisma.account.findMany({ where: { orgId }, select: { id: true, code: true } })
  const existingByCode = new Map(existing.map(e => [e.code, e.id]))

  // First pass · create
  const created: Record<string, string> = {}
  const skipped: string[] = []
  const errors: Array<{ code: string; reason: string }> = []
  for (const r of rows) {
    if (skipExisting && existingByCode.has(r.code)) {
      skipped.push(r.code)
      continue
    }
    const type = r.type || inferTypeFromCode(r.code)
    if (!type) {
      errors.push({ code: r.code, reason: 'cannot_infer_type' })
      continue
    }
    try {
      const a = await prisma.account.create({
        data: {
          orgId,
          code: r.code,
          name: r.name,
          nameAr: r.nameAr || null,
          type,
          description: r.description || null,
        },
      })
      created[r.code] = a.id
    } catch (e: any) {
      if (e.code === 'P2002') skipped.push(r.code)
      else errors.push({ code: r.code, reason: e.message })
    }
  }

  // Second pass · link parents
  let linked = 0
  for (const r of rows) {
    if (!r.parentCode) continue
    const childId = created[r.code] || existingByCode.get(r.code)
    if (!childId) continue
    const parentId = created[r.parentCode] || existingByCode.get(r.parentCode)
    if (parentId) {
      try {
        await prisma.account.update({ where: { id: childId }, data: { parentId } })
        linked++
      } catch {}
    }
  }

  return c.json({
    ok: true,
    created: Object.keys(created).length,
    skipped: skipped.length,
    linked,
    errors,
    message: `استورد ${Object.keys(created).length} · ${linked} رابط أبوي · تخطّى ${skipped.length} مكرر · ${errors.length} خطأ`,
  })
})
