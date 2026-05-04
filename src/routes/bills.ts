import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'

export const billsRoutes = new Hono()

const lineSchema = z.object({
  productId: z.string().optional().nullable(),
  description: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().min(0),
  taxRateId: z.string().optional().nullable(),
})

const billSchema = z.object({
  contactId: z.string(),
  billNumber: z.string().optional(),
  status: z.enum(['DRAFT', 'RECEIVED', 'PAID', 'PARTIAL', 'OVERDUE', 'CANCELLED']).default('DRAFT'),
  issueDate: z.string().transform((s) => new Date(s)),
  dueDate: z.string().transform((s) => new Date(s)),
  currency: z.string().length(3).default('SAR'),
  exchangeRate: z.coerce.number().positive().default(1),
  notes: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(1),
})

async function calcTotals(lines: z.infer<typeof lineSchema>[], orgId: string) {
  const taxRateMap = new Map<string, number>()
  const taxRateIds = lines.map((l) => l.taxRateId).filter((x): x is string => !!x)
  if (taxRateIds.length) {
    const rates = await prisma.taxRate.findMany({ where: { orgId, id: { in: taxRateIds } } })
    rates.forEach((r) => taxRateMap.set(r.id, Number(r.rate)))
  }
  let subtotal = 0, taxTotal = 0
  const computed = lines.map((l) => {
    const lineSubtotal = l.quantity * l.unitPrice
    const taxRate = l.taxRateId ? taxRateMap.get(l.taxRateId) || 0 : 0
    const lineTax = lineSubtotal * taxRate
    subtotal += lineSubtotal
    taxTotal += lineTax
    return {
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
    lines: computed,
  }
}

async function nextBillNumber(orgId: string): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `BILL-${year}-`
  const last = await prisma.bill.findFirst({
    where: { orgId, billNumber: { startsWith: prefix } },
    orderBy: { billNumber: 'desc' },
    select: { billNumber: true },
  })
  const lastNum = last ? Number(last.billNumber.split('-').pop() || '0') : 0
  return `${prefix}${String(lastNum + 1).padStart(4, '0')}`
}

billsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const status = c.req.query('status')
  const where: any = { orgId }
  if (status) where.status = status
  const items = await prisma.bill.findMany({
    where,
    include: { contact: { select: { id: true, displayName: true } }, _count: { select: { lines: true, payments: true } } },
    orderBy: { issueDate: 'desc' },
    take: 200,
  })
  return c.json({ items, total: items.length })
})

billsRoutes.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const b = await prisma.bill.findFirst({
    where: { id: c.req.param('id'), orgId },
    include: { contact: true, lines: { include: { product: true, taxRate: true } }, payments: true },
  })
  if (!b) return c.json({ error: 'not found' }, 404)
  return c.json(b)
})

billsRoutes.post('/', zValidator('json', billSchema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')
  const contact = await prisma.contact.findFirst({ where: { id: data.contactId, orgId } })
  if (!contact) return c.json({ error: 'invalid contact' }, 400)
  const totals = await calcTotals(data.lines, orgId)
  const number = data.billNumber || (await nextBillNumber(orgId))
  const bill = await prisma.bill.create({
    data: {
      orgId,
      contactId: data.contactId,
      billNumber: number,
      status: data.status,
      issueDate: data.issueDate,
      dueDate: data.dueDate,
      currency: data.currency,
      exchangeRate: new Prisma.Decimal(data.exchangeRate),
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
      notes: data.notes,
      lines: { create: totals.lines },
    },
    include: { lines: true, contact: true },
  })
  return c.json(bill, 201)
})

billsRoutes.patch('/:id', zValidator('json', billSchema.partial()), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.bill.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  const data = c.req.valid('json')
  const updates: any = { ...data }
  if (data.lines) {
    const totals = await calcTotals(data.lines, orgId)
    Object.assign(updates, { subtotal: totals.subtotal, taxTotal: totals.taxTotal, total: totals.total })
    delete updates.lines
    await prisma.billLine.deleteMany({ where: { billId: id } })
    updates.lines = { create: totals.lines }
  }
  const b = await prisma.bill.update({ where: { id }, data: updates, include: { lines: true, contact: true } })
  return c.json(b)
})

billsRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.bill.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.bill.delete({ where: { id } })
  return c.body(null, 204)
})
