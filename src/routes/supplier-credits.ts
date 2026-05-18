import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'

export const supplierCreditsRoutes = new Hono()

const lineSchema = z.object({
  originalBillLineId: z.string().optional().nullable(),
  productId: z.string().optional().nullable(),
  description: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().min(0),
  taxRateId: z.string().optional().nullable(),
})

const supplierCreditSchema = z.object({
  contactId: z.string(),
  originalBillId: z.string().optional().nullable(),
  creditNumber: z.string().optional(),
  status: z.enum(['DRAFT', 'ISSUED', 'APPLIED', 'CANCELLED']).default('DRAFT'),
  reason: z.enum(['RETURN', 'DISCOUNT', 'PRICING_ERROR', 'QUALITY_ISSUE', 'OTHER']).default('RETURN'),
  issueDate: z.string().transform((s) => new Date(s)),
  currency: z.string().length(3).default('SAR'),
  exchangeRate: z.coerce.number().positive().default(1),
  notes: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(1),
})

async function nextSupplierCreditNumber(orgId: string): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `SC-${year}-`
  const last = await prisma.supplierCredit.findFirst({
    where: { orgId, creditNumber: { startsWith: prefix } },
    orderBy: { creditNumber: 'desc' },
    select: { creditNumber: true },
  })
  const lastNum = last ? Number(last.creditNumber.split('-').pop() || '0') : 0
  return `${prefix}${String(lastNum + 1).padStart(4, '0')}`
}

async function calcTotals(lines: z.infer<typeof lineSchema>[], orgId: string) {
  const taxRateMap = new Map<string, number>()
  const taxRateIds = [...new Set(lines.map((l) => l.taxRateId).filter((x): x is string => !!x))]
  if (taxRateIds.length) {
    const rates = await prisma.taxRate.findMany({ where: { orgId, id: { in: taxRateIds } } })
    rates.forEach((r) => taxRateMap.set(r.id, Number(r.rate)))
  }

  let subtotal = 0
  let taxTotal = 0
  const computedLines = lines.map((l) => {
    const lineSubtotal = l.quantity * l.unitPrice
    const taxRate = l.taxRateId ? taxRateMap.get(l.taxRateId) || 0 : 0
    const lineTax = lineSubtotal * taxRate
    subtotal += lineSubtotal
    taxTotal += lineTax
    return {
      originalBillLineId: l.originalBillLineId || null,
      productId: l.productId || null,
      description: l.description,
      quantity: new Prisma.Decimal(l.quantity),
      unitPrice: new Prisma.Decimal(l.unitPrice),
      taxRateId: l.taxRateId || null,
      subtotal: new Prisma.Decimal(lineSubtotal + lineTax),
    }
  })

  return {
    subtotal: new Prisma.Decimal(subtotal),
    taxTotal: new Prisma.Decimal(taxTotal),
    total: new Prisma.Decimal(subtotal + taxTotal),
    lines: computedLines,
  }
}

supplierCreditsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const contactId = c.req.query('contactId')
  const originalBillId = c.req.query('originalBillId')
  const status = c.req.query('status')
  const q = (c.req.query('q') || '').trim()
  const limit = Math.min(Number(c.req.query('limit') || '50'), 200)

  const where: any = { orgId }
  if (contactId) where.contactId = contactId
  if (originalBillId) where.originalBillId = originalBillId
  if (status) where.status = status
  if (q) {
    where.OR = [
      { creditNumber: { contains: q, mode: 'insensitive' } },
      { contact: { displayName: { contains: q, mode: 'insensitive' } } },
      { originalBill: { billNumber: { contains: q, mode: 'insensitive' } } },
    ]
  }

  const items = await prisma.supplierCredit.findMany({
    where,
    include: {
      contact: { select: { id: true, displayName: true, email: true } },
      originalBill: { select: { id: true, billNumber: true, issueDate: true, total: true, currency: true } },
      _count: { select: { lines: true } },
    },
    orderBy: { issueDate: 'desc' },
    take: limit,
  })
  return c.json({ items, total: items.length })
})

supplierCreditsRoutes.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const item = await prisma.supplierCredit.findFirst({
    where: { id: c.req.param('id'), orgId },
    include: {
      contact: true,
      originalBill: { include: { lines: { include: { product: true, taxRate: true } } } },
      lines: { include: { product: true, taxRate: true, originalBillLine: true } },
    },
  })
  if (!item) return c.json({ error: 'not_found' }, 404)
  return c.json(item)
})

supplierCreditsRoutes.post('/', zValidator('json', supplierCreditSchema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')

  const contact = await prisma.contact.findFirst({ where: { id: data.contactId, orgId } })
  if (!contact) return c.json({ error: 'invalid_contact' }, 400)

  if (data.originalBillId) {
    const bill = await prisma.bill.findFirst({
      where: { id: data.originalBillId, orgId },
      include: { lines: { select: { id: true } } },
    })
    if (!bill) return c.json({ error: 'invalid_bill' }, 400)
    if (bill.contactId !== data.contactId) return c.json({ error: 'bill_contact_mismatch' }, 400)
    const billLineIds = new Set(bill.lines.map((l) => l.id))
    const invalidLine = data.lines.find((l) => l.originalBillLineId && !billLineIds.has(l.originalBillLineId))
    if (invalidLine) return c.json({ error: 'bill_line_mismatch' }, 400)
  }

  const totals = await calcTotals(data.lines, orgId)
  const number = data.creditNumber || (await nextSupplierCreditNumber(orgId))

  const item = await prisma.supplierCredit.create({
    data: {
      orgId,
      contactId: data.contactId,
      originalBillId: data.originalBillId || null,
      creditNumber: number,
      status: data.status as any,
      reason: data.reason as any,
      issueDate: data.issueDate,
      currency: data.currency,
      exchangeRate: new Prisma.Decimal(data.exchangeRate),
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
      notes: data.notes,
      lines: { create: totals.lines },
    },
    include: {
      contact: { select: { id: true, displayName: true, email: true } },
      originalBill: { select: { id: true, billNumber: true, issueDate: true, total: true, currency: true } },
      lines: true,
    },
  })

  return c.json(item, 201)
})

supplierCreditsRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.supplierCredit.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not_found' }, 404)
  await prisma.supplierCredit.delete({ where: { id } })
  return c.body(null, 204)
})
