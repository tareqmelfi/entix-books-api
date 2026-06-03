export const BANK_STATEMENT_REVIEW_STATUS = 'needs_bank_statement_review' as const

export type BankStatementDetection = {
  isBankStatement: boolean
  reasons: string[]
}

export type BankStatementGuardInput = {
  fileName?: string | null
  mimeType?: string | null
  text?: string | null
  extracted?: any
}

const BLOCKED_MESSAGE = 'Bank statement detected. It was not converted into an expense. Route it to bank statement review/staging.'

function clean(value: unknown): string {
  return String(value || '')
    .replace(/[ـ]/g, '')
    .replace(/[\u064B-\u065F]/g, '')
    .toLowerCase()
}

function normalizeClassifier(value: unknown): string {
  return clean(value).replace(/[\s_\-.]+/g, '')
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (value == null || depth > 4) return []
  if (typeof value === 'string') {
    if (value.length > 200_000) return []
    return [value]
  }
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)]
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1))
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      if (/base64|fileBase64|attachmentBase64|content/i.test(key)) return []
      return [key, ...collectStrings(item, depth + 1)]
    })
  }
  return []
}

function addReason(reasons: string[], reason: string) {
  if (!reasons.includes(reason)) reasons.push(reason)
}

function hasStatementPhrase(text: string): boolean {
  return [
    /bank[\s_-]*statement/i,
    /account[\s_-]*statement/i,
    /statement\s+of\s+account/i,
    /كشف\s+حساب/,
    /كشف\s*الحساب/,
  ].some((pattern) => pattern.test(text))
}

function countTransactionLikeLines(text: string): number {
  const lines = text.split(/\r?\n|\\n/).map((line) => line.trim()).filter(Boolean)
  const datePattern = /(\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b)/
  const amountPattern = /[-+]?\b\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\b|[-+]?\b\d+(?:\.\d{1,2})?\b/
  const bankingWords = /(debit|credit|balance|withdrawal|deposit|مدين|دائن|رصيد|سحب|ايداع|إيداع|تحويل)/
  return lines.filter((line) => {
    const normalized = clean(line)
    const hasAmount = amountPattern.test(line)
    return hasAmount && (datePattern.test(line) || bankingWords.test(normalized))
  }).length
}

function hasBankStatementStructure(text: string, extracted: any): boolean {
  const normalized = clean(text)
  const hasAccount =
    /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/i.test(text) ||
    /\bSA\d{22}\b/i.test(text) ||
    /(iban|account\s*(no|number)|رقم\s*الحساب|رقم\s*الايبان|رقم\s*الآيبان)/i.test(normalized)

  const hasBalance =
    /(opening\s*balance|closing\s*balance|available\s*balance|ending\s*balance|beginning\s*balance|الرصيد\s*الافتتاحي|رصيد\s*افتتاحي|الرصيد\s*الختامي|رصيد\s*ختامي|الرصيد\s*السابق|الرصيد\s*الحالي)/i.test(normalized)

  const transactionCount = countTransactionLikeLines(text)
  const extractedTransactions = Array.isArray(extracted?.transactions)
    ? extracted.transactions.length
    : Array.isArray(extracted?.entries)
      ? extracted.entries.length
      : 0

  return hasAccount && hasBalance && Math.max(transactionCount, extractedTransactions) >= 3
}

export function detectBankStatement(input: BankStatementGuardInput = {}): BankStatementDetection {
  const reasons: string[] = []
  const extracted = input.extracted || {}

  if (extracted?.status === BANK_STATEMENT_REVIEW_STATUS || extracted?.documentType === 'bank_statement') {
    addReason(reasons, 'already_marked_bank_statement')
  }

  const classificationFields = [
    extracted?.document_type,
    extracted?.documentType,
    extracted?.docType,
    extracted?.type,
    extracted?.kind,
  ]

  let genericStatementClassification: string | null = null
  for (const value of classificationFields) {
    const normalized = normalizeClassifier(value)
    if (['bankstatement', 'accountstatement'].includes(normalized)) {
      addReason(reasons, `classification:${String(value)}`)
    } else if (normalized === 'statement') {
      genericStatementClassification = String(value)
    }
  }

  const fileName = input.fileName || extracted?.fileName || extracted?._meta?.fileName || ''
  if (fileName && hasStatementPhrase(fileName)) {
    addReason(reasons, `filename:${fileName}`)
  }

  const combinedText = [
    input.text || '',
    fileName,
    ...collectStrings(extracted),
  ].filter(Boolean).join('\n')

  const hasExplicitStatementPhrase = combinedText ? hasStatementPhrase(combinedText) : false
  const hasRealStatementStructure = combinedText ? hasBankStatementStructure(combinedText, extracted) : false

  if (combinedText && hasExplicitStatementPhrase) {
    addReason(reasons, 'statement_phrase')
  }

  if (combinedText && hasRealStatementStructure) {
    addReason(reasons, 'bank_statement_structure')
  }

  if (genericStatementClassification && (hasExplicitStatementPhrase || hasRealStatementStructure)) {
    addReason(reasons, `classification:${genericStatementClassification}`)
  }

  return { isBankStatement: reasons.length > 0, reasons }
}

export function bankStatementBlockedResponse(reasons: string[] = []) {
  return {
    status: BANK_STATEMENT_REVIEW_STATUS,
    documentType: 'bank_statement',
    message: BLOCKED_MESSAGE,
    reasons,
    stagingAvailable: false,
    nextAction: 'bank_statement_review',
  }
}

export function markBankStatementExtraction<T extends Record<string, any>>(extracted: T, reasons: string[]): T {
  return {
    ...extracted,
    ...bankStatementBlockedResponse(reasons),
    docType: extracted?.docType || 'STATEMENT',
    warnings: [
      ...(Array.isArray(extracted?.warnings) ? extracted.warnings : []),
      BLOCKED_MESSAGE,
    ],
  }
}

export function isBankStatementBlocked(value: any): boolean {
  return value?.status === BANK_STATEMENT_REVIEW_STATUS || value?.documentType === 'bank_statement'
}

export async function logBankStatementBlockedAttempt(args: {
  prisma: { auditLog?: { create: (input: any) => Promise<any> } }
  orgId: string
  userId?: string | null
  source: string
  entityType?: string
  entityId?: string | null
  reasons?: string[]
  metadata?: Record<string, unknown>
}) {
  try {
    await args.prisma.auditLog?.create({
      data: {
        orgId: args.orgId,
        userId: args.userId || null,
        action: 'BANK_STATEMENT_AUTO_CREATE_BLOCKED',
        entityType: args.entityType || 'Document',
        entityId: args.entityId || null,
        severity: 'WARN',
        metadata: {
          source: args.source,
          reasons: args.reasons || [],
          ...(args.metadata || {}),
        },
      },
    })
  } catch (err) {
    console.warn('[bank-statement-guard] audit log skipped', err)
  }
}
