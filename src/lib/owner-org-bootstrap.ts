import { Prisma, type PrismaClient } from '@prisma/client'
import { buildCoaForIndustry, type AccountSeed } from './coa-templates.js'

type Tx = Prisma.TransactionClient
type AccountType = AccountSeed['type']
type CashFlowType = 'OPERATING' | 'INVESTING' | 'FINANCING' | 'NON_CASH'

export type OwnerOrgKey = 'ensidex' | 'falcon-core'

type ExtendedAccountSeed = AccountSeed & {
  cashFlowType?: CashFlowType
  allowPosting?: boolean
  allowPayment?: boolean
  allowExpenseClaim?: boolean
  isSystemAccount?: boolean
}

type ContactSeed = {
  customCode: string
  displayName: string
  legalName?: string
  email?: string
  country: string
  city?: string
  taxId?: string
  roles: Array<'customer' | 'supplier'>
}

type ProductSeed = {
  sku: string
  name: string
  nameAr: string
  type: 'SERVICE' | 'SUBSCRIPTION' | 'DIGITAL'
  category: string
  billingCycle?: string
  unitPrice: string
  incomeAccountCode: string
  expenseAccountCode?: string
}

type InvoiceSeed = {
  invoiceNumber: string
  contactCode: string
  status: 'DRAFT' | 'SENT' | 'PAID'
  issueOffsetDays: number
  dueInDays: number
  lines: Array<{ sku: string; quantity: string; unitPrice?: string; description?: string }>
}

type BillSeed = {
  billNumber: string
  contactCode: string
  status: 'RECEIVED' | 'PAID'
  issueOffsetDays: number
  dueInDays: number
  description: string
  subtotal: string
}

type OwnerOrgConfig = {
  key: OwnerOrgKey
  slug: string
  name: string
  legalName: string
  country: string
  state: string
  baseCurrency: string
  industry: string
  website?: string
  addressLine?: string
  city: string
  postalCode?: string
  numberingPrefix: string
  openingBalance: string
  contacts: ContactSeed[]
  products: ProductSeed[]
  invoices: InvoiceSeed[]
  bills: BillSeed[]
}

export const OWNER_ORG_BOOTSTRAPS: OwnerOrgConfig[] = [
  {
    key: 'ensidex',
    slug: 'ensidex',
    name: 'ENSIDEX',
    legalName: 'ENSIDEX LLC',
    country: 'US',
    state: 'WY',
    baseCurrency: 'USD',
    industry: 'AI finance software and consulting',
    website: 'https://ensidex.com',
    addressLine: 'Wyoming, USA',
    city: 'Sheridan',
    postalCode: '82801',
    numberingPrefix: 'EN',
    openingBalance: '15000',
    contacts: [
      { customCode: 'EN-CUST-001', displayName: 'Northstar Retail LLC', legalName: 'Northstar Retail LLC', email: 'ap@northstar.example', country: 'US', city: 'Austin', roles: ['customer'] },
      { customCode: 'EN-CUST-002', displayName: 'Riyadh Operations Co.', legalName: 'Riyadh Operations Company', email: 'finance@riyadh-ops.example', country: 'SA', city: 'Riyadh', taxId: '300123456789003', roles: ['customer'] },
      { customCode: 'EN-CUST-003', displayName: 'Blue Harbor Studio LLC', legalName: 'Blue Harbor Studio LLC', email: 'billing@blueharbor.example', country: 'US', city: 'Miami', roles: ['customer'] },
      { customCode: 'EN-SUPP-001', displayName: 'Cloud Platform Vendor', legalName: 'Cloud Platform Vendor Inc.', email: 'billing@cloud-vendor.example', country: 'US', city: 'Seattle', roles: ['supplier'] },
      { customCode: 'EN-SUPP-002', displayName: 'AI Infrastructure Vendor', legalName: 'AI Infrastructure Vendor Inc.', email: 'billing@ai-infra.example', country: 'US', city: 'San Francisco', roles: ['supplier'] },
      { customCode: 'EN-SUPP-003', displayName: 'Compliance Services Office', legalName: 'Compliance Services Office LLC', email: 'accounts@compliance-office.example', country: 'US', city: 'Cheyenne', roles: ['supplier'] },
    ],
    products: [
      { sku: 'EN-AI-SPRINT', name: 'AI Finance Automation Sprint', nameAr: 'حزمة أتمتة مالية بالذكاء الاصطناعي', type: 'SERVICE', category: 'AI', unitPrice: '3500', incomeAccountCode: '42110', expenseAccountCode: '67200' },
      { sku: 'EN-BOOKS-SETUP', name: 'Accounting Setup and Migration', nameAr: 'إعداد وترحيل النظام المحاسبي', type: 'SERVICE', category: 'Accounting', unitPrice: '2500', incomeAccountCode: '42120', expenseAccountCode: '67200' },
      { sku: 'EN-RET-MONTHLY', name: 'Monthly Advisory Retainer', nameAr: 'اشتراك استشاري شهري', type: 'SUBSCRIPTION', category: 'Retainer', billingCycle: 'MONTHLY', unitPrice: '1500', incomeAccountCode: '42130', expenseAccountCode: '67200' },
      { sku: 'EN-SUB-SMB', name: 'Entix Books SMB Subscription', nameAr: 'اشتراك Entix Books للشركات الصغيرة', type: 'SUBSCRIPTION', category: 'SaaS', billingCycle: 'MONTHLY', unitPrice: '99', incomeAccountCode: '42210', expenseAccountCode: '62110' },
    ],
    invoices: [
      { invoiceNumber: 'EN-INV-2026-0001', contactCode: 'EN-CUST-001', status: 'SENT', issueOffsetDays: 10, dueInDays: 20, lines: [{ sku: 'EN-AI-SPRINT', quantity: '1' }] },
      { invoiceNumber: 'EN-INV-2026-0002', contactCode: 'EN-CUST-002', status: 'DRAFT', issueOffsetDays: 4, dueInDays: 30, lines: [{ sku: 'EN-BOOKS-SETUP', quantity: '1' }, { sku: 'EN-RET-MONTHLY', quantity: '1' }] },
      { invoiceNumber: 'EN-INV-2026-0003', contactCode: 'EN-CUST-003', status: 'PAID', issueOffsetDays: 35, dueInDays: 15, lines: [{ sku: 'EN-SUB-SMB', quantity: '6' }] },
    ],
    bills: [
      { billNumber: 'EN-BILL-2026-0001', contactCode: 'EN-SUPP-001', status: 'RECEIVED', issueOffsetDays: 8, dueInDays: 22, description: 'Cloud hosting and storage', subtotal: '420' },
      { billNumber: 'EN-BILL-2026-0002', contactCode: 'EN-SUPP-002', status: 'PAID', issueOffsetDays: 22, dueInDays: 15, description: 'AI API usage', subtotal: '680' },
    ],
  },
  {
    key: 'falcon-core',
    slug: 'falcon-core',
    name: 'Falcon Core',
    legalName: 'FALCON CORE LLC',
    country: 'US',
    state: 'WY',
    baseCurrency: 'USD',
    industry: 'Management consulting and venture operations',
    website: 'https://fc.sa',
    addressLine: 'Wyoming, USA',
    city: 'Sheridan',
    postalCode: '82801',
    numberingPrefix: 'FC',
    openingBalance: '25000',
    contacts: [
      { customCode: 'FC-CUST-001', displayName: 'Summit Operations LLC', legalName: 'Summit Operations LLC', email: 'ap@summit-ops.example', country: 'US', city: 'Dallas', roles: ['customer'] },
      { customCode: 'FC-CUST-002', displayName: 'Eastern Growth Co.', legalName: 'Eastern Growth Company', email: 'finance@eastern-growth.example', country: 'SA', city: 'Dammam', taxId: '300987654321003', roles: ['customer'] },
      { customCode: 'FC-SUPP-001', displayName: 'Legal and Compliance Partner', legalName: 'Legal and Compliance Partner LLC', email: 'billing@legal-partner.example', country: 'US', city: 'Cheyenne', roles: ['supplier'] },
      { customCode: 'FC-SUPP-002', displayName: 'Research Data Vendor', legalName: 'Research Data Vendor Inc.', email: 'accounts@research-data.example', country: 'US', city: 'New York', roles: ['supplier'] },
      { customCode: 'FC-SUPP-003', displayName: 'Operations Contractor', legalName: 'Operations Contractor LLC', email: 'billing@ops-contractor.example', country: 'US', city: 'Phoenix', roles: ['supplier'] },
    ],
    products: [
      { sku: 'FC-ADVISORY', name: 'Strategic Advisory Retainer', nameAr: 'اشتراك استشارات استراتيجية', type: 'SUBSCRIPTION', category: 'Advisory', billingCycle: 'MONTHLY', unitPrice: '3000', incomeAccountCode: '42100', expenseAccountCode: '67200' },
      { sku: 'FC-SYSTEMS', name: 'Business Systems Implementation', nameAr: 'تنفيذ أنظمة الأعمال', type: 'SERVICE', category: 'Systems', unitPrice: '5500', incomeAccountCode: '42300', expenseAccountCode: '67200' },
      { sku: 'FC-RESEARCH', name: 'Investor Research Package', nameAr: 'حزمة أبحاث استثمارية', type: 'DIGITAL', category: 'Research', unitPrice: '1800', incomeAccountCode: '42130', expenseAccountCode: '62120' },
    ],
    invoices: [
      { invoiceNumber: 'FC-INV-2026-0001', contactCode: 'FC-CUST-001', status: 'SENT', issueOffsetDays: 12, dueInDays: 18, lines: [{ sku: 'FC-ADVISORY', quantity: '1' }] },
      { invoiceNumber: 'FC-INV-2026-0002', contactCode: 'FC-CUST-002', status: 'DRAFT', issueOffsetDays: 2, dueInDays: 30, lines: [{ sku: 'FC-SYSTEMS', quantity: '1' }, { sku: 'FC-RESEARCH', quantity: '1' }] },
      { invoiceNumber: 'FC-INV-2026-0003', contactCode: 'FC-CUST-001', status: 'PAID', issueOffsetDays: 40, dueInDays: 15, lines: [{ sku: 'FC-RESEARCH', quantity: '2' }] },
    ],
    bills: [
      { billNumber: 'FC-BILL-2026-0001', contactCode: 'FC-SUPP-001', status: 'RECEIVED', issueOffsetDays: 9, dueInDays: 21, description: 'Registered agent and compliance support', subtotal: '300' },
      { billNumber: 'FC-BILL-2026-0002', contactCode: 'FC-SUPP-002', status: 'PAID', issueOffsetDays: 24, dueInDays: 15, description: 'Market data subscription', subtotal: '950' },
    ],
  },
]

const OWNER_SPECIFIC_ACCOUNTS: ExtendedAccountSeed[] = [
  { code: '11110', name: 'Operating Checking Account', nameAr: 'الحساب الجاري التشغيلي', type: 'ASSET', subtype: 'bank', parentCode: '11100', cashFlowType: 'OPERATING', allowPayment: true, isSystemAccount: true },
  { code: '11120', name: 'Operating Savings Account', nameAr: 'حساب التوفير التشغيلي', type: 'ASSET', subtype: 'bank', parentCode: '11100', cashFlowType: 'OPERATING', allowPayment: true },
  { code: '11210', name: 'Stripe Clearing', nameAr: 'حساب تسوية Stripe', type: 'ASSET', subtype: 'payment-clearing', parentCode: '12000', cashFlowType: 'OPERATING', allowPayment: true },
  { code: '11220', name: 'Card Processor Clearing', nameAr: 'حساب تسوية بوابات الدفع', type: 'ASSET', subtype: 'payment-clearing', parentCode: '12000', cashFlowType: 'OPERATING', allowPayment: true },
  { code: '17000', name: 'Intangible Assets', nameAr: 'الأصول غير الملموسة', type: 'ASSET', subtype: 'intangible', cashFlowType: 'INVESTING' },
  { code: '17100', name: 'Software and Platform IP', nameAr: 'البرمجيات وحقوق الملكية الفكرية', type: 'ASSET', subtype: 'intangible', parentCode: '17000', cashFlowType: 'INVESTING' },
  { code: '22110', name: 'Sales Tax Payable', nameAr: 'ضريبة المبيعات المستحقة', type: 'LIABILITY', subtype: 'tax-payable', parentCode: '22000', cashFlowType: 'OPERATING', isSystemAccount: true },
  { code: '24400', name: 'Credit Cards Payable', nameAr: 'بطاقات ائتمان مستحقة الدفع', type: 'LIABILITY', subtype: 'credit-card', parentCode: '24000', cashFlowType: 'OPERATING', allowPayment: true },
  { code: '31200', name: 'LLC Members Equity', nameAr: 'حقوق أعضاء الشركة ذات المسؤولية المحدودة', type: 'EQUITY', subtype: 'llc-members-equity', parentCode: '31000', cashFlowType: 'FINANCING', isSystemAccount: true },
  { code: '42110', name: 'AI Automation Revenue', nameAr: 'إيرادات أتمتة الذكاء الاصطناعي', type: 'REVENUE', subtype: 'service', parentCode: '42000', cashFlowType: 'OPERATING' },
  { code: '42120', name: 'Accounting Setup Revenue', nameAr: 'إيرادات إعداد الأنظمة المحاسبية', type: 'REVENUE', subtype: 'service', parentCode: '42000', cashFlowType: 'OPERATING' },
  { code: '42130', name: 'Retainer Revenue', nameAr: 'إيرادات الاشتراكات الاستشارية', type: 'REVENUE', subtype: 'service', parentCode: '42000', cashFlowType: 'OPERATING' },
  { code: '42210', name: 'Software Subscription Revenue', nameAr: 'إيرادات اشتراكات البرمجيات', type: 'REVENUE', subtype: 'subscription', parentCode: '42000', cashFlowType: 'OPERATING' },
  { code: '62100', name: 'Hosting and Cloud Infrastructure', nameAr: 'استضافة وبنية سحابية', type: 'EXPENSE', subtype: 'cloud', parentCode: '67000', cashFlowType: 'OPERATING', allowExpenseClaim: true },
  { code: '62110', name: 'AI API Usage', nameAr: 'استخدام واجهات الذكاء الاصطناعي', type: 'EXPENSE', subtype: 'ai-api', parentCode: '67000', cashFlowType: 'OPERATING', allowExpenseClaim: true },
  { code: '62120', name: 'Software Subscriptions', nameAr: 'اشتراكات البرامج', type: 'EXPENSE', subtype: 'software', parentCode: '67000', cashFlowType: 'OPERATING', allowExpenseClaim: true },
  { code: '67210', name: 'Delivery Contractors', nameAr: 'مقاولو التنفيذ', type: 'EXPENSE', subtype: 'subcontractor', parentCode: '67200', cashFlowType: 'OPERATING', allowExpenseClaim: true },
  { code: '71100', name: 'Merchant Processing Fees', nameAr: 'رسوم معالجة المدفوعات', type: 'EXPENSE', subtype: 'merchant-fees', parentCode: '71000', cashFlowType: 'OPERATING' },
]

export function buildOwnerOrgAccountPlan(): ExtendedAccountSeed[] {
  const seen = new Map<string, ExtendedAccountSeed>()
  for (const seed of [...buildCoaForIndustry('services'), ...OWNER_SPECIFIC_ACCOUNTS]) {
    seen.set(seed.code, { ...defaultAccountFlags(seed), ...seed })
  }
  return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code, 'en'))
}

export function validateOwnerOrgPlan() {
  const accounts = buildOwnerOrgAccountPlan()
  const byCode = new Map(accounts.map((a) => [a.code, a]))
  const missingParents = accounts
    .filter((a) => a.parentCode && !byCode.has(a.parentCode))
    .map((a) => `${a.code}->${a.parentCode}`)
  const countsByType = accounts.reduce<Record<AccountType, number>>((acc, account) => {
    acc[account.type] = (acc[account.type] || 0) + 1
    return acc
  }, { ASSET: 0, LIABILITY: 0, EQUITY: 0, REVENUE: 0, EXPENSE: 0 })
  return {
    accountCount: accounts.length,
    countsByType,
    missingParents,
    requiredCodesPresent: ['11110', '12000', '21000', '31200', '42110', '62110', '71100'].every((code) => byCode.has(code)),
  }
}

export function summarizeOwnerOrgPlan() {
  const accountValidation = validateOwnerOrgPlan()
  return OWNER_ORG_BOOTSTRAPS.map((org) => ({
    slug: org.slug,
    legalName: org.legalName,
    ownerEmailRequired: true,
    accounts: accountValidation.accountCount,
    accountsByType: accountValidation.countsByType,
    contacts: org.contacts.length,
    customers: org.contacts.filter((c) => c.roles.includes('customer')).length,
    suppliers: org.contacts.filter((c) => c.roles.includes('supplier')).length,
    products: org.products.length,
    invoices: org.invoices.length,
    bills: org.bills.length,
    openingBalance: org.openingBalance,
  }))
}

function defaultAccountFlags(seed: AccountSeed): Partial<ExtendedAccountSeed> {
  const subtype = seed.subtype || ''
  let cashFlowType: CashFlowType = 'OPERATING'
  if (seed.type === 'EQUITY') cashFlowType = 'FINANCING'
  if (subtype.includes('fixed') || subtype.includes('intangible')) cashFlowType = 'INVESTING'
  if (subtype.includes('depreciation') || subtype.includes('retained')) cashFlowType = 'NON_CASH'

  return {
    cashFlowType,
    allowPosting: true,
    allowPayment: seed.type === 'ASSET' && /(cash|bank|payment-clearing)/.test(subtype),
    allowExpenseClaim: seed.type === 'EXPENSE' && !/(cogs|depreciation|interest)/.test(subtype),
    isSystemAccount: ['12000', '21000', '22000', '31000', '32000', '41000', '42000', '51000'].includes(seed.code),
  }
}

export async function bootstrapOwnerOrganizations(
  client: PrismaClient,
  options: { ownerEmail?: string; orgKey?: OwnerOrgKey; resetSamples?: boolean } = {},
) {
  const ownerEmail = (options.ownerEmail || 'tareq@fc.sa').trim().toLowerCase()
  const configs = options.orgKey
    ? OWNER_ORG_BOOTSTRAPS.filter((config) => config.key === options.orgKey)
    : OWNER_ORG_BOOTSTRAPS
  return client.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { email: ownerEmail },
      update: { emailVerified: true, locale: 'ar' },
      create: { email: ownerEmail, emailVerified: true, locale: 'ar', name: 'Account Owner' },
    })

    const results = []
    for (const config of configs) {
      const result = await ensureOwnerOrg(tx, config, user.id, options.resetSamples === true)
      results.push(result)
    }
    return {
      ownerEmail,
      userId: user.id,
      orgs: results,
      plan: summarizeOwnerOrgPlan(),
      note: 'If the user row was newly created, set a password through the existing admin reset route or normal signup flow.',
    }
  }, { timeout: 60_000 })
}

async function ensureOwnerOrg(tx: Tx, config: OwnerOrgConfig, userId: string, resetSamples: boolean) {
  const org = await tx.organization.upsert({
    where: { slug: config.slug },
    update: {
      name: config.name,
      legalName: config.legalName,
      country: config.country,
      state: config.state,
      baseCurrency: config.baseCurrency,
      fiscalYearStart: 1,
      fiscalYearEnd: 12,
      defaultInvoiceLanguage: 'en',
      industry: config.industry,
      website: config.website || null,
      addressLine: config.addressLine || null,
      city: config.city,
      postalCode: config.postalCode || null,
      email: 'tareq@fc.sa',
      numberingSettings: numberingSettings(config.numberingPrefix),
      paymentSettings: {
        reports: {
          language: 'en',
          paperSize: 'letter',
          orientation: 'portrait',
          density: 'comfortable',
          primaryColor: '#1D4ED8',
          accentColor: '#0B1B49',
          showCompanyDetails: true,
        },
      },
    },
    create: {
      slug: config.slug,
      name: config.name,
      legalName: config.legalName,
      country: config.country,
      state: config.state,
      baseCurrency: config.baseCurrency,
      fiscalYearStart: 1,
      fiscalYearEnd: 12,
      defaultInvoiceLanguage: 'en',
      industry: config.industry,
      website: config.website || null,
      addressLine: config.addressLine || null,
      city: config.city,
      postalCode: config.postalCode || null,
      email: 'tareq@fc.sa',
      zatcaEnabled: false,
      zatcaMode: 'sandbox',
      numberingSettings: numberingSettings(config.numberingPrefix),
      paymentSettings: {
        reports: {
          language: 'en',
          paperSize: 'letter',
          orientation: 'portrait',
          density: 'comfortable',
          primaryColor: '#1D4ED8',
          accentColor: '#0B1B49',
          showCompanyDetails: true,
        },
      },
    },
  })

  await tx.orgMembership.upsert({
    where: { userId_orgId: { userId, orgId: org.id } },
    update: { role: 'OWNER' },
    create: { userId, orgId: org.id, role: 'OWNER' },
  })

  const taxRates = await ensureTaxRates(tx, org.id)
  const accounts = await ensureAccounts(tx, org.id)
  const bankAccount = await ensureBankAccount(tx, org.id, config, accounts.get('11110')?.id || null)

  if (resetSamples) {
    await resetSeededSamples(tx, org.id, config)
  }

  const contacts = await ensureContacts(tx, org.id, config.contacts)
  const products = await ensureProducts(tx, org.id, config.products, taxRates.noTax?.id || null, accounts)
  await ensureInvoices(tx, org.id, config, contacts, products, taxRates.noTax?.id || null, bankAccount?.id || null)
  await ensureBills(tx, org.id, config, contacts, taxRates.noTax?.id || null, bankAccount?.id || null)
  await ensureOpeningJournal(tx, org.id, config, accounts)
  await ensureFiscalPeriods(tx, org.id, 2026)
  await tx.auditLog.create({
    data: {
      orgId: org.id,
      userId,
      action: 'OWNER_ORG_BOOTSTRAP',
      entityType: 'Organization',
      entityId: org.id,
      severity: 'INFO',
      metadata: {
        slug: config.slug,
        resetSamples,
        accounts: accounts.size,
        contacts: contacts.size,
        products: products.size,
      },
    },
  })

  return {
    orgId: org.id,
    slug: org.slug,
    legalName: org.legalName,
    accounts: accounts.size,
    contacts: contacts.size,
    products: products.size,
    invoices: config.invoices.length,
    bills: config.bills.length,
    bankAccount: bankAccount?.name || null,
  }
}

function numberingSettings(prefix: string) {
  return {
    entityCode: prefix,
    contact: { prefix: `${prefix}-CON-`, padding: 4, start: 1 },
    invoice: { prefix: `${prefix}-INV-{YYYY}{MM}-`, padding: 4, start: 1 },
    bill: { prefix: `${prefix}-BIL-{YYYY}{MM}-`, padding: 4, start: 1 },
    quote: { prefix: `${prefix}-QTE-{YYYY}{MM}-`, padding: 4, start: 1 },
    receipt: { prefix: `${prefix}-RCP-{YYYY}{MM}-`, padding: 4, start: 1 },
    payment: { prefix: `${prefix}-RCP-{YYYY}{MM}-`, padding: 4, start: 1 },
  }
}

async function ensureAccounts(tx: Tx, orgId: string) {
  const accountMap = new Map<string, { id: string; code: string }>()
  const plan = buildOwnerOrgAccountPlan()

  for (const account of plan) {
    const saved = await tx.account.upsert({
      where: { orgId_code: { orgId, code: account.code } },
      update: {
        name: account.name,
        nameAr: account.nameAr,
        type: account.type,
        subtype: account.subtype || null,
        description: account.description || null,
        cashFlowType: account.cashFlowType || null,
        allowPosting: account.allowPosting ?? true,
        allowPayment: account.allowPayment ?? false,
        allowExpenseClaim: account.allowExpenseClaim ?? false,
        isSystemAccount: account.isSystemAccount ?? false,
        isActive: true,
      },
      create: {
        orgId,
        code: account.code,
        name: account.name,
        nameAr: account.nameAr,
        type: account.type,
        subtype: account.subtype || null,
        description: account.description || null,
        cashFlowType: account.cashFlowType || null,
        allowPosting: account.allowPosting ?? true,
        allowPayment: account.allowPayment ?? false,
        allowExpenseClaim: account.allowExpenseClaim ?? false,
        isSystemAccount: account.isSystemAccount ?? false,
      },
      select: { id: true, code: true },
    })
    accountMap.set(saved.code, saved)
  }

  for (const account of plan) {
    if (!account.parentCode) continue
    const child = accountMap.get(account.code)
    const parent = accountMap.get(account.parentCode)
    if (child && parent) {
      await tx.account.update({ where: { id: child.id }, data: { parentId: parent.id } })
    }
  }

  return accountMap
}

async function ensureTaxRates(tx: Tx, orgId: string) {
  const noTax = await ensureTaxRate(tx, orgId, 'No Tax', '0', 'EXEMPT')
  const usSalesTaxPlaceholder = await ensureTaxRate(tx, orgId, 'US Sales Tax 0% - configure by state', '0', 'ZERO_RATED')
  return { noTax, usSalesTaxPlaceholder }
}

async function ensureTaxRate(tx: Tx, orgId: string, name: string, rate: string, type: string) {
  const existing = await tx.taxRate.findFirst({ where: { orgId, name } })
  if (existing) {
    return tx.taxRate.update({ where: { id: existing.id }, data: { rate, type, isActive: true } })
  }
  return tx.taxRate.create({ data: { orgId, name, rate, type, isActive: true } })
}

async function ensureBankAccount(tx: Tx, orgId: string, config: OwnerOrgConfig, accountId: string | null) {
  const name = `${config.name} Operating · ${config.baseCurrency}`
  const existing = await tx.bankAccount.findFirst({ where: { orgId, name } })
  const data = {
    orgId,
    accountId,
    name,
    bankName: 'Operating Bank',
    country: config.country,
    currency: config.baseCurrency,
    balance: config.openingBalance,
    isActive: true,
  }
  if (existing) return tx.bankAccount.update({ where: { id: existing.id }, data })
  return tx.bankAccount.create({ data })
}

async function ensureContacts(tx: Tx, orgId: string, contacts: ContactSeed[]) {
  const map = new Map<string, { id: string; customCode: string | null }>()
  for (const contact of contacts) {
    const type: 'BOTH' | 'CUSTOMER' | 'SUPPLIER' = contact.roles.length > 1 ? 'BOTH' : contact.roles.includes('customer') ? 'CUSTOMER' : 'SUPPLIER'
    const data = {
      orgId,
      customCode: contact.customCode,
      type,
      isCustomer: contact.roles.includes('customer'),
      isSupplier: contact.roles.includes('supplier'),
      entityKind: 'COMPANY' as const,
      displayName: contact.displayName,
      legalName: contact.legalName || contact.displayName,
      email: contact.email || null,
      taxId: contact.taxId || null,
      country: contact.country,
      city: contact.city || null,
      defaultCurrency: 'USD',
      isActive: true,
    }
    const existing = await tx.contact.findFirst({ where: { orgId, customCode: contact.customCode } })
    const saved = existing
      ? await tx.contact.update({ where: { id: existing.id }, data, select: { id: true, customCode: true } })
      : await tx.contact.create({ data, select: { id: true, customCode: true } })
    map.set(contact.customCode, saved)
  }
  return map
}

async function ensureProducts(
  tx: Tx,
  orgId: string,
  products: ProductSeed[],
  taxRateId: string | null,
  accounts: Map<string, { id: string; code: string }>,
) {
  const map = new Map<string, { id: string; sku: string | null; unitPrice: Prisma.Decimal; name: string }>()
  for (const product of products) {
    const saved = await tx.product.upsert({
      where: { orgId_sku: { orgId, sku: product.sku } },
      update: {
        name: product.name,
        nameAr: product.nameAr,
        type: product.type,
        category: product.category,
        billingCycle: product.billingCycle || null,
        unitPrice: product.unitPrice,
        taxRateId,
        incomeAccountId: accounts.get(product.incomeAccountCode)?.id || null,
        expenseAccountId: product.expenseAccountCode ? accounts.get(product.expenseAccountCode)?.id || null : null,
        isActive: true,
      },
      create: {
        orgId,
        sku: product.sku,
        name: product.name,
        nameAr: product.nameAr,
        type: product.type,
        category: product.category,
        billingCycle: product.billingCycle || null,
        unitPrice: product.unitPrice,
        taxRateId,
        incomeAccountId: accounts.get(product.incomeAccountCode)?.id || null,
        expenseAccountId: product.expenseAccountCode ? accounts.get(product.expenseAccountCode)?.id || null : null,
        isActive: true,
      },
      select: { id: true, sku: true, unitPrice: true, name: true },
    })
    map.set(product.sku, saved)
  }
  return map
}

async function ensureInvoices(
  tx: Tx,
  orgId: string,
  config: OwnerOrgConfig,
  contacts: Map<string, { id: string; customCode: string | null }>,
  products: Map<string, { id: string; sku: string | null; unitPrice: Prisma.Decimal; name: string }>,
  taxRateId: string | null,
  bankAccountId: string | null,
) {
  const now = new Date()
  for (const invoice of config.invoices) {
    const contact = contacts.get(invoice.contactCode)
    if (!contact) throw new Error(`Missing contact ${invoice.contactCode}`)

    const computedLines = invoice.lines.map((line) => {
      const product = products.get(line.sku)
      if (!product) throw new Error(`Missing product ${line.sku}`)
      const quantity = new Prisma.Decimal(line.quantity)
      const unitPrice = new Prisma.Decimal(line.unitPrice || product.unitPrice)
      const lineSubtotal = quantity.mul(unitPrice)
      return {
        productId: product.id,
        description: line.description || product.name,
        quantity,
        unitPrice,
        discount: new Prisma.Decimal(0),
        taxRateId,
        subtotal: lineSubtotal,
      }
    })
    const subtotal = computedLines.reduce((sum, line) => sum.add(line.subtotal), new Prisma.Decimal(0))
    const issueDate = addDays(now, -invoice.issueOffsetDays)
    const dueDate = addDays(issueDate, invoice.dueInDays)
    const amountPaid = invoice.status === 'PAID' ? subtotal : new Prisma.Decimal(0)

    const saved = await tx.invoice.upsert({
      where: { orgId_invoiceNumber: { orgId, invoiceNumber: invoice.invoiceNumber } },
      update: {
        contactId: contact.id,
        status: invoice.status,
        issueDate,
        dueDate,
        currency: config.baseCurrency,
        subtotal,
        taxTotal: '0',
        discountTotal: '0',
        total: subtotal,
        amountPaid,
        notes: 'Seeded owner-company verification invoice.',
        termsConditions: 'Payment due per invoice terms.',
      },
      create: {
        orgId,
        contactId: contact.id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        issueDate,
        dueDate,
        currency: config.baseCurrency,
        subtotal,
        taxTotal: '0',
        discountTotal: '0',
        total: subtotal,
        amountPaid,
        notes: 'Seeded owner-company verification invoice.',
        termsConditions: 'Payment due per invoice terms.',
      },
    })
    await tx.invoiceLine.deleteMany({ where: { invoiceId: saved.id } })
    await tx.invoiceLine.createMany({ data: computedLines.map((line) => ({ ...line, invoiceId: saved.id })) })
    await tx.payment.deleteMany({ where: { invoiceId: saved.id } })
    if (invoice.status === 'PAID') {
      await tx.payment.create({
        data: {
          invoiceId: saved.id,
          bankAccountId,
          amount: subtotal,
          currency: config.baseCurrency,
          method: 'BANK_TRANSFER',
          reference: `${invoice.invoiceNumber}-PAID`,
          notes: 'Seeded paid invoice verification payment.',
          paidAt: addDays(issueDate, 3),
        },
      })
    }
  }
}

async function ensureBills(
  tx: Tx,
  orgId: string,
  config: OwnerOrgConfig,
  contacts: Map<string, { id: string; customCode: string | null }>,
  taxRateId: string | null,
  bankAccountId: string | null,
) {
  const now = new Date()
  for (const bill of config.bills) {
    const contact = contacts.get(bill.contactCode)
    if (!contact) throw new Error(`Missing contact ${bill.contactCode}`)
    const issueDate = addDays(now, -bill.issueOffsetDays)
    const dueDate = addDays(issueDate, bill.dueInDays)
    const subtotal = new Prisma.Decimal(bill.subtotal)
    const amountPaid = bill.status === 'PAID' ? subtotal : new Prisma.Decimal(0)

    const saved = await tx.bill.upsert({
      where: { orgId_billNumber: { orgId, billNumber: bill.billNumber } },
      update: {
        contactId: contact.id,
        status: bill.status,
        issueDate,
        dueDate,
        currency: config.baseCurrency,
        subtotal,
        taxTotal: '0',
        total: subtotal,
        amountPaid,
        notes: 'Seeded owner-company verification bill.',
      },
      create: {
        orgId,
        contactId: contact.id,
        billNumber: bill.billNumber,
        status: bill.status,
        issueDate,
        dueDate,
        currency: config.baseCurrency,
        subtotal,
        taxTotal: '0',
        total: subtotal,
        amountPaid,
        notes: 'Seeded owner-company verification bill.',
      },
    })
    await tx.billLine.deleteMany({ where: { billId: saved.id } })
    await tx.billLine.create({
      data: {
        billId: saved.id,
        description: bill.description,
        quantity: '1',
        unitPrice: subtotal,
        taxRateId,
        subtotal,
      },
    })
    await tx.payment.deleteMany({ where: { billId: saved.id } })
    if (bill.status === 'PAID') {
      await tx.payment.create({
        data: {
          billId: saved.id,
          bankAccountId,
          amount: subtotal,
          currency: config.baseCurrency,
          method: 'BANK_TRANSFER',
          reference: `${bill.billNumber}-PAID`,
          notes: 'Seeded paid bill verification payment.',
          paidAt: addDays(issueDate, 4),
        },
      })
    }
  }
}

async function ensureOpeningJournal(tx: Tx, orgId: string, config: OwnerOrgConfig, accounts: Map<string, { id: string; code: string }>) {
  const debit = accounts.get('11110')
  const credit = accounts.get('31200')
  if (!debit || !credit) throw new Error(`Missing opening journal accounts for ${config.slug}`)
  const entryNumber = `${config.numberingPrefix}-JE-2026-0001`
  const existing = await tx.journalEntry.findFirst({ where: { orgId, entryNumber } })
  const data = {
    orgId,
    entryNumber,
    date: new Date('2026-01-01T00:00:00.000Z'),
    description: `${config.name} opening balance`,
    reference: 'OWNER-BOOTSTRAP',
    source: 'manual',
    isPosted: true,
    postedAt: new Date('2026-01-01T00:00:00.000Z'),
  }
  const journal = existing
    ? await tx.journalEntry.update({ where: { id: existing.id }, data })
    : await tx.journalEntry.create({ data })

  await tx.journalLine.deleteMany({ where: { journalId: journal.id } })
  await tx.journalLine.createMany({
    data: [
      { journalId: journal.id, accountId: debit.id, description: 'Opening operating cash', debit: config.openingBalance, credit: '0' },
      { journalId: journal.id, accountId: credit.id, description: 'Opening LLC member equity', debit: '0', credit: config.openingBalance },
    ],
  })
}

async function ensureFiscalPeriods(tx: Tx, orgId: string, fiscalYear: number) {
  for (let month = 1; month <= 12; month++) {
    const startDate = new Date(Date.UTC(fiscalYear, month - 1, 1))
    const endDate = new Date(Date.UTC(fiscalYear, month, 0, 23, 59, 59, 999))
    await tx.fiscalPeriod.upsert({
      where: { orgId_fiscalYear_periodNumber: { orgId, fiscalYear, periodNumber: month } },
      update: { startDate, endDate, status: 'OPEN' },
      create: { orgId, fiscalYear, periodNumber: month, startDate, endDate, status: 'OPEN' },
    })
  }
  await tx.fiscalPeriod.upsert({
    where: { orgId_fiscalYear_periodNumber: { orgId, fiscalYear, periodNumber: 0 } },
    update: {
      startDate: new Date(Date.UTC(fiscalYear, 0, 1)),
      endDate: new Date(Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999)),
      status: 'OPEN',
    },
    create: {
      orgId,
      fiscalYear,
      periodNumber: 0,
      startDate: new Date(Date.UTC(fiscalYear, 0, 1)),
      endDate: new Date(Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999)),
      status: 'OPEN',
    },
  })
}

async function resetSeededSamples(tx: Tx, orgId: string, config: OwnerOrgConfig) {
  const invoiceNumbers = config.invoices.map((x) => x.invoiceNumber)
  const billNumbers = config.bills.map((x) => x.billNumber)
  const contactCodes = config.contacts.map((x) => x.customCode)
  const productSkus = config.products.map((x) => x.sku)
  const entryNumber = `${config.numberingPrefix}-JE-2026-0001`

  const invoices = await tx.invoice.findMany({ where: { orgId, invoiceNumber: { in: invoiceNumbers } }, select: { id: true } })
  const bills = await tx.bill.findMany({ where: { orgId, billNumber: { in: billNumbers } }, select: { id: true } })
  const journals = await tx.journalEntry.findMany({ where: { orgId, entryNumber }, select: { id: true } })

  await tx.payment.deleteMany({
    where: {
      OR: [
        invoices.length ? { invoiceId: { in: invoices.map((x) => x.id) } } : undefined,
        bills.length ? { billId: { in: bills.map((x) => x.id) } } : undefined,
      ].filter(Boolean) as any,
    },
  })
  await tx.invoiceLine.deleteMany({ where: { invoiceId: { in: invoices.map((x) => x.id) } } })
  await tx.invoice.deleteMany({ where: { id: { in: invoices.map((x) => x.id) } } })
  await tx.billLine.deleteMany({ where: { billId: { in: bills.map((x) => x.id) } } })
  await tx.bill.deleteMany({ where: { id: { in: bills.map((x) => x.id) } } })
  await tx.journalLine.deleteMany({ where: { journalId: { in: journals.map((x) => x.id) } } })
  await tx.journalEntry.deleteMany({ where: { id: { in: journals.map((x) => x.id) } } })
  await tx.product.deleteMany({ where: { orgId, sku: { in: productSkus } } })
  await tx.contact.deleteMany({ where: { orgId, customCode: { in: contactCodes } } })
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 86_400_000)
}
