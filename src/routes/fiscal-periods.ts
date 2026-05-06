/**
 * Fiscal Periods · year-end close + period locking
 *
 * GET    /api/fiscal-periods                       list periods (filter ?year=)
 * POST   /api/fiscal-periods/init                  generate 12 monthly periods for a fiscal year
 * POST   /api/fiscal-periods/:id/lock              lock period (no new entries · still editable for adjustments)
 * POST   /api/fiscal-periods/:id/unlock            reopen if not closed
 * POST   /api/fiscal-periods/:id/close             permanent close + roll-forward retained earnings
 * GET    /api/fiscal-periods/:id/preview-close     compute totals without committing
 */
import { Hono } from 'hono'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'

export const fiscalPeriodsRoutes = new Hono()

fiscalPeriodsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId') as string
  const year = c.req.query('year')
  const where: any = { orgId }
  if (year) where.fiscalYear = Number(year)
  const items = await prisma.fiscalPeriod.findMany({
    where,
    orderBy: [{ fiscalYear: 'desc' }, { periodNumber: 'asc' }],
  })
  return c.json({
    items: items.map(p => ({
      ...p,
      retainedEarnings: p.retainedEarnings != null ? Number(p.retainedEarnings) : null,
      totalRevenue: p.totalRevenue != null ? Number(p.totalRevenue) : null,
      totalExpense: p.totalExpense != null ? Number(p.totalExpense) : null,
      netIncome: p.netIncome != null ? Number(p.netIncome) : null,
    })),
  })
})

fiscalPeriodsRoutes.post('/init', async (c) => {
  const orgId = c.get('orgId') as string
  const body = await c.req.json()
  const fiscalYear = Number(body.year || new Date().getFullYear())
  const startMonth = Number(body.startMonth || 1) // 1-12

  const items: any[] = []
  for (let i = 0; i < 12; i++) {
    const month = ((startMonth - 1 + i) % 12) + 1
    const year = fiscalYear + Math.floor((startMonth - 1 + i) / 12)
    const startDate = new Date(year, month - 1, 1)
    const endDate = new Date(year, month, 0, 23, 59, 59)
    items.push({
      orgId,
      fiscalYear,
      periodNumber: i + 1,
      startDate,
      endDate,
      status: 'OPEN',
    })
  }

  // Skip if already exists
  const existing = await prisma.fiscalPeriod.findMany({ where: { orgId, fiscalYear } })
  if (existing.length > 0) {
    return c.json({ error: 'already_exists', count: existing.length }, 409)
  }

  await prisma.fiscalPeriod.createMany({ data: items })
  return c.json({ ok: true, count: 12 }, 201)
})

// Compute totals for closing — does NOT commit
fiscalPeriodsRoutes.get('/:id/preview-close', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const period = await prisma.fiscalPeriod.findFirst({ where: { id, orgId } })
  if (!period) return c.json({ error: 'not_found' }, 404)

  // Aggregate posted journal lines hitting REVENUE / EXPENSE accounts within period range
  const lines = await prisma.journalLine.findMany({
    where: {
      journal: { orgId, isPosted: true, date: { gte: period.startDate, lte: period.endDate } },
      account: { type: { in: ['REVENUE', 'EXPENSE'] } },
    },
    select: { debit: true, credit: true, account: { select: { type: true } } },
  })
  let totalRevenue = 0
  let totalExpense = 0
  for (const l of lines) {
    const d = Number(l.debit); const cr = Number(l.credit)
    if (l.account.type === 'REVENUE') totalRevenue += cr - d
    else totalExpense += d - cr
  }
  const netIncome = totalRevenue - totalExpense

  // Add invoice/expense direct totals not yet journalled
  const [invSum, expSum] = await Promise.all([
    prisma.invoice.aggregate({ where: { orgId, issueDate: { gte: period.startDate, lte: period.endDate } }, _sum: { subtotal: true } }),
    prisma.expense.aggregate({ where: { orgId, date: { gte: period.startDate, lte: period.endDate } }, _sum: { total: true } }),
  ])
  const invoiceTotal = Number(invSum._sum.subtotal || 0)
  const expenseTotal = Number(expSum._sum.total || 0)

  return c.json({
    period: {
      id: period.id,
      fiscalYear: period.fiscalYear,
      periodNumber: period.periodNumber,
      startDate: period.startDate,
      endDate: period.endDate,
      status: period.status,
    },
    journalRevenue: totalRevenue,
    journalExpense: totalExpense,
    invoiceRevenue: invoiceTotal,
    expenseTotal,
    combinedRevenue: totalRevenue + invoiceTotal,
    combinedExpense: totalExpense + expenseTotal,
    netIncome: (totalRevenue + invoiceTotal) - (totalExpense + expenseTotal),
  })
})

fiscalPeriodsRoutes.post('/:id/lock', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const p = await prisma.fiscalPeriod.findFirst({ where: { id, orgId } })
  if (!p) return c.json({ error: 'not_found' }, 404)
  if (p.status !== 'OPEN') return c.json({ error: 'already_locked', currentStatus: p.status }, 409)
  await prisma.fiscalPeriod.update({ where: { id }, data: { status: 'LOCKED', lockedAt: new Date() } })
  return c.json({ ok: true })
})

fiscalPeriodsRoutes.post('/:id/unlock', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const p = await prisma.fiscalPeriod.findFirst({ where: { id, orgId } })
  if (!p) return c.json({ error: 'not_found' }, 404)
  if (p.status !== 'LOCKED') return c.json({ error: 'cannot_unlock', currentStatus: p.status }, 409)
  await prisma.fiscalPeriod.update({ where: { id }, data: { status: 'OPEN', lockedAt: null } })
  return c.json({ ok: true })
})

fiscalPeriodsRoutes.post('/:id/close', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const p = await prisma.fiscalPeriod.findFirst({ where: { id, orgId } })
  if (!p) return c.json({ error: 'not_found' }, 404)
  if (p.status === 'CLOSED') return c.json({ error: 'already_closed' }, 409)

  // Compute totals (same logic as preview)
  const lines = await prisma.journalLine.findMany({
    where: {
      journal: { orgId, isPosted: true, date: { gte: p.startDate, lte: p.endDate } },
      account: { type: { in: ['REVENUE', 'EXPENSE'] } },
    },
    select: { debit: true, credit: true, account: { select: { type: true } } },
  })
  let revenue = 0; let expense = 0
  for (const l of lines) {
    const d = Number(l.debit); const cr = Number(l.credit)
    if (l.account.type === 'REVENUE') revenue += cr - d
    else expense += d - cr
  }
  const [invSum, expSum] = await Promise.all([
    prisma.invoice.aggregate({ where: { orgId, issueDate: { gte: p.startDate, lte: p.endDate } }, _sum: { subtotal: true } }),
    prisma.expense.aggregate({ where: { orgId, date: { gte: p.startDate, lte: p.endDate } }, _sum: { total: true } }),
  ])
  const totalRevenue = revenue + Number(invSum._sum.subtotal || 0)
  const totalExpense = expense + Number(expSum._sum.total || 0)
  const netIncome = totalRevenue - totalExpense

  // Find Retained Earnings account (3-series equity)
  const retained = await prisma.account.findFirst({
    where: { orgId, OR: [{ code: '3200' }, { name: { contains: 'Retained' } }, { nameAr: { contains: 'محتجزة' } }] },
  })

  // Auto-create closing journal entry that zeroes revenue/expense and rolls into retained earnings
  if (retained && netIncome !== 0) {
    const year = p.fiscalYear
    const closingNumber = `CLOSE-${year}-${String(p.periodNumber).padStart(2, '0')}`
    // Find revenue + expense accounts to clear
    const revAccts = await prisma.account.findMany({ where: { orgId, type: 'REVENUE' } })
    const expAccts = await prisma.account.findMany({ where: { orgId, type: 'EXPENSE' } })

    const journalLines: any[] = []
    // Each revenue account gets debited by its current period balance (closing it to zero)
    // Each expense account gets credited
    // Retained earnings absorbs the net
    for (const r of revAccts) {
      const sum = await prisma.journalLine.aggregate({
        where: {
          accountId: r.id,
          journal: { orgId, isPosted: true, date: { gte: p.startDate, lte: p.endDate } },
        },
        _sum: { credit: true, debit: true },
      })
      const bal = Number(sum._sum.credit || 0) - Number(sum._sum.debit || 0)
      if (bal !== 0) journalLines.push({ accountId: r.id, debit: new Prisma.Decimal(bal > 0 ? bal : 0), credit: new Prisma.Decimal(bal < 0 ? -bal : 0), description: 'Closing entry · revenue' })
    }
    for (const e of expAccts) {
      const sum = await prisma.journalLine.aggregate({
        where: {
          accountId: e.id,
          journal: { orgId, isPosted: true, date: { gte: p.startDate, lte: p.endDate } },
        },
        _sum: { credit: true, debit: true },
      })
      const bal = Number(sum._sum.debit || 0) - Number(sum._sum.credit || 0)
      if (bal !== 0) journalLines.push({ accountId: e.id, debit: new Prisma.Decimal(bal < 0 ? -bal : 0), credit: new Prisma.Decimal(bal > 0 ? bal : 0), description: 'Closing entry · expense' })
    }
    // Retained earnings catches the net
    if (netIncome > 0) {
      journalLines.push({ accountId: retained.id, debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(netIncome), description: 'Closing · transfer net income' })
    } else if (netIncome < 0) {
      journalLines.push({ accountId: retained.id, debit: new Prisma.Decimal(-netIncome), credit: new Prisma.Decimal(0), description: 'Closing · transfer net loss' })
    }

    if (journalLines.length > 0) {
      await prisma.journalEntry.create({
        data: {
          orgId,
          entryNumber: closingNumber,
          date: p.endDate,
          description: `Closing entry · Period ${p.periodNumber}/${year}`,
          source: 'system',
          isPosted: true,
          postedAt: new Date(),
          lines: { create: journalLines },
        },
      })
    }
  }

  await prisma.fiscalPeriod.update({
    where: { id },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
      totalRevenue: new Prisma.Decimal(totalRevenue),
      totalExpense: new Prisma.Decimal(totalExpense),
      netIncome: new Prisma.Decimal(netIncome),
      retainedEarnings: new Prisma.Decimal(netIncome),
    },
  })

  return c.json({ ok: true, totalRevenue, totalExpense, netIncome })
})
