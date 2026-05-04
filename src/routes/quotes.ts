import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'

export const quotesRoutes = new Hono()

const lineSchema = z.object({
  productId: z.string().optional().nullable(),
  description: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().min(0),
  discount: z.coerce.number().min(0).default(0),
  taxRateId: z.string().optional().nullable(),
})

const quoteSchema = z.object({
  contactId: z.string(),
  quoteNumber: z.string().optional(),
  status: z.enum(['DRAFT', 'SENT', 'VIEWED', 'ACCEPTED', 'REJECTED', 'CONVERTED', 'EXPIRED']).default('DRAFT'),
  issueDate: z.string().transform((s) => new Date(s)),
  validUntil: z.string().transform((s) => new Date(s)),
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
  let subtotal = 0, taxTotal = 0, discountTotal = 0
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

async function nextQuoteNumber(orgId: string): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `Q-${year}-`
  const last = await prisma.quote.findFirst({
    where: { orgId, quoteNumber: { startsWith: prefix } },
    orderBy: { quoteNumber: 'desc' },
    select: { quoteNumber: true },
  })
  const lastNum = last ? Number(last.quoteNumber.split('-').pop() || '0') : 0
  return `${prefix}${String(lastNum + 1).padStart(4, '0')}`
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

quotesRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const status = c.req.query('status')
  const where: any = { orgId }
  if (status) where.status = status
  const items = await prisma.quote.findMany({
    where,
    include: { contact: { select: { id: true, displayName: true, email: true } } },
    orderBy: { issueDate: 'desc' },
    take: 200,
  })
  return c.json({ items, total: items.length })
})

quotesRoutes.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const q = await prisma.quote.findFirst({
    where: { id: c.req.param('id'), orgId },
    include: { contact: true, lines: { include: { product: true, taxRate: true } } },
  })
  if (!q) return c.json({ error: 'not found' }, 404)
  return c.json(q)
})

quotesRoutes.post('/', zValidator('json', quoteSchema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')
  const contact = await prisma.contact.findFirst({ where: { id: data.contactId, orgId } })
  if (!contact) return c.json({ error: 'invalid contact' }, 400)

  const totals = await calcTotals(data.lines, orgId)
  const number = data.quoteNumber || (await nextQuoteNumber(orgId))

  const quote = await prisma.quote.create({
    data: {
      orgId,
      contactId: data.contactId,
      quoteNumber: number,
      status: data.status,
      issueDate: data.issueDate,
      validUntil: data.validUntil,
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
  return c.json(quote, 201)
})

quotesRoutes.patch('/:id', zValidator('json', quoteSchema.partial()), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.quote.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)

  const data = c.req.valid('json')
  const updates: any = { ...data }
  if (data.lines) {
    const totals = await calcTotals(data.lines, orgId)
    Object.assign(updates, {
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      discountTotal: totals.discountTotal,
      total: totals.total,
    })
    delete updates.lines
    await prisma.quoteLine.deleteMany({ where: { quoteId: id } })
    updates.lines = { create: totals.lines }
  }
  const q = await prisma.quote.update({ where: { id }, data: updates, include: { lines: true, contact: true } })
  return c.json(q)
})

quotesRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.quote.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.quote.delete({ where: { id } })
  return c.body(null, 204)
})

// CONVERT QUOTE TO INVOICE — the killer feature
quotesRoutes.post('/:id/convert-to-invoice', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const q = await prisma.quote.findFirst({
    where: { id, orgId },
    include: { lines: true },
  })
  if (!q) return c.json({ error: 'not found' }, 404)
  if (q.convertedInvoiceId) {
    return c.json({ error: 'already_converted', invoiceId: q.convertedInvoiceId }, 409)
  }

  const invoiceNumber = await nextInvoiceNumber(orgId)
  const dueDate = new Date()
  dueDate.setDate(dueDate.getDate() + 30)

  const invoice = await prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.create({
      data: {
        orgId,
        contactId: q.contactId,
        invoiceNumber,
        status: 'DRAFT',
        issueDate: new Date(),
        dueDate,
        currency: q.currency,
        exchangeRate: q.exchangeRate,
        subtotal: q.subtotal,
        taxTotal: q.taxTotal,
        discountTotal: q.discountTotal,
        total: q.total,
        notes: q.notes ? `${q.notes}\n\n(محوّل من عرض السعر ${q.quoteNumber})` : `(محوّل من عرض السعر ${q.quoteNumber})`,
        termsConditions: q.termsConditions,
        lines: {
          create: q.lines.map((l) => ({
            productId: l.productId,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discount: l.discount,
            taxRateId: l.taxRateId,
            subtotal: l.subtotal,
          })),
        },
      },
      include: { lines: true, contact: true },
    })
    await tx.quote.update({
      where: { id: q.id },
      data: { status: 'CONVERTED', convertedInvoiceId: inv.id },
    })
    return inv
  })

  return c.json({ invoice, quoteId: q.id }, 201)
})
