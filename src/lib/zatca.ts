/**
 * ZATCA Phase 2 · E-Invoicing Saudi Arabia (UX-56)
 *
 * Scope of this module:
 *   1. TLV QR code generator (Tag-Length-Value · Base64)
 *   2. UBL 2.1 XML template builder for Standard Tax Invoice
 *   3. Invoice hash + chain (PIH = Previous Invoice Hash)
 *   4. ZATCA Clearance API client (Standard) + Reporting API client (Simplified)
 *
 * Cryptographic signing (XAdES-B-B + EC keypair) and certificate compliance
 * are the most security-sensitive parts · they reference the org's signing
 * material stored in vault. See `signInvoice()` for the orchestration entry.
 *
 * Specs followed:
 *   - ZATCA E-Invoicing XML Implementation Standard 2.0
 *   - UBL 2.1 (OASIS Standard)
 *   - XAdES-B-B for digital signatures
 *
 * Sandbox vs Production:
 *   - ZATCA_MODE = "sandbox" (default) | "simulation" | "production"
 *   - sandbox: ZATCA_API_BASE = https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal
 *   - production: https://gw-fatoora.zatca.gov.sa/e-invoicing/core
 *
 * Out of scope for this scaffold (Phase 2.1 follow-up):
 *   - Full XAdES signature wrapper (requires libxmlsec or node-forge integration)
 *   - Onboarding & CSID retrieval (one-time per device)
 *   - Production cert lifecycle
 */

import { createHash } from 'crypto'

// ─── Config ──────────────────────────────────────────────────────────────────

export const ZATCA_MODE: 'sandbox' | 'simulation' | 'production' =
  (process.env.ZATCA_MODE as any) || 'sandbox'

const ZATCA_BASE_URLS: Record<typeof ZATCA_MODE, string> = {
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
}

export const ZATCA_API_BASE = ZATCA_BASE_URLS[ZATCA_MODE]

// ─── TLV QR Code ─────────────────────────────────────────────────────────────

/**
 * Build the ZATCA Phase-2 QR code payload (Tag-Length-Value · Base64).
 *
 * Tags:
 *   1 · Seller Name (UTF-8)
 *   2 · VAT Number (15-digit · "3xxxxxxxxxxxxx3")
 *   3 · Invoice Timestamp (ISO-8601)
 *   4 · Invoice Total with VAT (decimal as string)
 *   5 · VAT Total (decimal as string)
 *   6 · XML hash (SHA-256 base64) [Phase 2]
 *   7 · ECDSA signature (base64) [Phase 2]
 *   8 · ECDSA public key (base64) [Phase 2]
 *   9 · ZATCA stamp signature [Phase 2 · for Standard invoices after clearance]
 */
export interface QrInput {
  sellerName: string
  vatNumber: string
  timestamp: string // ISO-8601
  totalWithVat: string
  vatAmount: string
  xmlHashBase64?: string
  signatureBase64?: string
  publicKeyBase64?: string
  stampSignatureBase64?: string
}

function tlv(tag: number, value: string): Buffer {
  const valueBuf = Buffer.from(value, 'utf-8')
  return Buffer.concat([Buffer.from([tag, valueBuf.length]), valueBuf])
}

export function buildZatcaQr(input: QrInput): string {
  const parts: Buffer[] = [
    tlv(1, input.sellerName),
    tlv(2, input.vatNumber),
    tlv(3, input.timestamp),
    tlv(4, input.totalWithVat),
    tlv(5, input.vatAmount),
  ]
  if (input.xmlHashBase64) parts.push(tlv(6, input.xmlHashBase64))
  if (input.signatureBase64) parts.push(tlv(7, input.signatureBase64))
  if (input.publicKeyBase64) parts.push(tlv(8, input.publicKeyBase64))
  if (input.stampSignatureBase64) parts.push(tlv(9, input.stampSignatureBase64))
  return Buffer.concat(parts).toString('base64')
}

// ─── UBL 2.1 XML Builder ─────────────────────────────────────────────────────

export interface UblInvoiceInput {
  invoiceNumber: string
  uuid: string
  issueDate: string // YYYY-MM-DD
  issueTime: string // HH:mm:ss
  /** "388" Standard · "388-01" Simplified · "381" Credit Note */
  invoiceTypeCode: '388' | '383' | '381'
  /** Sub-type: "0100000" Standard B2B · "0200000" Simplified B2C */
  invoiceSubTypeCode: '0100000' | '0200000'
  currency: string
  /** Previous invoice hash · "" for the first invoice in the chain */
  previousInvoiceHash: string
  /** Sequential ICV (invoice counter value) · resets per CSID/device */
  icv: number
  seller: {
    vatNumber: string
    crNumber?: string
    legalName: string
    addressLine: string
    city: string
    postalCode: string
    country: string
  }
  buyer: {
    vatNumber?: string
    legalName: string
    addressLine?: string
    city?: string
    postalCode?: string
    country?: string
  }
  lines: Array<{
    id: number
    description: string
    quantity: number
    unitPrice: number
    /** Tax category code: "S" Standard · "Z" Zero · "E" Exempt */
    taxCategory: 'S' | 'Z' | 'E'
    taxRate: number // 0.15 for KSA standard
    lineSubtotal: number
    lineTax: number
    lineTotal: number
  }>
  totals: {
    subtotal: number
    discount: number
    vat: number
    total: number
  }
  paymentMeansCode?: string // "10" cash · "30" credit transfer · etc.
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildUblInvoiceXml(inv: UblInvoiceInput): string {
  const ns = `xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
    xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
    xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
    xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"`

  const lineXml = inv.lines.map((l) => `
    <cac:InvoiceLine>
      <cbc:ID>${l.id}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="PCE">${l.quantity}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${inv.currency}">${l.lineSubtotal.toFixed(2)}</cbc:LineExtensionAmount>
      <cac:TaxTotal>
        <cbc:TaxAmount currencyID="${inv.currency}">${l.lineTax.toFixed(2)}</cbc:TaxAmount>
        <cbc:RoundingAmount currencyID="${inv.currency}">${l.lineTotal.toFixed(2)}</cbc:RoundingAmount>
      </cac:TaxTotal>
      <cac:Item>
        <cbc:Name>${escapeXml(l.description)}</cbc:Name>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>${l.taxCategory}</cbc:ID>
          <cbc:Percent>${(l.taxRate * 100).toFixed(2)}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${inv.currency}">${l.unitPrice.toFixed(2)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`).join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice ${ns}>
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${escapeXml(inv.invoiceNumber)}</cbc:ID>
  <cbc:UUID>${inv.uuid}</cbc:UUID>
  <cbc:IssueDate>${inv.issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${inv.issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${inv.invoiceSubTypeCode}">${inv.invoiceTypeCode}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${inv.currency}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${inv.currency}</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${inv.icv}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${inv.previousInvoiceHash || 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ=='}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">${escapeXml(inv.seller.crNumber || '')}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXml(inv.seller.addressLine)}</cbc:StreetName>
        <cbc:CityName>${escapeXml(inv.seller.city)}</cbc:CityName>
        <cbc:PostalZone>${escapeXml(inv.seller.postalCode)}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>${inv.seller.country}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${inv.seller.vatNumber}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity><cbc:RegistrationName>${escapeXml(inv.seller.legalName)}</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      ${inv.buyer.vatNumber ? `<cac:PartyTaxScheme><cbc:CompanyID>${inv.buyer.vatNumber}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : ''}
      <cac:PartyLegalEntity><cbc:RegistrationName>${escapeXml(inv.buyer.legalName)}</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>${inv.paymentMeansCode || '10'}</cbc:PaymentMeansCode>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${inv.currency}">${inv.totals.vat.toFixed(2)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${inv.currency}">${inv.totals.subtotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${inv.currency}">${inv.totals.subtotal.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${inv.currency}">${inv.totals.total.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="${inv.currency}">${inv.totals.discount.toFixed(2)}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="${inv.currency}">${inv.totals.total.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lineXml}
</Invoice>`
}

// ─── Hash chain ──────────────────────────────────────────────────────────────

/** SHA-256 of canonicalized XML · Base64 encoded · used for PIH chain. */
export function hashInvoiceXml(canonicalXml: string): string {
  return createHash('sha256').update(canonicalXml, 'utf-8').digest('base64')
}

/** Get the next ICV (sequential counter) for an org · stored on Organization or a counter table. */
export async function nextIcv(_orgId: string): Promise<number> {
  // TODO Phase 2.1: read/write a per-org counter row · for now stub.
  return Date.now() % 1_000_000
}

// ─── Clearance + Reporting API ───────────────────────────────────────────────

interface ZatcaSubmitResult {
  ok: boolean
  status: 'CLEARED' | 'REPORTED' | 'WARNING' | 'ERROR'
  warnings?: string[]
  errors?: string[]
  clearedXmlBase64?: string
  zatcaUuid?: string
  raw?: any
}

/**
 * Submit a Standard Tax Invoice for Clearance · ZATCA returns the cleared XML
 * (with stamp) which MUST be the version sent to the buyer.
 *
 * Endpoint: POST /invoices/clearance/single
 * Auth: Basic <CSID>:<secret>
 */
export async function submitForClearance(
  signedInvoiceXmlBase64: string,
  invoiceHashBase64: string,
  uuid: string,
  csid: string,
  csidSecret: string,
): Promise<ZatcaSubmitResult> {
  if (ZATCA_MODE === 'sandbox' && process.env.ZATCA_DRY_RUN === 'true') {
    return { ok: true, status: 'CLEARED', warnings: ['dry-run · not actually sent'], zatcaUuid: uuid }
  }
  try {
    const r = await fetch(`${ZATCA_API_BASE}/invoices/clearance/single`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'en',
        'Accept-Version': 'V2',
        'Clearance-Status': '1',
        Authorization: `Basic ${Buffer.from(`${csid}:${csidSecret}`).toString('base64')}`,
      },
      body: JSON.stringify({ invoiceHash: invoiceHashBase64, uuid, invoice: signedInvoiceXmlBase64 }),
    })
    const json: any = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, status: 'ERROR', errors: [json?.error || `HTTP ${r.status}`], raw: json }
    return {
      ok: true,
      status: json.clearanceStatus === 'CLEARED' ? 'CLEARED' : 'WARNING',
      warnings: json.warnings || [],
      clearedXmlBase64: json.clearedInvoice,
      zatcaUuid: json.uuid || uuid,
      raw: json,
    }
  } catch (e: any) {
    return { ok: false, status: 'ERROR', errors: [e?.message || 'network failure'] }
  }
}

/**
 * Submit a Simplified Tax Invoice for Reporting · within 24h of issue.
 *
 * Endpoint: POST /invoices/reporting/single
 */
export async function submitForReporting(
  signedInvoiceXmlBase64: string,
  invoiceHashBase64: string,
  uuid: string,
  csid: string,
  csidSecret: string,
): Promise<ZatcaSubmitResult> {
  if (ZATCA_MODE === 'sandbox' && process.env.ZATCA_DRY_RUN === 'true') {
    return { ok: true, status: 'REPORTED', warnings: ['dry-run · not actually sent'], zatcaUuid: uuid }
  }
  try {
    const r = await fetch(`${ZATCA_API_BASE}/invoices/reporting/single`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'en',
        'Accept-Version': 'V2',
        Authorization: `Basic ${Buffer.from(`${csid}:${csidSecret}`).toString('base64')}`,
      },
      body: JSON.stringify({ invoiceHash: invoiceHashBase64, uuid, invoice: signedInvoiceXmlBase64 }),
    })
    const json: any = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, status: 'ERROR', errors: [json?.error || `HTTP ${r.status}`], raw: json }
    return {
      ok: json.reportingStatus !== 'NOT_REPORTED',
      status: json.reportingStatus === 'REPORTED' ? 'REPORTED' : 'WARNING',
      warnings: json.warnings || [],
      zatcaUuid: uuid,
      raw: json,
    }
  } catch (e: any) {
    return { ok: false, status: 'ERROR', errors: [e?.message || 'network failure'] }
  }
}

// ─── Public orchestration ────────────────────────────────────────────────────

/**
 * Process an invoice end-to-end:
 *   1. Build UBL XML
 *   2. Hash it (and chain from previous hash)
 *   3. Sign with org's EC private key (TODO Phase 2.1)
 *   4. Generate QR code (TLV base64)
 *   5. Submit to ZATCA (clearance for Standard, reporting for Simplified)
 *
 * For now: returns the unsigned XML + hash + QR · the actual submission
 * is enabled once Phase-2.1 wires the signing key vault.
 */
export interface ProcessInvoiceResult {
  uuid: string
  xml: string
  xmlHash: string
  qr: string
  status: 'BUILT' | 'CLEARED' | 'REPORTED' | 'ERROR'
  warnings?: string[]
  errors?: string[]
}

export async function processInvoiceForZatca(
  input: UblInvoiceInput,
  options?: { skipSubmit?: boolean; csid?: string; csidSecret?: string },
): Promise<ProcessInvoiceResult> {
  const xml = buildUblInvoiceXml(input)
  const xmlHash = hashInvoiceXml(xml)
  const qr = buildZatcaQr({
    sellerName: input.seller.legalName,
    vatNumber: input.seller.vatNumber,
    timestamp: `${input.issueDate}T${input.issueTime}`,
    totalWithVat: input.totals.total.toFixed(2),
    vatAmount: input.totals.vat.toFixed(2),
    xmlHashBase64: xmlHash,
  })

  if (options?.skipSubmit || !options?.csid || !options?.csidSecret) {
    return { uuid: input.uuid, xml, xmlHash, qr, status: 'BUILT' }
  }

  const xmlBase64 = Buffer.from(xml, 'utf-8').toString('base64')
  const isSimplified = input.invoiceSubTypeCode === '0200000'
  const result = isSimplified
    ? await submitForReporting(xmlBase64, xmlHash, input.uuid, options.csid, options.csidSecret)
    : await submitForClearance(xmlBase64, xmlHash, input.uuid, options.csid, options.csidSecret)

  return {
    uuid: input.uuid,
    xml,
    xmlHash,
    qr,
    status: result.status === 'CLEARED' ? 'CLEARED' : result.status === 'REPORTED' ? 'REPORTED' : 'ERROR',
    warnings: result.warnings,
    errors: result.errors,
  }
}
