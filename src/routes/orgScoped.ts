/**
 * Compact CRUD routes for org-scoped resources:
 *  - Branches · CostCenters · Projects · FixedAssets · Products
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'

// ── Branches ────────────────────────────────────────────────────────────────
export const branchesRoutes = new Hono()
const branchSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
})
branchesRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const items = await prisma.branch.findMany({ where: { orgId, isActive: true }, orderBy: { name: 'asc' } })
  return c.json({ items, total: items.length })
})
branchesRoutes.post('/', zValidator('json', branchSchema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')
  const b = await prisma.branch.create({ data: { orgId, ...data } })
  return c.json(b, 201)
})
branchesRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const exists = await prisma.branch.findFirst({ where: { id: c.req.param('id'), orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.branch.update({ where: { id: c.req.param('id') }, data: { isActive: false } })
  return c.body(null, 204)
})

// ── CostCenters ─────────────────────────────────────────────────────────────
export const costCentersRoutes = new Hono()
const ccSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
})
costCentersRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const items = await prisma.costCenter.findMany({ where: { orgId, isActive: true }, orderBy: { code: 'asc' } })
  return c.json({ items, total: items.length })
})
costCentersRoutes.post('/', zValidator('json', ccSchema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')
  try {
    const cc = await prisma.costCenter.create({ data: { orgId, ...data } })
    return c.json(cc, 201)
  } catch (e: any) {
    if (e.code === 'P2002') return c.json({ error: 'code_exists' }, 409)
    throw e
  }
})
costCentersRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const exists = await prisma.costCenter.findFirst({ where: { id: c.req.param('id'), orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.costCenter.update({ where: { id: c.req.param('id') }, data: { isActive: false } })
  return c.body(null, 204)
})

// ── Projects ────────────────────────────────────────────────────────────────
export const projectsRoutes = new Hono()
const projSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  startDate: z.string().optional().nullable(),
  endDate: z.string().optional().nullable(),
  status: z.string().default('ACTIVE'),
})
projectsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const items = await prisma.project.findMany({ where: { orgId }, orderBy: { code: 'asc' } })
  return c.json({ items, total: items.length })
})
projectsRoutes.post('/', zValidator('json', projSchema), async (c) => {
  const orgId = c.get('orgId')
  const d = c.req.valid('json')
  try {
    const p = await prisma.project.create({
      data: {
        orgId, code: d.code, name: d.name, status: d.status,
        startDate: d.startDate ? new Date(d.startDate) : null,
        endDate: d.endDate ? new Date(d.endDate) : null,
      },
    })
    return c.json(p, 201)
  } catch (e: any) {
    if (e.code === 'P2002') return c.json({ error: 'code_exists' }, 409)
    throw e
  }
})
projectsRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const exists = await prisma.project.findFirst({ where: { id: c.req.param('id'), orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.project.delete({ where: { id: c.req.param('id') } })
  return c.body(null, 204)
})

// ── FixedAssets ─────────────────────────────────────────────────────────────
export const fixedAssetsRoutes = new Hono()
const faSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  category: z.string().optional().nullable(),
  acquisitionDate: z.string(),
  acquisitionCost: z.coerce.number().min(0),
  salvageValue: z.coerce.number().min(0).default(0),
  usefulLifeYears: z.coerce.number().int().min(1).default(5),
  depreciationMethod: z.string().default('STRAIGHT_LINE'),
})
fixedAssetsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const items = await prisma.fixedAsset.findMany({ where: { orgId }, orderBy: { code: 'asc' } })
  const totalCost = items.reduce((s, a) => s + Number(a.acquisitionCost), 0)
  // Accumulated depreciation (straight-line · approximation)
  const now = new Date()
  let totalDepreciation = 0
  for (const a of items) {
    const months = Math.max(0, (now.getTime() - a.acquisitionDate.getTime()) / (30 * 86400000))
    const monthlyDep = (Number(a.acquisitionCost) - Number(a.salvageValue)) / (a.usefulLifeYears * 12)
    totalDepreciation += Math.min(monthlyDep * months, Number(a.acquisitionCost) - Number(a.salvageValue))
  }
  return c.json({ items, total: items.length, totalCost, netBookValue: totalCost - totalDepreciation, totalDepreciation })
})
fixedAssetsRoutes.post('/', zValidator('json', faSchema), async (c) => {
  const orgId = c.get('orgId')
  const d = c.req.valid('json')
  try {
    const a = await prisma.fixedAsset.create({
      data: {
        orgId, code: d.code, name: d.name, category: d.category,
        acquisitionDate: new Date(d.acquisitionDate),
        acquisitionCost: new Prisma.Decimal(d.acquisitionCost),
        salvageValue: new Prisma.Decimal(d.salvageValue),
        usefulLifeYears: d.usefulLifeYears,
        depreciationMethod: d.depreciationMethod,
      },
    })
    return c.json(a, 201)
  } catch (e: any) {
    if (e.code === 'P2002') return c.json({ error: 'code_exists' }, 409)
    throw e
  }
})
fixedAssetsRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const exists = await prisma.fixedAsset.findFirst({ where: { id: c.req.param('id'), orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.fixedAsset.delete({ where: { id: c.req.param('id') } })
  return c.body(null, 204)
})

// ── Products ────────────────────────────────────────────────────────────────
export const productsRoutes = new Hono()
const productSchema = z.object({
  sku: z.string().optional().nullable(),
  name: z.string().min(1),
  nameAr: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  type: z.enum(['SERVICE', 'GOOD', 'INVENTORY', 'SUBSCRIPTION', 'PACKAGE', 'BUNDLE', 'DIGITAL']).default('SERVICE'),
  category: z.string().optional().nullable(),
  billingCycle: z.enum(['ONE_TIME', 'MONTHLY', 'QUARTERLY', 'ANNUAL']).optional().nullable(),
  unitPrice: z.coerce.number().min(0).default(0),
  costPrice: z.coerce.number().min(0).default(0),
  stockQty: z.coerce.number().default(0),
  taxRateId: z.string().optional().nullable(),
  incomeAccountId: z.string().optional().nullable(),
  expenseAccountId: z.string().optional().nullable(),
})

/** Auto-derive category from SKU prefix (e.g. "FC-ADV-001" → "ADV") */
function categoryFromSku(sku?: string | null): string | null {
  if (!sku) return null
  const m = sku.match(/^[A-Z]+-([A-Z]+)-/)
  return m ? m[1] : null
}

productsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const type = c.req.query('type')
  const category = c.req.query('category')
  const where: any = { orgId, isActive: true }
  if (type) where.type = type
  if (category) where.category = category
  const items = await prisma.product.findMany({ where, orderBy: [{ category: 'asc' }, { sku: 'asc' }, { name: 'asc' }] })

  // Group counts by category
  const grouped = await prisma.product.groupBy({
    by: ['category'],
    where: { orgId, isActive: true },
    _count: true,
  })

  return c.json({
    items,
    total: items.length,
    categories: grouped.map(g => ({ category: g.category || 'UNCATEGORIZED', count: g._count })),
  })
})

productsRoutes.post('/', zValidator('json', productSchema), async (c) => {
  const orgId = c.get('orgId')
  const d = c.req.valid('json')
  try {
    const p = await prisma.product.create({
      data: {
        orgId,
        sku: d.sku,
        name: d.name,
        nameAr: d.nameAr,
        description: d.description,
        type: d.type as any,
        category: d.category || categoryFromSku(d.sku),
        billingCycle: d.billingCycle,
        unitPrice: new Prisma.Decimal(d.unitPrice),
        costPrice: new Prisma.Decimal(d.costPrice),
        stockQty: new Prisma.Decimal(d.stockQty),
        taxRateId: d.taxRateId,
        incomeAccountId: d.incomeAccountId,
        expenseAccountId: d.expenseAccountId,
      },
    })
    return c.json(p, 201)
  } catch (e: any) {
    if (e.code === 'P2002') return c.json({ error: 'sku_exists' }, 409)
    throw e
  }
})

productsRoutes.patch('/:id', zValidator('json', productSchema.partial()), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.product.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  const d = c.req.valid('json') as any
  const patch: any = { ...d }
  if (d.unitPrice !== undefined) patch.unitPrice = new Prisma.Decimal(d.unitPrice)
  if (d.costPrice !== undefined) patch.costPrice = new Prisma.Decimal(d.costPrice)
  if (d.stockQty !== undefined) patch.stockQty = new Prisma.Decimal(d.stockQty)
  // Re-derive category if sku changes and category not provided
  if (d.sku !== undefined && d.category === undefined) patch.category = categoryFromSku(d.sku)
  const p = await prisma.product.update({ where: { id }, data: patch })
  return c.json(p)
})

productsRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const exists = await prisma.product.findFirst({ where: { id: c.req.param('id'), orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.product.update({ where: { id: c.req.param('id') }, data: { isActive: false } })
  return c.body(null, 204)
})

// ── Bulk import ─────────────────────────────────────────────────────────────
const importRowSchema = z.object({
  sku: z.string().optional().nullable(),
  name: z.string().min(1),
  nameAr: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  type: z.string().optional(),
  category: z.string().optional().nullable(),
  billingCycle: z.string().optional().nullable(),
  unitPrice: z.coerce.number().default(0),
  costPrice: z.coerce.number().default(0),
})
const importSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(2000),
  skipExisting: z.boolean().default(true),
})

function normalizeProductType(t?: string): 'SERVICE' | 'GOOD' | 'INVENTORY' | 'SUBSCRIPTION' | 'PACKAGE' | 'BUNDLE' | 'DIGITAL' {
  const s = (t || '').toUpperCase().trim()
  if (['SERVICE', 'خدمة', 'خدمات'].includes(s)) return 'SERVICE'
  if (['GOOD', 'PRODUCT', 'منتج', 'سلعة'].includes(s)) return 'GOOD'
  if (['INVENTORY', 'مخزون'].includes(s)) return 'INVENTORY'
  if (['SUBSCRIPTION', 'SUB', 'اشتراك'].includes(s)) return 'SUBSCRIPTION'
  if (['PACKAGE', 'PKG', 'باقة'].includes(s)) return 'PACKAGE'
  if (['BUNDLE', 'حزمة'].includes(s)) return 'BUNDLE'
  if (['DIGITAL', 'رقمي'].includes(s)) return 'DIGITAL'
  // Infer from SKU suffix
  if (/-SRV/i.test(s)) return 'SERVICE'
  if (/-PKG/i.test(s)) return 'PACKAGE'
  if (/-SUB/i.test(s)) return 'SUBSCRIPTION'
  if (/-ADD|-REC/i.test(s)) return 'SERVICE'
  return 'SERVICE'
}

productsRoutes.post('/import', zValidator('json', importSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const { rows, skipExisting } = c.req.valid('json')

  const existing = await prisma.product.findMany({ where: { orgId }, select: { sku: true } })
  const existingSkus = new Set(existing.map(e => e.sku).filter(Boolean) as string[])

  let created = 0, skipped = 0
  const errors: Array<{ sku: string; reason: string }> = []
  for (const r of rows) {
    if (skipExisting && r.sku && existingSkus.has(r.sku)) {
      skipped++
      continue
    }
    try {
      // Type inference from sku
      const inferType = r.sku ? normalizeProductType(r.sku) : normalizeProductType(r.type)
      await prisma.product.create({
        data: {
          orgId,
          sku: r.sku || null,
          name: r.name,
          nameAr: r.nameAr || null,
          description: r.description || null,
          type: (r.type ? normalizeProductType(r.type) : inferType) as any,
          category: r.category || categoryFromSku(r.sku),
          billingCycle: r.billingCycle || null,
          unitPrice: new Prisma.Decimal(r.unitPrice),
          costPrice: new Prisma.Decimal(r.costPrice),
          stockQty: new Prisma.Decimal(0),
        },
      })
      created++
    } catch (e: any) {
      if (e.code === 'P2002') skipped++
      else errors.push({ sku: r.sku || r.name, reason: e.message })
    }
  }

  return c.json({
    ok: true, created, skipped, errors,
    message: `استورد ${created} منتج · تخطّى ${skipped} مكرر · ${errors.length} خطأ`,
  })
})

// ── One-click seed of FC catalog (60+ products) ─────────────────────────────
productsRoutes.post('/seed-fc-catalog', async (c) => {
  const orgId = c.get('orgId') as string
  const { FC_PRODUCTS } = await import('../lib/fc-products-catalog.js')
  const existing = await prisma.product.findMany({ where: { orgId }, select: { sku: true } })
  const existingSkus = new Set(existing.map(e => e.sku).filter(Boolean) as string[])

  let created = 0, skipped = 0
  for (const p of FC_PRODUCTS) {
    if (existingSkus.has(p.sku)) { skipped++; continue }
    try {
      await prisma.product.create({
        data: {
          orgId,
          sku: p.sku,
          name: p.name,
          nameAr: p.nameAr,
          type: p.type as any,
          category: p.category,
          billingCycle: p.billingCycle || null,
          unitPrice: new Prisma.Decimal(p.unitPrice),
          costPrice: new Prisma.Decimal(0),
          stockQty: new Prisma.Decimal(0),
        },
      })
      created++
    } catch { skipped++ }
  }
  return c.json({
    ok: true, created, skipped,
    message: `تم تثبيت كتالوج Falcon Core/ENSIDEX · ${created} منتج جديد · ${skipped} مكرر`,
  })
})

// ── List industry catalogs available for seeding ────────────────────────────
productsRoutes.get('/industry-catalogs', async (c) => {
  const { INDUSTRY_CATALOGS } = await import('../lib/industry-catalogs.js')
  return c.json({
    items: INDUSTRY_CATALOGS.map(cat => ({
      id: cat.id, name: cat.name, nameAr: cat.nameAr,
      description: cat.description, icon: cat.icon,
      productCount: cat.products.length,
    })),
  })
})

// ── Seed by industry id ─────────────────────────────────────────────────────
productsRoutes.post('/seed-industry/:industryId', async (c) => {
  const orgId = c.get('orgId') as string
  const industryId = c.req.param('industryId')
  const { getCatalogById } = await import('../lib/industry-catalogs.js')
  const catalog = getCatalogById(industryId)
  if (!catalog) return c.json({ error: 'unknown_industry', message: `لا يوجد كتالوج باسم "${industryId}"` }, 404)

  const existing = await prisma.product.findMany({ where: { orgId }, select: { sku: true } })
  const existingSkus = new Set(existing.map(e => e.sku).filter(Boolean) as string[])

  let created = 0, skipped = 0
  for (const p of catalog.products) {
    if (existingSkus.has(p.sku)) { skipped++; continue }
    try {
      await prisma.product.create({
        data: {
          orgId,
          sku: p.sku,
          name: p.name,
          nameAr: p.nameAr,
          type: p.type as any,
          category: p.category,
          unitPrice: new Prisma.Decimal(p.unitPrice),
          costPrice: new Prisma.Decimal(0),
          stockQty: new Prisma.Decimal(0),
          description: p.description || null,
        },
      })
      created++
    } catch { skipped++ }
  }
  return c.json({
    ok: true, created, skipped,
    message: `تم تثبيت كتالوج ${catalog.nameAr} · ${created} منتج جديد · ${skipped} مكرر`,
    catalog: { id: catalog.id, nameAr: catalog.nameAr, icon: catalog.icon },
  })
})

// ── Categories list (distinct values) ───────────────────────────────────────
productsRoutes.get('/categories', async (c) => {
  const orgId = c.get('orgId')
  const grouped = await prisma.product.groupBy({
    by: ['category'],
    where: { orgId, isActive: true },
    _count: { _all: true },
    _sum: { unitPrice: true },
  })
  return c.json({
    categories: grouped.map(g => ({
      category: g.category || 'UNCATEGORIZED',
      count: g._count._all,
      totalValue: Number(g._sum.unitPrice || 0),
    })).sort((a, b) => b.count - a.count),
  })
})
