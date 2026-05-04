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
  type: z.enum(['SERVICE', 'GOOD', 'INVENTORY']).default('SERVICE'),
  unitPrice: z.coerce.number().min(0).default(0),
  costPrice: z.coerce.number().min(0).default(0),
  stockQty: z.coerce.number().default(0),
  taxRateId: z.string().optional().nullable(),
})
productsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const type = c.req.query('type')
  const where: any = { orgId, isActive: true }
  if (type) where.type = type
  const items = await prisma.product.findMany({ where, orderBy: { name: 'asc' } })
  return c.json({ items, total: items.length })
})
productsRoutes.post('/', zValidator('json', productSchema), async (c) => {
  const orgId = c.get('orgId')
  const d = c.req.valid('json')
  try {
    const p = await prisma.product.create({
      data: {
        orgId, sku: d.sku, name: d.name, nameAr: d.nameAr, type: d.type,
        unitPrice: new Prisma.Decimal(d.unitPrice),
        costPrice: new Prisma.Decimal(d.costPrice),
        stockQty: new Prisma.Decimal(d.stockQty),
        taxRateId: d.taxRateId,
      },
    })
    return c.json(p, 201)
  } catch (e: any) {
    if (e.code === 'P2002') return c.json({ error: 'sku_exists' }, 409)
    throw e
  }
})
productsRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const exists = await prisma.product.findFirst({ where: { id: c.req.param('id'), orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.product.update({ where: { id: c.req.param('id') }, data: { isActive: false } })
  return c.body(null, 204)
})
