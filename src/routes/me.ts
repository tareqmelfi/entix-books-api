import { Hono } from 'hono'
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

  // Seed default chart of accounts (20 accounts) + tax rates
  await seedDefaultAccounts(org.id)
  await prisma.taxRate.createMany({
    data: [
      { orgId: org.id, name: 'VAT 15%', rate: '0.15', type: 'STANDARD' },
      { orgId: org.id, name: 'VAT Exempt', rate: '0', type: 'EXEMPT' },
      { orgId: org.id, name: 'VAT 0%', rate: '0', type: 'ZERO_RATED' },
    ],
  })

  return c.json({ org, role: 'OWNER', created: true }, 201)
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
