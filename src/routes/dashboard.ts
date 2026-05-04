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
