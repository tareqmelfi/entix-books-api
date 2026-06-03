/**
 * OCR · Universal document understanding via Claude Vision (OpenRouter)
 *
 * Endpoints:
 *   POST /api/ocr/extract        — single file, structured extraction (legacy · still used)
 *   POST /api/ocr/extract-batch  — multiple files in one call · classify + extract + index
 *   GET  /api/ocr/health
 *
 * Accepts ANY file type — images, PDFs, Word, Excel, CSV, plain text.
 * For non-image types we send the raw text/base64 with a clear hint.
 * Claude decides what kind of document it is and what to extract.
 *
 * Cost: ~$0.005/page with claude-haiku-4.5 · falls back to 3.5-haiku if unavailable.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../db.js'
import { resolveAiKey, logAiUsage, estimateCost, QuotaExceededError, DisabledByAdminError } from '../lib/ai-billing.js'
import { inferMimeType, isImageMime, normalizeImageForVision, type NormalizedDocumentFile } from '../lib/document-images.js'
import { isOpenRouterModelIssue, openRouterVisionModels } from '../lib/openrouter-models.js'
import {
  detectBankStatement,
  logBankStatementBlockedAttempt,
  markBankStatementExtraction,
} from '../lib/bank-statement-guard.js'

export const ocrRoutes = new Hono()

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || ''
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

const VISION_MODEL_CHAIN = openRouterVisionModels(process.env.OPENROUTER_OCR_MODEL)

const VISION_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  'application/pdf',
])

const SYSTEM_PROMPT = `You extract structured data from ANY business document — receipts, invoices, bills, quotes, contracts, statements, photos of paper, screenshots, free-form text.
You support Arabic and English (and mixed).

Return ONLY valid JSON · no markdown · no extra text.

Schema:
{
  "docType": "RECEIPT" | "INVOICE" | "BILL" | "QUOTE" | "CONTRACT" | "STATEMENT" | "OTHER",
  "vendor": string | null,
  "vendorVat": string | null,
  "buyer": string | null,
  "documentNumber": string | null,
  "issueDate": "YYYY-MM-DD" | null,
  "dueDate": "YYYY-MM-DD" | null,
  "currency": string | null,
  "subtotal": number | null,
  "taxRate": number | null,
  "taxAmount": number | null,
  "discount": number | null,
  "total": number | null,
  "paymentMethod": "CASH" | "BANK_TRANSFER" | "CARD" | "MADA" | "STC_PAY" | "CHECK" | "OTHER" | null,
  "payments": [{ "method": "CASH" | "BANK_TRANSFER" | "CARD" | "MADA" | "STC_PAY" | "CHECK" | "OTHER", "amount": number, "reference": string | null, "cardLast4": string | null }],
  "category": string | null,
  "tags": string[],
  "lineItems": [{ "description": string, "quantity": number, "unitPrice": number, "taxRate": number | null, "subtotal": number }],
  "summary": string,
  "confidence": number,
  "language": "ar" | "en" | "mixed",
  "warnings": string[]
}

Rules:
- Numbers: NO commas · NO currency symbols · just decimals
- Dates: ISO YYYY-MM-DD only
- Arabic text: keep in Arabic · don't translate
- Currency: infer from symbol/text · default SAR if Saudi VAT pattern (300xxx) detected
- If unsure: null + warning · DO NOT invent
- For Saudi tax invoices, vendorVat is critical. Extract 15-digit VAT/tax IDs from labels like الرقم الضريبي, VAT Number, Tax Number. Prefer vendor tax ID over buyer tax ID.
- documentNumber is critical. Extract invoice/receipt number from labels like رقم الفاتورة, رقم الإيصال, invoice no, receipt no, bill no, ref. Do NOT use terminal ID, authorization code, cashier number, commercial registration, VAT number, or card number as documentNumber.
- Never collapse visible line items into only a total. If rows/items are visible, preserve each item with description, quantity, unitPrice, taxRate, subtotal. If the receipt repeats the same item in separate rows, keep separate rows unless the receipt explicitly groups them.
- If payment details show split payments, return all visible payments in payments[] and choose paymentMethod from the largest payment. If only one payment is visible, include one payment row.
- If the document is a bank/account statement, set docType="STATEMENT". Do not summarize it as one expense or one transaction.
- For card payments, use MADA when mada is visible, otherwise CARD. If the last 4 digits are visible, put them in cardLast4 and never include the full card number.
- Warnings must mention missing documentNumber, missing vendorVat, uncertain date, uncertain total, or uncertain line items.
- "tags" should help classification (e.g. ["restaurant","mada","Q1-2026","food"]) · short kebab-case-ar/en
- "summary": one Arabic sentence max 120 chars`

async function callOpenRouter(payload: any, apiKey: string): Promise<{ ok: true; json: any; model: string } | { ok: false; status: number; detail: string; tried: string[] }> {
  const tried: string[] = []
  for (const model of VISION_MODEL_CHAIN) {
    tried.push(model)
    try {
      const r = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://entix.io',
          'X-Title': 'Entix Books · OCR',
        },
        body: JSON.stringify({ ...payload, model }),
      })
      if (r.ok) return { ok: true, json: await r.json(), model }
      const txt = await r.text()
      console.warn(`[ocr] model ${model} status=${r.status}`, txt.slice(0, 200))
      const isModelIssue = isOpenRouterModelIssue(r.status, txt)
      if (!isModelIssue) {
        // 5xx · brief retry on same model
        if (r.status >= 500) {
          await new Promise((res) => setTimeout(res, 400))
          const r2 = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://entix.io',
              'X-Title': 'Entix Books · OCR',
            },
            body: JSON.stringify({ ...payload, model }),
          })
          if (r2.ok) return { ok: true, json: await r2.json(), model }
        }
      }
    } catch (e: any) {
      console.warn(`[ocr] model ${model} threw`, e?.message)
    }
  }
  return { ok: false, status: 502, detail: 'لا تتوفر أي نماذج للقراءة الذكية حالياً · حاول بعد دقيقة', tried }
}

function buildUserContent(file: { fileBase64: string; mimeType: string; fileName?: string; rawText?: string }, hint?: string) {
  const mime = inferMimeType(file.mimeType, file.fileName)
  const isPdf = mime === 'application/pdf' || (file.fileName || '').toLowerCase().endsWith('.pdf')
  const isImage = mime.startsWith('image/')
  const intro = `File: ${file.fileName || '(unnamed)'} · type: ${mime}${hint ? ` · hint: ${hint}` : ''}`

  if (isPdf) {
    // Anthropic-native PDF support · OpenRouter passes through the `file` content type
    // Reference: https://docs.anthropic.com/en/docs/build-with-claude/pdf-support
    return [
      { type: 'text', text: intro + '\nExtract all visible fields per the schema. The PDF may be multi-page · combine all pages into one extraction.' },
      {
        type: 'file',
        file: {
          filename: file.fileName || 'document.pdf',
          file_data: `data:application/pdf;base64,${file.fileBase64}`,
        },
      },
    ]
  }

  if (isImage) {
    return [
      { type: 'text', text: intro + '\nExtract all visible fields per the schema.' },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${file.fileBase64}` } },
    ]
  }

  // Non-visual: assume the caller provided extracted text · or decode base64 → utf-8
  let text = file.rawText
  if (!text) {
    try {
      text = Buffer.from(file.fileBase64, 'base64').toString('utf-8').slice(0, 50000)
    } catch { text = '' }
  }
  return [
    { type: 'text', text: `${intro}\n\nDocument content (text):\n\n${text}\n\nExtract all visible fields per the schema.` },
  ]
}

function isPdfDocument(file: { mimeType?: string; fileName?: string }) {
  const mime = inferMimeType(file.mimeType, file.fileName)
  return mime === 'application/pdf' || (file.fileName || '').toLowerCase().endsWith('.pdf')
}

function fileParserPlugins(file: { mimeType?: string; fileName?: string }) {
  if (!isPdfDocument(file)) return undefined
  return [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }]
}

async function prepareFileForOcr(file: {
  fileBase64: string
  mimeType?: string
  fileName?: string
  rawText?: string
}): Promise<NormalizedDocumentFile & { rawText?: string }> {
  const mimeType = inferMimeType(file.mimeType, file.fileName)
  if (!isImageMime(mimeType)) {
    return {
      fileBase64: file.fileBase64,
      mimeType,
      fileName: file.fileName,
      rawText: file.rawText,
      warnings: [],
      converted: false,
    }
  }
  const normalized = await normalizeImageForVision({
    fileBase64: file.fileBase64,
    mimeType,
    fileName: file.fileName,
  })
  return { ...normalized, rawText: file.rawText }
}

const singleSchema = z.object({
  fileBase64: z.string().min(20),
  mimeType: z.string().default('application/octet-stream'),
  fileName: z.string().optional(),
  rawText: z.string().optional(),
  docType: z.string().optional(), // hint
})

ocrRoutes.post('/extract', zValidator('json', singleSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const auth = c.get('auth') as { userId: string }
  const f = c.req.valid('json')

  const prepared = await prepareFileForOcr(f)
  if (prepared.error) {
    return c.json({
      error: 'image_preprocess_failed',
      detail: prepared.error,
      message: prepared.error,
      originalMimeType: inferMimeType(f.mimeType, f.fileName),
    }, 415)
  }

  const preDetection = detectBankStatement({
    fileName: f.fileName,
    mimeType: prepared.mimeType,
    text: f.rawText,
  })
  if (preDetection.isBankStatement) {
    await logBankStatementBlockedAttempt({
      prisma,
      orgId,
      userId: auth.userId,
      source: 'ocr.extract.pre_detection',
      entityType: 'Document',
      reasons: preDetection.reasons,
      metadata: { fileName: f.fileName || null, mimeType: prepared.mimeType },
    })
    return c.json({
      extracted: markBankStatementExtraction({}, preDetection.reasons),
      model: 'bank-statement-guard',
      cost: { promptTokens: 0, completionTokens: 0, totalCost: 0 },
      source: 'bank-statement-guard',
    })
  }

  let resolved: Awaited<ReturnType<typeof resolveAiKey>>
  try { resolved = await resolveAiKey(orgId) } catch (e: any) {
    if (e instanceof QuotaExceededError) {
      return c.json({ error: 'quota_exceeded', detail: e.upgradeHint, ...e }, 402)
    }
    if (e instanceof DisabledByAdminError) {
      return c.json({ error: 'ai_disabled', detail: e.reason }, 403)
    }
    return c.json({ error: 'ocr_disabled', detail: e.message }, 503)
  }

  const result = await callOpenRouter({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserContent(prepared, f.docType) },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 3500,
    temperature: 0,
    plugins: fileParserPlugins(prepared),
  }, resolved.apiKey)

  if (!result.ok) {
    await logAiUsage({
      orgId, userId: auth.userId,
      endpoint: '/api/ocr/extract', model: VISION_MODEL_CHAIN[0],
      source: resolved.source, provider: resolved.provider,
      costUsd: 0, successful: false, errorCode: 'openrouter_error',
    })
    return c.json({ error: 'openrouter_error', detail: result.detail, triedModels: result.tried }, 502)
  }

  const content = result.json?.choices?.[0]?.message?.content || ''
  let extracted: any
  try { extracted = JSON.parse(content) } catch {
    const m = content.match(/\{[\s\S]*\}/)
    extracted = m ? JSON.parse(m[0]) : null
  }
  if (extracted && prepared.warnings.length) {
    extracted.warnings = [...(extracted.warnings || []), ...prepared.warnings]
  }
  const postDetection = detectBankStatement({
    fileName: f.fileName,
    mimeType: prepared.mimeType,
    text: f.rawText,
    extracted,
  })
  if (extracted && postDetection.isBankStatement) {
    extracted = markBankStatementExtraction(extracted, postDetection.reasons)
    await logBankStatementBlockedAttempt({
      prisma,
      orgId,
      userId: auth.userId,
      source: 'ocr.extract.post_detection',
      entityType: 'Document',
      reasons: postDetection.reasons,
      metadata: { fileName: f.fileName || null, mimeType: prepared.mimeType },
    })
  }

  // Cost tracking
  const usage = result.json?.usage || {}
  const cost = typeof usage.total_cost === 'number' && usage.total_cost > 0
    ? usage.total_cost
    : estimateCost(result.model, usage.prompt_tokens || 0, usage.completion_tokens || 0)
  await logAiUsage({
    orgId, userId: auth.userId,
    endpoint: '/api/ocr/extract', model: result.model,
    source: resolved.source, provider: resolved.provider,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    costUsd: cost, successful: !!extracted,
    errorCode: extracted ? null : 'parse_failed',
  })

  if (!extracted) return c.json({ error: 'parse_failed', raw: content.slice(0, 500) }, 502)
  return c.json({
    extracted, model: result.model,
    cost: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalCost: cost },
    source: resolved.source,
  })
})

// ── Multi-file batch ───────────────────────────────────────────────────────
const batchSchema = z.object({
  files: z.array(z.object({
    fileBase64: z.string().min(20),
    mimeType: z.string().default('application/octet-stream'),
    fileName: z.string().optional(),
    rawText: z.string().optional(),
  })).min(1).max(50),
  hint: z.string().optional(), // user prompt: "هذي فواتير عيادة بيطرية" · "ترتيب حسب العميل"
})

ocrRoutes.post('/extract-batch', zValidator('json', batchSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const auth = c.get('auth') as { userId: string }
  const { files, hint } = c.req.valid('json')

  const preflightDetections = files.map((f) => ({
    file: f,
    detection: detectBankStatement({
      fileName: f.fileName,
      mimeType: inferMimeType(f.mimeType, f.fileName),
      text: [hint, f.rawText].filter(Boolean).join('\n'),
    }),
  }))
  if (preflightDetections.every((entry) => entry.detection.isBankStatement)) {
    const results: Array<{ fileName?: string; mimeType: string; ok: boolean; extracted?: any; model?: string }> = []
    for (const entry of preflightDetections) {
      const mimeType = inferMimeType(entry.file.mimeType, entry.file.fileName)
      await logBankStatementBlockedAttempt({
        prisma,
        orgId,
        userId: auth.userId,
        source: 'ocr.extract_batch.preflight_detection',
        entityType: 'Document',
        reasons: entry.detection.reasons,
        metadata: { fileName: entry.file.fileName || null, mimeType },
      })
      results.push({
        fileName: entry.file.fileName,
        mimeType,
        ok: true,
        extracted: markBankStatementExtraction({}, entry.detection.reasons),
        model: 'bank-statement-guard',
      })
    }
    return c.json({
      files: results,
      summary: { totalFiles: files.length, successful: results.length, failed: 0, totalAmount: 0, currency: null },
      index: { byDocType: { STATEMENT: results.length }, byVendor: {}, byMonth: {}, byTag: {} },
    })
  }

  let resolved: Awaited<ReturnType<typeof resolveAiKey>>
  try { resolved = await resolveAiKey(orgId) } catch (e: any) {
    if (e instanceof QuotaExceededError) {
      return c.json({ error: 'quota_exceeded', detail: e.upgradeHint, ...e }, 402)
    }
    if (e instanceof DisabledByAdminError) {
      return c.json({ error: 'ai_disabled', detail: e.reason }, 403)
    }
    return c.json({ error: 'ocr_disabled', detail: e.message }, 503)
  }

  // Process in parallel · cap concurrency at 5 to avoid rate limits
  const results: Array<{ fileName?: string; mimeType: string; ok: boolean; extracted?: any; error?: string; model?: string }> = []
  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  let totalCost = 0
  let primaryModel = VISION_MODEL_CHAIN[0]
  const queue = [...files]
  const workers = Array.from({ length: Math.min(5, files.length) }, async () => {
    while (queue.length > 0) {
      const f = queue.shift()
      if (!f) break
      const prepared = await prepareFileForOcr(f)
      if (prepared.error) {
        results.push({ fileName: f.fileName, mimeType: inferMimeType(f.mimeType, f.fileName), ok: false, error: prepared.error })
        continue
      }
      const preDetection = detectBankStatement({
        fileName: f.fileName,
        mimeType: prepared.mimeType,
        text: f.rawText,
      })
      if (preDetection.isBankStatement) {
        await logBankStatementBlockedAttempt({
          prisma,
          orgId,
          userId: auth.userId,
          source: 'ocr.extract_batch.pre_detection',
          entityType: 'Document',
          reasons: preDetection.reasons,
          metadata: { fileName: f.fileName || null, mimeType: prepared.mimeType },
        })
        results.push({ fileName: f.fileName, mimeType: prepared.mimeType, ok: true, extracted: markBankStatementExtraction({}, preDetection.reasons), model: 'bank-statement-guard' })
        continue
      }
      const r = await callOpenRouter({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserContent(prepared, hint) },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 3500,
        temperature: 0,
        plugins: fileParserPlugins(prepared),
      }, resolved.apiKey)
      if (!r.ok) {
        results.push({ fileName: f.fileName, mimeType: prepared.mimeType, ok: false, error: r.detail })
        continue
      }
      const content = r.json?.choices?.[0]?.message?.content || ''
      let extracted: any
      try { extracted = JSON.parse(content) } catch {
        const m = content.match(/\{[\s\S]*\}/)
        extracted = m ? JSON.parse(m[0]) : null
      }
      // Accumulate cost per file
      const usage = r.json?.usage || {}
      totalPromptTokens += usage.prompt_tokens || 0
      totalCompletionTokens += usage.completion_tokens || 0
      const fileCost = typeof usage.total_cost === 'number' && usage.total_cost > 0
        ? usage.total_cost
        : estimateCost(r.model, usage.prompt_tokens || 0, usage.completion_tokens || 0)
      totalCost += fileCost
      primaryModel = r.model

      if (!extracted) {
        results.push({ fileName: f.fileName, mimeType: prepared.mimeType, ok: false, error: 'parse_failed' })
        continue
      }
      if (prepared.warnings.length) {
        extracted.warnings = [...(extracted.warnings || []), ...prepared.warnings]
      }
      const postDetection = detectBankStatement({
        fileName: f.fileName,
        mimeType: prepared.mimeType,
        text: f.rawText,
        extracted,
      })
      if (postDetection.isBankStatement) {
        extracted = markBankStatementExtraction(extracted, postDetection.reasons)
        await logBankStatementBlockedAttempt({
          prisma,
          orgId,
          userId: auth.userId,
          source: 'ocr.extract_batch.post_detection',
          entityType: 'Document',
          reasons: postDetection.reasons,
          metadata: { fileName: f.fileName || null, mimeType: prepared.mimeType },
        })
      }
      results.push({ fileName: f.fileName, mimeType: prepared.mimeType, ok: true, extracted, model: r.model })
    }
  })
  await Promise.all(workers)

  // Single aggregate log for the whole batch
  await logAiUsage({
    orgId, userId: auth.userId,
    endpoint: '/api/ocr/extract-batch', model: primaryModel,
    source: resolved.source, provider: resolved.provider,
    promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens,
    costUsd: totalCost,
    successful: results.some((r) => r.ok),
  })

  // Build a classification index: by docType · by vendor · by month · by tag
  const byDocType: Record<string, number> = {}
  const byVendor: Record<string, number> = {}
  const byMonth: Record<string, number> = {}
  const byTag: Record<string, number> = {}
  let totalAmount = 0
  let currency: string | null = null

  for (const r of results) {
    if (!r.ok || !r.extracted) continue
    const e = r.extracted
    const dt = e.docType || 'OTHER'
    byDocType[dt] = (byDocType[dt] || 0) + 1
    if (e.vendor) byVendor[e.vendor] = (byVendor[e.vendor] || 0) + 1
    if (e.issueDate) {
      const m = e.issueDate.slice(0, 7)
      byMonth[m] = (byMonth[m] || 0) + 1
    }
    if (Array.isArray(e.tags)) e.tags.forEach((t: string) => { byTag[t] = (byTag[t] || 0) + 1 })
    if (typeof e.total === 'number' && !Number.isNaN(e.total)) totalAmount += e.total
    if (!currency && e.currency) currency = e.currency
  }

  return c.json({
    files: results,
    summary: {
      totalFiles: files.length,
      successful: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      totalAmount,
      currency,
    },
    index: { byDocType, byVendor, byMonth, byTag },
  })
})

ocrRoutes.get('/health', (c) =>
  c.json({
    enabled: !!OPENROUTER_KEY,
    provider: 'openrouter',
    primaryModel: VISION_MODEL_CHAIN[0],
    fallbackChain: VISION_MODEL_CHAIN,
    supportsBatch: true,
    maxBatchFiles: 50,
    visualMimes: Array.from(VISION_MIMES),
    nonVisualSupported: ['text/*', 'application/json', 'text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.*'],
  }),
)
