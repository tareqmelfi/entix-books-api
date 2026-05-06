/**
 * Contacts · org-scoped · unified directory
 *
 * UX-46 · A single contact can be Customer + Supplier + Employee + Shareholder + Freelancer simultaneously.
 * UX-47 · Country-aware: tax-id label, default currency, foreign-entity flag, withholding-tax rate, LEI code.
 *
 * Backward compat: legacy `type` enum (CUSTOMER/SUPPLIER/BOTH) is auto-derived from role flags.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../db.js'
import { nextContactCode } from '../lib/numbering.js'

export const contactsRoutes = new Hono()

const contactSchema = z.object({
  // User-facing custom code (auto-generated if blank)
  customCode: z.string().optional().nullable(),
  // Legacy enum (kept · derived from flags if not provided)
  type: z.enum(['CUSTOMER', 'SUPPLIER', 'BOTH']).optional(),
  // Multi-role flags (UX-46)
  isCustomer: z.boolean().optional(),
  isSupplier: z.boolean().optional(),
  isEmployee: z.boolean().optional(),
  isShareholder: z.boolean().optional(),
  isFreelancer: z.boolean().optional(),
  // Entity classification (UX-47)
  entityKind: z.enum(['INDIVIDUAL', 'COMPANY']).optional(),
  // Identity
  displayName: z.string().min(1).max(200),
  legalName: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('').transform(() => null)),
  phone: z.string().optional().nullable(),
  // Tax IDs
  taxId: z.string().optional().nullable(),
  vatNumber: z.string().optional().nullable(),
  crNumber: z.string().optional().nullable(),
  nationalId: z.string().optional().nullable(),
  leiCode: z.string().length(20).optional().nullable().or(z.literal('').transform(() => null)),
  // Foreign / withholding
  isForeign: z.boolean().optional(),
  withholdingTaxRate: z.coerce.number().min(0).max(100).optional().nullable(),
  defaultCurrency: z.string().length(3).optional().nullable().or(z.literal('').transform(() => null)),
  // Address
  addressLine1: z.string().optional().nullable(),
  addressLine2: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  region: z.string().optional().nullable(),
  country: z.string().length(2).default('SA'),
  postalCode: z.string().optional().nullable(),
  // CRM-light
  tags: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
})

/** Derive legacy `type` enum from role flags · keeps old code paths working */
function deriveType(flags: { isCustomer?: boolean; isSupplier?: boolean }): 'CUSTOMER' | 'SUPPLIER' | 'BOTH' {
  if (flags.isCustomer && flags.isSupplier) return 'BOTH'
  if (flags.isSupplier) return 'SUPPLIER'
  return 'CUSTOMER'
}

/** Derive role flags from legacy `type` · for back-compat when flags not provided */
function deriveFlags(type: 'CUSTOMER' | 'SUPPLIER' | 'BOTH'): { isCustomer: boolean; isSupplier: boolean } {
  return {
    isCustomer: type === 'CUSTOMER' || type === 'BOTH',
    isSupplier: type === 'SUPPLIER' || type === 'BOTH',
  }
}

// GET /contacts — list with optional filters
contactsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const type = c.req.query('type') as 'CUSTOMER' | 'SUPPLIER' | 'BOTH' | undefined
  // New: filter by any role flag · pass role=customer|supplier|employee|shareholder|freelancer
  const role = c.req.query('role')
  const country = c.req.query('country')
  const foreign = c.req.query('foreign') // 'true' | 'false' | undefined
  const q = c.req.query('q')
  const page = Number(c.req.query('page') || '1')
  const limit = Math.min(Number(c.req.query('limit') || '50'), 200)

  const where: any = { orgId, isActive: true }
  if (type) where.type = type
  if (role) {
    if (role === 'customer') where.isCustomer = true
    else if (role === 'supplier') where.isSupplier = true
    else if (role === 'employee') where.isEmployee = true
    else if (role === 'shareholder') where.isShareholder = true
    else if (role === 'freelancer') where.isFreelancer = true
  }
  if (country) where.country = country.toUpperCase()
  if (foreign === 'true') where.isForeign = true
  else if (foreign === 'false') where.isForeign = false
  if (q) {
    where.OR = [
      { displayName: { contains: q, mode: 'insensitive' } },
      { legalName: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q } },
      { taxId: { contains: q } },
      { vatNumber: { contains: q } },
      { nationalId: { contains: q } },
      { leiCode: { contains: q, mode: 'insensitive' } },
    ]
  }

  const [items, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: { displayName: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.contact.count({ where }),
  ])

  c.header('X-Total-Count', String(total))
  return c.json({ items, total, page, limit })
})

// GET /contacts/:id
contactsRoutes.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const contact = await prisma.contact.findFirst({ where: { id, orgId } })
  if (!contact) return c.json({ error: 'not found' }, 404)
  return c.json(contact)
})

// POST /contacts
contactsRoutes.post('/', zValidator('json', contactSchema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')

  // Reconcile legacy type ↔ role flags
  let { type, isCustomer, isSupplier } = data
  if (type === undefined && (isCustomer !== undefined || isSupplier !== undefined)) {
    type = deriveType({ isCustomer, isSupplier })
  } else if (type !== undefined && isCustomer === undefined && isSupplier === undefined) {
    const f = deriveFlags(type)
    isCustomer = f.isCustomer
    isSupplier = f.isSupplier
  } else if (type === undefined) {
    type = 'CUSTOMER'
    isCustomer = true
  }

  // Auto-flag foreign if non-base country (KSA-default for now · later use org's country)
  const isForeign = data.isForeign ?? (data.country !== 'SA')

  // Auto-generate customCode if blank
  let customCode = data.customCode?.trim() || null
  if (!customCode) {
    try { customCode = await nextContactCode(orgId) } catch { /* fall back · leave null */ }
  }

  const contact = await prisma.contact.create({
    data: {
      ...data,
      customCode,
      type: type!,
      isCustomer: isCustomer!,
      isSupplier: isSupplier!,
      isForeign,
      orgId,
    },
  })
  return c.json(contact, 201)
})

// GET /contacts/_/next-code · returns the next auto-suggested customCode (used by UI before submit)
contactsRoutes.get('/_/next-code', async (c) => {
  const orgId = c.get('orgId') as string
  const code = await nextContactCode(orgId)
  return c.json({ customCode: code })
})

// POST /contacts/_/extract-from-document · AI reads a CR / EIN letter / Articles
// of Incorporation and returns extracted fields ready to pre-fill the wizard.
const extractDocSchema = z.object({
  fileBase64: z.string().min(1).max(140_000_000),
  fileName: z.string().optional(),
  mimeType: z.string().default('application/pdf'),
})
contactsRoutes.post('/_/extract-from-document', zValidator('json', extractDocSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const { fileBase64, fileName, mimeType } = c.req.valid('json')

  // Resolve AI key
  let resolved
  try {
    const { resolveAiKey } = await import('../lib/ai-billing.js')
    resolved = await resolveAiKey(orgId)
  } catch (e: any) {
    return c.json({ error: 'ai_disabled', message: e?.message || 'الذكاء غير مفعّل' }, 503)
  }
  if (!resolved.apiKey) return c.json({ error: 'no_key' }, 503)

  const SYSTEM = `You read commercial registration / tax / incorporation documents (KSA, US, UAE, EG, GB)
and extract a clean contact profile.

Output strict JSON only · no markdown:
{
  "displayName": "<short name as-shown on doc>",
  "legalName":   "<full legal name>",
  "entityKind":  "INDIVIDUAL" | "COMPANY",
  "country":     "<ISO 3166-1 alpha-2 like SA / US / AE / EG / GB>",
  "vatNumber":   "<VAT/EIN/TRN · digits only OR formatted as on the doc>",
  "crNumber":    "<KSA commercial registration · digits only>",
  "nationalId":  "<for individuals>",
  "addressLine1": "...",
  "city":        "...",
  "region":      "...",
  "postalCode":  "...",
  "phone":       "...",
  "email":       "...",
  "isCustomer":  true,
  "isSupplier":  false,
  "confidence":  0.0-1.0,
  "notes":       "<one short line in Arabic with summary>"
}

Rules:
- KSA CR (السجل التجاري) is 10 digits (often starts with 1010 / 7000 / 4030)
- KSA VAT (الرقم الضريبي) is 15 digits (often starts with 3 and ends with 003)
- US EIN is 9 digits formatted XX-XXXXXXX
- Strip Arabic-Indic digits to Western (٠-٩ → 0-9)
- For individual ID cards or 'هوية وطنية', set entityKind=INDIVIDUAL
- If you can't read the document at all, return confidence=0 and only the fields you found`

  const userContent: any = mimeType.startsWith('image/') || mimeType === 'application/pdf'
    ? [
        { type: 'text', text: `Extract structured contact data from this ${mimeType === 'application/pdf' ? 'PDF' : 'image'}. File: ${fileName || 'unknown'}` },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${fileBase64}` } },
      ]
    : `Extract from text:\n${Buffer.from(fileBase64, 'base64').toString('utf-8').slice(0, 30000)}`

  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolved.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://entix.io',
        'X-Title': 'Entix Books · Contact Extractor',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 1500,
      }),
    })
    if (!r.ok) {
      const detail = await r.text()
      let msg = 'فشل قراءة المستند · جرّب صورة أوضح'
      try {
        const j = JSON.parse(detail)
        if (/credit|quota|insufficient/i.test(j?.error?.message || '')) {
          msg = 'رصيد OpenRouter منخفض · شحن الرصيد أو استخدم BYOK'
        }
      } catch {}
      return c.json({ error: 'extraction_failed', message: msg, raw: detail.slice(0, 200) }, 502)
    }
    const j = await r.json() as any
    let parsed: any
    try { parsed = JSON.parse(j.choices?.[0]?.message?.content || '{}') } catch { parsed = {} }

    return c.json({
      displayName: parsed.displayName || null,
      legalName: parsed.legalName || null,
      entityKind: parsed.entityKind || 'COMPANY',
      country: parsed.country || 'SA',
      vatNumber: parsed.vatNumber || null,
      crNumber: parsed.crNumber || null,
      nationalId: parsed.nationalId || null,
      addressLine1: parsed.addressLine1 || null,
      city: parsed.city || null,
      region: parsed.region || null,
      postalCode: parsed.postalCode || null,
      phone: parsed.phone || null,
      email: parsed.email || null,
      isCustomer: parsed.isCustomer ?? true,
      isSupplier: parsed.isSupplier ?? false,
      confidence: parsed.confidence ?? 0.5,
      notes: parsed.notes || null,
    })
  } catch (e: any) {
    return c.json({ error: 'exception', message: e?.message || 'unknown' }, 500)
  }
})

// PATCH /contacts/:id
contactsRoutes.patch('/:id', zValidator('json', contactSchema.partial()), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.contact.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  const data = c.req.valid('json')

  // Keep type ↔ flags in sync if either side changes
  const patch: any = { ...data }
  const newIsCustomer = data.isCustomer ?? exists.isCustomer
  const newIsSupplier = data.isSupplier ?? exists.isSupplier
  if (data.isCustomer !== undefined || data.isSupplier !== undefined) {
    patch.type = deriveType({ isCustomer: newIsCustomer, isSupplier: newIsSupplier })
  } else if (data.type !== undefined) {
    const f = deriveFlags(data.type)
    patch.isCustomer = f.isCustomer
    patch.isSupplier = f.isSupplier
  }

  const contact = await prisma.contact.update({ where: { id }, data: patch })
  return c.json(contact)
})

// DELETE /contacts/:id (soft delete)
contactsRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.contact.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.contact.update({ where: { id }, data: { isActive: false } })
  return c.body(null, 204)
})

// GET /contacts/:id/summary · contact + all related records (for the detail page)
contactsRoutes.get('/:id/summary', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const contact = await prisma.contact.findFirst({ where: { id, orgId } })
  if (!contact) return c.json({ error: 'not found' }, 404)

  const [
    invoiceAgg,
    billAgg,
    quoteAgg,
    receiptAgg,
    paymentAgg,
    invoices,
    bills,
    quotes,
    vouchers,
    expenses,
  ] = await Promise.all([
    prisma.invoice.aggregate({
      where: { orgId, contactId: id },
      _sum: { total: true, amountPaid: true },
      _count: true,
    }),
    prisma.bill.aggregate({
      where: { orgId, contactId: id },
      _sum: { total: true, amountPaid: true },
      _count: true,
    }),
    prisma.quote.aggregate({
      where: { orgId, contactId: id },
      _sum: { total: true },
      _count: true,
    }),
    prisma.voucher.aggregate({
      where: { orgId, contactId: id, type: 'RECEIPT' },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.voucher.aggregate({
      where: { orgId, contactId: id, type: 'PAYMENT' },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.invoice.findMany({
      where: { orgId, contactId: id },
      orderBy: { issueDate: 'desc' },
      take: 20,
      select: { id: true, invoiceNumber: true, issueDate: true, dueDate: true, total: true, amountPaid: true, status: true, currency: true },
    }),
    prisma.bill.findMany({
      where: { orgId, contactId: id },
      orderBy: { issueDate: 'desc' },
      take: 20,
      select: { id: true, billNumber: true, issueDate: true, dueDate: true, total: true, amountPaid: true, status: true, currency: true },
    }),
    prisma.quote.findMany({
      where: { orgId, contactId: id },
      orderBy: { issueDate: 'desc' },
      take: 10,
      select: { id: true, quoteNumber: true, issueDate: true, validUntil: true, total: true, status: true, currency: true },
    }),
    prisma.voucher.findMany({
      where: { orgId, contactId: id },
      orderBy: { date: 'desc' },
      take: 20,
      select: { id: true, number: true, type: true, date: true, amount: true, currency: true, paymentMethod: true, reference: true, notes: true },
    }),
    // Expense model has no FK to Contact yet · match by free-text vendorName
    prisma.expense.findMany({
      where: { orgId, vendorName: { equals: contact.displayName, mode: 'insensitive' } },
      orderBy: { date: 'desc' },
      take: 10,
      select: { id: true, date: true, total: true, category: true, description: true, currency: true },
    }),
  ])

  const arOpen = Number(invoiceAgg._sum.total || 0) - Number(invoiceAgg._sum.amountPaid || 0)
  const apOpen = Number(billAgg._sum.total || 0) - Number(billAgg._sum.amountPaid || 0)
  const balance = arOpen - apOpen // positive = they owe me · negative = I owe them

  return c.json({
    contact,
    totals: {
      invoices: { count: invoiceAgg._count, total: Number(invoiceAgg._sum.total || 0), paid: Number(invoiceAgg._sum.amountPaid || 0), outstanding: arOpen },
      bills: { count: billAgg._count, total: Number(billAgg._sum.total || 0), paid: Number(billAgg._sum.amountPaid || 0), outstanding: apOpen },
      quotes: { count: quoteAgg._count, total: Number(quoteAgg._sum.total || 0) },
      receipts: { count: receiptAgg._count, total: Number(receiptAgg._sum.amount || 0) },
      payments: { count: paymentAgg._count, total: Number(paymentAgg._sum.amount || 0) },
      arOpen,
      apOpen,
      balance,
    },
    invoices,
    bills,
    quotes,
    vouchers,
    expenses,
  })
})

// POST /contacts/:id/touch · update lastInteraction (called when an invoice/quote/voucher is created for this contact)
contactsRoutes.post('/:id/touch', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.contact.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.contact.update({ where: { id }, data: { lastInteraction: new Date() } })
  return c.json({ ok: true })
})
