import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { nextContactCode } from '../lib/numbering.js'

export const expensesRoutes = new Hono()

const expenseLineSchema = z.object({
  description: z.string().min(1),
  quantity: z.coerce.number().positive().default(1),
  unitPrice: z.coerce.number().min(0).default(0),
  taxRate: z.coerce.number().min(0).max(1).optional().nullable(),
  taxInclusive: z.boolean().optional().nullable(),
  lineTotal: z.coerce.number().min(0).optional().nullable(),
  subtotal: z.coerce.number().min(0).optional().nullable(),
  category: z.string().optional().nullable(),
  accountName: z.string().optional().nullable(),
  sku: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
}).passthrough()

const expensePaymentSplitSchema = z.object({
  method: z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'STC_PAY', 'MADA', 'CHECK', 'OTHER']),
  amount: z.coerce.number().positive(),
  reference: z.string().optional().nullable(),
  cardLast4: z.string().optional().nullable(),
  accountName: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
}).passthrough()

const expenseSchema = z.object({
  number: z.string().optional(),
  date: z.string().transform((s) => new Date(s)),
  category: z.string().min(1),
  description: z.string().optional().nullable(),
  amount: z.coerce.number().positive(),
  subtotal: z.coerce.number().min(0).optional(),
  totalAmount: z.coerce.number().positive().optional(),
  currency: z.string().length(3).default('SAR'),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'STC_PAY', 'MADA', 'CHECK', 'OTHER']),
  contactId: z.string().optional().nullable(),
  vendorName: z.string().optional().nullable(),
  supplierTaxId: z.string().optional().nullable(),
  documentNumber: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  taxRateId: z.string().optional().nullable(),
  taxAmount: z.coerce.number().min(0).default(0),
  receiptUrl: z.string().url().optional().nullable(),
  attachmentName: z.string().optional().nullable(),
  attachmentType: z.string().optional().nullable(),
  attachmentSizeBytes: z.coerce.number().int().nonnegative().optional().nullable(),
  attachmentBase64: z.string().max(80_000_000).optional().nullable(),
  attachmentCount: z.coerce.number().int().nonnegative().optional(),
  lineItems: z.array(expenseLineSchema).optional().nullable(),
  paymentSplits: z.array(expensePaymentSplitSchema).optional().nullable(),
  extractedJson: z.any().optional().nullable(),
  ocrConfidence: z.coerce.number().min(0).max(1).optional().nullable(),
  autoCreateSupplier: z.boolean().default(true),
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

function cleanOptionalText(value?: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function normalizeTaxId(value?: string | null): string | null {
  const trimmed = cleanOptionalText(value)
  if (!trimmed) return null
  return trimmed.replace(/[^\dA-Za-z]/g, '')
}

function normalizeVendorName(value?: string | null): string | null {
  const trimmed = cleanOptionalText(value)
  if (!trimmed) return null
  return trimmed
    .replace(/\s+/g, ' ')
    .replace(/\s+-\s+/g, ' · ')
    .replace(/^(store|branch|cashier|supplier)\s*[:#-]?\s*/i, '')
    .trim()
}

async function resolveTaxRateId(orgId: string, taxRateId?: string | null, taxAmount = 0): Promise<string | null> {
  if (taxRateId) {
    const exists = await prisma.taxRate.findFirst({ where: { id: taxRateId, orgId, isActive: true }, select: { id: true } })
    return exists?.id || null
  }
  if (taxAmount <= 0) return null
  const vat15 = await prisma.taxRate.findFirst({
    where: { orgId, isActive: true, rate: new Prisma.Decimal(0.15) },
    select: { id: true },
  })
  return vat15?.id || null
}

async function resolveExpenseContact(
  orgId: string,
  data: z.infer<typeof expenseSchema> | Partial<z.infer<typeof expenseSchema>>,
): Promise<{ id: string; displayName: string } | null> {
  if (data.contactId) {
    const contact = await prisma.contact.findFirst({
      where: { id: data.contactId, orgId, isActive: true },
      select: { id: true, displayName: true, isSupplier: true, isCustomer: true },
    })
    if (!contact) return null
    if (!contact.isSupplier) {
      await prisma.contact.update({
        where: { id: contact.id },
        data: { isSupplier: true, type: contact.isCustomer ? 'BOTH' : 'SUPPLIER' },
      })
    }
    return { id: contact.id, displayName: contact.displayName }
  }

  const vendorName = normalizeVendorName(data.vendorName)
  if (!vendorName) return null

  const supplierTaxId = normalizeTaxId(data.supplierTaxId || (data.extractedJson as any)?.issuer?.taxId)
  const or: any[] = [{ displayName: { equals: vendorName, mode: 'insensitive' } }]
  if (supplierTaxId) {
    or.unshift({ taxId: { equals: supplierTaxId } }, { vatNumber: { equals: supplierTaxId } })
  }

  const existing = await prisma.contact.findFirst({
    where: { orgId, isActive: true, OR: or },
    select: { id: true, displayName: true, isSupplier: true, isCustomer: true },
  })
  if (existing) {
    if (!existing.isSupplier) {
      await prisma.contact.update({
        where: { id: existing.id },
        data: { isSupplier: true, type: existing.isCustomer ? 'BOTH' : 'SUPPLIER' },
      })
    }
    return { id: existing.id, displayName: existing.displayName }
  }

  if (data.autoCreateSupplier === false) return null

  let customCode: string | null = null
  try { customCode = await nextContactCode(orgId) } catch { customCode = null }
  const created = await prisma.contact.create({
    data: {
      orgId,
      customCode,
      type: 'SUPPLIER',
      isCustomer: false,
      isSupplier: true,
      entityKind: 'COMPANY',
      displayName: vendorName,
      legalName: vendorName,
      taxId: supplierTaxId,
      vatNumber: supplierTaxId,
      country: (data.extractedJson as any)?.issuer?.country || 'SA',
      defaultCurrency: data.currency || 'SAR',
      notes: 'Auto-created from expense receipt upload.',
    },
    select: { id: true, displayName: true },
  })
  return created
}

async function findDuplicateExpense(args: {
  orgId: string
  excludeId?: string
  contactId?: string | null
  vendorName?: string | null
  documentNumber?: string | null
  date: Date
  total: number
}) {
  const vendorName = cleanOptionalText(args.vendorName)
  const documentNumber = cleanOptionalText(args.documentNumber)

  if (documentNumber) {
    const or: any[] = []
    if (args.contactId) or.push({ contactId: args.contactId })
    if (vendorName) or.push({ vendorName: { equals: vendorName, mode: 'insensitive' } })
    const byNumber = await prisma.expense.findFirst({
      where: {
        orgId: args.orgId,
        id: args.excludeId ? { not: args.excludeId } : undefined,
        documentNumber,
        ...(or.length ? { OR: or } : {}),
      },
      select: { id: true, number: true, total: true, date: true, vendorName: true },
    })
    if (byNumber) return { ...byNumber, reason: 'same_document_number' }
  }

  const start = new Date(args.date)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  const candidates = await prisma.expense.findMany({
    where: {
      orgId: args.orgId,
      id: args.excludeId ? { not: args.excludeId } : undefined,
      date: { gte: start, lt: end },
      ...(args.contactId ? { contactId: args.contactId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: { id: true, number: true, total: true, date: true, vendorName: true },
  })
  const duplicate = candidates.find((item) => {
    const sameAmount = Math.abs(Number(item.total) - args.total) < 0.01
    const itemVendor = item.vendorName?.toLowerCase() || ''
    const sameVendor = !vendorName || !itemVendor || itemVendor.includes(vendorName.toLowerCase()) || vendorName.toLowerCase().includes(itemVendor)
    return sameAmount && sameVendor
  })
  return duplicate ? { ...duplicate, reason: 'same_date_vendor_total' } : null
}

const expenseInclude = {
  contact: { select: { id: true, displayName: true, taxId: true, vatNumber: true, isSupplier: true } },
  taxRate: { select: { id: true, name: true, rate: true } },
}

const expenseListSelect = {
  id: true,
  orgId: true,
  contactId: true,
  number: true,
  date: true,
  category: true,
  description: true,
  amount: true,
  subtotal: true,
  currency: true,
  paymentMethod: true,
  vendorName: true,
  documentNumber: true,
  reference: true,
  taxRateId: true,
  taxAmount: true,
  total: true,
  receiptUrl: true,
  attachmentName: true,
  attachmentType: true,
  attachmentSizeBytes: true,
  attachmentCount: true,
  paymentSplits: true,
  duplicateOfId: true,
  duplicateReason: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  contact: { select: { id: true, displayName: true, taxId: true, vatNumber: true, isSupplier: true } },
  taxRate: { select: { id: true, name: true, rate: true } },
}

// GET /expenses
expensesRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const category = c.req.query('category')
  const contactId = c.req.query('contactId')
  const from = c.req.query('from')
  const to = c.req.query('to')
  const page = Number(c.req.query('page') || '1')
  const limit = Math.min(Number(c.req.query('limit') || '50'), 200)

  const where: any = { orgId }
  if (category) where.category = category
  if (contactId) where.contactId = contactId
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
      select: expenseListSelect,
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
    include: expenseInclude,
  })
  if (!e) return c.json({ error: 'not found' }, 404)
  return c.json(e)
})

// POST /expenses
expensesRoutes.post('/', zValidator('json', expenseSchema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')
  const number = data.number || (await nextExpenseNumber(orgId))
  const amount = data.subtotal ?? data.amount
  const taxAmount = data.taxAmount || 0
  const total = data.totalAmount ?? (amount + taxAmount)
  const contact = await resolveExpenseContact(orgId, data)
  const taxRateId = await resolveTaxRateId(orgId, data.taxRateId, taxAmount)
  const duplicate = await findDuplicateExpense({
    orgId,
    contactId: contact?.id,
    vendorName: data.vendorName,
    documentNumber: data.documentNumber,
    date: data.date,
    total,
  })

  try {
    const e = await prisma.expense.create({
      data: {
        orgId,
        contactId: contact?.id || null,
        number,
        date: data.date,
        category: data.category,
        description: data.description,
        amount: new Prisma.Decimal(data.amount),
        subtotal: new Prisma.Decimal(amount),
        currency: data.currency,
        paymentMethod: data.paymentMethod,
        vendorName: contact?.displayName || normalizeVendorName(data.vendorName),
        documentNumber: data.documentNumber,
        reference: data.reference,
        taxRateId,
        taxAmount: new Prisma.Decimal(taxAmount),
        total: new Prisma.Decimal(total),
        receiptUrl: data.receiptUrl,
        attachmentName: data.attachmentName,
        attachmentType: data.attachmentType,
        attachmentSizeBytes: data.attachmentSizeBytes,
        attachmentBase64: data.attachmentBase64,
        attachmentCount: data.attachmentCount ?? (data.attachmentBase64 ? 1 : 0),
        lineItems: data.lineItems ? data.lineItems as Prisma.InputJsonValue : Prisma.JsonNull,
        paymentSplits: data.paymentSplits ? data.paymentSplits as Prisma.InputJsonValue : Prisma.JsonNull,
        extractedJson: data.extractedJson ? data.extractedJson as Prisma.InputJsonValue : Prisma.JsonNull,
        ocrConfidence: data.ocrConfidence != null ? new Prisma.Decimal(data.ocrConfidence) : null,
        duplicateOfId: duplicate?.id || null,
        duplicateReason: duplicate?.reason || null,
        notes: data.notes,
      },
      include: expenseInclude,
    })
    return c.json({ ...e, duplicateExpense: duplicate }, 201)
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
  const {
    autoCreateSupplier,
    supplierTaxId,
    subtotal,
    totalAmount,
    ...rest
  } = data
  const updates: any = { ...rest }
  delete updates.lineItems
  delete updates.paymentSplits
  delete updates.extractedJson

  if (data.contactId !== undefined || data.vendorName !== undefined) {
    const contact = await resolveExpenseContact(orgId, data)
    updates.contactId = contact?.id || data.contactId || null
    if (contact) updates.vendorName = contact.displayName
  }

  if (data.amount !== undefined || data.taxAmount !== undefined) {
    const amount = data.amount ?? Number(exists.amount)
    const taxAmount = data.taxAmount ?? Number(exists.taxAmount)
    updates.subtotal = new Prisma.Decimal(subtotal ?? amount)
    updates.total = new Prisma.Decimal(totalAmount ?? ((subtotal ?? amount) + taxAmount))
    if (data.amount !== undefined) updates.amount = new Prisma.Decimal(amount)
    if (data.taxAmount !== undefined) updates.taxAmount = new Prisma.Decimal(taxAmount)
  }
  if (data.taxRateId !== undefined || data.taxAmount !== undefined) {
    updates.taxRateId = await resolveTaxRateId(orgId, data.taxRateId, data.taxAmount ?? Number(exists.taxAmount))
  }
  if (data.lineItems !== undefined) updates.lineItems = data.lineItems ? data.lineItems as Prisma.InputJsonValue : Prisma.JsonNull
  if (data.paymentSplits !== undefined) updates.paymentSplits = data.paymentSplits ? data.paymentSplits as Prisma.InputJsonValue : Prisma.JsonNull
  if (data.extractedJson !== undefined) updates.extractedJson = data.extractedJson ? data.extractedJson as Prisma.InputJsonValue : Prisma.JsonNull
  if (data.ocrConfidence !== undefined) updates.ocrConfidence = data.ocrConfidence != null ? new Prisma.Decimal(data.ocrConfidence) : null
  if (data.date) updates.date = new Date(data.date)

  const e = await prisma.expense.update({
    where: { id },
    data: updates,
    include: expenseInclude,
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
