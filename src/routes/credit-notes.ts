import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'

export const creditNotesRoutes = new Hono()

const lineSchema = z.object({
  originalInvoiceLineId: z.string().optional().nullable(),
  productId: z.string().optional().nullable(),
  description: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().min(0),
  taxRateId: z.string().optional().nullable(),
})

const creditNoteSchema = z.object({
  contactId: z.string(),
  originalInvoiceId: z.string().optional().nullable(),
  noteNumber: z.string().optional(),
  status: z.enum(['DRAFT', 'ISSUED', 'APPLIED', 'CANCELLED']).default('DRAFT'),
  reason: z.enum(['RETURN', 'DISCOUNT', 'PRICING_ERROR', 'QUALITY_ISSUE', 'OTHER']).default('RETURN'),
  issueDate: z.string().transform((s) => new Date(s)),
  currency: z.string().length(3).default('SAR'),
  exchangeRate: z.coerce.number().positive().default(1),
  notes: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(1),
})

async function nextCreditNoteNumber(orgId: string): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `CN-${year}-`
  const last = await prisma.creditNote.findFirst({
    where: { orgId, noteNumber: { startsWith: prefix } },
    orderBy: { noteNumber: 'desc' },
    select: { noteNumber: true },
  })
  const lastNum = last ? Number(last.noteNumber.split('-').pop() || '0') : 0
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
      originalInvoiceLineId: l.originalInvoiceLineId || null,
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

creditNotesRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const contactId = c.req.query('contactId')
  const originalInvoiceId = c.req.query('originalInvoiceId')
  const status = c.req.query('status')
  const q = (c.req.query('q') || '').trim()
  const limit = Math.min(Number(c.req.query('limit') || '50'), 200)

  const where: any = { orgId }
  if (contactId) where.contactId = contactId
  if (originalInvoiceId) where.originalInvoiceId = originalInvoiceId
  if (status) where.status = status
  if (q) {
    where.OR = [
      { noteNumber: { contains: q, mode: 'insensitive' } },
      { contact: { displayName: { contains: q, mode: 'insensitive' } } },
      { originalInvoice: { invoiceNumber: { contains: q, mode: 'insensitive' } } },
    ]
  }

  const items = await prisma.creditNote.findMany({
    where,
    include: {
      contact: { select: { id: true, displayName: true, email: true } },
      originalInvoice: { select: { id: true, invoiceNumber: true, issueDate: true, total: true, currency: true } },
      _count: { select: { lines: true } },
    },
    orderBy: { issueDate: 'desc' },
    take: limit,
  })
  return c.json({ items, total: items.length })
})

creditNotesRoutes.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const item = await prisma.creditNote.findFirst({
    where: { id: c.req.param('id'), orgId },
    include: {
      contact: true,
      originalInvoice: { include: { lines: { include: { product: true, taxRate: true } } } },
      lines: { include: { product: true, taxRate: true, originalInvoiceLine: true } },
    },
  })
  if (!item) return c.json({ error: 'not_found' }, 404)
  return c.json(item)
})

creditNotesRoutes.post('/', zValidator('json', creditNoteSchema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')

  const contact = await prisma.contact.findFirst({ where: { id: data.contactId, orgId } })
  if (!contact) return c.json({ error: 'invalid_contact' }, 400)

  if (data.originalInvoiceId) {
    const invoice = await prisma.invoice.findFirst({
      where: { id: data.originalInvoiceId, orgId },
      include: { lines: { select: { id: true } } },
    })
    if (!invoice) return c.json({ error: 'invalid_invoice' }, 400)
    if (invoice.contactId !== data.contactId) return c.json({ error: 'invoice_contact_mismatch' }, 400)

    const invoiceLineIds = new Set(invoice.lines.map((l) => l.id))
    const invalidLine = data.lines.find((l) => l.originalInvoiceLineId && !invoiceLineIds.has(l.originalInvoiceLineId))
    if (invalidLine) return c.json({ error: 'invoice_line_mismatch' }, 400)
  }

  const totals = await calcTotals(data.lines, orgId)
  const number = data.noteNumber || (await nextCreditNoteNumber(orgId))

  const item = await prisma.creditNote.create({
    data: {
      orgId,
      contactId: data.contactId,
      originalInvoiceId: data.originalInvoiceId || null,
      noteNumber: number,
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
      originalInvoice: { select: { id: true, invoiceNumber: true, issueDate: true, total: true, currency: true } },
      lines: true,
    },
  })

  return c.json(item, 201)
})

creditNotesRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.creditNote.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not_found' }, 404)
  await prisma.creditNote.delete({ where: { id } })
  return c.body(null, 204)
})
