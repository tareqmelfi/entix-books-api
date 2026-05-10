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

// ── Team management · invite by email + role + remove ─────────────────────
const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER']).default('VIEWER'),
})

orgsRoutes.post('/:id/members/invite', zValidator('json', inviteSchema), async (c) => {
  const auth = c.get('auth')
  const orgId = c.req.param('id')
  const m = await prisma.orgMembership.findUnique({ where: { userId_orgId: { userId: auth.userId, orgId } } })
  if (!m) return c.json({ error: 'not_a_member' }, 403)
  if (m.role !== 'OWNER' && m.role !== 'ADMIN') return c.json({ error: 'forbidden' }, 403)
  const { email, role } = c.req.valid('json')

  // Find or create user · for now we just create membership directly; in production
  // this should send a magic link email and let the user accept the invite
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
  if (!user) {
    // Better-auth requires explicit signup · for now return a partial success with the invite URL
    const inviteUrl = `${process.env.PUBLIC_FRONTEND_URL || 'https://entix.io'}/signup?invite=${encodeURIComponent(email)}&org=${orgId}`
    return c.json({ ok: true, pending: true, email, role, inviteUrl, message: 'المستخدم لم يُسجَّل بعد · أرسل له هذا الرابط' })
  }

  const existing = await prisma.orgMembership.findUnique({ where: { userId_orgId: { userId: user.id, orgId } } })
  if (existing) return c.json({ error: 'already_member', currentRole: existing.role }, 409)

  const membership = await prisma.orgMembership.create({
    data: { userId: user.id, orgId, role },
    include: { user: { select: { id: true, email: true, name: true } } },
  })
  return c.json({ ok: true, member: membership }, 201)
})

orgsRoutes.patch('/:id/members/:memberId', zValidator('json', z.object({ role: z.enum(['OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER']) })), async (c) => {
  const auth = c.get('auth')
  const orgId = c.req.param('id')
  const memberId = c.req.param('memberId')
  const m = await prisma.orgMembership.findUnique({ where: { userId_orgId: { userId: auth.userId, orgId } } })
  if (!m || (m.role !== 'OWNER' && m.role !== 'ADMIN')) return c.json({ error: 'forbidden' }, 403)
  const target = await prisma.orgMembership.findUnique({ where: { id: memberId } })
  if (!target || target.orgId !== orgId) return c.json({ error: 'not_found' }, 404)
  const { role } = c.req.valid('json')
  await prisma.orgMembership.update({ where: { id: memberId }, data: { role } })
  return c.json({ ok: true })
})

orgsRoutes.delete('/:id/members/:memberId', async (c) => {
  const auth = c.get('auth')
  const orgId = c.req.param('id')
  const memberId = c.req.param('memberId')
  const m = await prisma.orgMembership.findUnique({ where: { userId_orgId: { userId: auth.userId, orgId } } })
  if (!m || (m.role !== 'OWNER' && m.role !== 'ADMIN')) return c.json({ error: 'forbidden' }, 403)
  const target = await prisma.orgMembership.findUnique({ where: { id: memberId } })
  if (!target || target.orgId !== orgId) return c.json({ error: 'not_found' }, 404)
  if (target.userId === auth.userId) return c.json({ error: 'cannot_remove_self' }, 400)
  await prisma.orgMembership.delete({ where: { id: memberId } })
  return c.body(null, 204)
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


// ── POST /:id/seed-demo-data · fill an existing org with demo dataset (UX-173) ──
orgsRoutes.post('/:id/seed-demo-data', async (c) => {
  const auth = c.get('auth') as any
  if (!auth?.userId) return c.json({ error: 'unauthorized' }, 401)
  const orgId = c.req.param('id')
  const member = await prisma.orgMembership.findUnique({
    where: { userId_orgId: { userId: auth.userId, orgId } },
  })
  if (!member) return c.json({ error: 'forbidden' }, 403)

  const today = new Date()
  let seeded = { accounts: 0, contacts: 0, products: 0, invoices: 0, bills: 0, expenses: 0, vouchers: 0, journals: 0 }

  // ── Accounts ─────────────────────────────────────────────────────────────
  const ACC = [
    ['1000','Cash on Hand','الصندوق','ASSET',{cashFlowType:'OPERATING',allowPayment:true}],
    ['1010','Mercury USD','مرکري دولار','ASSET',{cashFlowType:'OPERATING',allowPayment:true}],
    ['1100','Accounts Receivable','العملاء','ASSET',{cashFlowType:'OPERATING',isSystemAccount:true}],
    ['1200','Inventory','المخزون','ASSET',{cashFlowType:'OPERATING'}],
    ['2000','Accounts Payable','الموردون','LIABILITY',{cashFlowType:'OPERATING',isSystemAccount:true}],
    ['2100','VAT Payable','ضريبة القيمة المضافة','LIABILITY',{cashFlowType:'OPERATING',isSystemAccount:true}],
    ['3000','Owner Capital','رأس المال','EQUITY',{cashFlowType:'FINANCING'}],
    ['4000','Sales Revenue','إيرادات المبيعات','REVENUE',{cashFlowType:'OPERATING'}],
    ['4100','Services Revenue','إيرادات الخدمات','REVENUE',{cashFlowType:'OPERATING'}],
    ['5000','Cost of Goods Sold','تكلفة البضاعة','EXPENSE',{cashFlowType:'OPERATING'}],
    ['6100','Salaries Expense','مصاريف الرواتب','EXPENSE',{cashFlowType:'OPERATING',allowExpenseClaim:true}],
    ['6200','Rent Expense','مصاريف الإيجار','EXPENSE',{cashFlowType:'OPERATING',allowExpenseClaim:true}],
  ] as Array<[string,string,string,string,any]>

  const accCache: Record<string, any> = {}
  for (const [code, name, nameAr, type, extra] of ACC) {
    const existing = await prisma.account.findFirst({ where: { orgId, code } })
    if (existing) { accCache[code] = existing; continue }
    const created = await prisma.account.create({
      data: { orgId, code, name, nameAr, type: type as any, ...extra },
    })
    accCache[code] = created
    seeded.accounts++
  }

  // ── Contacts ─────────────────────────────────────────────────────────────
  const customers = [
    { displayName: 'Acme Corporation', email: 'ap@acme.com', phone: '+966112345678', taxId: '300123456789003', country: 'SA', city: 'Riyadh', kind: 'COMPANY' },
    { displayName: 'Ahmad Trading Co', email: 'finance@ahmad.sa', phone: '+966551234567', taxId: '300987654321003', country: 'SA', city: 'Jeddah', kind: 'COMPANY' },
    { displayName: 'Sarah AlMutairi', email: 'sarah@gmail.com', phone: '+966505555555', country: 'SA', kind: 'INDIVIDUAL' },
    { displayName: 'TechStart Inc', email: 'billing@techstart.io', taxId: '88-1234567', country: 'US', city: 'San Francisco', kind: 'COMPANY' },
    { displayName: 'Crescent Real Estate', email: 'cfo@crescent.sa', phone: '+966114567890', taxId: '300555111223003', country: 'SA', kind: 'COMPANY' },
  ]
  const suppliers = [
    { displayName: 'Cloudflare Inc', email: 'billing@cloudflare.com', taxId: '27-3441673', country: 'US', kind: 'COMPANY' },
    { displayName: 'STC Business', email: 'b2b@stc.com.sa', phone: '+966114000000', taxId: '300111222333003', country: 'SA', kind: 'COMPANY' },
    { displayName: 'AWS', email: 'aws-billing@amazon.com', taxId: '91-1646860', country: 'US', kind: 'COMPANY' },
  ]

  const cIds: string[] = []
  for (let i = 0; i < customers.length; i++) {
    const c = customers[i]
    const code = `CUST-${String(i + 1).padStart(4,'0')}`
    const existing = await prisma.contact.findFirst({ where: { orgId, customCode: code } })
    if (existing) { cIds.push(existing.id); continue }
    const r = await prisma.contact.create({ data: { orgId, customCode: code, type: 'CUSTOMER' as any, isCustomer: true, entityKind: c.kind as any, displayName: c.displayName, email: c.email, phone: c.phone || null, taxId: c.taxId || null, country: c.country, city: c.city || null }})
    cIds.push(r.id); seeded.contacts++
  }
  const sIds: string[] = []
  for (let i = 0; i < suppliers.length; i++) {
    const s = suppliers[i]
    const code = `SUPP-${String(i + 1).padStart(4,'0')}`
    const existing = await prisma.contact.findFirst({ where: { orgId, customCode: code } })
    if (existing) { sIds.push(existing.id); continue }
    const r = await prisma.contact.create({ data: { orgId, customCode: code, type: 'SUPPLIER' as any, isSupplier: true, entityKind: s.kind as any, displayName: s.displayName, email: s.email, phone: s.phone || null, taxId: s.taxId || null, country: s.country }})
    sIds.push(r.id); seeded.contacts++
  }

  // ── Products ─────────────────────────────────────────────────────────────
  const products = [
    { code: 'CONS-HR', name: 'Consulting · Per Hour', sellPrice: '500', kind: 'SERVICE' },
    { code: 'WEB-DEV', name: 'Website Development', sellPrice: '15000', kind: 'SERVICE' },
    { code: 'SAAS-MO', name: 'SaaS Subscription · Monthly', sellPrice: '299', kind: 'SERVICE' },
    { code: 'LAPTOP-PRO', name: 'MacBook Pro 16"', sellPrice: '13500', kind: 'GOOD' },
    { code: 'CHAIR-ERG', name: 'Ergonomic Chair', sellPrice: '2500', kind: 'GOOD' },
  ]
  const pIds: string[] = []
  for (const p of products) {
    const existing = await prisma.product.findFirst({ where: { orgId, code: p.code } })
    if (existing) { pIds.push(existing.id); continue }
    const r = await prisma.product.create({ data: { orgId, code: p.code, name: p.name, sellPrice: p.sellPrice, kind: p.kind as any, isActive: true, taxRate: '0.15', revenueAccountId: p.kind === 'GOOD' ? accCache['4000']?.id : accCache['4100']?.id, expenseAccountId: accCache['5000']?.id }})
    pIds.push(r.id); seeded.products++
  }

  // ── Invoices ─────────────────────────────────────────────────────────────
  for (let i = 1; i <= 10; i++) {
    const number = `DEMO-INV-${String(i).padStart(4,'0')}`
    const existing = await prisma.invoice.findFirst({ where: { orgId, invoiceNumber: number } })
    if (existing) continue
    const customerId = cIds[i % cIds.length]
    const productId = pIds[i % pIds.length]
    const product = await prisma.product.findUnique({ where: { id: productId } })
    if (!product) continue
    const qty = 1 + Math.floor(Math.random() * 3)
    const unit = Number(product.sellPrice)
    const subtotal = qty * unit
    const taxAmount = subtotal * 0.15
    const total = subtotal + taxAmount
    const issueDate = new Date(today.getTime() - i * 5 * 86400000)
    const r = Math.random()
    const status = i <= 2 ? 'DRAFT' : r < 0.5 ? 'PAID' : 'APPROVED'
    await prisma.invoice.create({ data: { orgId, contactId: customerId, invoiceNumber: number, issueDate, dueDate: new Date(issueDate.getTime() + 30 * 86400000), currency: 'SAR', subtotal: subtotal.toFixed(2), taxAmount: taxAmount.toFixed(2), total: total.toFixed(2), amountPaid: status === 'PAID' ? total.toFixed(2) : '0', status, lines: { create: [{ description: product.name, quantity: String(qty), unitPrice: product.sellPrice, taxRate: '0.15', taxInclusive: false, productId: product.id, total: subtotal.toFixed(2) }] } } })
    seeded.invoices++
  }

  // ── Expenses ────────────────────────────────────────────────────────────
  const cats = ['Office Rent', 'Salaries', 'Utilities', 'Travel', 'Software']
  for (let i = 1; i <= 10; i++) {
    const number = `DEMO-EXP-${String(i).padStart(4,'0')}`
    const existing = await prisma.expense.findFirst({ where: { orgId, number } })
    if (existing) continue
    const amount = 200 + Math.floor(Math.random() * 3000)
    await prisma.expense.create({ data: { orgId, number, date: new Date(today.getTime() - i * 3 * 86400000), category: cats[i % cats.length], currency: 'SAR', subtotal: amount.toFixed(2), taxAmount: (amount * 0.15).toFixed(2), total: (amount * 1.15).toFixed(2), paymentMethod: 'CASH' as any, description: `${cats[i % cats.length]} expense` } })
    seeded.expenses++
  }

  return c.json({ ok: true, seeded })
})
