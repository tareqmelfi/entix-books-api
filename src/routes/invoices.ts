import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../db.js'
import { Prisma } from '@prisma/client'

export const invoicesRoutes = new Hono()

const lineSchema = z.object({
  productId: z.string().optional().nullable(),
  description: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().min(0),
  discount: z.coerce.number().min(0).default(0),
  taxRateId: z.string().optional().nullable(),
})

const invoiceSchema = z.object({
  contactId: z.string(),
  invoiceNumber: z.string().optional(), // auto-generated if missing
  status: z.enum(['DRAFT', 'SENT', 'VIEWED', 'PAID', 'PARTIAL', 'OVERDUE', 'CANCELLED']).default('DRAFT'),
  issueDate: z.string().transform((s) => new Date(s)),
  dueDate: z.string().transform((s) => new Date(s)),
  currency: z.string().length(3).default('SAR'),
  exchangeRate: z.coerce.number().positive().default(1),
  notes: z.string().optional().nullable(),
  termsConditions: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(1),
})

async function calcTotals(lines: z.infer<typeof lineSchema>[], orgId: string) {
  const taxRateMap = new Map<string, number>()
  const taxRateIds = lines.map((l) => l.taxRateId).filter((x): x is string => !!x)
  if (taxRateIds.length) {
    const rates = await prisma.taxRate.findMany({ where: { orgId, id: { in: taxRateIds } } })
    rates.forEach((r) => taxRateMap.set(r.id, Number(r.rate)))
  }

  let subtotal = 0
  let taxTotal = 0
  let discountTotal = 0
  const computedLines = lines.map((l) => {
    const lineSubtotal = l.quantity * l.unitPrice - (l.discount || 0)
    const taxRate = l.taxRateId ? taxRateMap.get(l.taxRateId) || 0 : 0
    const lineTax = lineSubtotal * taxRate
    subtotal += lineSubtotal
    taxTotal += lineTax
    discountTotal += l.discount || 0
    return {
      productId: l.productId || null,
      description: l.description,
      quantity: new Prisma.Decimal(l.quantity),
      unitPrice: new Prisma.Decimal(l.unitPrice),
      discount: new Prisma.Decimal(l.discount || 0),
      taxRateId: l.taxRateId || null,
      subtotal: new Prisma.Decimal(lineSubtotal + lineTax),
    }
  })

  return {
    subtotal: new Prisma.Decimal(subtotal),
    taxTotal: new Prisma.Decimal(taxTotal),
    discountTotal: new Prisma.Decimal(discountTotal),
    total: new Prisma.Decimal(subtotal + taxTotal),
    lines: computedLines,
  }
}

async function nextInvoiceNumber(orgId: string): Promise<string> {
  // Use org's numbering settings · falls back to defaults
  const { nextInvoiceNumber: nextFromSettings } = await import('../lib/numbering.js')
  return nextFromSettings(orgId)
}

// GET /invoices/_/next-number · returns the next invoice number without consuming it
invoicesRoutes.get('/_/next-number', async (c) => {
  const orgId = c.get('orgId') as string
  const number = await nextInvoiceNumber(orgId)
  return c.json({ number })
})

// GET /invoices
invoicesRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const status = c.req.query('status')
  const contactId = c.req.query('contactId')
  const page = Number(c.req.query('page') || '1')
  const limit = Math.min(Number(c.req.query('limit') || '50'), 200)

  const where: any = { orgId }
  if (status) {
    const arr = status.split(',').map(s => s.trim()).filter(Boolean)
    where.status = arr.length === 1 ? arr[0] : { in: arr }
  }
  if (contactId) where.contactId = contactId

  const [items, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: {
        contact: { select: { id: true, displayName: true, email: true } },
        _count: { select: { lines: true, payments: true } },
      },
      orderBy: { issueDate: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.invoice.count({ where }),
  ])

  c.header('X-Total-Count', String(total))
  return c.json({ items, total, page, limit })
})

// GET /invoices/:id (with lines)
invoicesRoutes.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const inv = await prisma.invoice.findFirst({
    where: { id, orgId },
    include: {
      contact: true,
      lines: { include: { product: true, taxRate: true } },
      payments: { orderBy: { paidAt: 'desc' } },
    },
  })
  if (!inv) return c.json({ error: 'not found' }, 404)
  return c.json(inv)
})

// POST /invoices
invoicesRoutes.post('/', zValidator('json', invoiceSchema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')

  const contact = await prisma.contact.findFirst({ where: { id: data.contactId, orgId } })
  if (!contact) return c.json({ error: 'invalid contact' }, 400)

  const totals = await calcTotals(data.lines, orgId)
  const number = data.invoiceNumber || (await nextInvoiceNumber(orgId))

  const invoice = await prisma.invoice.create({
    data: {
      orgId,
      contactId: data.contactId,
      invoiceNumber: number,
      status: data.status,
      issueDate: data.issueDate,
      dueDate: data.dueDate,
      currency: data.currency,
      exchangeRate: new Prisma.Decimal(data.exchangeRate),
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      discountTotal: totals.discountTotal,
      total: totals.total,
      notes: data.notes,
      termsConditions: data.termsConditions,
      lines: { create: totals.lines },
    },
    include: { lines: true, contact: true },
  })

  return c.json(invoice, 201)
})

// PATCH /invoices/:id
invoicesRoutes.patch('/:id', zValidator('json', invoiceSchema.partial()), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.invoice.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)

  const data = c.req.valid('json')
  const updates: any = { ...data }

  // Recompute totals if lines changed
  if (data.lines) {
    const totals = await calcTotals(data.lines, orgId)
    Object.assign(updates, {
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      discountTotal: totals.discountTotal,
      total: totals.total,
    })
    delete updates.lines
    await prisma.invoiceLine.deleteMany({ where: { invoiceId: id } })
    updates.lines = { create: totals.lines }
  }

  const invoice = await prisma.invoice.update({
    where: { id },
    data: updates,
    include: { lines: true, contact: true },
  })
  return c.json(invoice)
})

// DELETE /invoices/:id
invoicesRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.invoice.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.invoice.delete({ where: { id } })
  return c.body(null, 204)
})

// ── Invoice HTML print template (Wafeq parity) · UX-171 ──────────────────────
function escapeHtml(s: any): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function buildInvoiceHtml(opts: { org: any; contact: any; invoice: any; lines: any[] }): string {
  const { org, contact, invoice, lines } = opts
  const total = Number(invoice.total)
  const subtotal = Number(invoice.subtotal)
  const tax = Number(invoice.taxAmount)
  const paid = Number(invoice.amountPaid || 0)
  const due = total - paid
  const currency = invoice.currency || 'SAR'
  const isKsa = (org.country || 'SA') === 'SA'
  const primary = (org.paymentSettings as any)?.branding?.primaryColor || '#1276E3'
  const accent = (org.paymentSettings as any)?.branding?.accentColor || '#0B1B49'

  const orgAddress = [
    org.buildingNumber, org.streetName, org.district,
    org.city, org.region, org.postalCode, org.country
  ].filter(Boolean).join(' · ')
  const contactAddress = [contact?.addressLine1, contact?.city, contact?.country].filter(Boolean).join(' · ')

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(invoice.invoiceNumber)} · ${escapeHtml(org.name)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  body{margin:0;font-family:'Tajawal','Noto Sans Arabic','Inter',sans-serif;color:${accent};background:#F4F5F7;font-size:13px;line-height:1.5}
  .page{max-width:210mm;margin:20px auto;background:white;padding:24mm 18mm;box-shadow:0 1px 4px rgba(0,0,0,0.06)}
  @media print { body{background:white} .page{box-shadow:none;margin:0;max-width:none;padding:14mm} .no-print{display:none!important} }
  .row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
  .logo{max-height:64px;max-width:200px;object-fit:contain}
  h1{font-size:24px;font-weight:800;margin:0 0 4px 0;color:${primary}}
  h2{font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 6px 0}
  .muted{color:#6B7280;font-size:11px}
  .num{font-family:'Inter',monospace;direction:ltr;display:inline-block}
  .badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;background:#F4FCFF;color:${primary};border:1px solid ${primary}33}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:24px}
  .block{padding:12px 14px;border-radius:8px;background:#F9FAFB;border:1px solid #E5E7EB}
  .block strong{display:block;color:${accent};margin-bottom:4px;font-size:14px}
  table{width:100%;border-collapse:collapse;margin-top:24px}
  thead th{background:${accent};color:white;padding:10px 12px;font-size:11px;font-weight:600;text-align:start;letter-spacing:0.02em}
  thead th.num-col{text-align:end}
  tbody td{padding:12px;border-bottom:1px solid #F3F4F6;vertical-align:top;font-size:13px}
  tbody td.num-col{text-align:end;font-family:'Inter',monospace;direction:ltr}
  .totals{margin-top:16px;display:flex;justify-content:flex-start}
  .totals-box{min-width:280px;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden}
  .totals-row{display:flex;justify-content:space-between;padding:8px 14px;font-size:13px}
  .totals-row.line{border-bottom:1px solid #F3F4F6}
  .totals-row.grand{background:${accent};color:white;font-weight:700;font-size:15px}
  .footer{margin-top:32px;padding-top:16px;border-top:2px solid ${primary};display:grid;grid-template-columns:1fr auto;gap:24px;align-items:end}
  .stamp{max-height:90px;max-width:160px;object-fit:contain;opacity:0.9}
  .qr{width:96px;height:96px;background:#F9FAFB;border:1px dashed #D1D5DB;display:flex;align-items:center;justify-content:center;font-size:10px;color:#9CA3AF}
  .notes{margin-top:24px;padding:12px 14px;background:#FFFBEB;border-right:3px solid #F59E0B;border-radius:6px;font-size:12px;color:#78350F}
  .actions{position:fixed;top:12px;left:12px;z-index:99;display:flex;gap:8px}
  .actions button{padding:8px 16px;border-radius:6px;border:1px solid #D1D5DB;background:white;cursor:pointer;font-size:13px;font-weight:600}
  .actions button.primary{background:${primary};color:white;border-color:${primary}}
</style>
</head>
<body>
<div class="actions no-print">
  <button class="primary" onclick="window.print()">طباعة / حفظ PDF</button>
  <button onclick="window.close()">إغلاق</button>
</div>
<div class="page">
  <!-- Header · logo + Tax Invoice title -->
  <div class="row">
    <div>
      ${org.logoUrl ? `<img src="${escapeHtml(org.logoUrl)}" alt="${escapeHtml(org.name)}" class="logo">` : `<div style="font-weight:800;font-size:24px;color:${primary}">${escapeHtml(org.name)}</div>`}
      <div class="muted" style="margin-top:8px">${escapeHtml(org.legalName || org.name)}</div>
      ${orgAddress ? `<div class="muted">${escapeHtml(orgAddress)}</div>` : ''}
      ${org.email ? `<div class="muted">${escapeHtml(org.email)} · ${escapeHtml(org.phone || '')}</div>` : ''}
      ${org.vatNumber ? `<div class="muted">${isKsa ? 'الرقم الضريبي' : 'EIN'}: <span class="num">${escapeHtml(org.vatNumber)}</span></div>` : ''}
      ${org.crNumber ? `<div class="muted">${isKsa ? 'السجل التجاري' : 'Filing #'}: <span class="num">${escapeHtml(org.crNumber)}</span></div>` : ''}
    </div>
    <div style="text-align:end">
      <h1>${isKsa ? 'فاتورة ضريبية' : 'Invoice'}</h1>
      <div style="font-size:13px;color:#6B7280">Tax Invoice</div>
      <div style="margin-top:8px">
        <span class="badge">${escapeHtml(String(invoice.status || 'DRAFT').toUpperCase())}</span>
      </div>
    </div>
  </div>

  <!-- Two-column · Bill-to + Invoice details -->
  <div class="grid-2">
    <div class="block">
      <h2>عميل · BILL TO</h2>
      <strong>${escapeHtml(contact?.displayName || contact?.legalName || '—')}</strong>
      ${contact?.legalName && contact?.legalName !== contact?.displayName ? `<div class="muted">${escapeHtml(contact.legalName)}</div>` : ''}
      ${contactAddress ? `<div class="muted" style="margin-top:4px">${escapeHtml(contactAddress)}</div>` : ''}
      ${contact?.email ? `<div class="muted">${escapeHtml(contact.email)}</div>` : ''}
      ${contact?.phone ? `<div class="muted">${escapeHtml(contact.phone)}</div>` : ''}
      ${contact?.taxId ? `<div class="muted">${isKsa ? 'الرقم الضريبي' : 'Tax ID'}: <span class="num">${escapeHtml(contact.taxId)}</span></div>` : ''}
    </div>
    <div class="block">
      <h2>تفاصيل الفاتورة · INVOICE DETAILS</h2>
      <table style="margin:0;font-size:13px"><tbody>
        <tr><td style="padding:4px 0;color:#6B7280">رقم الفاتورة</td><td style="padding:4px 0;text-align:end" class="num">${escapeHtml(invoice.invoiceNumber)}</td></tr>
        <tr><td style="padding:4px 0;color:#6B7280">تاريخ الإصدار</td><td style="padding:4px 0;text-align:end" class="num">${escapeHtml(String(invoice.issueDate).slice(0,10))}</td></tr>
        ${invoice.dueDate ? `<tr><td style="padding:4px 0;color:#6B7280">تاريخ الاستحقاق</td><td style="padding:4px 0;text-align:end" class="num">${escapeHtml(String(invoice.dueDate).slice(0,10))}</td></tr>` : ''}
        ${invoice.reference ? `<tr><td style="padding:4px 0;color:#6B7280">المرجع</td><td style="padding:4px 0;text-align:end" class="num">${escapeHtml(invoice.reference)}</td></tr>` : ''}
      </tbody></table>
    </div>
  </div>

  <!-- Line items table -->
  <table>
    <thead>
      <tr>
        <th style="width:50px">#</th>
        <th>الوصف · Description</th>
        <th class="num-col" style="width:80px">الكمية</th>
        <th class="num-col" style="width:100px">السعر</th>
        <th class="num-col" style="width:80px">VAT</th>
        <th class="num-col" style="width:120px">الإجمالي</th>
      </tr>
    </thead>
    <tbody>
      ${lines.map((l: any, i: number) => {
        const q = Number(l.quantity || 0)
        const p = Number(l.unitPrice || 0)
        const lineTotal = Number(l.total || (q * p))
        const vatRate = Number(l.taxRate || 0) * 100
        return `<tr>
          <td class="num-col">${i + 1}</td>
          <td>${escapeHtml(l.description || '')}</td>
          <td class="num-col">${q.toLocaleString()}</td>
          <td class="num-col">${p.toFixed(2)}</td>
          <td class="num-col">${vatRate}%</td>
          <td class="num-col">${lineTotal.toFixed(2)}</td>
        </tr>`
      }).join('')}
    </tbody>
  </table>

  <!-- Totals -->
  <div class="totals">
    <div class="totals-box">
      <div class="totals-row line"><span>المجموع الفرعي · Subtotal</span><span class="num">${subtotal.toFixed(2)} ${currency}</span></div>
      <div class="totals-row line"><span>ضريبة القيمة المضافة · VAT</span><span class="num">${tax.toFixed(2)} ${currency}</span></div>
      <div class="totals-row grand"><span>الإجمالي · Total</span><span class="num">${total.toFixed(2)} ${currency}</span></div>
      ${paid > 0 ? `<div class="totals-row line"><span>المدفوع</span><span class="num">${paid.toFixed(2)} ${currency}</span></div>
      <div class="totals-row line" style="background:#FEF3C7"><span><strong>المستحق</strong></span><span class="num"><strong>${due.toFixed(2)} ${currency}</strong></span></div>` : ''}
    </div>
  </div>

  ${invoice.notes ? `<div class="notes"><strong>ملاحظات:</strong> ${escapeHtml(invoice.notes)}</div>` : ''}
  ${invoice.termsConditions ? `<div class="notes" style="background:#EFF6FF;border-color:#3B82F6;color:#1E3A8A"><strong>الشروط:</strong> ${escapeHtml(invoice.termsConditions)}</div>` : ''}

  <!-- Footer · stamp + QR + signature -->
  <div class="footer">
    <div class="muted">
      <div>شكراً لتعاملكم معنا · Thank you for your business</div>
      ${org.website ? `<div>${escapeHtml(org.website)}</div>` : ''}
    </div>
    <div style="display:flex;gap:16px;align-items:center">
      ${org.stampUrl ? `<img src="${escapeHtml(org.stampUrl)}" class="stamp" alt="ختم">` : ''}
      ${isKsa && org.zatcaEnabled ? '<div class="qr">QR (ZATCA)</div>' : ''}
    </div>
  </div>
</div>
</body>
</html>`
}

// GET /invoices/:id/print · returns branded HTML (printable)
invoicesRoutes.get('/:id/print', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const invoice = await prisma.invoice.findFirst({
    where: { id, orgId },
    include: { lines: true, contact: true },
  })
  if (!invoice) return c.json({ error: 'not_found' }, 404)
  const org = await prisma.organization.findUnique({ where: { id: orgId } })
  if (!org) return c.json({ error: 'org_not_found' }, 404)

  const html = buildInvoiceHtml({
    org, contact: invoice.contact, invoice, lines: invoice.lines,
  })
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})

// POST /invoices/:id/email · sends branded HTML via Resend
invoicesRoutes.post('/:id/email', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({})) as { to?: string; subject?: string; message?: string }

  const invoice = await prisma.invoice.findFirst({
    where: { id, orgId },
    include: { lines: true, contact: true },
  })
  if (!invoice) return c.json({ error: 'not_found' }, 404)
  const org = await prisma.organization.findUnique({ where: { id: orgId } })
  if (!org) return c.json({ error: 'org_not_found' }, 404)

  const to = body.to || invoice.contact?.email
  if (!to) return c.json({ error: 'no_recipient', message: 'العميل بدون بريد · حدد bcc يدوياً' }, 400)
  if (!process.env.RESEND_API_KEY) return c.json({ error: 'no_email_provider', message: 'RESEND_API_KEY غير مُعدّ' }, 503)

  const html = buildInvoiceHtml({
    org, contact: invoice.contact, invoice, lines: invoice.lines,
  })
  const subject = body.subject || `فاتورة ${invoice.invoiceNumber} · ${org.name}`
  const fromAddr = org.email || `noreply@entix.io`
  const fromName = org.name

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${fromName} <${fromAddr}>`,
      to: [to],
      subject,
      html,
      text: body.message || undefined,
    }),
  })
  if (!r.ok) {
    const detail = await r.text()
    return c.json({ error: 'resend_failed', detail: detail.slice(0, 300) }, 502)
  }
  const json = (await r.json()) as { id?: string }
  return c.json({ ok: true, to, messageId: json.id })
})
