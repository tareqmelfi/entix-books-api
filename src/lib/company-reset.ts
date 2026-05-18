import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'

type ResetMode = 'blank' | 'demo'

export async function resetCompanyData(orgId: string, mode: ResetMode = 'blank') {
  return prisma.$transaction(async (tx) => {
    const [invoiceIds, billIds, quoteIds, voucherIds, journalIds, inboxIds, loyaltyIds, supplierCreditIds, creditNoteIds] = await Promise.all([
      tx.invoice.findMany({ where: { orgId }, select: { id: true } }),
      tx.bill.findMany({ where: { orgId }, select: { id: true } }),
      tx.quote.findMany({ where: { orgId }, select: { id: true } }),
      tx.voucher.findMany({ where: { orgId }, select: { id: true } }),
      tx.journalEntry.findMany({ where: { orgId }, select: { id: true } }),
      tx.inboxMessage.findMany({ where: { orgId }, select: { id: true } }),
      tx.loyaltyAccount.findMany({ where: { orgId }, select: { id: true } }),
      tx.supplierCredit.findMany({ where: { orgId }, select: { id: true } }),
      tx.creditNote.findMany({ where: { orgId }, select: { id: true } }),
    ])

    const invoices = invoiceIds.map((x) => x.id)
    const bills = billIds.map((x) => x.id)
    const quotes = quoteIds.map((x) => x.id)
    const vouchers = voucherIds.map((x) => x.id)
    const journals = journalIds.map((x) => x.id)
    const inboxMessages = inboxIds.map((x) => x.id)
    const loyaltyAccounts = loyaltyIds.map((x) => x.id)
    const supplierCredits = supplierCreditIds.map((x) => x.id)
    const creditNotes = creditNoteIds.map((x) => x.id)

    const counts: Record<string, number> = {}
    const add = async (key: string, promise: Promise<{ count: number }>) => {
      const result = await promise
      counts[key] = result.count
    }

    if (supplierCredits.length) await add('supplierCreditLines', tx.supplierCreditLine.deleteMany({ where: { supplierCreditId: { in: supplierCredits } } }))
    await add('supplierCredits', tx.supplierCredit.deleteMany({ where: { orgId } }))

    if (creditNotes.length) await add('creditNoteLines', tx.creditNoteLine.deleteMany({ where: { creditNoteId: { in: creditNotes } } }))
    await add('creditNotes', tx.creditNote.deleteMany({ where: { orgId } }))

    await add('payrollLines', tx.payrollLine.deleteMany({ where: { orgId } }))
    await add('payrollRuns', tx.payrollRun.deleteMany({ where: { orgId } }))
    await add('employeeContracts', tx.employeeContract.deleteMany({ where: { orgId } }))

    if (invoices.length || bills.length) {
      await add('payments', tx.payment.deleteMany({
        where: {
          OR: [
            ...(invoices.length ? [{ invoiceId: { in: invoices } }] : []),
            ...(bills.length ? [{ billId: { in: bills } }] : []),
          ],
        },
      }))
    }

    if (vouchers.length) await add('voucherAttachments', tx.voucherAttachment.deleteMany({ where: { voucherId: { in: vouchers } } }))
    await add('vouchers', tx.voucher.deleteMany({ where: { orgId } }))

    if (journals.length) await add('journalAttachments', tx.journalAttachment.deleteMany({ where: { journalId: { in: journals } } }))
    await add('journals', tx.journalEntry.deleteMany({ where: { orgId } }))

    if (inboxMessages.length) await add('inboxAttachments', tx.inboxAttachment.deleteMany({ where: { messageId: { in: inboxMessages } } }))
    await add('inboxMessages', tx.inboxMessage.deleteMany({ where: { orgId } }))

    if (loyaltyAccounts.length) await add('loyaltyTransactions', tx.loyaltyTransaction.deleteMany({ where: { accountId: { in: loyaltyAccounts } } }))
    await add('loyaltyAccounts', tx.loyaltyAccount.deleteMany({ where: { orgId } }))

    await add('stockMovements', tx.stockMovement.deleteMany({ where: { orgId } }))
    await add('stockLevels', tx.stockLevel.deleteMany({ where: { orgId } }))
    await add('warehouses', tx.warehouse.deleteMany({ where: { orgId } }))

    if (invoices.length) await add('invoiceLines', tx.invoiceLine.deleteMany({ where: { invoiceId: { in: invoices } } }))
    await add('invoices', tx.invoice.deleteMany({ where: { orgId } }))

    if (bills.length) await add('billLines', tx.billLine.deleteMany({ where: { billId: { in: bills } } }))
    await add('bills', tx.bill.deleteMany({ where: { orgId } }))

    if (quotes.length) await add('quoteLines', tx.quoteLine.deleteMany({ where: { quoteId: { in: quotes } } }))
    await add('quotes', tx.quote.deleteMany({ where: { orgId } }))

    await add('expenses', tx.expense.deleteMany({ where: { orgId } }))
    await add('fixedAssets', tx.fixedAsset.deleteMany({ where: { orgId } }))
    await add('notifications', tx.notification.deleteMany({ where: { orgId } }))
    await add('signatureRequests', tx.signatureRequest.deleteMany({ where: { orgId } }))
    await add('currencyRates', tx.currencyRate.deleteMany({ where: { orgId } }))
    await add('fiscalPeriods', tx.fiscalPeriod.deleteMany({ where: { orgId } }))
    await add('branches', tx.branch.deleteMany({ where: { orgId } }))
    await add('costCenters', tx.costCenter.deleteMany({ where: { orgId } }))
    await add('projects', tx.project.deleteMany({ where: { orgId } }))
    await add('bankAccounts', tx.bankAccount.deleteMany({ where: { orgId } }))
    await add('products', tx.product.deleteMany({ where: { orgId } }))
    await add('contacts', tx.contact.deleteMany({ where: { orgId } }))
    await add('taxRates', tx.taxRate.deleteMany({ where: { orgId } }))
    await add('accounts', tx.account.deleteMany({ where: { orgId } }))

    await seedCompanyDefaults(tx, orgId)
    if (mode === 'demo') await seedMinimalDemo(tx, orgId)

    return { counts }
  }, { timeout: 30_000 })
}

export async function seedCompanyDefaults(tx: Prisma.TransactionClient, orgId: string) {
  const accounts: Array<{
    code: string
    name: string
    nameAr: string
    type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'
    subtype?: string
    allowPayment?: boolean
    allowExpenseClaim?: boolean
    isSystemAccount?: boolean
  }> = [
    { code: '11000', name: 'Cash on Hand', nameAr: 'النقد في الصندوق', type: 'ASSET', subtype: 'cash', allowPayment: true, isSystemAccount: true },
    { code: '11100', name: 'Bank Accounts', nameAr: 'الحسابات البنكية', type: 'ASSET', subtype: 'bank', allowPayment: true, isSystemAccount: true },
    { code: '12000', name: 'Accounts Receivable', nameAr: 'الذمم المدينة', type: 'ASSET', subtype: 'receivable', isSystemAccount: true },
    { code: '13000', name: 'Inventory', nameAr: 'المخزون', type: 'ASSET', subtype: 'inventory', isSystemAccount: true },
    { code: '14000', name: 'Fixed Assets', nameAr: 'الأصول الثابتة', type: 'ASSET', subtype: 'fixed_asset' },
    { code: '21000', name: 'Accounts Payable', nameAr: 'الذمم الدائنة', type: 'LIABILITY', subtype: 'payable', isSystemAccount: true },
    { code: '22000', name: 'VAT Payable', nameAr: 'ضريبة القيمة المضافة المستحقة', type: 'LIABILITY', subtype: 'tax', isSystemAccount: true },
    { code: '31000', name: 'Owner Equity', nameAr: 'حقوق الملكية', type: 'EQUITY', isSystemAccount: true },
    { code: '32000', name: 'Retained Earnings', nameAr: 'الأرباح المحتجزة', type: 'EQUITY', isSystemAccount: true },
    { code: '41000', name: 'Sales Revenue', nameAr: 'إيرادات المبيعات', type: 'REVENUE', isSystemAccount: true },
    { code: '42000', name: 'Service Revenue', nameAr: 'إيرادات الخدمات', type: 'REVENUE' },
    { code: '51000', name: 'Cost of Goods Sold', nameAr: 'تكلفة البضاعة المباعة', type: 'EXPENSE' },
    { code: '52000', name: 'Salaries', nameAr: 'الرواتب', type: 'EXPENSE', allowExpenseClaim: true },
    { code: '53000', name: 'Rent Expense', nameAr: 'مصروف الإيجار', type: 'EXPENSE', allowExpenseClaim: true },
    { code: '54000', name: 'Utilities', nameAr: 'المرافق', type: 'EXPENSE', allowExpenseClaim: true },
    { code: '55000', name: 'Office Supplies', nameAr: 'مستلزمات مكتبية', type: 'EXPENSE', allowExpenseClaim: true },
    { code: '56000', name: 'Marketing', nameAr: 'التسويق', type: 'EXPENSE', allowExpenseClaim: true },
    { code: '57000', name: 'Bank Fees', nameAr: 'رسوم بنكية', type: 'EXPENSE' },
  ]

  await tx.account.createMany({ data: accounts.map((a) => ({ ...a, orgId })), skipDuplicates: true })
  await tx.taxRate.createMany({
    data: [
      { orgId, name: 'VAT 15%', rate: '0.15', type: 'STANDARD' },
      { orgId, name: 'VAT Exempt', rate: '0', type: 'EXEMPT' },
      { orgId, name: 'VAT 0%', rate: '0', type: 'ZERO_RATED' },
    ],
  })
  await tx.warehouse.create({
    data: { orgId, code: 'MAIN', name: 'المستودع الرئيسي', isPrimary: true },
  })
}

async function seedMinimalDemo(tx: Prisma.TransactionClient, orgId: string) {
  const vat15 = await tx.taxRate.findFirst({ where: { orgId, type: 'STANDARD' }, orderBy: { createdAt: 'asc' } })
  const [customer, supplier, employee] = await Promise.all([
    tx.contact.create({
      data: {
        orgId,
        customCode: 'CUST-0001',
        type: 'CUSTOMER',
        isCustomer: true,
        entityKind: 'COMPANY',
        displayName: 'شركة أكمي السعودية',
        legalName: 'Acme Saudi Trading Co.',
        email: 'ap@acme.sa',
        taxId: '300123456789003',
        country: 'SA',
        city: 'الرياض',
      },
    }),
    tx.contact.create({
      data: {
        orgId,
        customCode: 'SUPP-0001',
        type: 'SUPPLIER',
        isSupplier: true,
        entityKind: 'COMPANY',
        displayName: 'STC Business',
        email: 'b2b@stc.com.sa',
        taxId: '300111222333003',
        country: 'SA',
      },
    }),
    tx.contact.create({
      data: {
        orgId,
        customCode: 'EMP-0001',
        type: 'CUSTOMER',
        isEmployee: true,
        entityKind: 'INDIVIDUAL',
        displayName: 'سارة المطيري',
        email: 'sarah.employee@example.com',
        nationalId: '1000000001',
        country: 'SA',
      },
    }),
  ])

  const product = await tx.product.create({
    data: {
      orgId,
      sku: 'CONS-HR',
      name: 'Consulting · Per Hour',
      nameAr: 'استشارة بالساعة',
      type: 'SERVICE',
      unitPrice: '500',
      taxRateId: vat15?.id || null,
    },
  })

  const today = new Date()
  const dueDate = new Date(today.getTime() + 30 * 86400000)
  await tx.invoice.create({
    data: {
      orgId,
      contactId: customer.id,
      invoiceNumber: `INV-${today.getFullYear()}-0001`,
      status: 'SENT',
      issueDate: today,
      dueDate,
      currency: 'SAR',
      subtotal: '5000',
      taxTotal: '750',
      total: '5750',
      lines: {
        create: [{
          productId: product.id,
          description: product.name,
          quantity: '10',
          unitPrice: '500',
          taxRateId: vat15?.id || null,
          subtotal: '5750',
        }],
      },
    },
  })

  await tx.bill.create({
    data: {
      orgId,
      contactId: supplier.id,
      billNumber: `BILL-${today.getFullYear()}-0001`,
      status: 'RECEIVED',
      issueDate: today,
      dueDate,
      currency: 'SAR',
      subtotal: '1200',
      taxTotal: '180',
      total: '1380',
      lines: {
        create: [{
          description: 'Internet and telecom services',
          quantity: '1',
          unitPrice: '1200',
          taxRateId: vat15?.id || null,
          subtotal: '1380',
        }],
      },
    },
  })

  await tx.employeeContract.create({
    data: {
      orgId,
      contactId: employee.id,
      employeeNumber: 'EMP-0001',
      jobTitle: 'Accountant',
      nationalityCode: 'SA',
      basicSalary: '8000',
      housingAllowance: '2000',
      transportAllowance: '500',
      iban: 'SA0000000000000000000000',
    },
  })
}
