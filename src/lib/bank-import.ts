/**
 * Bank statement import · UX-58
 *
 * Parsers:
 *   - CSV (open format · column-mapped via bank profile)
 *   - MT940 (SWIFT standard · used by KSA banks AlRajhi, NCB, Riyad)
 *   - OFX (Open Financial Exchange · used by some int'l banks)
 *
 * Output: a normalized list of BankTransaction rows ready to insert.
 *
 * Auto-match rules (deterministic, run after parse):
 *   1. Exact reference number match → existing voucher.reference
 *   2. Amount + date (±2 days) → existing voucher
 *   3. Amount + counterparty name (fuzzy) → existing customer/supplier
 *   4. Else: leaves it UNMATCHED for human triage
 */

export interface RawBankTransaction {
  date: string // YYYY-MM-DD
  amount: number // signed: positive = credit (in), negative = debit (out)
  description: string
  reference?: string
  counterparty?: string
  balance?: number
  currency?: string
}

export interface CsvProfile {
  /** Delimiter · defaults to "," · KSA banks often use ";" */
  delimiter?: string
  /** 1-based column indices */
  columns: {
    date: number
    description: number
    /** EITHER amount column (signed)... */
    amount?: number
    /** ...OR separate debit/credit columns */
    debit?: number
    credit?: number
    reference?: number
    counterparty?: number
    balance?: number
  }
  /** Date format · "DD/MM/YYYY" "YYYY-MM-DD" "DD-MMM-YY" etc. */
  dateFormat?: string
  /** Skip first N header rows */
  headerRows?: number
}

// Common KSA bank profiles · users can pick or define their own
export const KSA_BANK_PROFILES: Record<string, CsvProfile> = {
  RAJHI: {
    delimiter: ',',
    columns: { date: 1, description: 2, debit: 3, credit: 4, balance: 5, reference: 6 },
    dateFormat: 'DD/MM/YYYY',
    headerRows: 1,
  },
  NCB: {
    delimiter: ',',
    columns: { date: 1, reference: 2, description: 3, debit: 4, credit: 5, balance: 6 },
    dateFormat: 'YYYY-MM-DD',
    headerRows: 1,
  },
  RIYAD: {
    delimiter: ',',
    columns: { date: 1, description: 2, amount: 3, balance: 4, reference: 5 },
    dateFormat: 'DD-MM-YYYY',
    headerRows: 1,
  },
  SAB: {
    delimiter: ',',
    columns: { date: 1, description: 2, debit: 3, credit: 4 },
    dateFormat: 'DD/MM/YYYY',
    headerRows: 1,
  },
  GENERIC: {
    delimiter: ',',
    columns: { date: 1, description: 2, amount: 3 },
    dateFormat: 'YYYY-MM-DD',
    headerRows: 1,
  },
}

function parseDate(raw: string, fmt: string = 'YYYY-MM-DD'): string {
  const s = raw.trim()
  if (!s) return ''
  // ISO already
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  // DD/MM/YYYY or DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/)
  if (m) {
    const [, d, mo, y] = m
    const year = y.length === 2 ? `20${y}` : y
    return `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  // Fallback to Date parsing
  const dt = new Date(s)
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10)
  return s
}

function parseAmount(raw: string): number {
  if (!raw) return 0
  const cleaned = raw.replace(/[\s,]/g, '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
  const n = Number(cleaned)
  return isNaN(n) ? 0 : n
}

/** CSV parser · respects quoted fields and bank-specific column mapping. */
export function parseCsvStatement(text: string, profile: CsvProfile = KSA_BANK_PROFILES.GENERIC): RawBankTransaction[] {
  const delim = profile.delimiter || ','
  const skipRows = profile.headerRows ?? 1
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const dataLines = lines.slice(skipRows)

  const out: RawBankTransaction[] = []
  for (const line of dataLines) {
    // Simple CSV split (doesn't handle escaped quotes · sufficient for most bank exports)
    const cols = line.split(delim).map((c) => c.trim().replace(/^"|"$/g, ''))
    const c = profile.columns
    const date = parseDate(cols[c.date - 1] || '', profile.dateFormat)
    const description = cols[c.description - 1] || ''
    let amount = 0
    if (c.amount !== undefined) {
      amount = parseAmount(cols[c.amount - 1] || '0')
    } else {
      const debit = parseAmount(cols[(c.debit || 0) - 1] || '0')
      const credit = parseAmount(cols[(c.credit || 0) - 1] || '0')
      amount = credit - debit
    }
    if (!date || amount === 0) continue
    out.push({
      date,
      amount,
      description,
      reference: c.reference ? cols[c.reference - 1] : undefined,
      counterparty: c.counterparty ? cols[c.counterparty - 1] : undefined,
      balance: c.balance ? parseAmount(cols[c.balance - 1] || '0') : undefined,
    })
  }
  return out
}

/** MT940 parser · SWIFT standard 940 · used by GCC banks. */
export function parseMt940(text: string): RawBankTransaction[] {
  const out: RawBankTransaction[] = []
  // MT940 records start with :61: (transaction) and :86: (description)
  // Split into blocks · simple regex for `:61:YYMMDD...` lines
  const lines = text.split(/\r?\n/)
  let cur: Partial<RawBankTransaction> | null = null
  for (const line of lines) {
    if (line.startsWith(':61:')) {
      if (cur && cur.date && cur.amount !== undefined) out.push(cur as RawBankTransaction)
      cur = {}
      // :61:241225C50000,00NTRF...
      const m = line.match(/:61:(\d{6})(\d{4})?([CD])(\d+(?:[,.]\d{1,4})?)/)
      if (m) {
        const [, valueDate, , dc, amt] = m
        const yy = valueDate.slice(0, 2)
        const mm = valueDate.slice(2, 4)
        const dd = valueDate.slice(4, 6)
        const year = Number(yy) > 50 ? `19${yy}` : `20${yy}`
        cur.date = `${year}-${mm}-${dd}`
        cur.amount = (dc === 'C' ? 1 : -1) * Number(amt.replace(',', '.'))
      }
    } else if (line.startsWith(':86:') && cur) {
      cur.description = (cur.description || '') + line.slice(4)
    }
  }
  if (cur && cur.date && cur.amount !== undefined) out.push(cur as RawBankTransaction)
  return out
}

/** OFX parser · scoped to STMTTRN blocks · sufficient for most exports. */
export function parseOfx(text: string): RawBankTransaction[] {
  const out: RawBankTransaction[] = []
  const blocks = text.split(/<STMTTRN>/i).slice(1)
  for (const blk of blocks) {
    const get = (tag: string) => {
      const m = blk.match(new RegExp(`<${tag}>([^<]+)`, 'i'))
      return m ? m[1].trim() : ''
    }
    const dposted = get('DTPOSTED')
    const date = dposted ? `${dposted.slice(0, 4)}-${dposted.slice(4, 6)}-${dposted.slice(6, 8)}` : ''
    const amount = Number(get('TRNAMT'))
    const description = get('NAME') || get('MEMO')
    const reference = get('FITID') || get('CHECKNUM')
    if (!date || isNaN(amount)) continue
    out.push({ date, amount, description, reference })
  }
  return out
}

// ─── Auto-match ──────────────────────────────────────────────────────────────

export interface MatchCandidate {
  type: 'voucher' | 'invoice' | 'bill' | 'expense' | 'unknown'
  id?: string
  confidence: number // 0-1
  reason: string
}

/** Token-based fuzzy similarity · returns 0-1 (1 = identical). */
function fuzzy(a: string, b: string): number {
  if (!a || !b) return 0
  const tokens = (s: string) => s.toLowerCase().split(/[\s\-_]+/).filter(Boolean)
  const ta = new Set(tokens(a))
  const tb = new Set(tokens(b))
  if (ta.size === 0 || tb.size === 0) return 0
  let common = 0
  ta.forEach((t) => { if (tb.has(t)) common++ })
  return common / Math.max(ta.size, tb.size)
}

/**
 * Try to match a raw bank line to an existing record.
 * The caller (route) supplies the candidate sets pulled from Prisma.
 */
export function matchTransaction(
  tx: RawBankTransaction,
  candidates: {
    vouchers: Array<{ id: string; amount: number; date: string; reference?: string | null; contactName?: string | null }>
    invoices: Array<{ id: string; total: number; dueDate: string; invoiceNumber: string; contactName?: string | null }>
    bills: Array<{ id: string; total: number; dueDate: string; billNumber: string; contactName?: string | null }>
  },
): MatchCandidate {
  // Rule 1 · exact reference match on vouchers
  if (tx.reference) {
    const v = candidates.vouchers.find((v) => v.reference && v.reference.trim() === tx.reference)
    if (v) return { type: 'voucher', id: v.id, confidence: 0.95, reason: 'reference exact' }
  }

  // Rule 2 · exact amount + date within 2 days
  const amt = Math.abs(tx.amount)
  const txDate = new Date(tx.date).getTime()
  const within2d = (d: string) => Math.abs(new Date(d).getTime() - txDate) <= 2 * 86400_000

  const v2 = candidates.vouchers.find((v) => Math.abs(v.amount - amt) < 0.01 && within2d(v.date))
  if (v2) return { type: 'voucher', id: v2.id, confidence: 0.85, reason: 'amount + date' }

  // Rule 3 · receivables/payables matching by amount + due date + name fuzzy
  if (tx.amount > 0) {
    // Inflow → could be payment for an invoice
    for (const inv of candidates.invoices) {
      if (Math.abs(inv.total - amt) < 0.01) {
        const nameScore = fuzzy(tx.description, inv.contactName || '')
        if (nameScore > 0.5) return { type: 'invoice', id: inv.id, confidence: 0.7, reason: `invoice ${inv.invoiceNumber} amount + name` }
        if (within2d(inv.dueDate)) return { type: 'invoice', id: inv.id, confidence: 0.6, reason: `invoice ${inv.invoiceNumber} amount + due date` }
      }
    }
  } else {
    // Outflow → could be payment for a bill
    for (const b of candidates.bills) {
      if (Math.abs(b.total - amt) < 0.01) {
        const nameScore = fuzzy(tx.description, b.contactName || '')
        if (nameScore > 0.5) return { type: 'bill', id: b.id, confidence: 0.7, reason: `bill ${b.billNumber} amount + name` }
        if (within2d(b.dueDate)) return { type: 'bill', id: b.id, confidence: 0.6, reason: `bill ${b.billNumber} amount + due date` }
      }
    }
  }

  return { type: 'unknown', confidence: 0, reason: 'no match' }
}
