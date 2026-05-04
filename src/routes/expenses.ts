import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'

export const expensesRoutes = new Hono()

const expenseSchema = z.object({
  number: z.string().optional(),
  date: z.string().transform((s) => new Date(s)),
  category: z.string().min(1),
  description: z.string().optional().nullable(),
  amount: z.coerce.number().positive(),
  currency: z.string().length(3).default('SAR'),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'STC_PAY', 'MADA', 'CHECK', 'OTHER']),
  vendorName: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  taxRateId: z.string().optional().nullable(),
  taxAmount: z.coerce.number().min(0).default(0),
  receiptUrl: z.string().url().optional().nullable(),
  notes: z.string().optional().nullable(),
})

async function nextExpenseNumber(orgId: string): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `EXP-${year}-`
  const last = await prisma.expense.findFirst({
    where: { orgId, number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  })
  const lastNum = last ? Number(last.number.split('-').pop() || '0') : 0
  return `${prefix}${String(lastNum + 1).padStart(4, '0')}`
}

// GET /expenses
expensesRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const category = c.req.query('category')
  const from = c.req.query('from')
  const to = c.req.query('to')
  const page = Number(c.req.query('page') || '1')
  const limit = Math.min(Number(c.req.query('limit') || '50'), 200)

  const where: any = { orgId }
  if (category) where.category = category
  if (from || to) {
    where.date = {}
    if (from) where.date.gte = new Date(from)
    if (to) where.date.lte = new Date(to)
  }

  const [items, total, sumAgg] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy: { date: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { taxRate: { select: { name: true, rate: true } } },
    }),
    prisma.expense.count({ where }),
    prisma.expense.aggregate({ where, _sum: { total: true }, _avg: { total: true } }),
  ])

  c.header('X-Total-Count', String(total))
  return c.json({
    items,
    total,
    page,
    limit,
    summary: {
      sumTotal: sumAgg._sum.total ?? '0',
      avgTotal: sumAgg._avg.total ?? '0',
    },
  })
})

// GET /expenses/:id
expensesRoutes.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const e = await prisma.expense.findFirst({
    where: { id: c.req.param('id'), orgId },
    include: { taxRate: true },
  })
  if (!e) return c.json({ error: 'not found' }, 404)
  return c.json(e)
})

// POST /expenses
expensesRoutes.post('/', zValidator('json', expenseSchema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')
  const number = data.number || (await nextExpenseNumber(orgId))
  const total = data.amount + data.taxAmount

  try {
    const e = await prisma.expense.create({
      data: {
        orgId,
        number,
        date: data.date,
        category: data.category,
        description: data.description,
        amount: new Prisma.Decimal(data.amount),
        currency: data.currency,
        paymentMethod: data.paymentMethod,
        vendorName: data.vendorName,
        reference: data.reference,
        taxRateId: data.taxRateId || null,
        taxAmount: new Prisma.Decimal(data.taxAmount),
        total: new Prisma.Decimal(total),
        receiptUrl: data.receiptUrl,
        notes: data.notes,
      },
      include: { taxRate: true },
    })
    return c.json(e, 201)
  } catch (err: any) {
    if (err.code === 'P2002') return c.json({ error: 'number_already_exists' }, 409)
    throw err
  }
})

// PATCH /expenses/:id
expensesRoutes.patch('/:id', zValidator('json', expenseSchema.partial()), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.expense.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)

  const data = c.req.valid('json')
  const updates: any = { ...data }
  if (data.amount !== undefined || data.taxAmount !== undefined) {
    const amount = data.amount ?? Number(exists.amount)
    const taxAmount = data.taxAmount ?? Number(exists.taxAmount)
    updates.total = new Prisma.Decimal(amount + taxAmount)
    if (data.amount !== undefined) updates.amount = new Prisma.Decimal(amount)
    if (data.taxAmount !== undefined) updates.taxAmount = new Prisma.Decimal(taxAmount)
  }
  if (data.date) updates.date = new Date(data.date)

  const e = await prisma.expense.update({
    where: { id },
    data: updates,
    include: { taxRate: true },
  })
  return c.json(e)
})

// DELETE /expenses/:id
expensesRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.expense.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.expense.delete({ where: { id } })
  return c.body(null, 204)
})
