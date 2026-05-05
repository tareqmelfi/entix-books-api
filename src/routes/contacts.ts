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

export const contactsRoutes = new Hono()

const contactSchema = z.object({
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

  const contact = await prisma.contact.create({
    data: {
      ...data,
      type: type!,
      isCustomer: isCustomer!,
      isSupplier: isSupplier!,
      isForeign,
      orgId,
    },
  })
  return c.json(contact, 201)
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

// POST /contacts/:id/touch · update lastInteraction (called when an invoice/quote/voucher is created for this contact)
contactsRoutes.post('/:id/touch', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.contact.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.contact.update({ where: { id }, data: { lastInteraction: new Date() } })
  return c.json({ ok: true })
})
