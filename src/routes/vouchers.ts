/**
 * Vouchers · سند قبض (RECEIPT) + سند صرف (PAYMENT)
 *
 * - RECEIPT  : cash IN from a customer · optionally linked to an invoice
 * - PAYMENT  : cash OUT to a supplier · optionally linked to a bill
 * Auto-updates invoice/bill amountPaid + status when linked.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { createNotification } from './notifications.js'

export const vouchersRoutes = new Hono()

const voucherSchema = z.object({
  type: z.enum(['RECEIPT', 'PAYMENT']),
  number: z.string().optional(),
  date: z.string().transform((s) => new Date(s)),
  contactId: z.string().optional().nullable(),
  amount: z.coerce.number().positive(),
  currency: z.string().length(3).default('SAR'),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'STC_PAY', 'MADA', 'CHECK', 'OTHER']),
  reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  invoiceId: z.string().optional().nullable(),
  billId: z.string().optional().nullable(),
  // UX-45 enrichment
  bankAccountId: z.string().optional().nullable(),
  isAdvance: z.boolean().optional().default(false),
  projectId: z.string().optional().nullable(),
  costCenterId: z.string().optional().nullable(),
  attachmentUrl: z.string().url().optional().nullable().or(z.literal('').transform(() => null)),
})

async function nextVoucherNumber(orgId: string, type: 'RECEIPT' | 'PAYMENT'): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = type === 'RECEIPT' ? `R-${year}-` : `P-${year}-`
  const last = await prisma.voucher.findFirst({
    where: { orgId, type, number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  })
  const lastNum = last ? Number(last.number.split('-').pop() || '0') : 0
  return `${prefix}${String(lastNum + 1).padStart(4, '0')}`
}

vouchersRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const type = c.req.query('type') as 'RECEIPT' | 'PAYMENT' | undefined
  const where: any = { orgId }
  if (type) where.type = type

  // Filters · ?contactId=... ?invoiceId=... ?billId=... ?bankAccountId=... ?isAdvance=true ?projectId=...
  const contactId = c.req.query('contactId')
  const invoiceId = c.req.query('invoiceId')
  const billId = c.req.query('billId')
  const bankAccountId = c.req.query('bankAccountId')
  const isAdvance = c.req.query('isAdvance')
  const projectId = c.req.query('projectId')
  if (contactId) where.contactId = contactId
  if (invoiceId) where.invoiceId = invoiceId
  if (billId) where.billId = billId
  if (bankAccountId) where.bankAccountId = bankAccountId
  if (isAdvance === 'true') where.isAdvance = true
  if (isAdvance === 'false') where.isAdvance = false
  if (projectId) where.projectId = projectId

  const [items, sumAgg] = await Promise.all([
    prisma.voucher.findMany({
      where,
      include: {
        contact: { select: { id: true, displayName: true } },
        bankAccount: { select: { id: true, name: true, bankName: true } },
        project: { select: { id: true, code: true, name: true } },
        costCenter: { select: { id: true, code: true, name: true } },
      },
      orderBy: { date: 'desc' },
      take: 200,
    }),
    prisma.voucher.aggregate({ where, _sum: { amount: true }, _avg: { amount: true } }),
  ])

  return c.json({
    items,
    total: items.length,
    summary: {
      sumAmount: sumAgg._sum.amount ?? '0',
      avgAmount: sumAgg._avg.amount ?? '0',
    },
  })
})

vouchersRoutes.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const v = await prisma.voucher.findFirst({
    where: { id: c.req.param('id'), orgId },
    include: { contact: true },
  })
  if (!v) return c.json({ error: 'not found' }, 404)
  return c.json(v)
})

vouchersRoutes.post('/', zValidator('json', voucherSchema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')

  // Validate links
  if (data.invoiceId) {
    const inv = await prisma.invoice.findFirst({ where: { id: data.invoiceId, orgId } })
    if (!inv) return c.json({ error: 'invalid invoiceId' }, 400)
  }
  if (data.billId) {
    const b = await prisma.bill.findFirst({ where: { id: data.billId, orgId } })
    if (!b) return c.json({ error: 'invalid billId' }, 400)
  }
  if (data.bankAccountId) {
    const ba = await prisma.bankAccount.findFirst({ where: { id: data.bankAccountId, orgId } })
    if (!ba) return c.json({ error: 'invalid bankAccountId' }, 400)
  }
  if (data.projectId) {
    const p = await prisma.project.findFirst({ where: { id: data.projectId, orgId } })
    if (!p) return c.json({ error: 'invalid projectId' }, 400)
  }
  if (data.costCenterId) {
    const cc = await prisma.costCenter.findFirst({ where: { id: data.costCenterId, orgId } })
    if (!cc) return c.json({ error: 'invalid costCenterId' }, 400)
  }
  // Enforce: advance payment cannot be linked to invoice/bill simultaneously
  if (data.isAdvance && (data.invoiceId || data.billId)) {
    return c.json({ error: 'advance_with_link', message: 'الدفعة المقدمة لا تُربط بفاتورة أو سند مشتريات · أزل الربط أو ألغِ الـadvance' }, 400)
  }

  const number = data.number || (await nextVoucherNumber(orgId, data.type))

  const voucher = await prisma.$transaction(async (tx) => {
    const v = await tx.voucher.create({
      data: {
        orgId,
        type: data.type,
        number,
        date: data.date,
        contactId: data.contactId || null,
        amount: new Prisma.Decimal(data.amount),
        currency: data.currency,
        paymentMethod: data.paymentMethod,
        reference: data.reference,
        notes: data.notes,
        invoiceId: data.invoiceId || null,
        billId: data.billId || null,
        bankAccountId: data.bankAccountId || null,
        isAdvance: data.isAdvance ?? false,
        projectId: data.projectId || null,
        costCenterId: data.costCenterId || null,
        attachmentUrl: data.attachmentUrl || null,
      },
      include: {
        contact: true,
        bankAccount: { select: { id: true, name: true, bankName: true } },
        project: { select: { id: true, code: true, name: true } },
        costCenter: { select: { id: true, code: true, name: true } },
      },
    })

    // Update bank account balance for non-cash methods
    if (data.bankAccountId && data.paymentMethod !== 'CASH') {
      const delta = data.type === 'RECEIPT' ? data.amount : -data.amount
      await tx.bankAccount.update({
        where: { id: data.bankAccountId },
        data: { balance: { increment: new Prisma.Decimal(delta) } },
      })
    }

    // Touch contact lastInteraction
    if (data.contactId) {
      await tx.contact.update({ where: { id: data.contactId }, data: { lastInteraction: new Date() } })
    }

    // Auto-update linked invoice / bill
    if (data.invoiceId && data.type === 'RECEIPT') {
      const inv = await tx.invoice.findUnique({ where: { id: data.invoiceId } })
      if (inv) {
        const newPaid = Number(inv.amountPaid) + data.amount
        const total = Number(inv.total)
        const status = newPaid >= total ? 'PAID' : newPaid > 0 ? 'PARTIAL' : inv.status
        await tx.invoice.update({
          where: { id: data.invoiceId },
          data: { amountPaid: new Prisma.Decimal(newPaid), status },
        })
      }
    }
    if (data.billId && data.type === 'PAYMENT') {
      const b = await tx.bill.findUnique({ where: { id: data.billId } })
      if (b) {
        const newPaid = Number(b.amountPaid) + data.amount
        const total = Number(b.total)
        const status = newPaid >= total ? 'PAID' : newPaid > 0 ? 'PARTIAL' : b.status
        await tx.bill.update({
          where: { id: data.billId },
          data: { amountPaid: new Prisma.Decimal(newPaid), status },
        })
      }
    }

    return v
  })

  // Fire-and-forget notification (outside tx)
  const customerName = voucher.contact?.displayName || ''
  if (data.type === 'RECEIPT') {
    await createNotification(orgId, {
      type: 'INVOICE_PAID',
      title: `سند قبض جديد · ${voucher.number}`,
      body: `${data.amount.toLocaleString()} ${data.currency}${customerName ? ` من ${customerName}` : ''}`,
      link: `/app/receipts`,
      refType: 'VOUCHER',
      refId: voucher.id,
    })
  } else {
    await createNotification(orgId, {
      type: 'EXPENSE_CREATED',
      title: `سند صرف جديد · ${voucher.number}`,
      body: `${data.amount.toLocaleString()} ${data.currency}${customerName ? ` لـ ${customerName}` : ''}`,
      link: `/app/payments`,
      refType: 'VOUCHER',
      refId: voucher.id,
    })
  }

  return c.json(voucher, 201)
})

vouchersRoutes.patch('/:id', zValidator('json', voucherSchema.partial()), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.voucher.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  const data = c.req.valid('json')
  const updates: any = { ...data }
  if (data.amount !== undefined) updates.amount = new Prisma.Decimal(data.amount)
  if (data.date) updates.date = new Date(data.date)
  const v = await prisma.voucher.update({ where: { id }, data: updates, include: { contact: true } })
  return c.json(v)
})

vouchersRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.voucher.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  // Reverse the linked invoice/bill
  await prisma.$transaction(async (tx) => {
    if (exists.invoiceId && exists.type === 'RECEIPT') {
      const inv = await tx.invoice.findUnique({ where: { id: exists.invoiceId } })
      if (inv) {
        const newPaid = Math.max(0, Number(inv.amountPaid) - Number(exists.amount))
        const status = newPaid === 0 ? 'SENT' : newPaid >= Number(inv.total) ? 'PAID' : 'PARTIAL'
        await tx.invoice.update({
          where: { id: exists.invoiceId },
          data: { amountPaid: new Prisma.Decimal(newPaid), status },
        })
      }
    }
    if (exists.billId && exists.type === 'PAYMENT') {
      const b = await tx.bill.findUnique({ where: { id: exists.billId } })
      if (b) {
        const newPaid = Math.max(0, Number(b.amountPaid) - Number(exists.amount))
        const status = newPaid === 0 ? 'RECEIVED' : newPaid >= Number(b.total) ? 'PAID' : 'PARTIAL'
        await tx.bill.update({
          where: { id: exists.billId },
          data: { amountPaid: new Prisma.Decimal(newPaid), status },
        })
      }
    }
    // Reverse bank account balance change
    if (exists.bankAccountId && exists.paymentMethod !== 'CASH') {
      const delta = exists.type === 'RECEIPT' ? -Number(exists.amount) : Number(exists.amount)
      await tx.bankAccount.update({
        where: { id: exists.bankAccountId },
        data: { balance: { increment: new Prisma.Decimal(delta) } },
      })
    }
    await tx.voucher.delete({ where: { id } })
  })
  return c.body(null, 204)
})
