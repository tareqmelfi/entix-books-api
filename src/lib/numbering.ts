/**
 * Numbering helper · UX-103
 *
 * Generates document codes (contact / invoice / quote / bill / voucher) using
 * the org's `numberingSettings` field with sensible defaults.
 *
 * Token replacements in prefix:
 *   {ENTITY} → company/entity code (default EN)
 *   {CLIENT} → customer shortCode, e.g. SNBL
 *   {VENDOR} → vendor shortCode
 *   {PROJECT} → project code, e.g. ENG01
 *   {DOC}   → document type, e.g. INV / QTE / BIL / RCP
 *   {YYYY} → 4-digit year
 *   {YY}   → 2-digit year
 *   {MM}   → 2-digit month
 *   {DD}   → 2-digit day
 *   {SEQ}  → padded sequence, e.g. 0001
 *
 * Counter is the org-scoped count of existing rows of that doc type + start offset.
 */
import { prisma } from '../db.js'

export type DocKind = 'contact' | 'invoice' | 'quote' | 'bill' | 'receipt' | 'payment'

const DEFAULTS: Record<DocKind, { prefix: string; padding: number; start: number }> = {
  contact: { prefix: 'EN-CON-',           padding: 4, start: 1 },
  invoice: { prefix: 'EN-INV-{YYYY}{MM}-', padding: 4, start: 1 },
  quote:   { prefix: 'EN-QTE-{YYYY}{MM}-', padding: 4, start: 1 },
  bill:    { prefix: 'EN-BIL-{YYYY}{MM}-', padding: 4, start: 1 },
  receipt: { prefix: 'EN-RCP-{YYYY}{MM}-', padding: 4, start: 1 },
  payment: { prefix: 'EN-RCP-{YYYY}{MM}-', padding: 4, start: 1 },
}

export const SUPPORTED_NUMBERING_TOKENS = ['ENTITY', 'CLIENT', 'VENDOR', 'PROJECT', 'DOC', 'YYYY', 'YY', 'MM', 'DD', 'SEQ'] as const
const SUPPORTED_NUMBERING_TOKEN_SET = new Set<string>(SUPPORTED_NUMBERING_TOKENS)

type NumberingContext = {
  entityCode?: string | null
  clientCode?: string | null
  vendorCode?: string | null
  projectCode?: string | null
  docCode?: string | null
  sequence?: string | null
  now?: Date
}

export function normalizeContactShortCode(value?: string | null): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  const normalized = trimmed
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')

  if (!normalized) return null
  if (normalized.length > 4) {
    throw new Error('short_code_too_long')
  }
  return normalized
}

export function suggestContactShortCode(displayName: string): string {
  const normalized = displayName
    .toUpperCase()
    .replace(/\b(AL|THE|AND|CO|COMPANY|LLC|LTD|INC|LP)\b/g, ' ')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const words = normalized.split(' ').filter(Boolean)
  const initials = words.map((word) => word[0]).join('').slice(0, 4)
  const compact = normalized.replace(/\s+/g, '').slice(0, 4)
  return initials || compact || 'CON'
}

export async function nextContactShortCode(args: {
  orgId: string
  displayName: string
  requested?: string | null
  excludeId?: string
}): Promise<string | null> {
  if (args.requested !== undefined) {
    const requested = normalizeContactShortCode(args.requested)
    if (!requested) return null

    const duplicate = await prisma.contact.findFirst({
      where: {
        orgId: args.orgId,
        shortCode: requested,
        ...(args.excludeId ? { id: { not: args.excludeId } } : {}),
      },
      select: { id: true },
    })
    if (duplicate) throw new Error('short_code_already_exists')
    return requested
  }

  const base = suggestContactShortCode(args.displayName)
  const candidates = new Set<string>([base])
  for (let i = 1; i <= 99; i++) {
    candidates.add(`${base.slice(0, Math.max(1, 4 - String(i).length))}${i}`)
  }

  for (const candidate of candidates) {
    const duplicate = await prisma.contact.findFirst({
      where: {
        orgId: args.orgId,
        shortCode: candidate,
        ...(args.excludeId ? { id: { not: args.excludeId } } : {}),
      },
      select: { id: true },
    })
    if (!duplicate) return candidate
  }

  throw new Error('short_code_pool_exhausted')
}

export function findUnsupportedNumberingTokens(prefix: string): string[] {
  const matches = Array.from(prefix.matchAll(/\{([A-Z]+)\}/g)).map((match) => match[1])
  return matches.filter((token) => !SUPPORTED_NUMBERING_TOKEN_SET.has(token))
}

export function hasLegacyPlaceholder(prefix: string): boolean {
  return /\bX{2,}\b/i.test(prefix)
}

export function expandNumberingTokens(prefix: string, context: NumberingContext = {}): string {
  const now = context.now || new Date()
  const yyyy = String(now.getFullYear())
  const yy = yyyy.slice(2)
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')

  return prefix
    .replace(/\{ENTITY\}/g, context.entityCode || 'EN')
    .replace(/\{CLIENT\}/g, context.clientCode || 'GEN')
    .replace(/\{VENDOR\}/g, context.vendorCode || context.clientCode || 'GEN')
    .replace(/\{PROJECT\}/g, context.projectCode || 'GEN')
    .replace(/\{DOC\}/g, context.docCode || 'DOC')
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{YY\}/g, yy)
    .replace(/\{MM\}/g, mm)
    .replace(/\{DD\}/g, dd)
    .replace(/\{SEQ\}/g, context.sequence || '')
}

export async function getOrgNumberingForKind(orgId: string, kind: DocKind) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { numberingSettings: true } })
  const cfg: any = (org?.numberingSettings as any)?.[kind] || {}
  return {
    prefix: cfg.prefix ?? DEFAULTS[kind].prefix,
    padding: cfg.padding ?? DEFAULTS[kind].padding,
    start: cfg.start ?? DEFAULTS[kind].start,
  }
}

/** Build the next number for a given doc kind. Caller passes the highest existing number string (or null). */
export function buildNextNumber(
  prefix: string,
  padding: number,
  start: number,
  lastSeq: number | null,
  context: NumberingContext = {},
): string {
  const next = (lastSeq ?? (start - 1)) + 1
  const sequence = String(next).padStart(padding, '0')
  const expandedPrefix = expandNumberingTokens(prefix, { ...context, sequence })
  return prefix.includes('{SEQ}') ? expandedPrefix : `${expandedPrefix}${sequence}`
}

/** Extract the trailing integer part of a code · returns null if not parseable */
export function parseTrailingSeq(code: string): number | null {
  const m = code.match(/(\d+)\s*$/)
  return m ? Number(m[1]) : null
}

export async function nextContactCode(orgId: string): Promise<string> {
  const { prefix, padding, start } = await getOrgNumberingForKind(orgId, 'contact')
  // Find max trailing seq across existing customCode values
  const existing = await prisma.contact.findMany({
    where: { orgId, customCode: { not: null } },
    select: { customCode: true },
  })
  const seqs = existing.map(e => parseTrailingSeq(e.customCode || '')).filter((n): n is number => n !== null)
  const lastSeq = seqs.length ? Math.max(...seqs) : null
  return buildNextNumber(prefix, padding, start, lastSeq, { docCode: 'CON' })
}

async function getDocumentNumberingContext(orgId: string, contactId?: string | null, docCode?: string): Promise<NumberingContext> {
  const [org, contact] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { numberingSettings: true } }),
    contactId
      ? prisma.contact.findFirst({
          where: { id: contactId, orgId },
          select: { shortCode: true, isSupplier: true, isCustomer: true },
        })
      : Promise.resolve(null),
  ])

  const settings: any = org?.numberingSettings || {}
  return {
    entityCode: settings.entityCode || 'EN',
    clientCode: contact?.shortCode || undefined,
    vendorCode: contact?.shortCode || undefined,
    docCode,
  }
}

export async function nextInvoiceNumber(orgId: string, contactId?: string | null): Promise<string> {
  const { prefix, padding, start } = await getOrgNumberingForKind(orgId, 'invoice')
  const context = await getDocumentNumberingContext(orgId, contactId, 'INV')
  const last = await prisma.invoice.findFirst({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    select: { invoiceNumber: true },
  })
  const lastSeq = last ? parseTrailingSeq(last.invoiceNumber) : null
  return buildNextNumber(prefix, padding, start, lastSeq, context)
}

export async function nextQuoteNumber(orgId: string, contactId?: string | null): Promise<string> {
  const { prefix, padding, start } = await getOrgNumberingForKind(orgId, 'quote')
  const context = await getDocumentNumberingContext(orgId, contactId, 'QTE')
  const last = await prisma.quote.findFirst({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    select: { quoteNumber: true },
  })
  const lastSeq = last ? parseTrailingSeq(last.quoteNumber) : null
  return buildNextNumber(prefix, padding, start, lastSeq, context)
}

export async function nextBillNumber(orgId: string, contactId?: string | null): Promise<string> {
  const { prefix, padding, start } = await getOrgNumberingForKind(orgId, 'bill')
  const context = await getDocumentNumberingContext(orgId, contactId, 'BIL')
  const last = await prisma.bill.findFirst({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    select: { billNumber: true },
  })
  const lastSeq = last ? parseTrailingSeq(last.billNumber) : null
  return buildNextNumber(prefix, padding, start, lastSeq, context)
}

export async function nextVoucherNumber(orgId: string, type: 'RECEIPT' | 'PAYMENT', contactId?: string | null): Promise<string> {
  const kind: DocKind = type === 'RECEIPT' ? 'receipt' : 'payment'
  const { prefix, padding, start } = await getOrgNumberingForKind(orgId, kind)
  const context = await getDocumentNumberingContext(orgId, contactId, type === 'RECEIPT' ? 'RCP' : 'PAY')
  const last = await prisma.voucher.findFirst({
    where: { orgId, type },
    orderBy: { createdAt: 'desc' },
    select: { number: true },
  })
  const lastSeq = last ? parseTrailingSeq(last.number) : null
  return buildNextNumber(prefix, padding, start, lastSeq, context)
}
