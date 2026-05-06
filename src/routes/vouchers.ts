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

// ── Attachments ────────────────────────────────────────────────────────────
const attachSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().default('application/octet-stream'),
  sizeBytes: z.number().int().min(0),
  data: z.string(), // base64 or data: URL
})

vouchersRoutes.get('/:id/attachments', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const v = await prisma.voucher.findFirst({ where: { id, orgId }, select: { id: true } })
  if (!v) return c.json({ error: 'not_found' }, 404)
  const items = await prisma.voucherAttachment.findMany({ where: { voucherId: id }, orderBy: { createdAt: 'desc' } })
  return c.json({ items })
})

vouchersRoutes.post('/:id/attachments', zValidator('json', attachSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const v = await prisma.voucher.findFirst({ where: { id, orgId }, select: { id: true } })
  if (!v) return c.json({ error: 'not_found' }, 404)
  const body = c.req.valid('json')
  const url = body.data.startsWith('data:') ? body.data : `data:${body.contentType};base64,${body.data}`
  const created = await prisma.voucherAttachment.create({
    data: { voucherId: id, filename: body.filename, contentType: body.contentType, sizeBytes: body.sizeBytes, url },
  })
  return c.json(created, 201)
})

vouchersRoutes.delete('/:id/attachments/:aid', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const aid = c.req.param('aid')
  const v = await prisma.voucher.findFirst({ where: { id, orgId }, select: { id: true } })
  if (!v) return c.json({ error: 'not_found' }, 404)
  await prisma.voucherAttachment.deleteMany({ where: { id: aid, voucherId: id } })
  return c.body(null, 204)
})

// ── Branded HTML/PDF ───────────────────────────────────────────────────────
// Returns a Wafeq-style stamped voucher · printable as PDF from browser.
// Includes org logo + stamp + party details + amount in words + signature line.
function amountInArabic(n: number): string {
  // Simple fallback · for production use a proper number-to-words library
  const fmt = n.toFixed(2)
  return `${fmt} ريال سعودي فقط لا غير`
}

vouchersRoutes.get('/:id/print', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const v = await prisma.voucher.findFirst({
    where: { id, orgId },
    include: {
      contact: true,
      bankAccount: { select: { name: true, bankName: true, accountNumber: true } },
      org: true,
      attachments: true,
    },
  }) as any
  if (!v) return c.json({ error: 'not_found' }, 404)

  const isReceipt = v.type === 'RECEIPT'
  const title = isReceipt ? 'سند قبض · Receipt Voucher' : 'سند صرف · Payment Voucher'
  const partyLabel = isReceipt ? 'استُلم من' : 'صُرف لـ'
  const org = v.org
  const stamp = org.stampUrl || ''
  const logo = org.logoUrl || ''
  const dateStr = new Date(v.date).toISOString().slice(0, 10)
  const formatMethod = (m: string) => ({
    CASH: 'نقد', BANK_TRANSFER: 'تحويل بنكي', CARD: 'بطاقة', STC_PAY: 'STC Pay',
    MADA: 'مدى', CHECK: 'شيك', OTHER: 'أخرى',
  } as any)[m] || m

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8" />
<title>${v.number} · ${title}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: 'Tajawal','Noto Sans Arabic','Plus Jakarta Sans',Arial,sans-serif; color:#0B1B49; line-height:1.5; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #1276E3; padding-bottom:12px; margin-bottom:24px; }
  .logo { max-width:160px; max-height:80px; object-fit:contain; }
  .org-info { text-align:left; font-size:13px; color:#374151; }
  .org-info b { color:#0B1B49; font-size:15px; display:block; margin-bottom:4px; }
  .title { text-align:center; font-size:22px; font-weight:700; margin:24px 0 8px; }
  .vnum { text-align:center; color:#1276E3; font-family:monospace; font-size:14px; margin-bottom:18px; }
  table.meta { width:100%; border-collapse:collapse; margin-bottom:18px; }
  table.meta td { border:1px solid #E5E7EB; padding:10px 12px; font-size:13px; }
  table.meta td.label { background:#F9FAFB; color:#6B7280; width:140px; font-weight:600; }
  .amount-box { background:#EFF8FF; border:2px solid #1276E3; border-radius:8px; padding:18px; margin:18px 0; text-align:center; }
  .amount-box .num { font-size:28px; font-weight:800; color:#1276E3; font-family:monospace; }
  .amount-box .words { font-size:14px; color:#0B1B49; margin-top:6px; }
  .footer { margin-top:48px; display:flex; justify-content:space-between; align-items:flex-end; }
  .sig-line { border-top:1px solid #6B7280; padding-top:6px; min-width:200px; text-align:center; font-size:12px; color:#6B7280; }
  .stamp { max-width:140px; max-height:140px; opacity:0.85; }
  .ref { font-family:monospace; font-size:12px; color:#6B7280; }
  .notes { margin-top:24px; padding:12px; background:#F9FAFB; border-radius:6px; font-size:13px; color:#374151; }
  @media print { .no-print { display:none; } }
  .no-print { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#1276E3; color:#fff; padding:10px 24px; border-radius:8px; cursor:pointer; }
</style>
</head>
<body>
  <div class="head">
    <div>${logo ? `<img src="${logo}" class="logo" alt="logo" />` : `<b style="font-size:20px;">${esc(org.name)}</b>`}</div>
    <div class="org-info">
      <b>${esc(org.legalName || org.name)}</b>
      ${org.vatNumber ? `الرقم الضريبي: <span class="ref">${esc(org.vatNumber)}</span><br>` : ''}
      ${org.crNumber ? `السجل التجاري: <span class="ref">${esc(org.crNumber)}</span><br>` : ''}
      ${org.phone ? `هاتف: <span class="ref" dir="ltr">${esc(org.phone)}</span><br>` : ''}
      ${org.email ? `<span class="ref" dir="ltr">${esc(org.email)}</span>` : ''}
    </div>
  </div>

  <div class="title">${title}</div>
  <div class="vnum">رقم السند: ${esc(v.number)} · التاريخ: ${dateStr}</div>

  <table class="meta">
    <tr><td class="label">${partyLabel}</td><td>${esc(v.contact?.displayName || '—')}</td></tr>
    ${v.contact?.email ? `<tr><td class="label">البريد الإلكتروني</td><td><span class="ref" dir="ltr">${esc(v.contact.email)}</span></td></tr>` : ''}
    ${v.contact?.phone ? `<tr><td class="label">الهاتف</td><td><span class="ref" dir="ltr">${esc(v.contact.phone)}</span></td></tr>` : ''}
    <tr><td class="label">طريقة الدفع</td><td>${formatMethod(v.paymentMethod)}</td></tr>
    ${v.bankAccount ? `<tr><td class="label">الحساب البنكي</td><td>${esc(v.bankAccount.bankName || v.bankAccount.name)} · <span class="ref" dir="ltr">${esc(v.bankAccount.accountNumber || '')}</span></td></tr>` : ''}
    ${v.reference ? `<tr><td class="label">المرجع</td><td><span class="ref">${esc(v.reference)}</span></td></tr>` : ''}
    ${v.invoiceId ? `<tr><td class="label">مرتبط بالفاتورة</td><td><span class="ref">${v.invoiceId}</span></td></tr>` : ''}
  </table>

  <div class="amount-box">
    <div class="num" dir="ltr">${Number(v.amount).toLocaleString()} ${v.currency}</div>
    <div class="words">${amountInArabic(Number(v.amount))}</div>
  </div>

  ${v.notes ? `<div class="notes"><b>ملاحظات:</b><br>${esc(v.notes)}</div>` : ''}

  <div class="footer">
    <div class="sig-line">توقيع المسؤول</div>
    ${stamp ? `<img src="${stamp}" class="stamp" alt="stamp" />` : '<div class="sig-line">الختم</div>'}
    <div class="sig-line">توقيع ${isReceipt ? 'المستلم' : 'المستفيد'}</div>
  </div>

  <button class="no-print" onclick="window.print()">طباعة / حفظ كـ PDF</button>
</body>
</html>`
  c.header('Content-Type', 'text/html; charset=utf-8')
  return c.body(html)
})

function esc(s: string | null | undefined): string {
  if (s == null) return ''
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[m])
}

// ── Email voucher to contact ───────────────────────────────────────────────
vouchersRoutes.post('/:id/email', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const v = await prisma.voucher.findFirst({
    where: { id, orgId },
    include: { contact: true, org: true },
  }) as any
  if (!v) return c.json({ error: 'not_found' }, 404)
  const to = body.to || v.contact?.email
  if (!to) return c.json({ error: 'no_recipient', message: 'العميل ليس له بريد إلكتروني' }, 400)

  const isReceipt = v.type === 'RECEIPT'
  const subject = body.subject || `${isReceipt ? 'سند قبض' : 'سند صرف'} رقم ${v.number} · ${v.org.name}`
  const printUrl = `${process.env.PUBLIC_API_URL || 'https://api.entix.io'}/api/vouchers/${id}/print`

  // Use existing email lib
  try {
    const { sendTransactional } = await import('../lib/email.js') as any
    await sendTransactional({
      to,
      subject,
      html: `<div style="font-family:sans-serif;direction:rtl;">
        <h2>${esc(subject)}</h2>
        <p>السلام عليكم،</p>
        <p>تجدون مرفقاً ${isReceipt ? 'سند القبض' : 'سند الصرف'} رقم <b>${esc(v.number)}</b>
        بتاريخ ${new Date(v.date).toISOString().slice(0,10)} بمبلغ
        <b>${Number(v.amount).toLocaleString()} ${v.currency}</b>.</p>
        <p><a href="${printUrl}" style="background:#1276E3;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">عرض السند المختوم</a></p>
        <p>${body.message ? esc(body.message) : ''}</p>
        <p style="color:#6B7280;font-size:12px;margin-top:24px;">${esc(v.org.name)}${v.org.email ? ` · ${esc(v.org.email)}` : ''}</p>
      </div>`,
    })
    return c.json({ ok: true, to })
  } catch (e: any) {
    return c.json({ error: 'email_failed', message: e?.message || 'unknown' }, 500)
  }
})
