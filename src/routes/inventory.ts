/**
 * Inventory routes · UX-59 · multi-warehouse + stock movements
 *
 * Warehouses
 *   GET    /api/inventory/warehouses
 *   POST   /api/inventory/warehouses                  { code, name, isPrimary? }
 *   PATCH  /api/inventory/warehouses/:id
 *   DELETE /api/inventory/warehouses/:id              (soft via isActive=false)
 *
 * Stock
 *   GET    /api/inventory/stock                       ?productId=&warehouseId=
 *   GET    /api/inventory/movements                   ?productId=&warehouseId=&from=&to=
 *   POST   /api/inventory/receipts                    { productId, warehouseId, quantity, unitCost, refType?, refId? }
 *   POST   /api/inventory/issues                      { productId, warehouseId, quantity, method, refType?, refId? }
 *   POST   /api/inventory/transfers                   { productId, fromWarehouseId, toWarehouseId, quantity, method }
 *   POST   /api/inventory/adjustments                 { productId, warehouseId, newQuantity, reason }
 *   POST   /api/inventory/opening-balance             { productId, warehouseId, quantity, unitCost }
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../db.js'
import { applyInbound, applyOutbound } from '../lib/inventory.js'

export const inventoryRoutes = new Hono()

// ─── Warehouses ──────────────────────────────────────────────────────────────

inventoryRoutes.get('/warehouses', async (c) => {
  const orgId = c.get('orgId') as string
  const items = await prisma.warehouse.findMany({
    where: { orgId, isActive: true },
    orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
  })
  return c.json({ items })
})

const warehouseSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(120),
  address: z.string().optional().nullable(),
  isPrimary: z.boolean().optional(),
})

inventoryRoutes.post('/warehouses', zValidator('json', warehouseSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const data = c.req.valid('json')
  // Enforce single primary
  if (data.isPrimary) {
    await prisma.warehouse.updateMany({ where: { orgId, isPrimary: true }, data: { isPrimary: false } })
  }
  const w = await prisma.warehouse.create({ data: { ...data, orgId } })
  return c.json(w, 201)
})

inventoryRoutes.patch('/warehouses/:id', zValidator('json', warehouseSchema.partial()), async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const exists = await prisma.warehouse.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not_found' }, 404)
  const data = c.req.valid('json')
  if (data.isPrimary) {
    await prisma.warehouse.updateMany({ where: { orgId, isPrimary: true, id: { not: id } }, data: { isPrimary: false } })
  }
  const w = await prisma.warehouse.update({ where: { id }, data })
  return c.json(w)
})

inventoryRoutes.delete('/warehouses/:id', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const exists = await prisma.warehouse.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not_found' }, 404)
  // Block delete if any non-zero stock
  const hasStock = await prisma.stockLevel.findFirst({ where: { warehouseId: id, quantity: { gt: 0 } } })
  if (hasStock) return c.json({ error: 'has_stock', message: 'لا يمكن حذف مستودع به مخزون · انقل المخزون أولاً' }, 400)
  await prisma.warehouse.update({ where: { id }, data: { isActive: false } })
  return c.body(null, 204)
})

// ─── Stock levels & movements ────────────────────────────────────────────────

inventoryRoutes.get('/stock', async (c) => {
  const orgId = c.get('orgId') as string
  const productId = c.req.query('productId')
  const warehouseId = c.req.query('warehouseId')
  const where: any = { orgId }
  if (productId) where.productId = productId
  if (warehouseId) where.warehouseId = warehouseId
  const items = await prisma.stockLevel.findMany({
    where,
    include: { warehouse: { select: { id: true, code: true, name: true } } },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })
  return c.json({ items })
})

inventoryRoutes.get('/movements', async (c) => {
  const orgId = c.get('orgId') as string
  const productId = c.req.query('productId')
  const warehouseId = c.req.query('warehouseId')
  const from = c.req.query('from')
  const to = c.req.query('to')
  const where: any = { orgId }
  if (productId) where.productId = productId
  if (warehouseId) where.warehouseId = warehouseId
  if (from || to) {
    where.occurredAt = {}
    if (from) where.occurredAt.gte = new Date(from)
    if (to) where.occurredAt.lte = new Date(to)
  }
  const items = await prisma.stockMovement.findMany({
    where,
    orderBy: { occurredAt: 'desc' },
    take: 500,
  })
  return c.json({ items })
})

const inboundSchema = z.object({
  productId: z.string(),
  warehouseId: z.string(),
  quantity: z.coerce.number().positive(),
  unitCost: z.coerce.number().min(0),
  refType: z.string().optional(),
  refId: z.string().optional(),
  notes: z.string().optional(),
})

inventoryRoutes.post('/receipts', zValidator('json', inboundSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const data = c.req.valid('json')
  const m = await applyInbound(prisma, { ...data, orgId, type: 'RECEIPT' })
  return c.json(m, 201)
})

inventoryRoutes.post('/opening-balance', zValidator('json', inboundSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const data = c.req.valid('json')
  const m = await applyInbound(prisma, { ...data, orgId, type: 'OPENING' })
  return c.json(m, 201)
})

const outboundSchema = z.object({
  productId: z.string(),
  warehouseId: z.string(),
  quantity: z.coerce.number().positive(),
  method: z.enum(['WAC', 'FIFO', 'LIFO']).default('WAC'),
  refType: z.string().optional(),
  refId: z.string().optional(),
  notes: z.string().optional(),
})

inventoryRoutes.post('/issues', zValidator('json', outboundSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const data = c.req.valid('json')
  try {
    const r = await applyOutbound(prisma, { ...data, orgId, type: 'ISSUE' })
    return c.json(r, 201)
  } catch (e: any) {
    return c.json({ error: e?.message || 'failed' }, 400)
  }
})

const transferSchema = z.object({
  productId: z.string(),
  fromWarehouseId: z.string(),
  toWarehouseId: z.string(),
  quantity: z.coerce.number().positive(),
  method: z.enum(['WAC', 'FIFO', 'LIFO']).default('WAC'),
  notes: z.string().optional(),
})

inventoryRoutes.post('/transfers', zValidator('json', transferSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const { productId, fromWarehouseId, toWarehouseId, quantity, method, notes } = c.req.valid('json')
  if (fromWarehouseId === toWarehouseId) return c.json({ error: 'same_warehouse' }, 400)
  try {
    // Outbound from source · captures COGS
    const out = await applyOutbound(prisma, {
      orgId, productId, warehouseId: fromWarehouseId, quantity, method, type: 'TRANSFER_OUT', notes,
    })
    // Inbound to destination at the same unit cost
    const unitCost = quantity > 0 ? out.cogs / quantity : 0
    await applyInbound(prisma, {
      orgId, productId, warehouseId: toWarehouseId, quantity, unitCost, type: 'TRANSFER_IN', notes,
    })
    return c.json({ ok: true, cogs: out.cogs, unitCost }, 201)
  } catch (e: any) {
    return c.json({ error: e?.message || 'failed' }, 400)
  }
})

const adjustmentSchema = z.object({
  productId: z.string(),
  warehouseId: z.string(),
  newQuantity: z.coerce.number().min(0),
  reason: z.string().optional(),
})

inventoryRoutes.post('/adjustments', zValidator('json', adjustmentSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const { productId, warehouseId, newQuantity, reason } = c.req.valid('json')
  const level = await prisma.stockLevel.findUnique({
    where: { productId_warehouseId: { productId, warehouseId } },
  })
  const oldQty = level ? Number(level.quantity) : 0
  const delta = newQuantity - oldQty
  if (delta === 0) return c.json({ ok: true, message: 'no change' })
  try {
    if (delta > 0) {
      const m = await applyInbound(prisma, {
        orgId, productId, warehouseId, quantity: delta, unitCost: level ? Number(level.averageCost) : 0,
        type: 'OPENING', refType: 'ADJUSTMENT', notes: reason,
      })
      return c.json({ ok: true, movement: m })
    } else {
      const r = await applyOutbound(prisma, {
        orgId, productId, warehouseId, quantity: Math.abs(delta), method: 'WAC', type: 'ADJUSTMENT', notes: reason,
      })
      return c.json({ ok: true, ...r })
    }
  } catch (e: any) {
    return c.json({ error: e?.message || 'failed' }, 400)
  }
})
