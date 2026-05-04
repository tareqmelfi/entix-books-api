/**
 * Dashboard summary · org-scoped financial overview
 * Powers /app dashboard cards · all numbers come from DB
 */
import { Hono } from 'hono'
import { prisma } from '../db.js'

export const dashboardRoutes = new Hono()

dashboardRoutes.get('/summary', async (c) => {
  const orgId = c.get('orgId')
  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1)

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, baseCurrency: true, country: true },
  })

  // Top KPIs
  const [
    revenueTotal,
    purchasesTotal,
    expenseTotal,
    receiptTotal,
    paymentTotal,
    invoiceCount,
    overdueCount,
    contactCount,
    vatPayable,
    vatRefundable,
  ] = await Promise.all([
    prisma.invoice.aggregate({ where: { orgId }, _sum: { total: true } }),
    prisma.bill.aggregate({ where: { orgId }, _sum: { total: true } }),
    prisma.expense.aggregate({ where: { orgId }, _sum: { total: true } }),
    prisma.voucher.aggregate({ where: { orgId, type: 'RECEIPT' }, _sum: { amount: true } }),
    prisma.voucher.aggregate({ where: { orgId, type: 'PAYMENT' }, _sum: { amount: true } }),
    prisma.invoice.count({ where: { orgId } }),
    prisma.invoice.count({ where: { orgId, status: 'OVERDUE' } }),
    prisma.contact.count({ where: { orgId, isActive: true } }),
    prisma.invoice.aggregate({ where: { orgId }, _sum: { taxTotal: true } }),
    prisma.bill.aggregate({ where: { orgId }, _sum: { taxTotal: true } }),
  ])

  const vatOutput = Number(vatPayable._sum.taxTotal || 0)
  const vatInput = Number(vatRefundable._sum.taxTotal || 0)
  const vatNet = vatOutput - vatInput

  // 6-month revenue vs expenses (chart data)
  const monthlyTrend: Array<{ month: string; revenue: number; expenses: number }> = []
  for (let i = 5; i >= 0; i--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1)
    const [r, e] = await Promise.all([
      prisma.invoice.aggregate({
        where: { orgId, issueDate: { gte: monthStart, lt: monthEnd } },
        _sum: { total: true },
      }),
      prisma.expense.aggregate({
        where: { orgId, date: { gte: monthStart, lt: monthEnd } },
        _sum: { total: true },
      }),
    ])
    const monthName = monthStart.toLocaleDateString('ar-SA', { month: 'short' })
    monthlyTrend.push({
      month: monthName,
      revenue: Number(r._sum.total || 0),
      expenses: Number(e._sum.total || 0),
    })
  }

  // Cash flow (last 6 months)
  const cashFlowTrend: Array<{ month: string; in: number; out: number }> = []
  for (let i = 5; i >= 0; i--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1)
    const [inAgg, outAgg] = await Promise.all([
      prisma.voucher.aggregate({
        where: { orgId, type: 'RECEIPT', date: { gte: monthStart, lt: monthEnd } },
        _sum: { amount: true },
      }),
      prisma.voucher.aggregate({
        where: { orgId, type: 'PAYMENT', date: { gte: monthStart, lt: monthEnd } },
        _sum: { amount: true },
      }),
    ])
    cashFlowTrend.push({
      month: monthStart.toLocaleDateString('ar-SA', { month: 'short' }),
      in: Number(inAgg._sum.amount || 0),
      out: Number(outAgg._sum.amount || 0),
    })
  }

  return c.json({
    org,
    kpi: {
      revenue: Number(revenueTotal._sum.total || 0),
      purchases: Number(purchasesTotal._sum.total || 0),
      expenses: Number(expenseTotal._sum.total || 0),
      receipts: Number(receiptTotal._sum.amount || 0),
      payments: Number(paymentTotal._sum.amount || 0),
      vatOutput,
      vatInput,
      vatNet,
      invoiceCount,
      overdueCount,
      contactCount,
    },
    monthlyTrend,
    cashFlowTrend,
  })
})

// ── /sales · sales-only KPIs and recent invoices ────────────────────────────
dashboardRoutes.get('/sales', async (c) => {
  const orgId = c.get('orgId')
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const yearStart = new Date(now.getFullYear(), 0, 1)

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { baseCurrency: true, name: true },
  })

  const [thisMonth, ytd, allTime, byStatus, recentInvoices, topCustomers] = await Promise.all([
    prisma.invoice.aggregate({ where: { orgId, issueDate: { gte: monthStart } }, _sum: { total: true, amountPaid: true }, _count: true }),
    prisma.invoice.aggregate({ where: { orgId, issueDate: { gte: yearStart } }, _sum: { total: true, amountPaid: true }, _count: true }),
    prisma.invoice.aggregate({ where: { orgId }, _sum: { total: true, amountPaid: true }, _count: true }),
    prisma.invoice.groupBy({ by: ['status'], where: { orgId }, _count: { _all: true }, _sum: { total: true } }),
    prisma.invoice.findMany({
      where: { orgId },
      include: { contact: { select: { displayName: true } } },
      orderBy: { issueDate: 'desc' },
      take: 10,
    }),
    prisma.invoice.groupBy({
      by: ['contactId'],
      where: { orgId, issueDate: { gte: yearStart } },
      _sum: { total: true },
      orderBy: { _sum: { total: 'desc' } },
      take: 5,
    }),
  ])

  const customerNames = topCustomers.length
    ? await prisma.contact.findMany({ where: { id: { in: topCustomers.map((t) => t.contactId) } }, select: { id: true, displayName: true } })
    : []
  const customerMap = new Map(customerNames.map((c) => [c.id, c.displayName]))

  return c.json({
    org,
    thisMonth: {
      total: Number(thisMonth._sum.total || 0),
      paid: Number(thisMonth._sum.amountPaid || 0),
      count: thisMonth._count,
    },
    ytd: {
      total: Number(ytd._sum.total || 0),
      paid: Number(ytd._sum.amountPaid || 0),
      count: ytd._count,
    },
    allTime: {
      total: Number(allTime._sum.total || 0),
      paid: Number(allTime._sum.amountPaid || 0),
      count: allTime._count,
      outstanding: Number(allTime._sum.total || 0) - Number(allTime._sum.amountPaid || 0),
    },
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all, total: Number(s._sum.total || 0) })),
    recentInvoices: recentInvoices.map((i) => ({
      id: i.id,
      number: i.invoiceNumber,
      contact: i.contact.displayName,
      status: i.status,
      total: Number(i.total),
      paid: Number(i.amountPaid),
      date: i.issueDate.toISOString().slice(0, 10),
    })),
    topCustomers: topCustomers.map((t) => ({
      contactId: t.contactId,
      name: customerMap.get(t.contactId) || '—',
      total: Number(t._sum.total || 0),
    })),
  })
})

// ── /purchases · purchase bills + cash expenses ─────────────────────────────
dashboardRoutes.get('/purchases', async (c) => {
  const orgId = c.get('orgId')
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const yearStart = new Date(now.getFullYear(), 0, 1)

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { baseCurrency: true, name: true },
  })

  const [billsThisMonth, billsYtd, expensesYtd, byCategory, topSuppliers, recentBills] = await Promise.all([
    prisma.bill.aggregate({ where: { orgId, issueDate: { gte: monthStart } }, _sum: { total: true }, _count: true }),
    prisma.bill.aggregate({ where: { orgId, issueDate: { gte: yearStart } }, _sum: { total: true }, _count: true }),
    prisma.expense.aggregate({ where: { orgId, date: { gte: yearStart } }, _sum: { total: true }, _count: true }),
    prisma.expense.groupBy({
      by: ['category'],
      where: { orgId, date: { gte: yearStart } },
      _sum: { total: true },
      orderBy: { _sum: { total: 'desc' } },
      take: 8,
    }),
    prisma.bill.groupBy({
      by: ['contactId'],
      where: { orgId, issueDate: { gte: yearStart } },
      _sum: { total: true },
      orderBy: { _sum: { total: 'desc' } },
      take: 5,
    }),
    prisma.bill.findMany({
      where: { orgId },
      include: { contact: { select: { displayName: true } } },
      orderBy: { issueDate: 'desc' },
      take: 10,
    }),
  ])

  const supplierNames = topSuppliers.length
    ? await prisma.contact.findMany({ where: { id: { in: topSuppliers.map((t) => t.contactId) } }, select: { id: true, displayName: true } })
    : []
  const supplierMap = new Map(supplierNames.map((c) => [c.id, c.displayName]))

  return c.json({
    org,
    thisMonth: {
      bills: Number(billsThisMonth._sum.total || 0),
      billCount: billsThisMonth._count,
    },
    ytd: {
      bills: Number(billsYtd._sum.total || 0),
      billCount: billsYtd._count,
      expenses: Number(expensesYtd._sum.total || 0),
      expenseCount: expensesYtd._count,
      total: Number(billsYtd._sum.total || 0) + Number(expensesYtd._sum.total || 0),
    },
    expensesByCategory: byCategory.map((c) => ({ category: c.category, total: Number(c._sum.total || 0) })),
    topSuppliers: topSuppliers.map((t) => ({
      contactId: t.contactId,
      name: supplierMap.get(t.contactId) || '—',
      total: Number(t._sum.total || 0),
    })),
    recentBills: recentBills.map((b) => ({
      id: b.id,
      number: b.billNumber,
      contact: b.contact.displayName,
      status: b.status,
      total: Number(b.total),
      date: b.issueDate.toISOString().slice(0, 10),
    })),
  })
})
