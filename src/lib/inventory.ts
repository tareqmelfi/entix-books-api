/**
 * Inventory math · WAC / FIFO / LIFO valuation (UX-59)
 *
 * Methods:
 *   - WAC (Weighted Average Cost): updated on every inbound movement
 *       new_avg = ((old_qty * old_avg) + (new_qty * new_cost)) / (old_qty + new_qty)
 *   - FIFO (First In, First Out): outbound consumed in chronological order of inbound
 *   - LIFO (Last In, First Out): outbound consumed in reverse-chronological order
 *
 * Ledger model: append-only StockMovement rows · current state in StockLevel.
 *
 * COGS calculation reads the StockMovement ledger and re-walks the inbound
 * stack with the configured method · returns total cost of the outbound qty.
 */

import { Prisma, type PrismaClient } from '@prisma/client'

export type ValuationMethod = 'WAC' | 'FIFO' | 'LIFO'

export interface InboundMovement {
  occurredAt: Date
  quantity: number
  unitCost: number
  remaining?: number // for FIFO/LIFO walking
}

/**
 * Update WAC on inbound movement · returns the new weighted-average cost.
 */
export function newWac(
  currentQty: number,
  currentAvg: number,
  inboundQty: number,
  inboundCost: number,
): number {
  const totalQty = currentQty + inboundQty
  if (totalQty <= 0) return inboundCost
  if (currentQty <= 0) return inboundCost
  return ((currentQty * currentAvg) + (inboundQty * inboundCost)) / totalQty
}

/**
 * Walk inbound stack to compute COGS for a given outbound quantity using FIFO or LIFO.
 *
 * `inbound` should be passed in chronological order (oldest first) for FIFO,
 * the function reverses for LIFO internally.
 *
 * Returns:
 *   { totalCost, breakdown: [{ qty, unitCost, fromMovementAt }] }
 *   When `consume === true`, mutates the .remaining field on the inbound array.
 */
export function consumeInbound(
  inbound: InboundMovement[],
  outboundQty: number,
  method: 'FIFO' | 'LIFO',
  consume = false,
): { totalCost: number; breakdown: Array<{ qty: number; unitCost: number; from: Date }>; shortfall: number } {
  const stack = method === 'LIFO' ? [...inbound].reverse() : [...inbound]
  // Initialize remaining if absent
  for (const m of stack) if (m.remaining === undefined) m.remaining = m.quantity

  let toConsume = outboundQty
  let totalCost = 0
  const breakdown: Array<{ qty: number; unitCost: number; from: Date }> = []

  for (const layer of stack) {
    if (toConsume <= 0) break
    const avail = layer.remaining ?? layer.quantity
    if (avail <= 0) continue
    const take = Math.min(avail, toConsume)
    totalCost += take * layer.unitCost
    breakdown.push({ qty: take, unitCost: layer.unitCost, from: layer.occurredAt })
    if (consume) layer.remaining = avail - take
    toConsume -= take
  }
  return { totalCost, breakdown, shortfall: toConsume }
}

/**
 * Apply an inbound movement (RECEIPT / RETURN_IN / OPENING / TRANSFER_IN).
 * Updates StockLevel atomically.
 */
export async function applyInbound(
  prisma: PrismaClient,
  args: {
    orgId: string
    productId: string
    warehouseId: string
    quantity: number
    unitCost: number
    type: 'RECEIPT' | 'RETURN_IN' | 'OPENING' | 'TRANSFER_IN'
    refType?: string
    refId?: string
    notes?: string
    createdById?: string
  },
) {
  const { orgId, productId, warehouseId, quantity, unitCost, type, refType, refId, notes, createdById } = args
  return prisma.$transaction(async (tx) => {
    const existing = await tx.stockLevel.findUnique({
      where: { productId_warehouseId: { productId, warehouseId } },
    })
    const oldQty = existing ? Number(existing.quantity) : 0
    const oldAvg = existing ? Number(existing.averageCost) : 0
    const newAvg = newWac(oldQty, oldAvg, quantity, unitCost)
    const newQty = oldQty + quantity

    if (existing) {
      await tx.stockLevel.update({
        where: { id: existing.id },
        data: {
          quantity: new Prisma.Decimal(newQty),
          averageCost: new Prisma.Decimal(newAvg),
          lastCost: new Prisma.Decimal(unitCost),
        },
      })
    } else {
      await tx.stockLevel.create({
        data: {
          orgId,
          productId,
          warehouseId,
          quantity: new Prisma.Decimal(newQty),
          averageCost: new Prisma.Decimal(newAvg),
          lastCost: new Prisma.Decimal(unitCost),
        },
      })
    }

    return tx.stockMovement.create({
      data: {
        orgId,
        productId,
        warehouseId,
        type,
        quantity: new Prisma.Decimal(quantity),
        unitCost: new Prisma.Decimal(unitCost),
        refType,
        refId,
        notes,
        createdById,
      },
    })
  })
}

/**
 * Apply an outbound movement (ISSUE / RETURN_OUT / TRANSFER_OUT / ADJUSTMENT).
 * Computes COGS using the configured valuation method and decrements StockLevel.
 *
 * Returns the COGS for the outbound qty.
 */
export async function applyOutbound(
  prisma: PrismaClient,
  args: {
    orgId: string
    productId: string
    warehouseId: string
    quantity: number // positive · the function negates it for the ledger
    method: ValuationMethod
    type: 'ISSUE' | 'RETURN_OUT' | 'TRANSFER_OUT' | 'ADJUSTMENT'
    refType?: string
    refId?: string
    notes?: string
    createdById?: string
  },
): Promise<{ cogs: number; shortfall: number }> {
  const { orgId, productId, warehouseId, quantity, method, type, refType, refId, notes, createdById } = args
  return prisma.$transaction(async (tx) => {
    const level = await tx.stockLevel.findUnique({
      where: { productId_warehouseId: { productId, warehouseId } },
    })
    if (!level) {
      throw new Error('no_stock_level · product not stocked in this warehouse')
    }
    const onHand = Number(level.quantity)
    if (onHand < quantity) {
      // Allow for ADJUSTMENT · otherwise reject
      if (type !== 'ADJUSTMENT') {
        throw new Error(`insufficient_stock · onHand=${onHand} requested=${quantity}`)
      }
    }

    let cogs = 0
    let shortfall = 0

    if (method === 'WAC') {
      cogs = quantity * Number(level.averageCost)
    } else {
      // FIFO / LIFO · walk the inbound stack
      const inboundLedger = await tx.stockMovement.findMany({
        where: {
          orgId,
          productId,
          warehouseId,
          quantity: { gt: 0 }, // inbound only
        },
        orderBy: { occurredAt: 'asc' },
      })
      // Subtract prior outbound consumption from layers · simple approach:
      // sum inbound qty - sum outbound qty per layer (chronological)
      const outboundLedger = await tx.stockMovement.findMany({
        where: { orgId, productId, warehouseId, quantity: { lt: 0 } },
        orderBy: { occurredAt: 'asc' },
      })
      let outboundConsumed = outboundLedger.reduce((s, m) => s + Math.abs(Number(m.quantity)), 0)
      const layers: InboundMovement[] = []
      for (const m of inboundLedger) {
        let qty = Number(m.quantity)
        // For FIFO consume from this layer first
        if (outboundConsumed > 0) {
          const take = Math.min(qty, outboundConsumed)
          qty -= take
          outboundConsumed -= take
        }
        if (qty > 0) layers.push({ occurredAt: m.occurredAt, quantity: qty, unitCost: Number(m.unitCost), remaining: qty })
      }
      const r = consumeInbound(layers, quantity, method)
      cogs = r.totalCost
      shortfall = r.shortfall
    }

    await tx.stockLevel.update({
      where: { id: level.id },
      data: { quantity: new Prisma.Decimal(onHand - quantity) },
    })

    await tx.stockMovement.create({
      data: {
        orgId,
        productId,
        warehouseId,
        type,
        quantity: new Prisma.Decimal(-quantity),
        unitCost: new Prisma.Decimal(quantity > 0 ? cogs / quantity : 0),
        refType,
        refId,
        notes,
        createdById,
      },
    })

    return { cogs, shortfall }
  })
}
