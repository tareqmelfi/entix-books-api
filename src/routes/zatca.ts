/**
 * ZATCA routes · UX-56
 *
 * POST /api/zatca/invoices/:id/process    Build XML + hash + QR · optionally submit
 * GET  /api/zatca/invoices/:id/qr         Get QR (data URL) for printing on invoice PDF
 * GET  /api/zatca/invoices/:id/xml        Download cleared XML (or built XML if not yet cleared)
 *
 * Auth: requireOrg (set up via parent router).
 *
 * NOTE · This route exposes the build pipeline. Actual signing with ZATCA-issued
 * EC keys + CSID is gated behind the org-level config flag `zatcaEnabled`.
 */
import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { prisma } from '../db.js'
import {
  processInvoiceForZatca,
  type UblInvoiceInput,
  buildZatcaQr,
} from '../lib/zatca.js'

export const zatcaRoutes = new Hono()

zatcaRoutes.post('/invoices/:id/process', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')

  const invoice = await prisma.invoice.findFirst({
    where: { id, orgId },
    include: { contact: true, lines: true, org: true },
  }) as any
  if (!invoice) return c.json({ error: 'not_found' }, 404)

  const org = (invoice as any).org
  if (!org?.vatNumber) {
    return c.json({ error: 'org_not_configured', message: 'الرقم الضريبي للمنشأة غير مسجل · أضفه من الإعدادات' }, 400)
  }

  // Decide invoice type
  // 0100000 = Standard (B2B, customer has VAT) · 0200000 = Simplified (B2C)
  const isStandard = !!invoice.contact?.vatNumber || !!(invoice as any).contact?.taxId
  const subType = isStandard ? '0100000' : '0200000'

  // Look up previous invoice's hash for chain
  const prev = await prisma.invoice.findFirst({
    where: { orgId, zatcaUuid: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { zatcaXml: true },
  })
  // Compute previous hash if available · base64 SHA-256 of cleared XML
  let previousInvoiceHash = ''
  if (prev?.zatcaXml) {
    const { createHash } = await import('crypto')
    previousInvoiceHash = createHash('sha256').update(prev.zatcaXml, 'utf-8').digest('base64')
  }

  const issueDateStr = invoice.issueDate.toISOString().slice(0, 10)
  const issueTimeStr = invoice.issueDate.toISOString().slice(11, 19)

  const ubl: UblInvoiceInput = {
    invoiceNumber: invoice.invoiceNumber,
    uuid: invoice.zatcaUuid || randomUUID(),
    issueDate: issueDateStr,
    issueTime: issueTimeStr,
    invoiceTypeCode: '388',
    invoiceSubTypeCode: subType,
    currency: invoice.currency,
    previousInvoiceHash,
    icv: 1, // TODO · per-org counter
    seller: {
      vatNumber: org.vatNumber,
      crNumber: org.crNumber || undefined,
      legalName: org.name || 'Entix Books',
      addressLine: org.address || 'King Fahd Road',
      city: org.city || 'Riyadh',
      postalCode: org.postalCode || '12211',
      country: 'SA',
    },
    buyer: {
      vatNumber: invoice.contact?.vatNumber || (invoice.contact as any)?.taxId || undefined,
      legalName: invoice.contact?.displayName || '—',
      addressLine: invoice.contact?.addressLine1 || undefined,
      city: invoice.contact?.city || undefined,
      postalCode: invoice.contact?.postalCode || undefined,
      country: invoice.contact?.country || undefined,
    },
    lines: (invoice.lines as any[]).map((l: any, i: number) => {
      const qty = Number(l.quantity)
      const unit = Number(l.unitPrice)
      const subtotal = qty * unit - Number(l.discount || 0)
      const taxRate = Number((l as any).taxRate || 0.15)
      const tax = subtotal * taxRate
      return {
        id: i + 1,
        description: l.description,
        quantity: qty,
        unitPrice: unit,
        taxCategory: 'S' as const,
        taxRate,
        lineSubtotal: subtotal,
        lineTax: tax,
        lineTotal: subtotal + tax,
      }
    }),
    totals: {
      subtotal: Number(invoice.subtotal),
      discount: Number(invoice.discountTotal),
      vat: Number(invoice.taxTotal),
      total: Number(invoice.total),
    },
  }

  const result = await processInvoiceForZatca(ubl, {
    skipSubmit: !((org as any).zatcaCsid && (org as any).zatcaCsidSecret),
    csid: (org as any).zatcaCsid,
    csidSecret: (org as any).zatcaCsidSecret,
  })

  await prisma.invoice.update({
    where: { id },
    data: {
      zatcaUuid: result.uuid,
      zatcaQr: result.qr,
      zatcaXml: result.xml,
      zatcaStatus: result.status,
    },
  })

  return c.json({
    ok: result.status !== 'ERROR',
    status: result.status,
    uuid: result.uuid,
    qr: result.qr,
    warnings: result.warnings || [],
    errors: result.errors || [],
  })
})

zatcaRoutes.get('/invoices/:id/qr', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const invoice = await prisma.invoice.findFirst({ where: { id, orgId }, select: { zatcaQr: true } })
  if (!invoice?.zatcaQr) return c.json({ error: 'not_processed', message: 'استدعِ /process أولاً' }, 404)
  return c.json({ qr: invoice.zatcaQr })
})

zatcaRoutes.get('/invoices/:id/xml', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const invoice = await prisma.invoice.findFirst({ where: { id, orgId }, select: { zatcaXml: true, invoiceNumber: true } })
  if (!invoice?.zatcaXml) return c.json({ error: 'not_processed' }, 404)
  c.header('Content-Type', 'application/xml; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.xml"`)
  return c.body(invoice.zatcaXml)
})
