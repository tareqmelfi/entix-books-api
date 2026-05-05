/**
 * Inbox · UX-81 · email-to-invoice
 *
 * Each org gets a unique forwarding address: bills+<orgSlug>@entix.io
 * Suppliers send their invoice as a PDF attachment to that address; an inbound-email
 * provider (Resend Inbound · CloudMailin · SendGrid Parse · Postmark) POSTs the
 * parsed payload to /api/inbox/webhook. We then:
 *   1. Resolve org by recipient address.
 *   2. Persist the message + attachments.
 *   3. For each PDF/image attachment, run /api/agent/extract-document.
 *   4. Create a DRAFT Bill (or Expense) with the extracted lines.
 *   5. Notify the user · they review and approve.
 *
 * Routes:
 *   POST /api/inbox/webhook           inbound email (no auth · validated by token)
 *   GET  /api/inbox                   list of messages + extracted state
 *   GET  /api/inbox/:id               single message with attachments
 *   POST /api/inbox/:id/approve       turn extracted draft into a real Bill
 *   POST /api/inbox/:id/reject        archive (won't be auto-posted)
 *   POST /api/inbox/:id/reprocess     re-run extraction (e.g. after fixing org slug)
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'

// Public · webhook only · token-validated inside
export const inboxWebhookRoutes = new Hono()
// Authed · list / get / approve / reject / reprocess
export const inboxRoutes = new Hono()

// ── Webhook (no auth · token-validated) ──────────────────────────────────────
const webhookSchema = z.object({
  to: z.string(),                       // bills+<orgSlug>@entix.io
  from: z.string(),
  subject: z.string().optional().default(''),
  text: z.string().optional().default(''),
  html: z.string().optional().default(''),
  messageId: z.string().optional(),
  attachments: z.array(z.object({
    filename: z.string(),
    contentType: z.string(),
    content: z.string(),                // base64
    size: z.number().optional(),
  })).default([]),
})

inboxWebhookRoutes.post('/webhook', zValidator('json', webhookSchema), async (c) => {
  const tokenHeader = c.req.header('x-inbox-token')
  if (!tokenHeader || tokenHeader !== process.env.INBOX_WEBHOOK_TOKEN) {
    return c.json({ error: 'invalid_token' }, 401)
  }

  const payload = c.req.valid('json')

  // Resolve org by recipient slug · `bills+<slug>@entix.io`
  const slugMatch = payload.to.match(/bills\+([a-z0-9-]+)@/i)
  const slug = slugMatch?.[1]
  if (!slug) return c.json({ error: 'no_org_slug', detail: 'recipient must be bills+<slug>@entix.io' }, 400)

  const org = await prisma.organization.findFirst({ where: { slug } })
  if (!org) return c.json({ error: 'org_not_found', slug }, 404)

  // Persist the inbound message
  const message = await prisma.inboxMessage.create({
    data: {
      orgId: org.id,
      fromAddress: payload.from,
      toAddress: payload.to,
      subject: payload.subject,
      bodyText: payload.text,
      bodyHtml: payload.html,
      messageId: payload.messageId,
      status: 'RECEIVED',
      attachmentCount: payload.attachments.length,
    },
  })

  // Stash attachments
  for (const att of payload.attachments) {
    await prisma.inboxAttachment.create({
      data: {
        messageId: message.id,
        filename: att.filename,
        contentType: att.contentType,
        sizeBytes: att.size || Math.round((att.content.length * 3) / 4),
        contentBase64: att.content,
      },
    })
  }

  return c.json({ ok: true, messageId: message.id, attachments: payload.attachments.length })
})

// ── Authed routes ────────────────────────────────────────────────────────────
inboxRoutes.get('/', async (c) => {
  const orgId = c.get('orgId') as string
  const status = c.req.query('status')
  const where: any = { orgId }
  if (status) where.status = status

  const messages = await prisma.inboxMessage.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { _count: { select: { attachments: true } } },
  })

  return c.json({
    items: messages.map((m) => ({
      id: m.id,
      from: m.fromAddress,
      subject: m.subject,
      status: m.status,
      attachmentCount: m._count.attachments,
      extractedKind: m.extractedKind,
      extractedTotal: m.extractedTotal != null ? Number(m.extractedTotal) : null,
      extractedCurrency: m.extractedCurrency,
      createdAt: m.createdAt,
      processedAt: m.processedAt,
      billId: m.billId,
    })),
    total: messages.length,
  })
})

inboxRoutes.get('/:id', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const m = await prisma.inboxMessage.findFirst({
    where: { id, orgId },
    include: { attachments: { select: { id: true, filename: true, contentType: true, sizeBytes: true } } },
  })
  if (!m) return c.json({ error: 'not_found' }, 404)
  return c.json(m)
})

// Approve: turn extracted preview into a real Bill (DRAFT)
inboxRoutes.post('/:id/approve', async (c) => {
  const orgId = c.get('orgId') as string
  const auth = c.get('auth') as any
  const id = c.req.param('id')

  const m = await prisma.inboxMessage.findFirst({ where: { id, orgId } })
  if (!m) return c.json({ error: 'not_found' }, 404)
  if (!m.extractedJson) return c.json({ error: 'not_extracted', message: 'لم يتم استخراج البيانات بعد' }, 400)

  const ex = m.extractedJson as any

  // Try to find or create the contact (supplier)
  let contactId: string | null = null
  if (ex.issuer?.name) {
    const existing = await prisma.contact.findFirst({
      where: { orgId, displayName: { equals: ex.issuer.name, mode: 'insensitive' } },
    })
    if (existing) {
      contactId = existing.id
    } else {
      const c2 = await prisma.contact.create({
        data: {
          orgId,
          displayName: ex.issuer.name,
          legalName: ex.issuer.name,
          isSupplier: true,
          isCustomer: false,
          type: 'SUPPLIER',
          country: ex.issuer.country || 'SA',
          vatNumber: ex.issuer.taxId || null,
          isActive: true,
        },
      })
      contactId = c2.id
    }
  }
  if (!contactId) return c.json({ error: 'no_supplier', message: 'تعذّر تحديد المورّد · أضف يدوياً' }, 400)

  // Generate bill number
  const year = new Date().getFullYear()
  const prefix = `B-${year}-`
  const last = await prisma.bill.findFirst({
    where: { orgId, billNumber: { startsWith: prefix } },
    orderBy: { billNumber: 'desc' },
    select: { billNumber: true },
  })
  const nextNum = last ? Number(last.billNumber.split('-').pop() || '0') + 1 : 1
  const billNumber = `${prefix}${String(nextNum).padStart(4, '0')}`

  // Create draft bill with extracted lines
  const lines = (ex.lines || []) as any[]
  const subtotal = lines.reduce((s, l) => s + (Number(l.unitPrice || 0) * Number(l.quantity || 1)), 0)
  const taxTotal = lines.reduce((s, l) => s + (Number(l.unitPrice || 0) * Number(l.quantity || 1) * Number(l.taxRate || 0)), 0)
  const total = ex.totals?.total ? Number(ex.totals.total) : subtotal + taxTotal

  const bill = await prisma.bill.create({
    data: {
      orgId,
      contactId,
      billNumber,
      issueDate: ex.issueDate ? new Date(ex.issueDate) : new Date(),
      dueDate: ex.dueDate ? new Date(ex.dueDate) : null,
      currency: ex.currency || 'SAR',
      subtotal: new Prisma.Decimal(subtotal),
      taxTotal: new Prisma.Decimal(taxTotal),
      discount: new Prisma.Decimal(ex.totals?.discount || 0),
      total: new Prisma.Decimal(total),
      status: 'DRAFT',
      notes: `استورد من البريد · ${m.subject} (${m.fromAddress})`,
      reference: ex.documentNumber || null,
      createdById: auth?.userId || null,
      lines: {
        create: lines.map((l: any) => ({
          description: l.description || '—',
          quantity: new Prisma.Decimal(l.quantity || 1),
          unitPrice: new Prisma.Decimal(l.unitPrice || 0),
          taxRate: new Prisma.Decimal(l.taxRate || 0.15),
          taxInclusive: !!l.taxInclusive,
          subtotal: new Prisma.Decimal(Number(l.unitPrice || 0) * Number(l.quantity || 1)),
        })),
      },
    },
  })

  await prisma.inboxMessage.update({
    where: { id: m.id },
    data: { status: 'APPROVED', billId: bill.id, processedAt: new Date() },
  })

  return c.json({ ok: true, billId: bill.id, billNumber })
})

inboxRoutes.post('/:id/reject', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const m = await prisma.inboxMessage.findFirst({ where: { id, orgId } })
  if (!m) return c.json({ error: 'not_found' }, 404)
  await prisma.inboxMessage.update({
    where: { id: m.id },
    data: { status: 'REJECTED', processedAt: new Date() },
  })
  return c.json({ ok: true })
})

// Re-run AI extraction
inboxRoutes.post('/:id/reprocess', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const m = await prisma.inboxMessage.findFirst({
    where: { id, orgId },
    include: { attachments: true },
  })
  if (!m) return c.json({ error: 'not_found' }, 404)

  const pdf = m.attachments.find((a) => a.contentType === 'application/pdf')
    ?? m.attachments.find((a) => a.contentType.startsWith('image/'))
  if (!pdf) return c.json({ error: 'no_attachment', message: 'لا يوجد مرفق قابل للقراءة' }, 400)

  // Call extract-document internally
  const baseUrl = process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 3000}`
  const r = await fetch(`${baseUrl}/api/agent/extract-document`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Org-Id': orgId,
      Cookie: c.req.header('cookie') || '',
    },
    body: JSON.stringify({
      fileBase64: pdf.contentBase64,
      fileName: pdf.filename,
      mimeType: pdf.contentType,
      target: 'bill-lines',
    }),
  })

  if (!r.ok) {
    return c.json({ error: 'extraction_failed', detail: await r.text() }, 502)
  }
  const result = await r.json() as any

  await prisma.inboxMessage.update({
    where: { id: m.id },
    data: {
      status: 'EXTRACTED',
      extractedJson: result,
      extractedKind: result.kind || null,
      extractedTotal: result.totals?.total ? new Prisma.Decimal(result.totals.total) : null,
      extractedCurrency: result.currency || null,
    },
  })

  return c.json({ ok: true, kind: result.kind, lines: result.lines?.length || 0 })
})
