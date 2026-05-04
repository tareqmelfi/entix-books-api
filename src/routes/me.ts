import { Hono } from 'hono'
import { Prisma } from '@prisma/client'
import { requireAuth } from '../auth.js'
import { prisma } from '../db.js'

export const meRoutes = new Hono()

meRoutes.use('*', requireAuth)

// GET /me — current user + memberships
meRoutes.get('/', async (c) => {
  const auth = c.get('auth')
  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    include: {
      memberships: {
        include: {
          org: { select: { id: true, slug: true, name: true, baseCurrency: true, country: true } },
        },
      },
    },
  })
  return c.json(user)
})

// POST /me/bootstrap — first-time user · auto-create their first org
// Idempotent: if user already has an org, returns it.
meRoutes.post('/bootstrap', async (c) => {
  const auth = c.get('auth')

  const existing = await prisma.orgMembership.findFirst({
    where: { userId: auth.userId },
    include: { org: true },
    orderBy: { createdAt: 'asc' },
  })
  if (existing) return c.json({ org: existing.org, role: existing.role, created: false })

  const user = await prisma.user.findUnique({ where: { id: auth.userId } })
  const slug = `org-${Math.random().toString(36).slice(2, 10)}`
  const orgName = user?.name ? `${user.name} · شركتي` : 'شركتي'

  const org = await prisma.organization.create({
    data: {
      slug,
      name: orgName,
      country: 'SA',
      baseCurrency: 'SAR',
      memberships: {
        create: { userId: auth.userId, role: 'OWNER' },
      },
    },
  })

  // Seed default chart of accounts + tax rates + sample data so the user has something to play with
  await seedDefaultAccounts(org.id)
  const [vat15] = await Promise.all([
    prisma.taxRate.create({ data: { orgId: org.id, name: 'VAT 15%', rate: '0.15', type: 'STANDARD' } }),
    prisma.taxRate.create({ data: { orgId: org.id, name: 'VAT Exempt', rate: '0', type: 'EXEMPT' } }),
    prisma.taxRate.create({ data: { orgId: org.id, name: 'VAT 0%', rate: '0', type: 'ZERO_RATED' } }),
  ])
  await seedDemoData(org.id, vat15.id)

  return c.json({ org, role: 'OWNER', created: true }, 201)
})

// DELETE /me/account-data — wipe my org's data + leave the user (for retesting)
meRoutes.delete('/account-data', async (c) => {
  const auth = c.get('auth')
  const memberships = await prisma.orgMembership.findMany({
    where: { userId: auth.userId, role: 'OWNER' },
    select: { orgId: true },
  })
  for (const m of memberships) {
    await prisma.organization.delete({ where: { id: m.orgId } })
  }
  return c.json({ wiped: memberships.length })
})

async function seedDefaultAccounts(orgId: string) {
  const accounts: Array<{
    code: string
    name: string
    nameAr: string
    type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'
    subtype?: string
  }> = [
    { code: '11000', name: 'Cash on Hand', nameAr: 'النقد في الصندوق', type: 'ASSET', subtype: 'cash' },
    { code: '11100', name: 'Bank Accounts', nameAr: 'الحسابات البنكية', type: 'ASSET', subtype: 'bank' },
    { code: '12000', name: 'Accounts Receivable', nameAr: 'الذمم المدينة', type: 'ASSET', subtype: 'receivable' },
    { code: '13000', name: 'Inventory', nameAr: 'المخزون', type: 'ASSET', subtype: 'inventory' },
    { code: '14000', name: 'Fixed Assets', nameAr: 'الأصول الثابتة', type: 'ASSET', subtype: 'fixed_asset' },
    { code: '21000', name: 'Accounts Payable', nameAr: 'الذمم الدائنة', type: 'LIABILITY', subtype: 'payable' },
    { code: '22000', name: 'VAT Payable', nameAr: 'ضريبة القيمة المضافة المستحقة', type: 'LIABILITY', subtype: 'tax' },
    { code: '23000', name: 'Loans Payable', nameAr: 'القروض', type: 'LIABILITY', subtype: 'loan' },
    { code: '31000', name: 'Owner Equity', nameAr: 'حقوق الملكية', type: 'EQUITY' },
    { code: '32000', name: 'Retained Earnings', nameAr: 'الأرباح المحتجزة', type: 'EQUITY' },
    { code: '41000', name: 'Sales Revenue', nameAr: 'إيرادات المبيعات', type: 'REVENUE' },
    { code: '42000', name: 'Service Revenue', nameAr: 'إيرادات الخدمات', type: 'REVENUE' },
    { code: '51000', name: 'Cost of Goods Sold', nameAr: 'تكلفة البضاعة المباعة', type: 'EXPENSE' },
    { code: '52000', name: 'Salaries', nameAr: 'الرواتب', type: 'EXPENSE' },
    { code: '53000', name: 'Rent Expense', nameAr: 'مصروف الإيجار', type: 'EXPENSE' },
    { code: '54000', name: 'Utilities', nameAr: 'المرافق', type: 'EXPENSE' },
    { code: '55000', name: 'Office Supplies', nameAr: 'مستلزمات مكتبية', type: 'EXPENSE' },
    { code: '56000', name: 'Marketing', nameAr: 'التسويق', type: 'EXPENSE' },
    { code: '57000', name: 'Bank Fees', nameAr: 'رسوم بنكية', type: 'EXPENSE' },
    { code: '58000', name: 'Depreciation', nameAr: 'الإهلاك', type: 'EXPENSE' },
  ]
  await prisma.account.createMany({ data: accounts.map((a) => ({ ...a, orgId })) })
}

// Seeds 3 sample contacts · 1 invoice · 2 expenses · so the new user has data to test
async function seedDemoData(orgId: string, vat15Id: string) {
  const [c1, c2, c3] = await Promise.all([
    prisma.contact.create({
      data: {
        orgId,
        type: 'CUSTOMER',
        displayName: 'شركة الأمل التجارية',
        legalName: 'Al Amal Trading Co.',
        email: 'info@alamal.sa',
        phone: '+966555000111',
        vatNumber: '300000000000003',
        country: 'SA',
        city: 'الرياض',
      },
    }),
    prisma.contact.create({
      data: {
        orgId,
        type: 'CUSTOMER',
        displayName: 'مؤسسة النور',
        email: 'sales@alnoor.sa',
        phone: '+966555000222',
        country: 'SA',
        city: 'جدة',
      },
    }),
    prisma.contact.create({
      data: {
        orgId,
        type: 'SUPPLIER',
        displayName: 'شركة المواد الخام',
        email: 'orders@rawmat.sa',
        phone: '+966555000333',
        vatNumber: '310000000000003',
        country: 'SA',
        city: 'الدمام',
      },
    }),
  ])

  // Sample invoice for c1 (one line · 5000 SAR + 15% VAT)
  const today = new Date()
  const dueDate = new Date(today)
  dueDate.setDate(dueDate.getDate() + 30)
  await prisma.invoice.create({
    data: {
      orgId,
      contactId: c1.id,
      invoiceNumber: `INV-${today.getFullYear()}-00001`,
      status: 'SENT',
      issueDate: today,
      dueDate,
      currency: 'SAR',
      exchangeRate: new Prisma.Decimal(1),
      subtotal: new Prisma.Decimal(5000),
      taxTotal: new Prisma.Decimal(750),
      discountTotal: new Prisma.Decimal(0),
      total: new Prisma.Decimal(5750),
      notes: 'فاتورة تجريبية · يمكن تعديلها أو حذفها',
      lines: {
        create: [
          {
            description: 'خدمة استشارية',
            quantity: new Prisma.Decimal(1),
            unitPrice: new Prisma.Decimal(5000),
            discount: new Prisma.Decimal(0),
            taxRateId: vat15Id,
            subtotal: new Prisma.Decimal(5750),
          },
        ],
      },
    },
  })

  // 2 sample expenses
  await prisma.expense.createMany({
    data: [
      {
        orgId,
        number: `EXP-${today.getFullYear()}-0001`,
        date: today,
        category: 'Rent',
        description: 'إيجار المكتب',
        amount: new Prisma.Decimal(5000),
        currency: 'SAR',
        paymentMethod: 'BANK_TRANSFER',
        vendorName: 'مؤجر العقار',
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(5000),
      },
      {
        orgId,
        number: `EXP-${today.getFullYear()}-0002`,
        date: today,
        category: 'Utilities',
        description: 'كهرباء وماء',
        amount: new Prisma.Decimal(1200),
        currency: 'SAR',
        paymentMethod: 'CASH',
        vendorName: 'شركة الكهرباء',
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(1200),
      },
    ],
  })
}
