/**
 * Bank statement import routes · UX-58
 *
 * POST /api/bank-import/parse        Upload + parse only · returns rows + match suggestions (no DB writes)
 * POST /api/bank-import/commit       Apply user-approved matches · creates vouchers + updates balances
 * GET  /api/bank-import/profiles     List supported bank profiles for the dropdown
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { resolveAiKey, logAiUsage, estimateCost, QuotaExceededError, DisabledByAdminError } from '../lib/ai-billing.js'
import { isOpenRouterModelIssue, openRouterVisionModels } from '../lib/openrouter-models.js'
import {
  parseCsvStatement,
  parseMt940,
  parseOfx,
  matchTransaction,
  KSA_BANK_PROFILES,
  type RawBankTransaction,
} from '../lib/bank-import.js'

export const bankImportRoutes = new Hono()

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const BANK_STATEMENT_MODEL_CHAIN = openRouterVisionModels(process.env.OPENROUTER_BANK_STATEMENT_MODEL || process.env.OPENROUTER_OCR_MODEL)

async function callOpenRouterForStatement(payload: any, apiKey: string): Promise<{ ok: true; json: any; model: string } | { ok: false; status: number; detail: string; tried: string[] }> {
  const tried: string[] = []
  for (const model of BANK_STATEMENT_MODEL_CHAIN) {
    tried.push(model)
    try {
      const r = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://entix.io',
          'X-Title': 'Entix Books · Bank Statement Import',
        },
        body: JSON.stringify({ ...payload, model }),
      })
      if (r.ok) return { ok: true, json: await r.json(), model }
      const txt = await r.text()
      const isModelIssue = isOpenRouterModelIssue(r.status, txt)
      if (!isModelIssue && r.status < 500) return { ok: false, status: r.status, detail: txt.slice(0, 800), tried }
    } catch (e: any) {
      console.warn(`[bank-import] model ${model} threw`, e?.message)
    }
  }
  return { ok: false, status: 502, detail: 'لا تتوفر نماذج قراءة كشف البنك حالياً', tried }
}

function normalizeAiRows(value: any): RawBankTransaction[] {
  const rows = Array.isArray(value?.rows) ? value.rows : Array.isArray(value?.transactions) ? value.transactions : []
  return rows.map((row: any) => {
    const debit = Number(row.debit ?? 0)
    const credit = Number(row.credit ?? 0)
    const explicitAmount = row.amount !== undefined && row.amount !== null ? Number(row.amount) : NaN
    const amount = Number.isFinite(explicitAmount) ? explicitAmount : credit - debit
    return {
      date: String(row.date || '').slice(0, 10),
      description: String(row.description || row.memo || row.name || 'Bank transaction').trim(),
      amount,
      reference: row.reference ? String(row.reference) : undefined,
      counterparty: row.counterparty ? String(row.counterparty) : undefined,
      balance: row.balance !== undefined && row.balance !== null ? Number(row.balance) : undefined,
      currency: row.currency ? String(row.currency).toUpperCase() : undefined,
    }
  }).filter((row: RawBankTransaction) => row.date && Number.isFinite(row.amount) && row.amount !== 0)
}

async function parsePdfStatementWithAi(opts: {
  orgId: string
  userId?: string | null
  bankName?: string | null
  currency: string
  fileBase64: string
  fileName?: string
  mimeType?: string
}): Promise<{ rows: RawBankTransaction[]; model: string; source: string }> {
  let resolved: Awaited<ReturnType<typeof resolveAiKey>>
  try { resolved = await resolveAiKey(opts.orgId) } catch (e: any) {
    if (e instanceof QuotaExceededError) throw Object.assign(new Error('quota_exceeded'), { status: 402, detail: e.upgradeHint })
    if (e instanceof DisabledByAdminError) throw Object.assign(new Error('ai_disabled'), { status: 403, detail: e.reason })
    throw Object.assign(new Error('bank_statement_ai_disabled'), { status: 503, detail: e.message })
  }

  const prompt = `You are parsing a bank statement PDF for accounting reconciliation.
Return ONLY valid JSON, no markdown.

Schema:
{
  "statement": {
    "bankName": string | null,
    "accountNumberLast4": string | null,
    "routingNumber": string | null,
    "currency": string | null,
    "periodStart": "YYYY-MM-DD" | null,
    "periodEnd": "YYYY-MM-DD" | null
  },
  "rows": [
    {
      "date": "YYYY-MM-DD",
      "description": string,
      "amount": number,
      "debit": number | null,
      "credit": number | null,
      "balance": number | null,
      "reference": string | null,
      "counterparty": string | null,
      "currency": string | null
    }
  ]
}

Rules:
- Extract transaction rows only, not summary totals.
- Outflows/debits must be negative. Inflows/credits must be positive.
- Use ISO dates. If year is omitted, infer it from the statement period.
- Use decimals only, no commas or currency symbols.
- Default currency: ${opts.currency}.
- Expected bank/account: ${opts.bankName || 'unknown'}.
- If a row is uncertain, include it only when date, description, and amount are visible.`

  const result = await callOpenRouterForStatement({
    messages: [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Parse this bank statement PDF. File: ${opts.fileName || 'bank-statement.pdf'}` },
          {
            type: 'file',
            file: {
              filename: opts.fileName || 'bank-statement.pdf',
              file_data: `data:${opts.mimeType || 'application/pdf'};base64,${opts.fileBase64}`,
            },
          },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 8000,
    temperature: 0,
    plugins: [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }],
  }, resolved.apiKey)

  if (!result.ok) {
    await logAiUsage({
      orgId: opts.orgId, userId: opts.userId,
      endpoint: '/api/bank-import/parse', model: BANK_STATEMENT_MODEL_CHAIN[0],
      source: resolved.source, provider: resolved.provider,
      costUsd: 0, successful: false, errorCode: 'openrouter_error',
    })
    throw Object.assign(new Error('openrouter_error'), { status: result.status, detail: result.detail, triedModels: result.tried })
  }

  const content = result.json?.choices?.[0]?.message?.content || ''
  let parsed: any
  try { parsed = JSON.parse(content) } catch {
    const m = content.match(/\{[\s\S]*\}/)
    parsed = m ? JSON.parse(m[0]) : null
  }
  const usage = result.json?.usage || {}
  const cost = typeof usage.total_cost === 'number' && usage.total_cost > 0
    ? usage.total_cost
    : estimateCost(result.model, usage.prompt_tokens || 0, usage.completion_tokens || 0)
  await logAiUsage({
    orgId: opts.orgId, userId: opts.userId,
    endpoint: '/api/bank-import/parse', model: result.model,
    source: resolved.source, provider: resolved.provider,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    costUsd: cost, successful: !!parsed,
    errorCode: parsed ? null : 'parse_failed',
  })

  if (!parsed) throw Object.assign(new Error('parse_failed'), { status: 502, detail: content.slice(0, 500) })
  return { rows: normalizeAiRows(parsed), model: result.model, source: resolved.source }
}

bankImportRoutes.get('/profiles', (c) => {
  return c.json({
    profiles: Object.keys(KSA_BANK_PROFILES).map((id) => ({
      id,
      label: id === 'GENERIC' ? 'CSV Generic' : id,
    })),
    formats: ['csv', 'mt940', 'ofx', 'pdf'],
  })
})

const parseSchema = z.object({
  bankAccountId: z.string(),
  format: z.enum(['csv', 'mt940', 'ofx', 'pdf']).default('csv'),
  profile: z.string().optional().default('GENERIC'),
  text: z.string().max(5_000_000).optional(), // 5MB cap for text formats
  fileBase64: z.string().max(20_000_000).optional(), // PDF fallback · base64 payload
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.format === 'pdf') {
    if (!data.fileBase64) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fileBase64'], message: 'PDF file is required' })
  } else if (!data.text?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: 'Statement text is required' })
  }
})

bankImportRoutes.post('/parse', zValidator('json', parseSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const auth = c.get('auth') as { userId?: string } | undefined
  const { bankAccountId, format, profile, text, fileBase64, fileName, mimeType } = c.req.valid('json')

  const bank = await prisma.bankAccount.findFirst({ where: { id: bankAccountId, orgId } })
  if (!bank) return c.json({ error: 'invalid_bank_account' }, 400)

  let rows: RawBankTransaction[] = []
  let aiMeta: { model?: string; source?: string } = {}
  try {
    if (format === 'pdf') {
      const parsed = await parsePdfStatementWithAi({
        orgId,
        userId: auth?.userId,
        bankName: bank.bankName || bank.name,
        currency: bank.currency,
        fileBase64: fileBase64 || '',
        fileName,
        mimeType,
      })
      rows = parsed.rows
      aiMeta = { model: parsed.model, source: parsed.source }
    } else if (format === 'mt940') rows = parseMt940(text || '')
    else if (format === 'ofx') rows = parseOfx(text || '')
    else rows = parseCsvStatement(text || '', KSA_BANK_PROFILES[profile] || KSA_BANK_PROFILES.GENERIC)
  } catch (e: any) {
    return c.json({
      error: e?.message || 'parse_failed',
      message: e?.detail || e?.message || 'unknown',
      triedModels: e?.triedModels,
    }, e?.status || 400)
  }

  if (rows.length === 0) {
    return c.json({ rows: [], matched: 0, unmatched: 0, message: 'لم يتم استخراج أي حركات · تأكد من الصيغة' })
  }

  // Pull candidates within ±60 days of the imported range
  const dates = rows.map((r) => new Date(r.date).getTime()).filter((t) => !isNaN(t))
  const minDate = new Date(Math.min(...dates) - 60 * 86400_000)
  const maxDate = new Date(Math.max(...dates) + 60 * 86400_000)

  const [vouchers, invoices, bills] = await Promise.all([
    prisma.voucher.findMany({
      where: { orgId, date: { gte: minDate, lte: maxDate } },
      select: { id: true, amount: true, date: true, reference: true, contact: { select: { displayName: true } } },
      take: 1000,
    }),
    prisma.invoice.findMany({
      where: { orgId, dueDate: { gte: minDate, lte: maxDate }, status: { not: 'PAID' } },
      select: { id: true, total: true, dueDate: true, invoiceNumber: true, contact: { select: { displayName: true } } },
      take: 1000,
    }),
    prisma.bill.findMany({
      where: { orgId, dueDate: { gte: minDate, lte: maxDate }, status: { not: 'PAID' } },
      select: { id: true, total: true, dueDate: true, billNumber: true, contact: { select: { displayName: true } } },
      take: 1000,
    }),
  ])

  const candidates = {
    vouchers: vouchers.map((v) => ({
      id: v.id,
      amount: Number(v.amount),
      date: v.date.toISOString().slice(0, 10),
      reference: v.reference,
      contactName: v.contact?.displayName,
    })),
    invoices: invoices.map((i) => ({
      id: i.id,
      total: Number(i.total),
      dueDate: i.dueDate.toISOString().slice(0, 10),
      invoiceNumber: i.invoiceNumber,
      contactName: i.contact?.displayName,
    })),
    bills: bills.map((b) => ({
      id: b.id,
      total: Number(b.total),
      dueDate: b.dueDate.toISOString().slice(0, 10),
      billNumber: b.billNumber,
      contactName: b.contact?.displayName,
    })),
  }

  const enriched = rows.map((r, i) => ({
    index: i,
    ...r,
    match: matchTransaction(r, candidates),
  }))

  const matched = enriched.filter((r) => r.match.type !== 'unknown').length
  return c.json({
    rows: enriched,
    matched,
    unmatched: enriched.length - matched,
    bankAccount: { id: bank.id, name: bank.name, currency: bank.currency },
    ai: aiMeta,
  })
})

const commitSchema = z.object({
  bankAccountId: z.string(),
  // Only the rows the user approved · each may have user-overridden match decisions
  rows: z.array(z.object({
    date: z.string(),
    amount: z.coerce.number(),
    description: z.string(),
    reference: z.string().optional().nullable(),
    /** What the user chose: link to existing voucher, create new voucher, or skip */
    action: z.enum(['link_voucher', 'create_voucher', 'link_invoice', 'link_bill', 'skip']),
    targetId: z.string().optional(), // for link_* actions
    contactId: z.string().optional(), // for create_voucher
  })).min(1).max(500),
})

bankImportRoutes.post('/commit', zValidator('json', commitSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const { bankAccountId, rows } = c.req.valid('json')

  const bank = await prisma.bankAccount.findFirst({ where: { id: bankAccountId, orgId } })
  if (!bank) return c.json({ error: 'invalid_bank_account' }, 400)

  const created: string[] = []
  const linked: string[] = []
  const skipped: string[] = []

  for (const r of rows) {
    if (r.action === 'skip') { skipped.push(r.reference || r.description); continue }

    if (r.action === 'create_voucher') {
      const type = r.amount > 0 ? 'RECEIPT' : 'PAYMENT'
      const year = new Date().getFullYear()
      const prefix = type === 'RECEIPT' ? `R-${year}-` : `P-${year}-`
      const last = await prisma.voucher.findFirst({
        where: { orgId, type, number: { startsWith: prefix } },
        orderBy: { number: 'desc' },
        select: { number: true },
      })
      const lastNum = last ? Number(last.number.split('-').pop() || '0') : 0
      const number = `${prefix}${String(lastNum + 1).padStart(4, '0')}`
      const v = await prisma.voucher.create({
        data: {
          orgId,
          type: type as any,
          number,
          date: new Date(r.date),
          contactId: r.contactId || null,
          amount: new Prisma.Decimal(Math.abs(r.amount)),
          currency: bank.currency,
          paymentMethod: 'BANK_TRANSFER',
          reference: r.reference || null,
          notes: `استيراد من كشف ${bank.name} · ${r.description}`,
          bankAccountId,
        },
      })
      // Update bank balance
      await prisma.bankAccount.update({
        where: { id: bankAccountId },
        data: { balance: { increment: new Prisma.Decimal(r.amount) } },
      })
      created.push(v.id)
      continue
    }

    if (r.action === 'link_voucher' && r.targetId) {
      await prisma.voucher.update({
        where: { id: r.targetId },
        data: {
          bankAccountId,
          reference: r.reference || undefined,
        },
      })
      linked.push(r.targetId)
      continue
    }

    // For link_invoice / link_bill we create a voucher and link it
    if ((r.action === 'link_invoice' || r.action === 'link_bill') && r.targetId) {
      const isInvoice = r.action === 'link_invoice'
      const year = new Date().getFullYear()
      const prefix = isInvoice ? `R-${year}-` : `P-${year}-`
      const last = await prisma.voucher.findFirst({
        where: { orgId, type: isInvoice ? 'RECEIPT' : 'PAYMENT', number: { startsWith: prefix } },
        orderBy: { number: 'desc' },
        select: { number: true },
      })
      const lastNum = last ? Number(last.number.split('-').pop() || '0') : 0
      const number = `${prefix}${String(lastNum + 1).padStart(4, '0')}`
      const v = await prisma.voucher.create({
        data: {
          orgId,
          type: isInvoice ? 'RECEIPT' : 'PAYMENT',
          number,
          date: new Date(r.date),
          amount: new Prisma.Decimal(Math.abs(r.amount)),
          currency: bank.currency,
          paymentMethod: 'BANK_TRANSFER',
          reference: r.reference || null,
          notes: `استيراد من كشف ${bank.name}`,
          bankAccountId,
          invoiceId: isInvoice ? r.targetId : null,
          billId: isInvoice ? null : r.targetId,
        },
      })
      // Update related doc
      if (isInvoice) {
        const inv = await prisma.invoice.findUnique({ where: { id: r.targetId } })
        if (inv) {
          const newPaid = Number(inv.amountPaid) + Math.abs(r.amount)
          const status = newPaid >= Number(inv.total) ? 'PAID' : 'PARTIAL'
          await prisma.invoice.update({ where: { id: r.targetId }, data: { amountPaid: new Prisma.Decimal(newPaid), status } })
        }
      } else {
        const bill = await prisma.bill.findUnique({ where: { id: r.targetId } })
        if (bill) {
          const newPaid = Number(bill.amountPaid) + Math.abs(r.amount)
          const status = newPaid >= Number(bill.total) ? 'PAID' : 'PARTIAL'
          await prisma.bill.update({ where: { id: r.targetId }, data: { amountPaid: new Prisma.Decimal(newPaid), status } })
        }
      }
      await prisma.bankAccount.update({
        where: { id: bankAccountId },
        data: { balance: { increment: new Prisma.Decimal(r.amount) } },
      })
      created.push(v.id)
    }
  }

  return c.json({
    ok: true,
    created: created.length,
    linked: linked.length,
    skipped: skipped.length,
    voucherIds: created,
  })
})
