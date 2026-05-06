/**
 * Numbering helper · UX-103
 *
 * Generates document codes (contact / invoice / quote / bill / voucher) using
 * the org's `numberingSettings` field with sensible defaults.
 *
 * Token replacements in prefix:
 *   {YYYY} → 4-digit year
 *   {YY}   → 2-digit year
 *   {MM}   → 2-digit month
 *   {DD}   → 2-digit day
 *
 * Counter is the org-scoped count of existing rows of that doc type + start offset.
 */
import { prisma } from '../db.js'

export type DocKind = 'contact' | 'invoice' | 'quote' | 'bill' | 'receipt' | 'payment'

const DEFAULTS: Record<DocKind, { prefix: string; padding: number; start: number }> = {
  contact: { prefix: 'CUST-',         padding: 4, start: 1 },
  invoice: { prefix: 'INV-{YYYY}-',   padding: 4, start: 1 },
  quote:   { prefix: 'QT-{YYYY}-',    padding: 4, start: 1 },
  bill:    { prefix: 'BILL-{YYYY}-',  padding: 4, start: 1 },
  receipt: { prefix: 'R-{YYYY}-',     padding: 4, start: 1 },
  payment: { prefix: 'P-{YYYY}-',     padding: 4, start: 1 },
}

function expandTokens(prefix: string, now = new Date()): string {
  const yyyy = String(now.getFullYear())
  const yy = yyyy.slice(2)
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return prefix
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{YY\}/g, yy)
    .replace(/\{MM\}/g, mm)
    .replace(/\{DD\}/g, dd)
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
export function buildNextNumber(prefix: string, padding: number, start: number, lastSeq: number | null): string {
  const expandedPrefix = expandTokens(prefix)
  const next = (lastSeq ?? (start - 1)) + 1
  return `${expandedPrefix}${String(next).padStart(padding, '0')}`
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
  return buildNextNumber(prefix, padding, start, lastSeq)
}

export async function nextInvoiceNumber(orgId: string): Promise<string> {
  const { prefix, padding, start } = await getOrgNumberingForKind(orgId, 'invoice')
  const last = await prisma.invoice.findFirst({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    select: { invoiceNumber: true },
  })
  const lastSeq = last ? parseTrailingSeq(last.invoiceNumber) : null
  return buildNextNumber(prefix, padding, start, lastSeq)
}
