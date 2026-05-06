import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireAuth } from '../auth.js'
import { prisma } from '../db.js'

export const orgsRoutes = new Hono()

orgsRoutes.use('*', requireAuth)

// GET /orgs — list orgs the user is a member of
orgsRoutes.get('/', async (c) => {
  const auth = c.get('auth')
  const memberships = await prisma.orgMembership.findMany({
    where: { userId: auth.userId },
    include: { org: true },
    orderBy: { createdAt: 'asc' },
  })
  return c.json(memberships.map((m) => ({ ...m.org, role: m.role })))
})

const createOrgSchema = z.object({
  slug: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(120),
  legalName: z.string().optional().nullable(),
  country: z.string().length(2).default('SA'),
  baseCurrency: z.string().length(3).default('SAR'),
  vatNumber: z.string().optional().nullable(),
  crNumber: z.string().optional().nullable(),
  fiscalYearStart: z.number().int().min(1).max(12).optional(),
  fiscalYearEnd: z.number().int().min(1).max(12).optional(),
  // Branding
  logoUrl: z.string().optional().nullable(),
  stampUrl: z.string().optional().nullable(),
  // Contact
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  // Address (Saudi-style)
  addressLine: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  region: z.string().optional().nullable(),
  postalCode: z.string().optional().nullable(),
  district: z.string().optional().nullable(),
  buildingNumber: z.string().optional().nullable(),
  streetName: z.string().optional().nullable(),
  // Address (US-style)
  suiteUnit: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  industry: z.string().optional().nullable(),
  taxRegistrationDate: z.string().optional().nullable(),
  firstVatPeriodStart: z.string().optional().nullable(),
  vatPeriod: z.enum(['monthly', 'quarterly']).optional().nullable(),
})

// POST /orgs — create a new org · auto-add creator as OWNER
orgsRoutes.post('/', zValidator('json', createOrgSchema), async (c) => {
  const auth = c.get('auth')
  const data = c.req.valid('json')

  const { taxRegistrationDate, firstVatPeriodStart, fiscalYearEnd, fiscalYearStart, ...rest } = data as any
  // Derive start from end if only end was given
  const derivedStart = fiscalYearStart ?? (fiscalYearEnd ? (Number(fiscalYearEnd) % 12) + 1 : 1)
  const org = await prisma.organization.create({
    data: {
      ...rest,
      fiscalYearStart: derivedStart,
      fiscalYearEnd: fiscalYearEnd ?? null,
      taxRegistrationDate: taxRegistrationDate ? new Date(taxRegistrationDate) : null,
      firstVatPeriodStart: firstVatPeriodStart ? new Date(firstVatPeriodStart) : null,
      memberships: {
        create: { userId: auth.userId, role: 'OWNER' },
      },
    },
  })

  // Seed default chart of accounts
  await seedDefaultAccounts(org.id)
  // Seed default tax rates
  await prisma.taxRate.createMany({
    data: [
      { orgId: org.id, name: 'VAT 15%', rate: '0.15', type: 'STANDARD' },
      { orgId: org.id, name: 'VAT Exempt', rate: '0', type: 'EXEMPT' },
      { orgId: org.id, name: 'VAT 0%', rate: '0', type: 'ZERO_RATED' },
    ],
  })

  return c.json(org, 201)
})

// GET /orgs/:id
orgsRoutes.get('/:id', async (c) => {
  const auth = c.get('auth')
  const orgId = c.req.param('id')
  const m = await prisma.orgMembership.findUnique({
    where: { userId_orgId: { userId: auth.userId, orgId } },
    include: { org: true },
  })
  if (!m) return c.json({ error: 'not found' }, 404)
  return c.json({ ...m.org, role: m.role })
})

// PATCH /orgs/:id — update org info (OWNER/ADMIN only)
const updateOrgSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  legalName: z.string().optional().nullable(),
  country: z.string().length(2).optional(),
  baseCurrency: z.string().length(3).optional(),
  fiscalYearStart: z.number().int().min(1).max(12).optional(),
  fiscalYearEnd: z.number().int().min(1).max(12).optional(),
  vatNumber: z.string().optional().nullable(),
  crNumber: z.string().optional().nullable(),
  zatcaEnabled: z.boolean().optional(),
  logoUrl: z.string().optional().nullable(),
  stampUrl: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  addressLine: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  region: z.string().optional().nullable(),
  postalCode: z.string().optional().nullable(),
  district: z.string().optional().nullable(),
  buildingNumber: z.string().optional().nullable(),
  streetName: z.string().optional().nullable(),
  suiteUnit: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  industry: z.string().optional().nullable(),
  taxRegistrationDate: z.string().optional().nullable(),
  firstVatPeriodStart: z.string().optional().nullable(),
  vatPeriod: z.enum(['monthly', 'quarterly']).optional().nullable(),
  numberingSettings: z.any().optional(),
  paymentSettings: z.any().optional(),
})

const numberingPerKindSchema = z.object({
  prefix: z.string().max(60).optional(),
  padding: z.number().int().min(1).max(10).optional(),
  start: z.number().int().min(1).optional(),
})
const numberingSchema = z.object({
  contact: numberingPerKindSchema.optional(),
  invoice: numberingPerKindSchema.optional(),
  quote: numberingPerKindSchema.optional(),
  bill: numberingPerKindSchema.optional(),
  receipt: numberingPerKindSchema.optional(),
  payment: numberingPerKindSchema.optional(),
})

orgsRoutes.patch('/:id', zValidator('json', updateOrgSchema), async (c) => {
  const auth = c.get('auth')
  const orgId = c.req.param('id')
  const m = await prisma.orgMembership.findUnique({
    where: { userId_orgId: { userId: auth.userId, orgId } },
  })
  if (!m) return c.json({ error: 'not_a_member' }, 403)
  if (m.role !== 'OWNER' && m.role !== 'ADMIN') return c.json({ error: 'forbidden' }, 403)
  const data = c.req.valid('json') as any
  // Convert ISO date strings to Date for the new fields
  const patch: any = { ...data }
  if (data.taxRegistrationDate !== undefined) patch.taxRegistrationDate = data.taxRegistrationDate ? new Date(data.taxRegistrationDate) : null
  if (data.firstVatPeriodStart !== undefined) patch.firstVatPeriodStart = data.firstVatPeriodStart ? new Date(data.firstVatPeriodStart) : null
  const org = await prisma.organization.update({ where: { id: orgId }, data: patch })
  return c.json({ ...org, role: m.role })
})

// GET /orgs/:id/numbering · returns the numberingSettings JSON
orgsRoutes.get('/:id/numbering', async (c) => {
  const auth = c.get('auth')
  const orgId = c.req.param('id')
  const m = await prisma.orgMembership.findUnique({ where: { userId_orgId: { userId: auth.userId, orgId } } })
  if (!m) return c.json({ error: 'not_a_member' }, 403)
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { numberingSettings: true } })
  return c.json(org?.numberingSettings || {})
})

// PATCH /orgs/:id/numbering · updates the numberingSettings JSON
orgsRoutes.patch('/:id/numbering', zValidator('json', numberingSchema), async (c) => {
  const auth = c.get('auth')
  const orgId = c.req.param('id')
  const m = await prisma.orgMembership.findUnique({ where: { userId_orgId: { userId: auth.userId, orgId } } })
  if (!m) return c.json({ error: 'not_a_member' }, 403)
  if (m.role !== 'OWNER' && m.role !== 'ADMIN') return c.json({ error: 'forbidden' }, 403)
  const data = c.req.valid('json')
  const org = await prisma.organization.update({
    where: { id: orgId },
    data: { numberingSettings: data as any },
  })
  return c.json(org.numberingSettings || {})
})

// GET /orgs/:id/members
orgsRoutes.get('/:id/members', async (c) => {
  const auth = c.get('auth')
  const orgId = c.req.param('id')
  const m = await prisma.orgMembership.findUnique({
    where: { userId_orgId: { userId: auth.userId, orgId } },
  })
  if (!m) return c.json({ error: 'not_a_member' }, 403)
  const members = await prisma.orgMembership.findMany({
    where: { orgId },
    include: { user: { select: { id: true, email: true, name: true, image: true, createdAt: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return c.json({ members })
})

// Default Saudi/US chart of accounts (minimal · 5-digit codes)
async function seedDefaultAccounts(orgId: string) {
  const accounts: Array<{
    code: string
    name: string
    nameAr: string
    type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'
    subtype?: string
  }> = [
    // Assets · 1xxxx
    { code: '11000', name: 'Cash on Hand', nameAr: 'النقد في الصندوق', type: 'ASSET', subtype: 'cash' },
    { code: '11100', name: 'Bank Accounts', nameAr: 'الحسابات البنكية', type: 'ASSET', subtype: 'bank' },
    { code: '12000', name: 'Accounts Receivable', nameAr: 'الذمم المدينة', type: 'ASSET', subtype: 'receivable' },
    { code: '13000', name: 'Inventory', nameAr: 'المخزون', type: 'ASSET', subtype: 'inventory' },
    { code: '14000', name: 'Fixed Assets', nameAr: 'الأصول الثابتة', type: 'ASSET', subtype: 'fixed_asset' },
    // Liabilities · 2xxxx
    { code: '21000', name: 'Accounts Payable', nameAr: 'الذمم الدائنة', type: 'LIABILITY', subtype: 'payable' },
    { code: '22000', name: 'VAT Payable', nameAr: 'ضريبة القيمة المضافة المستحقة', type: 'LIABILITY', subtype: 'tax' },
    { code: '23000', name: 'Loans Payable', nameAr: 'القروض', type: 'LIABILITY', subtype: 'loan' },
    // Equity · 3xxxx
    { code: '31000', name: 'Owner Equity', nameAr: 'حقوق الملكية', type: 'EQUITY' },
    { code: '32000', name: 'Retained Earnings', nameAr: 'الأرباح المحتجزة', type: 'EQUITY' },
    // Revenue · 4xxxx
    { code: '41000', name: 'Sales Revenue', nameAr: 'إيرادات المبيعات', type: 'REVENUE' },
    { code: '42000', name: 'Service Revenue', nameAr: 'إيرادات الخدمات', type: 'REVENUE' },
    // Expenses · 5xxxx
    { code: '51000', name: 'Cost of Goods Sold', nameAr: 'تكلفة البضاعة المباعة', type: 'EXPENSE' },
    { code: '52000', name: 'Salaries', nameAr: 'الرواتب', type: 'EXPENSE' },
    { code: '53000', name: 'Rent Expense', nameAr: 'مصروف الإيجار', type: 'EXPENSE' },
    { code: '54000', name: 'Utilities', nameAr: 'المرافق', type: 'EXPENSE' },
    { code: '55000', name: 'Office Supplies', nameAr: 'مستلزمات مكتبية', type: 'EXPENSE' },
    { code: '56000', name: 'Marketing', nameAr: 'التسويق', type: 'EXPENSE' },
    { code: '57000', name: 'Bank Fees', nameAr: 'رسوم بنكية', type: 'EXPENSE' },
    { code: '58000', name: 'Depreciation', nameAr: 'الإهلاك', type: 'EXPENSE' },
  ]

  await prisma.account.createMany({
    data: accounts.map((a) => ({ ...a, orgId })),
  })
}
