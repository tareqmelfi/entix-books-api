/**
 * Seed Demo Org · ENSIDEX Demo Co (UX-149)
 *
 * Creates a single fully-loaded org with:
 *   - 18-account chart of accounts (assets · liabilities · equity · revenue · expense)
 *   - 8 customers + 5 suppliers (mix of individual/company · SA + US)
 *   - 12 products + 4 categories
 *   - 3 bank accounts (Mercury USD · Wise EUR · Al Rajhi SAR)
 *   - 2 branches + 3 cost centers + 2 projects
 *   - 30 invoices over the last 90 days (mix of draft/approved/paid/overdue)
 *   - 18 bills · 25 expenses · 12 vouchers (receipts + payments)
 *   - 6 manual journal entries · all posted
 *   - Numbering settings + branding logo placeholder
 *
 * Usage (one-shot from local dev or VPS):
 *   tsx src/scripts/seed-demo.ts <userId>           // attach demo org to existing user
 *   tsx src/scripts/seed-demo.ts <userId> --reset   // drop existing demo first
 *
 * The user must already exist in better-auth (sign-up first via UI).
 * The script wipes any existing org with slug "ensidex-demo" before re-seeding.
 */
import { PrismaClient, AccountType, ContactType, ContactEntityKind } from '@prisma/client'

const prisma = new PrismaClient()

const args = process.argv.slice(2)
const userId = args[0]
const reset = args.includes('--reset')

if (!userId) {
  console.error('Usage: tsx src/scripts/seed-demo.ts <userId> [--reset]')
  console.error('Get userId from `select id, email from "User";` in psql.')
  process.exit(1)
}

const SLUG = 'ensidex-demo'

async function main() {
  // 0 · Verify user exists
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) {
    console.error(`User ${userId} not found · sign up via UI first then re-run`)
    process.exit(1)
  }
  console.log(`✓ User: ${user.email}`)

  // 1 · Reset existing demo if --reset
  if (reset) {
    const existing = await prisma.organization.findUnique({ where: { slug: SLUG } })
    if (existing) {
      console.log(`Dropping existing demo org ${existing.id}...`)
      await prisma.organization.delete({ where: { id: existing.id } })
      console.log('✓ Dropped')
    }
  }

  // 2 · Create org
  console.log('Creating ENSIDEX Demo Co...')
  const org = await prisma.organization.create({
    data: {
      slug: SLUG,
      name: 'ENSIDEX Demo Co',
      legalName: 'ENSIDEX Demo Company LLC',
      country: 'SA',
      baseCurrency: 'SAR',
      fiscalYearStart: 1,
      fiscalYearEnd: 12,
      vatNumber: '300000000000003',
      crNumber: '1010000001',
      industry: 'CONSULTING',
      email: 'demo@ensidex.com',
      phone: '+966500000001',
      website: 'https://demo.entix.io',
      addressLine: 'King Fahd Road',
      buildingNumber: '7000',
      streetName: 'King Fahd Road',
      district: 'Al Olaya',
      city: 'Riyadh',
      region: 'Riyadh',
      postalCode: '12333',
      logoUrl: null,
      stampUrl: null,
      zatcaEnabled: false,
      zatcaMode: 'sandbox',
      numberingSettings: {
        contact: { prefix: 'CUST-', padding: 4, start: 1 },
        invoice: { prefix: 'INV-{YYYY}-', padding: 4 },
        bill: { prefix: 'BILL-{YYYY}-', padding: 4 },
        quote: { prefix: 'QT-{YYYY}-', padding: 4 },
        receipt: { prefix: 'R-{YYYY}-', padding: 4 },
        payment: { prefix: 'P-{YYYY}-', padding: 4 },
      },
      members: { create: { userId, role: 'OWNER' } },
    },
  })
  console.log(`✓ Org created · id=${org.id}`)

  // 3 · Chart of Accounts (Wafeq-style · 18 accounts)
  console.log('Seeding chart of accounts...')
  const acc = (
    code: string,
    name: string,
    nameAr: string,
    type: AccountType,
    extra: Partial<{
      subtype: string
      cashFlowType: string
      allowPayment: boolean
      allowExpenseClaim: boolean
      isSystemAccount: boolean
    }> = {},
  ) =>
    prisma.account.create({
      data: { orgId: org.id, code, name, nameAr, type, ...extra },
    })

  const cash = await acc('1000', 'Cash on Hand', 'الصندوق', 'ASSET', { subtype: 'cash', cashFlowType: 'OPERATING', allowPayment: true })
  const mercuryUsd = await acc('1010', 'Mercury USD', 'مرکري دولار', 'ASSET', { subtype: 'bank', cashFlowType: 'OPERATING', allowPayment: true })
  const wiseEur = await acc('1011', 'Wise EUR', 'وايز يورو', 'ASSET', { subtype: 'bank', cashFlowType: 'OPERATING', allowPayment: true })
  const rajhiSar = await acc('1012', 'Al Rajhi SAR', 'الراجحي ريال', 'ASSET', { subtype: 'bank', cashFlowType: 'OPERATING', allowPayment: true })
  const ar = await acc('1100', 'Accounts Receivable', 'العملاء', 'ASSET', { subtype: 'receivable', cashFlowType: 'OPERATING', isSystemAccount: true })
  const inventory = await acc('1200', 'Inventory', 'المخزون', 'ASSET', { subtype: 'inventory', cashFlowType: 'OPERATING' })
  const fixedAssets = await acc('1500', 'Fixed Assets', 'الأصول الثابتة', 'ASSET', { subtype: 'fixed', cashFlowType: 'INVESTING' })

  const ap = await acc('2000', 'Accounts Payable', 'الموردون', 'LIABILITY', { subtype: 'payable', cashFlowType: 'OPERATING', isSystemAccount: true })
  const vatPayable = await acc('2100', 'VAT Payable', 'ضريبة القيمة المضافة', 'LIABILITY', { subtype: 'tax', cashFlowType: 'OPERATING', isSystemAccount: true })
  const loans = await acc('2500', 'Loans', 'القروض', 'LIABILITY', { subtype: 'long-term', cashFlowType: 'FINANCING' })

  const capital = await acc('3000', 'Owner Capital', 'رأس المال', 'EQUITY', { subtype: 'capital', cashFlowType: 'FINANCING' })
  const retained = await acc('3100', 'Retained Earnings', 'الأرباح المحتجزة', 'EQUITY', { subtype: 'retained', cashFlowType: 'NON_CASH', isSystemAccount: true })

  const sales = await acc('4000', 'Sales Revenue', 'إيرادات المبيعات', 'REVENUE', { subtype: 'operating', cashFlowType: 'OPERATING' })
  const services = await acc('4100', 'Services Revenue', 'إيرادات الخدمات', 'REVENUE', { subtype: 'operating', cashFlowType: 'OPERATING' })

  const cogs = await acc('5000', 'Cost of Goods Sold', 'تكلفة البضاعة المباعة', 'EXPENSE', { subtype: 'cogs', cashFlowType: 'OPERATING' })
  const salaries = await acc('6100', 'Salaries Expense', 'مصاريف الرواتب', 'EXPENSE', { subtype: 'operating', cashFlowType: 'OPERATING', allowExpenseClaim: true })
  const rent = await acc('6200', 'Rent Expense', 'مصاريف الإيجار', 'EXPENSE', { subtype: 'operating', cashFlowType: 'OPERATING', allowExpenseClaim: true })
  const utilities = await acc('6300', 'Utilities Expense', 'مصاريف المرافق', 'EXPENSE', { subtype: 'operating', cashFlowType: 'OPERATING', allowExpenseClaim: true })
  console.log(`✓ Created 18 accounts`)

  // 4 · Bank Accounts
  console.log('Seeding bank accounts...')
  await prisma.bankAccount.createMany({
    data: [
      {
        orgId: org.id,
        name: 'Al Rajhi Main · SAR',
        accountNumber: 'SA0380000000608010167519',
        currency: 'SAR',
        bankName: 'Al Rajhi Bank',
        country: 'SA',
        accountId: rajhiSar.id,
        openingBalance: '50000.00',
      },
      {
        orgId: org.id,
        name: 'Mercury Operating · USD',
        accountNumber: '987654321',
        currency: 'USD',
        bankName: 'Mercury',
        country: 'US',
        accountId: mercuryUsd.id,
        openingBalance: '25000.00',
      },
      {
        orgId: org.id,
        name: 'Wise Multi-Currency · EUR',
        accountNumber: 'BE99 9670 1234 5678',
        currency: 'EUR',
        bankName: 'Wise',
        country: 'BE',
        accountId: wiseEur.id,
        openingBalance: '8000.00',
      },
    ],
  })

  // 5 · Branches + Cost Centers + Projects
  console.log('Seeding branches/cost-centers/projects...')
  await prisma.branch.createMany({
    data: [
      { orgId: org.id, code: 'RUH', name: 'Riyadh Main', isActive: true },
      { orgId: org.id, code: 'JED', name: 'Jeddah Office', isActive: true },
    ],
  })
  await prisma.costCenter.createMany({
    data: [
      { orgId: org.id, code: 'OPS', name: 'Operations', isActive: true },
      { orgId: org.id, code: 'SALES', name: 'Sales & Marketing', isActive: true },
      { orgId: org.id, code: 'TECH', name: 'Technology', isActive: true },
    ],
  })
  await prisma.project.createMany({
    data: [
      { orgId: org.id, code: 'WEB-001', name: 'Website Redesign · Acme Corp', isActive: true },
      { orgId: org.id, code: 'CONS-002', name: 'ZATCA Consulting · Ahmad Trading', isActive: true },
    ],
  })

  // 6 · Customers (8) + Suppliers (5)
  console.log('Seeding 13 contacts...')
  const customers = [
    { displayName: 'Acme Corporation', legalName: 'Acme Corporation LLC', email: 'ap@acme.com', phone: '+966112345678', taxId: '300123456789003', country: 'SA', city: 'Riyadh', kind: 'COMPANY' },
    { displayName: 'Ahmad Trading Co', legalName: 'Ahmad Trading Establishment', email: 'finance@ahmad-trading.sa', phone: '+966551234567', taxId: '300987654321003', country: 'SA', city: 'Jeddah', kind: 'COMPANY' },
    { displayName: 'Sarah AlMutairi', legalName: 'Sarah AlMutairi', email: 'sarah.m@gmail.com', phone: '+966505555555', country: 'SA', kind: 'INDIVIDUAL' },
    { displayName: 'TechStart Inc', legalName: 'TechStart Inc.', email: 'billing@techstart.io', phone: '+14155551234', taxId: '88-1234567', country: 'US', city: 'San Francisco', kind: 'COMPANY' },
    { displayName: 'Gulf Logistics', legalName: 'Gulf Logistics WLL', email: 'accounts@gulflogistics.com', phone: '+97444445555', country: 'QA', city: 'Doha', kind: 'COMPANY' },
    { displayName: 'Mohammed AlGhamdi', legalName: 'Mohammed AlGhamdi', email: 'm.ghamdi@outlook.com', phone: '+966543219876', country: 'SA', kind: 'INDIVIDUAL' },
    { displayName: 'Crescent Real Estate', legalName: 'Crescent Real Estate Co', email: 'cfo@crescent-re.sa', phone: '+966114567890', taxId: '300555111223003', country: 'SA', city: 'Riyadh', kind: 'COMPANY' },
    { displayName: 'Nour Al Khaleej', legalName: 'Nour Al Khaleej Trading', email: 'info@nour.ae', phone: '+97144443333', taxId: '100111222333004', country: 'AE', city: 'Dubai', kind: 'COMPANY' },
  ]
  const suppliers = [
    { displayName: 'Cloudflare Inc', legalName: 'Cloudflare Inc.', email: 'billing@cloudflare.com', taxId: '27-3441673', country: 'US', kind: 'COMPANY' },
    { displayName: 'STC Business', legalName: 'STC Business Solutions', email: 'b2b@stc.com.sa', phone: '+966114000000', taxId: '300111222333003', country: 'SA', kind: 'COMPANY' },
    { displayName: 'Office Supplies Hub', legalName: 'Office Supplies Hub Co', email: 'orders@osh.sa', phone: '+966112223344', taxId: '300444555666003', country: 'SA', kind: 'COMPANY' },
    { displayName: 'Khalid Cleaning Services', legalName: 'Khalid Cleaning Services', email: 'k.cleaning@gmail.com', phone: '+966551110000', country: 'SA', kind: 'INDIVIDUAL' },
    { displayName: 'AWS', legalName: 'Amazon Web Services Inc.', email: 'aws-billing@amazon.com', taxId: '91-1646860', country: 'US', kind: 'COMPANY' },
  ]
  const createdCustomers = await Promise.all(
    customers.map((c, i) =>
      prisma.contact.create({
        data: {
          orgId: org.id,
          customCode: `CUST-${String(i + 1).padStart(4, '0')}`,
          type: 'CUSTOMER' as ContactType,
          isCustomer: true,
          entityKind: c.kind as ContactEntityKind,
          displayName: c.displayName,
          legalName: c.legalName,
          email: c.email,
          phone: c.phone,
          taxId: c.taxId,
          country: c.country,
          city: c.city,
        },
      }),
    ),
  )
  const createdSuppliers = await Promise.all(
    suppliers.map((s, i) =>
      prisma.contact.create({
        data: {
          orgId: org.id,
          customCode: `SUPP-${String(i + 1).padStart(4, '0')}`,
          type: 'SUPPLIER' as ContactType,
          isSupplier: true,
          entityKind: s.kind as ContactEntityKind,
          displayName: s.displayName,
          legalName: s.legalName,
          email: s.email,
          phone: s.phone,
          taxId: s.taxId,
          country: s.country,
        },
      }),
    ),
  )
  console.log(`✓ ${createdCustomers.length} customers + ${createdSuppliers.length} suppliers`)

  // 7 · Products
  console.log('Seeding 12 products...')
  const products = [
    { code: 'CONS-HR', name: 'Consulting · Per Hour', nameAr: 'استشارة بالساعة', sellPrice: '500', costPrice: '150', kind: 'SERVICE' },
    { code: 'CONS-DAY', name: 'Consulting · Per Day', nameAr: 'استشارة باليوم', sellPrice: '3500', costPrice: '1000', kind: 'SERVICE' },
    { code: 'WEB-DEV', name: 'Website Development', nameAr: 'تطوير موقع', sellPrice: '15000', costPrice: '5000', kind: 'SERVICE' },
    { code: 'SAAS-MO', name: 'SaaS Subscription · Monthly', nameAr: 'اشتراك شهري', sellPrice: '299', costPrice: '50', kind: 'SERVICE' },
    { code: 'SAAS-YR', name: 'SaaS Subscription · Yearly', nameAr: 'اشتراك سنوي', sellPrice: '2999', costPrice: '500', kind: 'SERVICE' },
    { code: 'TRAIN-1', name: 'Training Workshop · 1-Day', nameAr: 'ورشة تدريبية يوم', sellPrice: '8000', costPrice: '2500', kind: 'SERVICE' },
    { code: 'AUDIT-Y', name: 'ZATCA Audit · Yearly', nameAr: 'تدقيق ضريبي سنوي', sellPrice: '12000', costPrice: '4000', kind: 'SERVICE' },
    { code: 'LAPTOP-PRO', name: 'MacBook Pro 16"', nameAr: 'ماك بوك برو 16', sellPrice: '13500', costPrice: '11000', kind: 'GOOD' },
    { code: 'MONITOR-27', name: 'Studio Display 27"', nameAr: 'شاشة 27 بوصة', sellPrice: '6500', costPrice: '5000', kind: 'GOOD' },
    { code: 'CHAIR-ERG', name: 'Ergonomic Chair', nameAr: 'كرسي مكتب صحي', sellPrice: '2500', costPrice: '1200', kind: 'GOOD' },
    { code: 'NB-A4', name: 'Notebook A4 (10-pack)', nameAr: 'دفتر A4 - علبة 10', sellPrice: '85', costPrice: '40', kind: 'GOOD' },
    { code: 'SUB-LIC', name: 'Annual Software License', nameAr: 'ترخيص برنامج سنوي', sellPrice: '4500', costPrice: '1500', kind: 'SERVICE' },
  ]
  const createdProducts = await Promise.all(
    products.map((p) =>
      prisma.product.create({
        data: {
          orgId: org.id,
          code: p.code,
          name: p.name,
          nameAr: p.nameAr,
          sellPrice: p.sellPrice,
          costPrice: p.costPrice,
          kind: p.kind as any,
          isActive: true,
          taxRate: '0.15',
          revenueAccountId: p.kind === 'GOOD' ? sales.id : services.id,
          expenseAccountId: cogs.id,
        },
      }),
    ),
  )

  // 8 · Invoices (30 over the last 90 days)
  console.log('Seeding 30 invoices...')
  const today = new Date()
  let invSeq = 0
  for (let i = 0; i < 30; i++) {
    invSeq++
    const customer = createdCustomers[i % createdCustomers.length]
    const issueDate = new Date(today.getTime() - (i * 3 + Math.floor(Math.random() * 3)) * 86400000)
    const dueDate = new Date(issueDate.getTime() + 30 * 86400000)
    const product = createdProducts[i % createdProducts.length]
    const qty = 1 + Math.floor(Math.random() * 5)
    const unitPrice = Number(product.sellPrice)
    const subtotal = qty * unitPrice
    const taxAmount = subtotal * 0.15
    const total = subtotal + taxAmount

    // Status mix: 50% paid · 25% sent · 15% draft · 10% overdue
    const r = Math.random()
    const status =
      i < 5 ? 'DRAFT' : r < 0.5 ? 'PAID' : r < 0.75 ? 'SENT' : i % 7 === 0 ? 'OVERDUE' : 'APPROVED'
    const amountPaid = status === 'PAID' ? total : 0

    await prisma.invoice.create({
      data: {
        orgId: org.id,
        contactId: customer.id,
        invoiceNumber: `INV-2026-${String(invSeq).padStart(4, '0')}`,
        issueDate,
        dueDate,
        currency: 'SAR',
        subtotal: subtotal.toFixed(2),
        taxAmount: taxAmount.toFixed(2),
        total: total.toFixed(2),
        amountPaid: amountPaid.toFixed(2),
        status,
        notes: status === 'DRAFT' ? 'Draft · awaiting approval' : null,
        lines: {
          create: [
            {
              description: product.name,
              quantity: String(qty),
              unitPrice: product.sellPrice,
              taxRate: '0.15',
              taxInclusive: false,
              productId: product.id,
              total: subtotal.toFixed(2),
            },
          ],
        },
      },
    })
  }

  // 9 · Bills (18)
  console.log('Seeding 18 bills...')
  let billSeq = 0
  for (let i = 0; i < 18; i++) {
    billSeq++
    const supplier = createdSuppliers[i % createdSuppliers.length]
    const issueDate = new Date(today.getTime() - (i * 4) * 86400000)
    const dueDate = new Date(issueDate.getTime() + 30 * 86400000)
    const subtotal = 500 + Math.floor(Math.random() * 5000)
    const taxAmount = subtotal * 0.15
    const total = subtotal + taxAmount
    const r = Math.random()
    const status = r < 0.6 ? 'PAID' : r < 0.85 ? 'RECEIVED' : 'DRAFT'

    await prisma.bill.create({
      data: {
        orgId: org.id,
        contactId: supplier.id,
        billNumber: `BILL-2026-${String(billSeq).padStart(4, '0')}`,
        issueDate,
        dueDate,
        currency: 'SAR',
        subtotal: subtotal.toFixed(2),
        taxAmount: taxAmount.toFixed(2),
        total: total.toFixed(2),
        amountPaid: status === 'PAID' ? total.toFixed(2) : '0',
        status,
        lines: {
          create: [
            {
              description: i % 3 === 0 ? 'Cloud hosting' : i % 3 === 1 ? 'Office supplies' : 'Internet & utilities',
              quantity: '1',
              unitPrice: subtotal.toFixed(2),
              taxRate: '0.15',
              taxInclusive: false,
              total: subtotal.toFixed(2),
            },
          ],
        },
      },
    })
  }

  // 10 · Expenses (25 cash expenses)
  console.log('Seeding 25 expenses...')
  let expSeq = 0
  const categories = ['Office Rent', 'Salaries', 'Utilities', 'Marketing', 'Travel', 'Meals', 'Software']
  for (let i = 0; i < 25; i++) {
    expSeq++
    const date = new Date(today.getTime() - (i * 2 + Math.floor(Math.random() * 3)) * 86400000)
    const amount = 100 + Math.floor(Math.random() * 4000)
    const taxAmount = amount * 0.15
    await prisma.expense.create({
      data: {
        orgId: org.id,
        number: `EXP-2026-${String(expSeq).padStart(4, '0')}`,
        date,
        category: categories[i % categories.length],
        currency: 'SAR',
        subtotal: amount.toFixed(2),
        taxAmount: taxAmount.toFixed(2),
        total: (amount + taxAmount).toFixed(2),
        paymentMethod: ['CASH', 'BANK_TRANSFER', 'MADA', 'CARD'][i % 4] as any,
        description: `${categories[i % categories.length]} for ${date.toISOString().slice(0, 7)}`,
        vendorName: i % 2 === 0 ? createdSuppliers[i % createdSuppliers.length].displayName : null,
      },
    })
  }

  // 11 · Vouchers (12 = 7 receipts + 5 payments)
  console.log('Seeding 12 vouchers...')
  for (let i = 0; i < 7; i++) {
    const customer = createdCustomers[i % createdCustomers.length]
    await prisma.voucher.create({
      data: {
        orgId: org.id,
        number: `R-2026-${String(i + 1).padStart(4, '0')}`,
        kind: 'RECEIPT' as any,
        date: new Date(today.getTime() - (i * 5) * 86400000),
        contactId: customer.id,
        amount: (1000 + i * 500).toFixed(2),
        currency: 'SAR',
        paymentMethod: 'BANK_TRANSFER' as any,
        description: `سند قبض من ${customer.displayName}`,
      },
    })
  }
  for (let i = 0; i < 5; i++) {
    const supplier = createdSuppliers[i % createdSuppliers.length]
    await prisma.voucher.create({
      data: {
        orgId: org.id,
        number: `P-2026-${String(i + 1).padStart(4, '0')}`,
        kind: 'PAYMENT' as any,
        date: new Date(today.getTime() - (i * 6) * 86400000),
        contactId: supplier.id,
        amount: (800 + i * 400).toFixed(2),
        currency: 'SAR',
        paymentMethod: 'BANK_TRANSFER' as any,
        description: `سند صرف لـ ${supplier.displayName}`,
      },
    })
  }

  // 12 · Manual journal entries (6 · all posted)
  console.log('Seeding 6 manual journal entries...')
  const journals = [
    { date: new Date(today.getTime() - 60 * 86400000), description: 'Opening balance · capital injection', debit: capital, credit: rajhiSar, amount: 100000 },
    { date: new Date(today.getTime() - 45 * 86400000), description: 'Office rent prepayment', debit: rent, credit: rajhiSar, amount: 12000 },
    { date: new Date(today.getTime() - 30 * 86400000), description: 'Monthly salaries · March', debit: salaries, credit: rajhiSar, amount: 35000 },
    { date: new Date(today.getTime() - 20 * 86400000), description: 'Utility bills paid', debit: utilities, credit: rajhiSar, amount: 1850 },
    { date: new Date(today.getTime() - 10 * 86400000), description: 'Loan repayment · principal', debit: loans, credit: rajhiSar, amount: 5000 },
    { date: new Date(today.getTime() - 5 * 86400000), description: 'Inventory purchase · cash', debit: inventory, credit: cash, amount: 8500 },
  ]
  for (let i = 0; i < journals.length; i++) {
    const j = journals[i]
    await prisma.journalEntry.create({
      data: {
        orgId: org.id,
        number: `JE-2026-${String(i + 1).padStart(4, '0')}`,
        date: j.date,
        description: j.description,
        status: 'POSTED' as any,
        currency: 'SAR',
        lines: {
          create: [
            { accountId: j.debit.id, debit: j.amount.toFixed(2), credit: '0', description: j.description },
            { accountId: j.credit.id, debit: '0', credit: j.amount.toFixed(2), description: j.description },
          ],
        },
      },
    })
  }

  // 13 · Tax rates
  console.log('Seeding tax rates...')
  await prisma.taxRate.createMany({
    data: [
      { orgId: org.id, name: 'VAT 15%', rate: '0.15', isActive: true, isDefault: true },
      { orgId: org.id, name: 'VAT 0%', rate: '0', isActive: true },
      { orgId: org.id, name: 'VAT Exempt', rate: '0', isActive: true },
    ],
  })

  console.log('')
  console.log('═══════════════════════════════════════')
  console.log('✅ ENSIDEX Demo Co seeded successfully!')
  console.log('═══════════════════════════════════════')
  console.log(`Org ID:        ${org.id}`)
  console.log(`Org slug:      ${SLUG}`)
  console.log(`User attached: ${user.email}`)
  console.log('')
  console.log('What was created:')
  console.log('  · 18 accounts (Wafeq-style chart of accounts)')
  console.log('  · 13 contacts (8 customers + 5 suppliers)')
  console.log('  · 12 products (mix of services + goods)')
  console.log('  · 30 invoices (mix of draft/sent/approved/paid/overdue)')
  console.log('  · 18 bills · 25 expenses · 12 vouchers')
  console.log('  · 6 manual journal entries (all posted)')
  console.log('  · 3 bank accounts (SAR · USD · EUR)')
  console.log('  · 2 branches · 3 cost centers · 2 projects')
  console.log('  · Numbering settings + 3 tax rates')
  console.log('')
  console.log('Switch to this org in the UI: org-switcher → "ENSIDEX Demo Co"')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
