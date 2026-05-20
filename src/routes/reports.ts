import { Hono } from 'hono'
import { prisma } from '../db.js'

export const reportsRoutes = new Hono()

type ReportCategory =
  | 'financial'
  | 'consolidated'
  | 'sales'
  | 'purchases'
  | 'payroll'
  | 'forecast'
  | 'tax'
  | 'accountant'
  | 'inventory'

type ReportDefinition = {
  id: string
  category: ReportCategory
  title: string
  englishTitle: string
  description: string
}

type ReportColumn = {
  key: string
  label: string
  align?: 'start' | 'end' | 'center'
  kind?: 'text' | 'money' | 'number' | 'date' | 'status'
}

type ReportRow = {
  id: string
  label: string
  values: Record<string, string | number | null>
  note?: string | null
  link?: { label: string; href: string; type: string } | null
  status?: string | null
}

type ReportSection = {
  id: string
  title: string
  description?: string | null
  columns: ReportColumn[]
  rows: ReportRow[]
}

const reportCatalog: ReportDefinition[] = [
  ['income-statement', 'financial', 'قائمة الدخل', 'Income Statement', 'إيرادات ومصاريف وصافي ربح الشركة خلال الفترة.'],
  ['income-by-branch', 'financial', 'قائمة الدخل بحسب الفرع', 'Income Statement by Branch', 'نتائج الدخل مفصولة حسب الفروع.'],
  ['income-by-cost-center', 'financial', 'قائمة الدخل بحسب مركز التكلفة', 'Income Statement by Cost Center', 'تحليل الإيراد والمصروف على مراكز التكلفة.'],
  ['income-by-project', 'financial', 'قائمة الدخل بحسب المشروع', 'Income Statement by Project', 'ربحية كل مشروع من المبيعات والمشتريات والمصاريف.'],
  ['cash-flow', 'financial', 'التدفق النقدي', 'Cash Flow Statement', 'النقد الداخل والخارج من سندات القبض والدفع والبنوك.'],
  ['cash-flow-indirect', 'financial', 'التدفقات النقدية - الطريقة غير المباشرة', 'Cash Flow Statement - Indirect Method', 'تسوية صافي الربح إلى تدفق نقدي تشغيلي.'],
  ['balance-sheet', 'financial', 'قائمة المركز المالي', 'Statement of Financial Position', 'الأصول والالتزامات وحقوق الملكية.'],
  ['cash-forecast', 'financial', 'التوقعات النقدية', 'Cash Forecast', 'توقع النقد القادم من التحصيل والمدفوعات.'],
  ['management-pdf', 'financial', 'تقارير الإدارة (PDF)', 'Management Reports PDF Pack', 'حزمة إدارة مختصرة قابلة للطباعة.'],
  ['consolidated-income', 'consolidated', 'قائمة الدخل الموحدة', 'Consolidated Income Statement', 'نتائج موحدة للمجموعة أو الشركات التابعة.'],
  ['consolidated-cash-flow', 'consolidated', 'التدفق النقدي الموحد', 'Consolidated Cash Flow', 'تدفقات نقدية موحدة للكيانات.'],
  ['consolidated-balance-sheet', 'consolidated', 'قائمة المركز المالي الموحدة', 'Consolidated Balance Sheet', 'مركز مالي موحد للمجموعة.'],
  ['customer-balances', 'sales', 'ملخص أرصدة العملاء', 'Customer Balances Summary', 'أرصدة العملاء المفتوحة ومبالغ التحصيل.'],
  ['customer-statement', 'sales', 'كشف حساب عميل', 'Customer Statement', 'حركة العميل من فواتير وسندات وإشعارات.'],
  ['customer-statement-detail', 'sales', 'كشف حساب عميل - مفصّل', 'Detailed Customer Statement', 'حركة مفصلة بالأسطر والمدفوعات والرصيد.'],
  ['ar-aging', 'sales', 'تقادم الحسابات المدينة', 'Accounts Receivable Aging', 'تقسيم الذمم المدينة حسب أيام التأخير.'],
  ['ar-aging-detail', 'sales', 'تقادم الحسابات المدينة - مفصّل', 'Detailed Accounts Receivable Aging', 'تقادم مفصل حسب العميل والفاتورة.'],
  ['sales-by-customer', 'sales', 'المبيعات بحسب العميل', 'Sales by Customer', 'إجمالي المبيعات والتحصيل حسب العميل.'],
  ['sales-by-branch', 'sales', 'المبيعات بحسب الفرع', 'Sales by Branch', 'تحليل المبيعات لكل فرع.'],
  ['sales-by-project', 'sales', 'المبيعات بحسب المشروع', 'Sales by Project', 'إيرادات المشاريع من الفواتير.'],
  ['sales-by-product', 'sales', 'المبيعات بحسب المنتج أو الخدمة', 'Sales by Product or Service', 'أكثر المنتجات والخدمات مبيعاً.'],
  ['supplier-balances', 'purchases', 'ملخص أرصدة الموردين', 'Supplier Balances Summary', 'أرصدة الموردين المفتوحة والمدفوعات المستحقة.'],
  ['supplier-statement', 'purchases', 'كشف حساب مورد', 'Supplier Statement', 'حركة المورد من فواتير ومدفوعات وإشعارات.'],
  ['supplier-statement-detail', 'purchases', 'كشف حساب مورد - مفصّل', 'Detailed Supplier Statement', 'حركة مورد مفصلة بالأسطر والمدفوعات.'],
  ['ap-aging', 'purchases', 'تقادم الحسابات الدائنة', 'Accounts Payable Aging', 'تقسيم الذمم الدائنة حسب تاريخ الاستحقاق.'],
  ['ap-aging-detail', 'purchases', 'تقادم الحسابات الدائنة - مفصّل', 'Detailed Accounts Payable Aging', 'تقادم مفصل حسب المورد والفاتورة.'],
  ['bills-by-supplier', 'purchases', 'الفواتير بحسب المورد', 'Bills by Supplier', 'فواتير الموردين وإجمالياتها حسب الجهة.'],
  ['bills-by-branch', 'purchases', 'الفواتير بحسب الفرع', 'Bills by Branch', 'توزيع فواتير المشتريات على الفروع.'],
  ['expenses-by-vendor', 'purchases', 'المصروفات بحسب مورد', 'Expenses by Vendor', 'تحليل المصروفات النقدية حسب المورد.'],
  ['expenses-by-branch', 'purchases', 'المصروفات بحسب الفرع', 'Expenses by Branch', 'توزيع المصروفات على الفروع.'],
  ['purchases-by-product', 'purchases', 'مشتريات بحسب المنتج أو الخدمة', 'Purchases by Product or Service', 'مشتريات المنتجات والخدمات والكميات.'],
  ['employee-statement', 'payroll', 'كشف حساب موظف', 'Employee Statement', 'حركة الموظف من رواتب وسلف ومطالبات.'],
  ['employee-statement-detail', 'payroll', 'كشف حساب موظف - مفصّل', 'Detailed Employee Statement', 'تفاصيل الراتب والبدلات والخصومات.'],
  ['forecast-cash', 'forecast', 'التوقعات النقدية', 'Cash Forecast', 'نظرة تشغيلية على النقد المتوقع.'],
  ['vat-summary', 'tax', 'ضريبة القيمة المضافة', 'VAT Summary', 'ملخص ضريبة المخرجات والمدخلات وصافي المستحق.'],
  ['taxes', 'tax', 'الضرائب', 'Taxes', 'كل الضرائب المطبقة حسب بلد الشركة.'],
  ['taxes-detail', 'tax', 'الضرائب - مفصّل', 'Detailed Taxes', 'تفاصيل الضريبة حسب المستند والجهة.'],
  ['trial-balance', 'accountant', 'ميزان المراجعة', 'Trial Balance', 'أرصدة مدينة ودائنة لكل حساب.'],
  ['account-statement', 'accountant', 'كشف الحساب', 'Account Statement', 'كشف حساب محاسبي مختصر.'],
  ['account-statement-detail', 'accountant', 'كشف الحساب - مفصّل', 'Detailed Account Statement', 'كشف مفصل لكل قيد وسطر.'],
  ['general-ledger', 'accountant', 'دفتر الأستاذ العام', 'General Ledger', 'دفتر الأستاذ لكل الحسابات.'],
  ['audit-log', 'accountant', 'سجل التدقيق', 'Audit Log', 'سجل تغييرات المستخدمين والاعتمادات والحذف.'],
  ['bank-reconciliation-report', 'accountant', 'تقرير تسوية مصرفية', 'Bank Reconciliation Report', 'حالة التسوية بين كشف البنك والحركات المسجلة.'],
  ['inventory-movement', 'inventory', 'حركة المخزون', 'Inventory Movement', 'حركات دخول وخروج وتعديل ورجوع المخزون.'],
  ['inventory-by-warehouse', 'inventory', 'حركة المخزون بحسب المستودع', 'Inventory Movement by Warehouse', 'حركات كل مستودع مع الرصيد والتكلفة.'],
  ['inventory-monthly-summary', 'inventory', 'الملخص الشهري للمخزون', 'Monthly Inventory Summary', 'رصيد أول المدة والحركة والتقييم شهرياً.'],
].map(([id, category, title, englishTitle, description]) => ({
  id,
  category: category as ReportCategory,
  title,
  englishTitle,
  description,
}))

const moneyColumns: ReportColumn[] = [
  { key: 'label', label: 'البند' },
  { key: 'amount', label: 'القيمة', align: 'end', kind: 'money' },
  { key: 'note', label: 'ملاحظة' },
]

function toNumber(value: unknown): number {
  if (value == null) return 0
  return Number(value) || 0
}

function isoDate(date: Date | string | null | undefined): string {
  if (!date) return '—'
  return new Date(date).toISOString().slice(0, 10)
}

function parseDateRange(query: { from?: string; to?: string }) {
  const now = new Date()
  const from = query.from ? new Date(query.from) : new Date(now.getFullYear(), 0, 1)
  const to = query.to ? new Date(query.to) : now
  to.setHours(23, 59, 59, 999)
  return { from, to }
}

function row(id: string, label: string, amount: number, note?: string, link?: ReportRow['link']): ReportRow {
  return { id, label, values: { label, amount, note: note || '' }, note: note || null, link: link || null }
}

function genericRow(id: string, values: Record<string, string | number | null>, label = String(values.label || values.name || id), link?: ReportRow['link']): ReportRow {
  return { id, label, values, link: link || null, note: typeof values.note === 'string' ? values.note : null }
}

function bucketAge(date: Date, now = new Date()) {
  const days = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000))
  if (days <= 30) return '0-30'
  if (days <= 60) return '31-60'
  if (days <= 90) return '61-90'
  return '90+'
}

function addGrouped(map: Map<string, any>, key: string, base: any, amount: number) {
  const current = map.get(key) || { ...base, amount: 0, count: 0 }
  current.amount += amount
  current.count += 1
  map.set(key, current)
}

function hasRows(sections: ReportSection[]) {
  return sections.some((section) => section.rows.length > 0)
}

function demoSections(def: ReportDefinition, currency: string): ReportSection[] {
  const suffix = currency === 'USD' ? 'US demo' : 'SA demo'
  if (def.category === 'sales') {
    return [{
      id: 'demo-sales',
      title: 'معاينة مبيعات تجريبية',
      description: 'بيانات توضيحية لا تدخل في دفاتر الشركة.',
      columns: [
        { key: 'label', label: 'العميل / المستند' },
        { key: 'amount', label: 'المبلغ', align: 'end', kind: 'money' },
        { key: 'status', label: 'الحالة', align: 'center', kind: 'status' },
        { key: 'note', label: 'ملاحظة' },
      ],
      rows: [
        genericRow('demo-sales-1', { label: 'Acme Trading', amount: 18500, status: 'مفتوح', note: suffix }),
        genericRow('demo-sales-2', { label: 'Blue Palm Studio', amount: 9400, status: 'مدفوع جزئياً', note: 'فاتورتان + سند قبض' }),
        genericRow('demo-sales-3', { label: 'Falcon Retail', amount: 6200, status: 'متأخر', note: 'يظهر في تقادم الذمم' }),
      ],
    }]
  }
  if (def.category === 'purchases') {
    return [{
      id: 'demo-purchases',
      title: 'معاينة مشتريات ومصروفات تجريبية',
      columns: [
        { key: 'label', label: 'المورد / التصنيف' },
        { key: 'amount', label: 'المبلغ', align: 'end', kind: 'money' },
        { key: 'tax', label: 'الضريبة', align: 'end', kind: 'money' },
        { key: 'note', label: 'ملاحظة' },
      ],
      rows: [
        genericRow('demo-pur-1', { label: 'tamimi markets', amount: 223, tax: 29.09, note: 'إيصال OCR مع أصناف' }),
        genericRow('demo-pur-2', { label: 'Elite Trading Company', amount: 290, tax: 37.83, note: 'فاتورة ضريبية مبسطة' }),
        genericRow('demo-pur-3', { label: 'Alinma Bank fees', amount: 115, tax: 0, note: 'مصروف بنكي' }),
      ],
    }]
  }
  if (def.category === 'tax') {
    return [{
      id: 'demo-tax',
      title: 'ملخص ضريبي تجريبي',
      columns: moneyColumns,
      rows: [
        row('demo-tax-output', 'ضريبة المخرجات', 4200, 'من فواتير المبيعات'),
        row('demo-tax-input', 'ضريبة المدخلات', 1660, 'من مشتريات ومصروفات'),
        row('demo-tax-net', 'الصافي المستحق', 2540, 'للمراجعة قبل الإقرار'),
      ],
    }]
  }
  if (def.category === 'accountant') {
    return [{
      id: 'demo-ledger',
      title: 'معاينة محاسبية تجريبية',
      columns: [
        { key: 'label', label: 'الحساب' },
        { key: 'debit', label: 'مدين', align: 'end', kind: 'money' },
        { key: 'credit', label: 'دائن', align: 'end', kind: 'money' },
        { key: 'balance', label: 'الرصيد', align: 'end', kind: 'money' },
      ],
      rows: [
        genericRow('demo-ledger-1', { label: '1110001 الحساب الرئيسي مصرف الإنماء', debit: 32000, credit: 6200, balance: 25800 }),
        genericRow('demo-ledger-2', { label: '41000 دخل عام', debit: 0, credit: 18500, balance: -18500 }),
        genericRow('demo-ledger-3', { label: '501 خدمات ومشتريات', debit: 2440, credit: 0, balance: 2440 }),
      ],
    }]
  }
  if (def.category === 'inventory') {
    return [{
      id: 'demo-inventory',
      title: 'معاينة مخزون تجريبية',
      columns: [
        { key: 'label', label: 'المنتج / المستودع' },
        { key: 'in', label: 'دخول', align: 'end', kind: 'number' },
        { key: 'out', label: 'خروج', align: 'end', kind: 'number' },
        { key: 'value', label: 'قيمة', align: 'end', kind: 'money' },
      ],
      rows: [
        genericRow('demo-inv-1', { label: 'Receipt printer rolls · المستودع الرئيسي', in: 120, out: 34, value: 2580 }),
        genericRow('demo-inv-2', { label: 'POS scanner · المستودع الرئيسي', in: 8, out: 2, value: 3600 }),
      ],
    }]
  }
  return [{
    id: 'demo-financial',
    title: 'معاينة مالية تجريبية',
    columns: moneyColumns,
    rows: [
      row('demo-revenue', 'الإيرادات', 42000, 'فواتير ومبيعات تجريبية'),
      row('demo-expenses', 'المشتريات والمصروفات', 18750, 'موردون ومصروفات تشغيلية'),
      row('demo-net', 'صافي الربح', 23250, 'شكل التقرير قبل الطباعة'),
    ],
  }]
}

reportsRoutes.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const auth = c.get('auth')
  const reportId = c.req.param('id')
  const def = reportCatalog.find((item) => item.id === reportId) || reportCatalog[0]
  const { from, to } = parseDateRange({ from: c.req.query('from'), to: c.req.query('to') })
  const forceDemo = c.req.query('demo') === '1'

  const dateFilter = { gte: from, lte: to }
  const [
    org,
    invoices,
    bills,
    expenses,
    vouchers,
    accounts,
    journals,
    bankAccounts,
    products,
    stockMovements,
    warehouses,
    payrollRuns,
    auditLogs,
  ] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId } }),
    prisma.invoice.findMany({
      where: { orgId, issueDate: dateFilter },
      include: {
        contact: { select: { id: true, displayName: true, taxId: true, vatNumber: true } },
        lines: { include: { product: { select: { id: true, sku: true, name: true, nameAr: true } }, taxRate: { select: { name: true, rate: true } } } },
      },
      orderBy: { issueDate: 'desc' },
      take: 500,
    }),
    prisma.bill.findMany({
      where: { orgId, issueDate: dateFilter },
      include: {
        contact: { select: { id: true, displayName: true, taxId: true, vatNumber: true } },
        lines: { include: { product: { select: { id: true, sku: true, name: true, nameAr: true } }, taxRate: { select: { name: true, rate: true } } } },
      },
      orderBy: { issueDate: 'desc' },
      take: 500,
    }),
    prisma.expense.findMany({
      where: { orgId, date: dateFilter },
      include: { contact: { select: { id: true, displayName: true, taxId: true, vatNumber: true } }, taxRate: { select: { name: true, rate: true } } },
      orderBy: { date: 'desc' },
      take: 500,
    }),
    prisma.voucher.findMany({
      where: { orgId, date: dateFilter },
      include: { contact: { select: { id: true, displayName: true } }, bankAccount: { select: { id: true, name: true } } },
      orderBy: { date: 'desc' },
      take: 500,
    }),
    prisma.account.findMany({ where: { orgId, isActive: true }, orderBy: { code: 'asc' }, take: 1000 }),
    prisma.journalEntry.findMany({
      where: { orgId, date: dateFilter },
      include: { lines: { include: { account: true } } },
      orderBy: { date: 'desc' },
      take: 500,
    }),
    prisma.bankAccount.findMany({ where: { orgId, isActive: true }, orderBy: { name: 'asc' } }),
    prisma.product.findMany({ where: { orgId, isActive: true }, orderBy: { name: 'asc' }, take: 500 }),
    prisma.stockMovement.findMany({ where: { orgId, occurredAt: dateFilter }, include: { warehouse: true }, orderBy: { occurredAt: 'desc' }, take: 500 }),
    prisma.warehouse.findMany({ where: { orgId, isActive: true }, orderBy: { name: 'asc' } }),
    prisma.payrollRun.findMany({ where: { orgId, createdAt: dateFilter }, include: { lines: { include: { employee: { select: { id: true, displayName: true } } } } }, orderBy: { createdAt: 'desc' }, take: 200 }),
    prisma.auditLog.findMany({ where: { orgId, createdAt: dateFilter }, orderBy: { createdAt: 'desc' }, take: 200 }),
  ])

  if (!org) return c.json({ error: 'org_not_found' }, 404)

  const currency = org.baseCurrency || 'SAR'
  const totalRevenue = invoices.reduce((sum, item) => sum + toNumber(item.total), 0)
  const totalPurchases = bills.reduce((sum, item) => sum + toNumber(item.total), 0)
  const totalExpenses = expenses.reduce((sum, item) => sum + toNumber(item.total), 0)
  const receiptTotal = vouchers.filter((v) => v.type === 'RECEIPT').reduce((sum, item) => sum + toNumber(item.amount), 0)
  const paymentTotal = vouchers.filter((v) => v.type === 'PAYMENT').reduce((sum, item) => sum + toNumber(item.amount), 0)
  const ar = invoices.reduce((sum, item) => sum + Math.max(0, toNumber(item.total) - toNumber(item.amountPaid)), 0)
  const ap = bills.reduce((sum, item) => sum + Math.max(0, toNumber(item.total) - toNumber(item.amountPaid)), 0)
  const cash = bankAccounts.reduce((sum, item) => sum + toNumber(item.balance), 0)
  const vatOutput = invoices.reduce((sum, item) => sum + toNumber(item.taxTotal), 0)
  const vatInput = bills.reduce((sum, item) => sum + toNumber(item.taxTotal), 0) + expenses.reduce((sum, item) => sum + toNumber(item.taxAmount), 0)
  const journalLines = journals.flatMap((journal) => journal.lines.map((line) => ({ journal, line })))

  const sections: ReportSection[] = []

  if (['income-statement', 'income-by-branch', 'income-by-cost-center', 'income-by-project', 'consolidated-income', 'management-pdf'].includes(def.id)) {
    sections.push({
      id: 'income-summary',
      title: 'ملخص قائمة الدخل',
      columns: moneyColumns,
      rows: [
        row('revenue', 'الإيرادات', totalRevenue, 'من فواتير المبيعات خلال الفترة', { label: 'فواتير المبيعات', href: '/app/invoices', type: 'invoices' }),
        row('purchases', 'المشتريات', totalPurchases, 'من فواتير الموردين', { label: 'فواتير المشتريات', href: '/app/purchases/bills', type: 'bills' }),
        row('expenses', 'المصروفات النقدية', totalExpenses, 'من المصروفات والإيصالات', { label: 'المصروفات', href: '/app/expenses', type: 'expenses' }),
        row('net-income', 'صافي الربح / الخسارة', totalRevenue - totalPurchases - totalExpenses, 'قبل التسويات والإقفالات المتقدمة'),
      ],
    })
  } else if (['cash-flow', 'cash-flow-indirect', 'cash-forecast', 'forecast-cash', 'consolidated-cash-flow'].includes(def.id)) {
    sections.push({
      id: 'cash-flow-summary',
      title: def.id.includes('forecast') ? 'التوقعات النقدية' : 'ملخص التدفق النقدي',
      columns: moneyColumns,
      rows: [
        row('cash-opening', 'رصيد نقدي حالي', cash, 'من الحسابات البنكية المسجلة', { label: 'الحسابات البنكية', href: '/app/bank-accounts', type: 'bankAccounts' }),
        row('cash-in', 'نقد داخل', receiptTotal, 'من سندات القبض'),
        row('cash-out', 'نقد خارج', paymentTotal + totalExpenses, 'سندات دفع + مصروفات نقدية'),
        row('cash-net', 'صافي الحركة', receiptTotal - paymentTotal - totalExpenses, 'خلال الفترة المحددة'),
      ],
    })
  } else if (['balance-sheet', 'consolidated-balance-sheet'].includes(def.id)) {
    sections.push({
      id: 'financial-position',
      title: 'قائمة المركز المالي',
      columns: moneyColumns,
      rows: [
        row('cash', 'النقد والبنوك', cash, 'أرصدة الحسابات البنكية', { label: 'الحسابات البنكية', href: '/app/bank-accounts', type: 'bankAccounts' }),
        row('ar', 'الذمم المدينة', ar, 'فواتير العملاء غير المحصلة', { label: 'فواتير العملاء', href: '/app/invoices', type: 'invoices' }),
        row('inventory', 'المخزون', products.reduce((sum, product) => sum + toNumber(product.stockQty) * toNumber(product.costPrice), 0), 'تقييم تقريبي من كميات المنتجات'),
        row('ap', 'الذمم الدائنة', ap, 'فواتير الموردين غير المدفوعة', { label: 'فواتير الموردين', href: '/app/purchases/bills', type: 'bills' }),
        row('vat', 'صافي الضريبة', vatOutput - vatInput, 'مخرجات ناقص مدخلات'),
        row('equity', 'حقوق الملكية المقدرة', cash + ar - ap - Math.max(vatOutput - vatInput, 0), 'تقدير لحين إقفال كامل القيود'),
      ],
    })
  } else if (def.category === 'sales') {
    if (def.id.includes('aging')) {
      const agingRows = invoices
        .filter((invoice) => toNumber(invoice.total) - toNumber(invoice.amountPaid) > 0)
        .map((invoice) => {
          const outstanding = toNumber(invoice.total) - toNumber(invoice.amountPaid)
          return genericRow(invoice.id, {
            label: invoice.contact.displayName,
            number: invoice.invoiceNumber,
            date: isoDate(invoice.dueDate),
            bucket: bucketAge(invoice.dueDate),
            amount: outstanding,
            status: invoice.status,
          }, invoice.contact.displayName, { label: invoice.invoiceNumber, href: `/app/invoices/${invoice.id}`, type: 'invoice' })
        })
      sections.push({
        id: 'ar-aging',
        title: 'تقادم الحسابات المدينة',
        columns: [
          { key: 'label', label: 'العميل' },
          { key: 'number', label: 'الفاتورة' },
          { key: 'date', label: 'الاستحقاق', kind: 'date' },
          { key: 'bucket', label: 'الفئة', align: 'center' },
          { key: 'amount', label: 'المتبقي', align: 'end', kind: 'money' },
          { key: 'status', label: 'الحالة', align: 'center', kind: 'status' },
        ],
        rows: agingRows,
      })
    } else if (def.id.includes('product')) {
      const byProduct = new Map<string, any>()
      for (const invoice of invoices) {
        for (const line of invoice.lines) {
          const label = line.product?.nameAr || line.product?.name || line.description
          addGrouped(byProduct, line.productId || label, { label, sku: line.product?.sku || '', quantity: 0 }, toNumber(line.subtotal))
          byProduct.get(line.productId || label).quantity += toNumber(line.quantity)
        }
      }
      sections.push({
        id: 'sales-products',
        title: 'المبيعات بحسب المنتج أو الخدمة',
        columns: [
          { key: 'label', label: 'المنتج / الخدمة' },
          { key: 'sku', label: 'SKU' },
          { key: 'quantity', label: 'الكمية', align: 'end', kind: 'number' },
          { key: 'amount', label: 'المبيعات', align: 'end', kind: 'money' },
        ],
        rows: Array.from(byProduct.entries()).map(([key, item]) => genericRow(key, item, item.label)),
      })
    } else {
      const byCustomer = new Map<string, any>()
      for (const invoice of invoices) {
        addGrouped(byCustomer, invoice.contactId, {
          label: invoice.contact.displayName,
          taxId: invoice.contact.taxId || invoice.contact.vatNumber || '',
          paid: 0,
          open: 0,
        }, toNumber(invoice.total))
        const current = byCustomer.get(invoice.contactId)
        current.paid += toNumber(invoice.amountPaid)
        current.open += Math.max(0, toNumber(invoice.total) - toNumber(invoice.amountPaid))
      }
      sections.push({
        id: 'sales-customers',
        title: def.id.includes('statement') ? 'كشف حساب العملاء' : 'ملخص العملاء والمبيعات',
        columns: [
          { key: 'label', label: 'العميل' },
          { key: 'taxId', label: 'الرقم الضريبي' },
          { key: 'count', label: 'عدد الفواتير', align: 'end', kind: 'number' },
          { key: 'amount', label: 'الإجمالي', align: 'end', kind: 'money' },
          { key: 'paid', label: 'المدفوع', align: 'end', kind: 'money' },
          { key: 'open', label: 'المفتوح', align: 'end', kind: 'money' },
        ],
        rows: Array.from(byCustomer.entries()).map(([contactId, item]) => genericRow(contactId, item, item.label, { label: item.label, href: `/app/contacts/${contactId}`, type: 'contact' })),
      })
    }
  } else if (def.category === 'purchases') {
    if (def.id.includes('aging')) {
      sections.push({
        id: 'ap-aging',
        title: 'تقادم الحسابات الدائنة',
        columns: [
          { key: 'label', label: 'المورد' },
          { key: 'number', label: 'الفاتورة' },
          { key: 'date', label: 'الاستحقاق', kind: 'date' },
          { key: 'bucket', label: 'الفئة', align: 'center' },
          { key: 'amount', label: 'المتبقي', align: 'end', kind: 'money' },
          { key: 'status', label: 'الحالة', align: 'center', kind: 'status' },
        ],
        rows: bills
          .filter((bill) => toNumber(bill.total) - toNumber(bill.amountPaid) > 0)
          .map((bill) => genericRow(bill.id, {
            label: bill.contact.displayName,
            number: bill.billNumber,
            date: isoDate(bill.dueDate),
            bucket: bucketAge(bill.dueDate),
            amount: toNumber(bill.total) - toNumber(bill.amountPaid),
            status: bill.status,
          }, bill.contact.displayName, { label: bill.billNumber, href: `/app/purchases/bills/${bill.id}`, type: 'bill' })),
      })
    } else if (def.id.includes('product')) {
      const byProduct = new Map<string, any>()
      for (const bill of bills) {
        for (const line of bill.lines) {
          const label = line.product?.nameAr || line.product?.name || line.description
          addGrouped(byProduct, line.productId || label, { label, sku: line.product?.sku || '', quantity: 0 }, toNumber(line.subtotal))
          byProduct.get(line.productId || label).quantity += toNumber(line.quantity)
        }
      }
      sections.push({
        id: 'purchase-products',
        title: 'المشتريات بحسب المنتج أو الخدمة',
        columns: [
          { key: 'label', label: 'المنتج / الخدمة' },
          { key: 'sku', label: 'SKU' },
          { key: 'quantity', label: 'الكمية', align: 'end', kind: 'number' },
          { key: 'amount', label: 'المشتريات', align: 'end', kind: 'money' },
        ],
        rows: Array.from(byProduct.entries()).map(([key, item]) => genericRow(key, item, item.label)),
      })
    } else {
      const bySupplier = new Map<string, any>()
      for (const bill of bills) {
        addGrouped(bySupplier, bill.contactId, { label: bill.contact.displayName, taxId: bill.contact.taxId || bill.contact.vatNumber || '', open: 0, paid: 0 }, toNumber(bill.total))
        const current = bySupplier.get(bill.contactId)
        current.open += Math.max(0, toNumber(bill.total) - toNumber(bill.amountPaid))
        current.paid += toNumber(bill.amountPaid)
      }
      for (const expense of expenses) {
        const key = expense.contactId || expense.vendorName || expense.category
        addGrouped(bySupplier, key, { label: expense.contact?.displayName || expense.vendorName || expense.category, taxId: expense.contact?.taxId || expense.contact?.vatNumber || '', open: 0, paid: toNumber(expense.total) }, toNumber(expense.total))
      }
      sections.push({
        id: 'purchase-suppliers',
        title: def.id.includes('expenses') ? 'المصروفات بحسب المورد' : 'ملخص الموردين والمشتريات',
        columns: [
          { key: 'label', label: 'المورد / الجهة' },
          { key: 'taxId', label: 'الرقم الضريبي' },
          { key: 'count', label: 'المستندات', align: 'end', kind: 'number' },
          { key: 'amount', label: 'الإجمالي', align: 'end', kind: 'money' },
          { key: 'open', label: 'المفتوح', align: 'end', kind: 'money' },
        ],
        rows: Array.from(bySupplier.entries()).map(([key, item]) => genericRow(String(key), item, item.label, typeof key === 'string' && key.startsWith('c') ? { label: item.label, href: `/app/contacts/${key}`, type: 'contact' } : null)),
      })
    }
  } else if (def.category === 'tax') {
    sections.push({
      id: 'tax-summary',
      title: org.country === 'US' ? 'Sales Tax Summary' : 'ملخص ضريبة القيمة المضافة',
      columns: moneyColumns,
      rows: [
        row('output-tax', org.country === 'US' ? 'Sales Tax Output' : 'VAT مخرجات', vatOutput, 'من فواتير المبيعات'),
        row('input-tax', org.country === 'US' ? 'Tax Credits/Input' : 'VAT مدخلات', vatInput, 'من مشتريات ومصروفات'),
        row('net-tax', 'الصافي', vatOutput - vatInput, 'موجب = مستحق، سالب = قابل للاسترداد'),
      ],
    })
    sections.push({
      id: 'tax-documents',
      title: 'تفاصيل المستندات الضريبية',
      columns: [
        { key: 'label', label: 'المستند' },
        { key: 'date', label: 'التاريخ', kind: 'date' },
        { key: 'tax', label: 'الضريبة', align: 'end', kind: 'money' },
        { key: 'amount', label: 'الإجمالي', align: 'end', kind: 'money' },
      ],
      rows: [
        ...invoices.map((invoice) => genericRow(`inv-${invoice.id}`, { label: invoice.invoiceNumber, date: isoDate(invoice.issueDate), tax: toNumber(invoice.taxTotal), amount: toNumber(invoice.total) }, invoice.invoiceNumber, { label: invoice.invoiceNumber, href: `/app/invoices/${invoice.id}`, type: 'invoice' })),
        ...bills.map((bill) => genericRow(`bill-${bill.id}`, { label: bill.billNumber, date: isoDate(bill.issueDate), tax: toNumber(bill.taxTotal), amount: toNumber(bill.total) }, bill.billNumber, { label: bill.billNumber, href: `/app/purchases/bills/${bill.id}`, type: 'bill' })),
        ...expenses.map((expense) => genericRow(`exp-${expense.id}`, { label: expense.number, date: isoDate(expense.date), tax: toNumber(expense.taxAmount), amount: toNumber(expense.total) }, expense.number, { label: expense.number, href: `/app/expenses/${expense.id}`, type: 'expense' })),
      ],
    })
  } else if (def.category === 'accountant') {
    if (def.id === 'audit-log') {
      sections.push({
        id: 'audit-log',
        title: 'سجل التدقيق',
        columns: [
          { key: 'date', label: 'التاريخ', kind: 'date' },
          { key: 'label', label: 'الإجراء' },
          { key: 'entity', label: 'الكيان' },
          { key: 'status', label: 'المستوى', align: 'center', kind: 'status' },
        ],
        rows: auditLogs.map((item) => genericRow(item.id, { date: isoDate(item.createdAt), label: item.action, entity: item.entityType, status: item.severity }, item.action)),
      })
    } else {
      const accountMap = new Map<string, any>()
      for (const account of accounts) accountMap.set(account.id, { label: `${account.code} · ${account.nameAr || account.name}`, type: account.type, debit: 0, credit: 0, balance: 0 })
      for (const { line } of journalLines) {
        const item = accountMap.get(line.accountId)
        if (!item) continue
        item.debit += toNumber(line.debit)
        item.credit += toNumber(line.credit)
        item.balance = item.debit - item.credit
      }
      sections.push({
        id: 'accounts',
        title: def.id === 'trial-balance' ? 'ميزان المراجعة' : 'دفتر الأستاذ / كشف الحساب',
        columns: [
          { key: 'label', label: 'الحساب' },
          { key: 'type', label: 'النوع', align: 'center', kind: 'status' },
          { key: 'debit', label: 'مدين', align: 'end', kind: 'money' },
          { key: 'credit', label: 'دائن', align: 'end', kind: 'money' },
          { key: 'balance', label: 'الرصيد', align: 'end', kind: 'money' },
        ],
        rows: Array.from(accountMap.entries())
          .filter(([, item]) => Math.abs(item.debit) + Math.abs(item.credit) + Math.abs(item.balance) > 0)
          .map(([accountId, item]) => genericRow(accountId, item, item.label, { label: item.label, href: `/app/chart-of-accounts?account=${accountId}`, type: 'account' })),
      })
    }
  } else if (def.category === 'inventory') {
    const productMap = new Map(products.map((product) => [product.id, product]))
    const warehouseMap = new Map(warehouses.map((warehouse) => [warehouse.id, warehouse]))
    const movementRows = stockMovements.map((movement) => {
      const product = productMap.get(movement.productId)
      const warehouse = warehouseMap.get(movement.warehouseId)
      return genericRow(movement.id, {
        label: product?.nameAr || product?.name || movement.productId,
        warehouse: warehouse?.name || movement.warehouse.name,
        date: isoDate(movement.occurredAt),
        type: movement.type,
        quantity: toNumber(movement.quantity),
        value: toNumber(movement.quantity) * toNumber(movement.unitCost),
      }, product?.nameAr || product?.name || movement.productId, { label: product?.name || 'Product', href: `/app/products/${movement.productId}`, type: 'product' })
    })
    sections.push({
      id: 'inventory',
      title: def.id.includes('warehouse') ? 'حركة المخزون بحسب المستودع' : 'حركة المخزون',
      columns: [
        { key: 'label', label: 'المنتج' },
        { key: 'warehouse', label: 'المستودع' },
        { key: 'date', label: 'التاريخ', kind: 'date' },
        { key: 'type', label: 'الحركة', align: 'center', kind: 'status' },
        { key: 'quantity', label: 'الكمية', align: 'end', kind: 'number' },
        { key: 'value', label: 'القيمة', align: 'end', kind: 'money' },
      ],
      rows: movementRows,
    })
  } else if (def.category === 'payroll') {
    sections.push({
      id: 'payroll',
      title: 'مسيرات الرواتب',
      columns: [
        { key: 'label', label: 'المسير' },
        { key: 'period', label: 'الفترة' },
        { key: 'gross', label: 'الإجمالي', align: 'end', kind: 'money' },
        { key: 'net', label: 'الصافي', align: 'end', kind: 'money' },
        { key: 'status', label: 'الحالة', align: 'center', kind: 'status' },
      ],
      rows: payrollRuns.map((run) => genericRow(run.id, { label: run.runNumber, period: run.period, gross: toNumber(run.grossSalary), net: toNumber(run.netSalary), status: run.status }, run.runNumber, { label: run.runNumber, href: '/app/payroll', type: 'payroll' })),
    })
  }

  const realDataExists = invoices.length + bills.length + expenses.length + vouchers.length + journals.length + stockMovements.length + payrollRuns.length > 0
  const canShowDemo = forceDemo || (!hasRows(sections) && (auth.email.toLowerCase() === 'tareq@fc.sa' || !realDataExists))
  const finalSections = canShowDemo ? demoSections(def, currency) : sections

  return c.json({
    id: def.id,
    title: org.country === 'US' && def.id === 'vat-summary' ? 'Sales Tax Summary' : def.title,
    englishTitle: def.englishTitle,
    description: def.description,
    category: def.category,
    status: canShowDemo ? 'demo' : hasRows(sections) ? 'live' : 'empty',
    generatedAt: new Date().toISOString(),
    period: { from: isoDate(from), to: isoDate(to) },
    currency,
    org: {
      id: org.id,
      name: org.name,
      legalName: org.legalName,
      country: org.country,
      baseCurrency: org.baseCurrency,
      vatNumber: org.vatNumber,
      crNumber: org.crNumber,
      logoUrl: org.logoUrl,
      printLogoUrl: org.printLogoUrl,
      stampUrl: org.stampUrl,
      defaultInvoiceLanguage: org.defaultInvoiceLanguage,
      addressLine: org.addressLine,
      city: org.city,
      region: org.region,
      postalCode: org.postalCode,
      email: org.email,
      phone: org.phone,
      website: org.website,
      paymentSettings: org.paymentSettings,
    },
    summary: {
      revenue: totalRevenue,
      purchases: totalPurchases,
      expenses: totalExpenses,
      receipts: receiptTotal,
      payments: paymentTotal,
      cash,
      accountsReceivable: ar,
      accountsPayable: ap,
      vatOutput,
      vatInput,
      vatNet: vatOutput - vatInput,
    },
    sections: finalSections,
    notices: canShowDemo
      ? ['هذه معاينة ديمو للتصميم والشكل. لا تدخل في الدفاتر ولا تغير بيانات الشركة.']
      : hasRows(sections)
        ? []
        : ['لا توجد بيانات كافية لهذا التقرير خلال الفترة المحددة.'],
  })
})
