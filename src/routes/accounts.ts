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
accountsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const accounts = await prisma.account.findMany({
    where: { orgId, isActive: true },
    orderBy: { code: 'asc' },
  })
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
