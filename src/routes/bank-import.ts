/**
 * Bank statement import routes · UX-58
 *
 * POST /api/bank-import/parse        Upload + parse only · returns rows + match suggestions (no DB writes)
 * POST /api/bank-import/commit       Apply user-approved matches · creates vouchers + updates balances
 * GET  /api/bank-import/profiles     List supported bank profiles for the dropdown
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import {
  parseCsvStatement,
  parseMt940,
  parseOfx,
  matchTransaction,
  KSA_BANK_PROFILES,
  type RawBankTransaction,
} from '../lib/bank-import.js'

export const bankImportRoutes = new Hono()

bankImportRoutes.get('/profiles', (c) => {
  return c.json({
    profiles: Object.keys(KSA_BANK_PROFILES).map((id) => ({
      id,
      label: id === 'GENERIC' ? 'CSV Generic' : id,
    })),
    formats: ['csv', 'mt940', 'ofx'],
  })
})

const parseSchema = z.object({
  bankAccountId: z.string(),
  format: z.enum(['csv', 'mt940', 'ofx']).default('csv'),
  profile: z.string().optional().default('GENERIC'),
  text: z.string().min(1).max(5_000_000), // 5MB cap
})

bankImportRoutes.post('/parse', zValidator('json', parseSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const { bankAccountId, format, profile, text } = c.req.valid('json')

  const bank = await prisma.bankAccount.findFirst({ where: { id: bankAccountId, orgId } })
  if (!bank) return c.json({ error: 'invalid_bank_account' }, 400)

  let rows: RawBankTransaction[] = []
  try {
    if (format === 'mt940') rows = parseMt940(text)
    else if (format === 'ofx') rows = parseOfx(text)
    else rows = parseCsvStatement(text, KSA_BANK_PROFILES[profile] || KSA_BANK_PROFILES.GENERIC)
  } catch (e: any) {
    return c.json({ error: 'parse_failed', message: e?.message || 'unknown' }, 400)
  }

  if (rows.length === 0) {
    return c.json({ rows: [], matched: 0, unmatched: 0, message: 'لم يتم استخراج أي حركات · تأكد من الصيغة' })
  }

  // Pull candidates within ±60 days of the imported range
  const dates = rows.map((r) => new Date(r.date).getTime()).filter((t) => !isNaN(t))
  const minDate = new Date(Math.min(...dates) - 60 * 86400_000)
  const maxDate = new Date(Math.max(...dates) + 60 * 86400_000)

  const [vouchers, invoices, bills] = await Promise.all([
    prisma.voucher.findMany({
      where: { orgId, date: { gte: minDate, lte: maxDate } },
      select: { id: true, amount: true, date: true, reference: true, contact: { select: { displayName: true } } },
      take: 1000,
    }),
    prisma.invoice.findMany({
      where: { orgId, dueDate: { gte: minDate, lte: maxDate }, status: { not: 'PAID' } },
      select: { id: true, total: true, dueDate: true, invoiceNumber: true, contact: { select: { displayName: true } } },
      take: 1000,
    }),
    prisma.bill.findMany({
      where: { orgId, dueDate: { gte: minDate, lte: maxDate }, status: { not: 'PAID' } },
      select: { id: true, total: true, dueDate: true, billNumber: true, contact: { select: { displayName: true } } },
      take: 1000,
    }),
  ])

  const candidates = {
    vouchers: vouchers.map((v) => ({
      id: v.id,
      amount: Number(v.amount),
      date: v.date.toISOString().slice(0, 10),
      reference: v.reference,
      contactName: v.contact?.displayName,
    })),
    invoices: invoices.map((i) => ({
      id: i.id,
      total: Number(i.total),
      dueDate: i.dueDate.toISOString().slice(0, 10),
      invoiceNumber: i.invoiceNumber,
      contactName: i.contact?.displayName,
    })),
    bills: bills.map((b) => ({
      id: b.id,
      total: Number(b.total),
      dueDate: b.dueDate.toISOString().slice(0, 10),
      billNumber: b.billNumber,
      contactName: b.contact?.displayName,
    })),
  }

  const enriched = rows.map((r, i) => ({
    index: i,
    ...r,
    match: matchTransaction(r, candidates),
  }))

  const matched = enriched.filter((r) => r.match.type !== 'unknown').length
  return c.json({
    rows: enriched,
    matched,
    unmatched: enriched.length - matched,
    bankAccount: { id: bank.id, name: bank.name, currency: bank.currency },
  })
})

const commitSchema = z.object({
  bankAccountId: z.string(),
  // Only the rows the user approved · each may have user-overridden match decisions
  rows: z.array(z.object({
    date: z.string(),
    amount: z.coerce.number(),
    description: z.string(),
    reference: z.string().optional().nullable(),
    /** What the user chose: link to existing voucher, create new voucher, or skip */
    action: z.enum(['link_voucher', 'create_voucher', 'link_invoice', 'link_bill', 'skip']),
    targetId: z.string().optional(), // for link_* actions
    contactId: z.string().optional(), // for create_voucher
  })).min(1).max(500),
})

bankImportRoutes.post('/commit', zValidator('json', commitSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const { bankAccountId, rows } = c.req.valid('json')

  const bank = await prisma.bankAccount.findFirst({ where: { id: bankAccountId, orgId } })
  if (!bank) return c.json({ error: 'invalid_bank_account' }, 400)

  const created: string[] = []
  const linked: string[] = []
  const skipped: string[] = []

  for (const r of rows) {
    if (r.action === 'skip') { skipped.push(r.reference || r.description); continue }

    if (r.action === 'create_voucher') {
      const type = r.amount > 0 ? 'RECEIPT' : 'PAYMENT'
      const year = new Date().getFullYear()
      const prefix = type === 'RECEIPT' ? `R-${year}-` : `P-${year}-`
      const last = await prisma.voucher.findFirst({
        where: { orgId, type, number: { startsWith: prefix } },
        orderBy: { number: 'desc' },
        select: { number: true },
      })
      const lastNum = last ? Number(last.number.split('-').pop() || '0') : 0
      const number = `${prefix}${String(lastNum + 1).padStart(4, '0')}`
      const v = await prisma.voucher.create({
        data: {
          orgId,
          type: type as any,
          number,
          date: new Date(r.date),
          contactId: r.contactId || null,
          amount: new Prisma.Decimal(Math.abs(r.amount)),
          currency: bank.currency,
          paymentMethod: 'BANK_TRANSFER',
          reference: r.reference || null,
          notes: `استيراد من كشف ${bank.name} · ${r.description}`,
          bankAccountId,
        },
      })
      // Update bank balance
      await prisma.bankAccount.update({
        where: { id: bankAccountId },
        data: { balance: { increment: new Prisma.Decimal(r.amount) } },
      })
      created.push(v.id)
      continue
    }

    if (r.action === 'link_voucher' && r.targetId) {
      await prisma.voucher.update({
        where: { id: r.targetId },
        data: {
          bankAccountId,
          reference: r.reference || undefined,
        },
      })
      linked.push(r.targetId)
      continue
    }

    // For link_invoice / link_bill we create a voucher and link it
    if ((r.action === 'link_invoice' || r.action === 'link_bill') && r.targetId) {
      const isInvoice = r.action === 'link_invoice'
      const year = new Date().getFullYear()
      const prefix = isInvoice ? `R-${year}-` : `P-${year}-`
      const last = await prisma.voucher.findFirst({
        where: { orgId, type: isInvoice ? 'RECEIPT' : 'PAYMENT', number: { startsWith: prefix } },
        orderBy: { number: 'desc' },
        select: { number: true },
      })
      const lastNum = last ? Number(last.number.split('-').pop() || '0') : 0
      const number = `${prefix}${String(lastNum + 1).padStart(4, '0')}`
      const v = await prisma.voucher.create({
        data: {
          orgId,
          type: isInvoice ? 'RECEIPT' : 'PAYMENT',
          number,
          date: new Date(r.date),
          amount: new Prisma.Decimal(Math.abs(r.amount)),
          currency: bank.currency,
          paymentMethod: 'BANK_TRANSFER',
          reference: r.reference || null,
          notes: `استيراد من كشف ${bank.name}`,
          bankAccountId,
          invoiceId: isInvoice ? r.targetId : null,
          billId: isInvoice ? null : r.targetId,
        },
      })
      // Update related doc
      if (isInvoice) {
        const inv = await prisma.invoice.findUnique({ where: { id: r.targetId } })
        if (inv) {
          const newPaid = Number(inv.amountPaid) + Math.abs(r.amount)
          const status = newPaid >= Number(inv.total) ? 'PAID' : 'PARTIAL'
          await prisma.invoice.update({ where: { id: r.targetId }, data: { amountPaid: new Prisma.Decimal(newPaid), status } })
        }
      } else {
        const bill = await prisma.bill.findUnique({ where: { id: r.targetId } })
        if (bill) {
          const newPaid = Number(bill.amountPaid) + Math.abs(r.amount)
          const status = newPaid >= Number(bill.total) ? 'PAID' : 'PARTIAL'
          await prisma.bill.update({ where: { id: r.targetId }, data: { amountPaid: new Prisma.Decimal(newPaid), status } })
        }
      }
      await prisma.bankAccount.update({
        where: { id: bankAccountId },
        data: { balance: { increment: new Prisma.Decimal(r.amount) } },
      })
      created.push(v.id)
    }
  }

  return c.json({
    ok: true,
    created: created.length,
    linked: linked.length,
    skipped: skipped.length,
    voucherIds: created,
  })
})
