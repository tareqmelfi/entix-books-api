import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../db.js'
import { Prisma } from '@prisma/client'

export const invoicesRoutes = new Hono()

const lineSchema = z.object({
  productId: z.string().optional().nullable(),
  description: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().min(0),
  discount: z.coerce.number().min(0).default(0),
  taxRateId: z.string().optional().nullable(),
})

const invoiceSchema = z.object({
  contactId: z.string(),
  invoiceNumber: z.string().optional(), // auto-generated if missing
  status: z.enum(['DRAFT', 'SENT', 'VIEWED', 'PAID', 'PARTIAL', 'OVERDUE', 'CANCELLED']).default('DRAFT'),
  issueDate: z.string().transform((s) => new Date(s)),
  dueDate: z.string().transform((s) => new Date(s)),
  currency: z.string().length(3).default('SAR'),
  exchangeRate: z.coerce.number().positive().default(1),
  notes: z.string().optional().nullable(),
  termsConditions: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(1),
})

async function calcTotals(lines: z.infer<typeof lineSchema>[], orgId: string) {
  const taxRateMap = new Map<string, number>()
  const taxRateIds = lines.map((l) => l.taxRateId).filter((x): x is string => !!x)
  if (taxRateIds.length) {
    const rates = await prisma.taxRate.findMany({ where: { orgId, id: { in: taxRateIds } } })
    rates.forEach((r) => taxRateMap.set(r.id, Number(r.rate)))
  }

  let subtotal = 0
  let taxTotal = 0
  let discountTotal = 0
  const computedLines = lines.map((l) => {
    const lineSubtotal = l.quantity * l.unitPrice - (l.discount || 0)
    const taxRate = l.taxRateId ? taxRateMap.get(l.taxRateId) || 0 : 0
    const lineTax = lineSubtotal * taxRate
    subtotal += lineSubtotal
    taxTotal += lineTax
    discountTotal += l.discount || 0
    return {
      productId: l.productId || null,
      description: l.description,
      quantity: new Prisma.Decimal(l.quantity),
      unitPrice: new Prisma.Decimal(l.unitPrice),
      discount: new Prisma.Decimal(l.discount || 0),
      taxRateId: l.taxRateId || null,
      subtotal: new Prisma.Decimal(lineSubtotal + lineTax),
    }
  })

  return {
    subtotal: new Prisma.Decimal(subtotal),
    taxTotal: new Prisma.Decimal(taxTotal),
    discountTotal: new Prisma.Decimal(discountTotal),
    total: new Prisma.Decimal(subtotal + taxTotal),
    lines: computedLines,
  }
}

async function nextInvoiceNumber(orgId: string): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `INV-${year}-`
  const last = await prisma.invoice.findFirst({
    where: { orgId, invoiceNumber: { startsWith: prefix } },
    orderBy: { invoiceNumber: 'desc' },
    select: { invoiceNumber: true },
  })
  const lastNum = last ? Number(last.invoiceNumber.split('-').pop() || '0') : 0
  return `${prefix}${String(lastNum + 1).padStart(5, '0')}`
}

// GET /invoices
invoicesRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const status = c.req.query('status')
  const contactId = c.req.query('contactId')
  const page = Number(c.req.query('page') || '1')
  const limit = Math.min(Number(c.req.query('limit') || '50'), 200)

  const where: any = { orgId }
  if (status) where.status = status
  if (contactId) where.contactId = contactId

  const [items, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: {
        contact: { select: { id: true, displayName: true, email: true } },
        _count: { select: { lines: true, payments: true } },
      },
      orderBy: { issueDate: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.invoice.count({ where }),
  ])

  c.header('X-Total-Count', String(total))
  return c.json({ items, total, page, limit })
})

// GET /invoices/:id (with lines)
invoicesRoutes.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const inv = await prisma.invoice.findFirst({
    where: { id, orgId },
    include: {
      contact: true,
      lines: { include: { product: true, taxRate: true } },
      payments: { orderBy: { paidAt: 'desc' } },
    },
  })
  if (!inv) return c.json({ error: 'not found' }, 404)
  return c.json(inv)
})

// POST /invoices
invoicesRoutes.post('/', zValidator('json', invoiceSchema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')

  const contact = await prisma.contact.findFirst({ where: { id: data.contactId, orgId } })
  if (!contact) return c.json({ error: 'invalid contact' }, 400)

  const totals = await calcTotals(data.lines, orgId)
  const number = data.invoiceNumber || (await nextInvoiceNumber(orgId))

  const invoice = await prisma.invoice.create({
    data: {
      orgId,
      contactId: data.contactId,
      invoiceNumber: number,
      status: data.status,
      issueDate: data.issueDate,
      dueDate: data.dueDate,
      currency: data.currency,
      exchangeRate: new Prisma.Decimal(data.exchangeRate),
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      discountTotal: totals.discountTotal,
      total: totals.total,
      notes: data.notes,
      termsConditions: data.termsConditions,
      lines: { create: totals.lines },
    },
    include: { lines: true, contact: true },
  })

  return c.json(invoice, 201)
})

// PATCH /invoices/:id
invoicesRoutes.patch('/:id', zValidator('json', invoiceSchema.partial()), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.invoice.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)

  const data = c.req.valid('json')
  const updates: any = { ...data }

  // Recompute totals if lines changed
  if (data.lines) {
    const totals = await calcTotals(data.lines, orgId)
    Object.assign(updates, {
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      discountTotal: totals.discountTotal,
      total: totals.total,
    })
    delete updates.lines
    await prisma.invoiceLine.deleteMany({ where: { invoiceId: id } })
    updates.lines = { create: totals.lines }
  }

  const invoice = await prisma.invoice.update({
    where: { id },
    data: updates,
    include: { lines: true, contact: true },
  })
  return c.json(invoice)
})

// DELETE /invoices/:id
invoicesRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.invoice.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.invoice.delete({ where: { id } })
  return c.body(null, 204)
})
