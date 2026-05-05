/**
 * E-signature integration · DocuSeal at sign.fc.sa
 *
 * POST /api/sign/quotes/:id/send       — create DocuSeal submission for a quote
 * POST /api/sign/invoices/:id/send     — create DocuSeal submission for an invoice
 * GET  /api/sign/requests              — list signature requests (org-scoped)
 * GET  /api/sign/requests/:id          — single request
 * POST /api/sign/webhook               — DocuSeal webhook receiver (no auth)
 *
 * env vars used:
 *   DOCUSEAL_BASE_URL   default: https://sign.fc.sa
 *   DOCUSEAL_TOKEN      required for create-submission calls
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireAuth, requireOrg } from '../auth.js'
import { prisma } from '../db.js'
import { createNotification } from './notifications.js'

export const signRoutes = new Hono()

const DOCUSEAL_BASE = process.env.DOCUSEAL_BASE_URL || 'https://sign.fc.sa'
const DOCUSEAL_TOKEN = process.env.DOCUSEAL_TOKEN || ''

// ── Webhook (no auth · public, validated by signing secret) ─────────────────
signRoutes.post('/webhook', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }

  // DocuSeal sends: { event_type: 'submission.completed' | 'submission.viewed' | ..., data: { id, ... } }
  const submissionId = String(body?.data?.id ?? body?.submission_id ?? '')
  if (!submissionId) return c.json({ ok: true, skipped: 'no_submission_id' })

  const sr = await prisma.signatureRequest.findUnique({ where: { docusealSubmissionId: submissionId } })
  if (!sr) return c.json({ ok: true, skipped: 'unknown_submission' })

  const eventType = String(body?.event_type || '')
  const updates: any = {}

  if (eventType === 'submission.viewed') {
    updates.status = 'VIEWED'
  } else if (eventType === 'submission.completed' || body?.data?.status === 'completed') {
    updates.status = 'SIGNED'
    updates.signedAt = new Date()
    updates.signedPdfUrl = body?.data?.combined_document_url || body?.data?.audit_log_url || null
    updates.auditTrailUrl = body?.data?.audit_log_url || null
  } else if (eventType === 'submission.declined') {
    updates.status = 'DECLINED'
  } else if (eventType === 'submission.expired') {
    updates.status = 'EXPIRED'
  }

  if (Object.keys(updates).length > 0) {
    await prisma.signatureRequest.update({ where: { id: sr.id }, data: updates })

    if (updates.status === 'SIGNED') {
      // Auto-update doc status: quote → ACCEPTED, invoice → SENT (so it's now binding)
      if (sr.docType === 'QUOTE') {
        await prisma.quote.updateMany({
          where: { id: sr.docId, orgId: sr.orgId, status: { in: ['DRAFT', 'SENT', 'VIEWED'] } },
          data: { status: 'ACCEPTED' },
        })
      }
      await createNotification(sr.orgId, {
        type: 'SIGN_COMPLETED',
        title: `تم توقيع ${sr.docType === 'QUOTE' ? 'عرض السعر' : 'الفاتورة'} · ${sr.docNumber}`,
        body: 'العميل وقّع المستند · جاهز للأرشفة',
        link: sr.docType === 'QUOTE' ? `/app/quotes` : `/app/invoices`,
        refType: 'SIGNATURE',
        refId: sr.id,
      })
    }
  }

  return c.json({ ok: true })
})

// ── Authenticated routes ────────────────────────────────────────────────────
signRoutes.use('/quotes/*', requireAuth, requireOrg)
signRoutes.use('/invoices/*', requireAuth, requireOrg)
signRoutes.use('/requests/*', requireAuth, requireOrg)
signRoutes.use('/requests', requireAuth, requireOrg)

const sendSchema = z.object({
  signers: z.array(z.object({
    name: z.string().min(1),
    email: z.string().email(),
    role: z.string().optional(),
  })).min(1),
  message: z.string().optional(),
  expiresInDays: z.number().int().min(1).max(180).optional(),
})

async function createDocusealSubmission(payload: {
  templateName: string
  pdfUrl: string
  signers: Array<{ name: string; email: string; role?: string }>
  message?: string
  expiresAt?: Date
}) {
  if (!DOCUSEAL_TOKEN) {
    throw new Error('DOCUSEAL_TOKEN not configured · set in Coolify env')
  }
  // DocuSeal API: POST /api/submissions
  const res = await fetch(`${DOCUSEAL_BASE}/api/submissions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': DOCUSEAL_TOKEN,
    },
    body: JSON.stringify({
      template: { name: payload.templateName, pdf_url: payload.pdfUrl },
      submitters: payload.signers.map((s) => ({
        name: s.name,
        email: s.email,
        role: s.role || 'Signer',
      })),
      message: payload.message,
      expire_at: payload.expiresAt?.toISOString(),
      send_email: true,
    }),
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`docuseal_api_${res.status}: ${txt.slice(0, 200)}`)
  }
  return res.json() as Promise<{ id: number | string; embed_src?: string; submitters?: Array<{ embed_src?: string; slug?: string }> }>
}

// POST /api/sign/quotes/:id/send
signRoutes.post('/quotes/:id/send', zValidator('json', sendSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const quoteId = c.req.param('id')
  const data = c.req.valid('json')

  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, orgId },
    include: { contact: true, org: true },
  })
  if (!quote) return c.json({ error: 'quote_not_found' }, 404)

  // Check we don't already have an active sig request
  const existing = await prisma.signatureRequest.findFirst({
    where: { orgId, docType: 'QUOTE', docId: quoteId, status: { in: ['PENDING', 'SENT', 'VIEWED'] } },
  })
  if (existing) {
    return c.json({ error: 'already_pending', signatureRequestId: existing.id, embedUrl: existing.docusealEmbedUrl }, 409)
  }

  const expiresAt = data.expiresInDays
    ? new Date(Date.now() + data.expiresInDays * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  const pdfUrl = `${process.env.PUBLIC_API_URL || 'https://api.entix.io'}/api/quotes/${quoteId}/pdf`

  let docuseal: any = null
  let errorMsg: string | null = null
  try {
    docuseal = await createDocusealSubmission({
      templateName: `Quote ${quote.quoteNumber}`,
      pdfUrl,
      signers: data.signers,
      message: data.message || `يرجى مراجعة وتوقيع عرض السعر رقم ${quote.quoteNumber} الصادر من ${quote.org.name}`,
      expiresAt,
    })
  } catch (e: any) {
    errorMsg = e.message || String(e)
  }

  const sr = await prisma.signatureRequest.create({
    data: {
      orgId,
      docType: 'QUOTE',
      docId: quoteId,
      docNumber: quote.quoteNumber,
      status: docuseal ? 'SENT' : 'PENDING',
      docusealSubmissionId: docuseal ? String(docuseal.id) : null,
      docusealEmbedUrl: docuseal?.submitters?.[0]?.embed_src || docuseal?.embed_src || null,
      signers: JSON.stringify(data.signers.map((s) => ({ ...s, status: 'pending' }))),
      sentAt: docuseal ? new Date() : null,
      expiresAt,
    },
  })

  if (docuseal) {
    await prisma.quote.update({ where: { id: quoteId }, data: { status: 'SENT' } })
    await createNotification(orgId, {
      type: 'SIGN_REQUESTED',
      title: `إرسال عرض السعر للتوقيع · ${quote.quoteNumber}`,
      body: `تم إرسال طلب توقيع إلى ${data.signers.map((s) => s.email).join(', ')}`,
      link: `/app/quotes`,
      refType: 'SIGNATURE',
      refId: sr.id,
    })
  }

  return c.json(
    { signatureRequest: sr, docuseal, error: errorMsg },
    docuseal ? 201 : 502,
  )
})

// POST /api/sign/invoices/:id/send
signRoutes.post('/invoices/:id/send', zValidator('json', sendSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const invoiceId = c.req.param('id')
  const data = c.req.valid('json')

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, orgId },
    include: { contact: true, org: true },
  })
  if (!invoice) return c.json({ error: 'invoice_not_found' }, 404)

  const existing = await prisma.signatureRequest.findFirst({
    where: { orgId, docType: 'INVOICE', docId: invoiceId, status: { in: ['PENDING', 'SENT', 'VIEWED'] } },
  })
  if (existing) {
    return c.json({ error: 'already_pending', signatureRequestId: existing.id, embedUrl: existing.docusealEmbedUrl }, 409)
  }

  const expiresAt = data.expiresInDays
    ? new Date(Date.now() + data.expiresInDays * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  const pdfUrl = `${process.env.PUBLIC_API_URL || 'https://api.entix.io'}/api/invoices/${invoiceId}/pdf`

  let docuseal: any = null
  let errorMsg: string | null = null
  try {
    docuseal = await createDocusealSubmission({
      templateName: `Invoice ${invoice.invoiceNumber}`,
      pdfUrl,
      signers: data.signers,
      message: data.message || `يرجى مراجعة وتوقيع الفاتورة رقم ${invoice.invoiceNumber} الصادرة من ${invoice.org.name}`,
      expiresAt,
    })
  } catch (e: any) {
    errorMsg = e.message || String(e)
  }

  const sr = await prisma.signatureRequest.create({
    data: {
      orgId,
      docType: 'INVOICE',
      docId: invoiceId,
      docNumber: invoice.invoiceNumber,
      status: docuseal ? 'SENT' : 'PENDING',
      docusealSubmissionId: docuseal ? String(docuseal.id) : null,
      docusealEmbedUrl: docuseal?.submitters?.[0]?.embed_src || docuseal?.embed_src || null,
      signers: JSON.stringify(data.signers.map((s) => ({ ...s, status: 'pending' }))),
      sentAt: docuseal ? new Date() : null,
      expiresAt,
    },
  })

  if (docuseal && invoice.status === 'DRAFT') {
    await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'SENT' } })
    await createNotification(orgId, {
      type: 'SIGN_REQUESTED',
      title: `إرسال الفاتورة للتوقيع · ${invoice.invoiceNumber}`,
      body: `تم إرسال طلب توقيع إلى ${data.signers.map((s) => s.email).join(', ')}`,
      link: `/app/invoices`,
      refType: 'SIGNATURE',
      refId: sr.id,
    })
  }

  return c.json(
    { signatureRequest: sr, docuseal, error: errorMsg },
    docuseal ? 201 : 502,
  )
})

// GET /api/sign/requests · list
signRoutes.get('/requests', async (c) => {
  const orgId = c.get('orgId') as string
  const status = c.req.query('status')
  const docType = c.req.query('docType')
  const where: any = { orgId }
  if (status) where.status = status
  if (docType) where.docType = docType
  const items = await prisma.signatureRequest.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return c.json({ items })
})

// GET /api/sign/requests/:id
signRoutes.get('/requests/:id', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const sr = await prisma.signatureRequest.findFirst({ where: { id, orgId } })
  if (!sr) return c.json({ error: 'not_found' }, 404)
  return c.json(sr)
})

// GET /api/sign/health · for connectivity check
signRoutes.get('/health', async (c) => {
  return c.json({
    base: DOCUSEAL_BASE,
    tokenSet: !!DOCUSEAL_TOKEN,
    publicApiUrl: process.env.PUBLIC_API_URL || 'https://api.entix.io',
  })
})
