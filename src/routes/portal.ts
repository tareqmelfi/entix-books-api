/**
 * Customer/Supplier Self-Service Portal · UX-118
 *
 * Public endpoints — auth via portalToken in query/header (magic-link style).
 *
 * GET    /api/portal/me?token=...           contact info + summary
 * GET    /api/portal/invoices?token=...     list invoices
 * GET    /api/portal/statement?token=...    full account statement
 * GET    /api/portal/documents?token=...    shared documents
 * POST   /api/portal/pay/:invoiceId         create payment link · public · validates token
 *
 * Org-side endpoints (require org auth — kept under orgScoped):
 *   POST /api/contacts/:id/portal/enable    issue or refresh portal token
 *   POST /api/contacts/:id/portal/disable
 */
import { Hono } from 'hono'
import { randomBytes, randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'

export const portalRoutes = new Hono()

async function authContact(c: any) {
  const token = c.req.query('token') || c.req.header('x-portal-token')
  if (!token) return null
  const contact = await prisma.contact.findFirst({
    where: { portalToken: token, portalEnabled: true, isActive: true },
    include: { org: { select: { id: true, name: true, baseCurrency: true, country: true, logoUrl: true } } },
  })
  return contact
}

portalRoutes.get('/me', async (c) => {
  const contact = await authContact(c)
  if (!contact) return c.json({ error: 'invalid_token' }, 401)

  // Compute outstanding + overdue
  const [outstanding, overdue, invoiceCount, lastPayment] = await Promise.all([
    prisma.invoice.aggregate({
      where: { orgId: contact.orgId, contactId: contact.id, status: { in: ['SENT', 'PARTIAL', 'OVERDUE'] } },
      _sum: { total: true, amountPaid: true },
    }),
    prisma.invoice.aggregate({
      where: { orgId: contact.orgId, contactId: contact.id, status: 'OVERDUE' },
      _sum: { total: true, amountPaid: true },
      _count: true,
    }),
    prisma.invoice.count({ where: { orgId: contact.orgId, contactId: contact.id } }),
    prisma.voucher.findFirst({
      where: { orgId: contact.orgId, contactId: contact.id, type: 'RECEIPT' },
      orderBy: { date: 'desc' },
      select: { date: true, amount: true },
    }),
  ])

  return c.json({
    contact: {
      id: contact.id,
      displayName: contact.displayName,
      email: contact.email,
      phone: contact.phone,
      country: contact.country,
      addressLine1: contact.addressLine1,
      city: contact.city,
      vatNumber: (contact as any).vatNumber,
      paymentTerms: (contact as any).paymentTerms,
      creditLimit: (contact as any).creditLimit ? Number((contact as any).creditLimit) : null,
    },
    org: contact.org,
    summary: {
      outstanding: Number(outstanding._sum.total || 0) - Number(outstanding._sum.amountPaid || 0),
      overdueAmount: Number(overdue._sum.total || 0) - Number(overdue._sum.amountPaid || 0),
      overdueCount: overdue._count || 0,
      totalInvoices: invoiceCount,
      lastPayment: lastPayment ? { date: lastPayment.date, amount: Number(lastPayment.amount) } : null,
    },
  })
})

portalRoutes.get('/invoices', async (c) => {
  const contact = await authContact(c)
  if (!contact) return c.json({ error: 'invalid_token' }, 401)
  const status = c.req.query('status')
  const where: any = { orgId: contact.orgId, contactId: contact.id }
  if (status) where.status = status
  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: { issueDate: 'desc' },
    take: 100,
  })
  return c.json({
    items: invoices.map(i => ({
      id: i.id,
      number: i.invoiceNumber,
      date: i.issueDate,
      dueDate: i.dueDate,
      currency: i.currency,
      total: Number(i.total),
      paid: Number(i.amountPaid),
      remaining: Number(i.total) - Number(i.amountPaid),
      status: i.status,
      paymentLinkUrl: (i as any).paymentLinkUrl,
    })),
  })
})

portalRoutes.get('/statement', async (c) => {
  const contact = await authContact(c)
  if (!contact) return c.json({ error: 'invalid_token' }, 401)
  // Combine invoices (debit) + vouchers RECEIPT (credit) chronologically with running balance
  const [invoices, payments] = await Promise.all([
    prisma.invoice.findMany({
      where: { orgId: contact.orgId, contactId: contact.id },
      orderBy: { issueDate: 'asc' },
      take: 500,
    }),
    prisma.voucher.findMany({
      where: { orgId: contact.orgId, contactId: contact.id, type: 'RECEIPT' },
      orderBy: { date: 'asc' },
      take: 500,
    }),
  ])
  type Row = { date: Date; description: string; ref: string; debit: number; credit: number }
  const rows: Row[] = []
  for (const i of invoices) {
    rows.push({
      date: i.issueDate,
      description: `فاتورة · ${i.invoiceNumber}`,
      ref: i.invoiceNumber,
      debit: Number(i.total),
      credit: 0,
    })
  }
  for (const p of payments) {
    rows.push({
      date: p.date,
      description: `دفعة مستلمة`,
      ref: p.voucherNumber,
      debit: 0,
      credit: Number(p.amount),
    })
  }
  rows.sort((a, b) => a.date.getTime() - b.date.getTime())
  let balance = 0
  const items = rows.map(r => {
    balance += r.debit - r.credit
    return { ...r, balance }
  })
  return c.json({ items, finalBalance: balance })
})

portalRoutes.get('/documents', async (c) => {
  const contact = await authContact(c)
  if (!contact) return c.json({ error: 'invalid_token' }, 401)
  // For now return empty + signed contracts when DocuSeal is wired
  return c.json({ items: [] })
})

// Initiate payment for an invoice via the portal — generates link and returns it
portalRoutes.post('/pay/:invoiceId', async (c) => {
  const contact = await authContact(c)
  if (!contact) return c.json({ error: 'invalid_token' }, 401)
  const invoiceId = c.req.param('invoiceId')
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, orgId: contact.orgId, contactId: contact.id },
    select: { id: true, paymentLinkUrl: true },
  })
  if (!inv) return c.json({ error: 'not_found' }, 404)
  if (inv.paymentLinkUrl) return c.json({ url: inv.paymentLinkUrl })
  return c.json({ error: 'no_link', message: 'اطلب من البائع إنشاء رابط دفع' }, 404)
})

// ── Org-side endpoints: enable/disable + token refresh ────────────────────
export const portalAdminRoutes = new Hono()

portalAdminRoutes.post('/:contactId/portal/enable', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('contactId')
  const contact = await prisma.contact.findFirst({ where: { id, orgId } })
  if (!contact) return c.json({ error: 'not_found' }, 404)
  const token = randomBytes(32).toString('hex')
  await prisma.contact.update({
    where: { id },
    data: { portalToken: token, portalEnabled: true },
  })
  const url = `${process.env.PORTAL_BASE_URL || 'https://portal.entix.io'}/?token=${token}`
  return c.json({ ok: true, url, token })
})

portalAdminRoutes.post('/:contactId/portal/disable', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('contactId')
  const contact = await prisma.contact.findFirst({ where: { id, orgId } })
  if (!contact) return c.json({ error: 'not_found' }, 404)
  await prisma.contact.update({
    where: { id },
    data: { portalEnabled: false, portalToken: null },
  })
  return c.json({ ok: true })
})

portalAdminRoutes.get('/:contactId/portal/url', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('contactId')
  const contact = await prisma.contact.findFirst({
    where: { id, orgId },
    select: { portalToken: true, portalEnabled: true },
  })
  if (!contact) return c.json({ error: 'not_found' }, 404)
  if (!contact.portalEnabled || !contact.portalToken) return c.json({ enabled: false })
  const url = `${process.env.PORTAL_BASE_URL || 'https://portal.entix.io'}/?token=${contact.portalToken}`
  return c.json({ enabled: true, url, token: contact.portalToken })
})
