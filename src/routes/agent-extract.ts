/**
 * Universal document extractor · UX-65b
 *
 * Endpoint: POST /api/agent/extract-document
 *   body: multipart/form-data with `file` (image, PDF, Excel, CSV) + optional fields
 *
 * Pipeline:
 *   1. Detect file type (mime sniff)
 *   2. Image/PDF → OCR via Claude vision (or call existing /api/ocr)
 *   3. CSV/Excel → direct text extraction (skip OCR)
 *   4. Extracted text → Haiku-class structured extraction with target schema
 *      (invoice-lines · contact · expense · receipt total · etc.)
 *   5. Return structured rows ready to populate the form
 *
 * Cost: ~$0.005-0.02 per document (depends on size)
 *
 * Bonus: hint="quote-to-invoice" tells the model "this is a quote · output as invoice"
 *        which lets a user upload a quote PDF and immediately produce an invoice.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { resolveAiKey, logAiUsage, estimateCost } from '../lib/ai-billing.js'
import { inferMimeType, isImageMime, normalizeImageForVision } from '../lib/document-images.js'
import { isOpenRouterModelIssue, openRouterVisionModels } from '../lib/openrouter-models.js'
import { prisma } from '../db.js'
import {
  bankStatementBlockedResponse,
  detectBankStatement,
  logBankStatementBlockedAttempt,
} from '../lib/bank-statement-guard.js'

export const agentExtractRoutes = new Hono()

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
// Primary + fallback. Keep this on current router aliases because model ids drift.
const VISION_MODELS = openRouterVisionModels(process.env.OPENROUTER_OCR_MODEL)

// PaddleOCR fallback service · self-hosted on same VPS (UX-161)
const PADDLE_OCR_URL = process.env.PADDLE_OCR_URL || ''
const PADDLE_OCR_TOKEN = process.env.PADDLE_OCR_TOKEN || ''

/** Try PaddleOCR · returns raw text or null if unavailable/failed */
async function paddleOcrFallback(fileBase64: string, mimeType: string): Promise<string | null> {
  if (!PADDLE_OCR_URL) return null
  // PaddleOCR doesn't handle PDFs natively · only images
  if (!mimeType.startsWith('image/')) return null
  try {
    const r = await fetch(`${PADDLE_OCR_URL}/ocr/json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(PADDLE_OCR_TOKEN ? { Authorization: `Bearer ${PADDLE_OCR_TOKEN}` } : {}),
      },
      body: JSON.stringify({ fileBase64, lang: 'ar' }),
    })
    if (!r.ok) {
      console.warn('[paddle-ocr] failed', r.status)
      return null
    }
    const j = (await r.json()) as { full_text?: string }
    return j.full_text || null
  } catch (e) {
    console.warn('[paddle-ocr] exception', e)
    return null
  }
}

const extractSchema = z.object({
  /** base64-encoded file contents (for non-image files use plain text) */
  fileBase64: z.string().min(1).max(140_000_000), // ~100MB raw · base64 grows by 33%
  fileName: z.string().optional(),
  mimeType: z.string().default('image/jpeg'),
  /** Target schema · what the user wants to populate */
  target: z.enum([
    'invoice-lines',
    'quote-lines',
    'bill-lines',
    'expense',
    'contact',
    'auto',
  ]).default('auto'),
  /** Convert from one type to another · "this is a quote, make it an invoice" */
  hint: z.string().max(500).optional(),
  /** Org's default tax rate · used to fill missing tax info */
  defaultTaxRate: z.coerce.number().min(0).max(1).default(0.15),
  /** Org's currency */
  currency: z.string().length(3).default('SAR'),
})

const normalizeImageSchema = z.object({
  fileBase64: z.string().min(1).max(140_000_000),
  fileName: z.string().optional(),
  mimeType: z.string().default('image/jpeg'),
  trimEdges: z.boolean().default(true),
})

const SYSTEM_PROMPT = `You are a document extraction engine for Entix Books (Arabic accounting · KSA).
Input: an image, PDF, or text blob from a receipt/quote/invoice/contract.
Goal: extract STRUCTURED data the app can drop straight into a form.

Output strict JSON · no markdown · no commentary. Schema:
{
  "kind": "invoice" | "quote" | "bill" | "expense" | "contact" | "unknown",
  "confidence": 0.0-1.0,
  "issuer": { "name": "...", "taxId": "...", "country": "SA" },
  "buyer": { "name": "...", "taxId": "..." },
  "documentNumber": "...",
  "issueDate": "YYYY-MM-DD",
  "dueDate": "YYYY-MM-DD",
  "currency": "SAR",
  "lines": [
    {
      "description": "...",
      "quantity": 1,
      "unitPrice": 0.00,
      "taxRate": 0.15,
      "taxInclusive": false,
      "lineTotal": 0.00,
      "category": "Groceries | Meals | Utilities | Fuel | Office | Software | Other",
      "accountName": "suggested accounting account name",
      "sku": "...",
      "notes": null
    }
  ],
  "totals": {
    "subtotal": 0.00,
    "discount": 0.00,
    "tax": 0.00,
    "total": 0.00
  },
  "payments": [
    {
      "method": "CASH" | "CARD" | "MADA" | "BANK_TRANSFER" | "STC_PAY" | "CHECK" | "OTHER",
      "amount": 0.00,
      "reference": "...",
      "cardLast4": "...",
      "accountName": "cash drawer | bank/card account"
    }
  ],
  "paymentTerms": "...",
  "notes": "...",
  "warnings": ["..."]
}

Rules:
- Normalize Arabic-Indic digits (٠-٩) to Western (0-9).
- If you can't read the document at all, set kind="unknown" and confidence=0.
- For quotes/invoices: every line must have a description.
- For receipts: split every visible item/receipt row into lines. Do not collapse distinct products into one line if prices are visible.
- Suggest category/accountName per line when it is obvious (groceries, meals, office, software, fuel, utilities).
- Extract payment methods separately. If total is paid by both cash and card, return multiple payments whose sum equals total.
- VAT rate in KSA is 15% by default. If the document shows a different rate, use that.
- If the source is a bank/account statement, do not treat it as an expense, bill, or one payment. Return kind="unknown" with warnings that it requires bank statement review.
- If "taxInclusive" cannot be determined, default to false (exclusive · price + tax).
- Dates in DD/MM/YYYY → convert to YYYY-MM-DD.
- Currency · default "SAR" if not stated.
- Round all numbers to 2 decimals.
- DO NOT invent data · leave fields null/empty if not present in the source.`

agentExtractRoutes.post('/extract-document', zValidator('json', extractSchema), async (c) => {
  const auth = c.get('auth') as any
  const orgId = c.get('orgId') as string
  const { fileBase64, fileName, mimeType, target, hint, defaultTaxRate, currency } = c.req.valid('json')
  const originalMimeType = inferMimeType(mimeType, fileName)
  const prepared = isImageMime(originalMimeType)
    ? await normalizeImageForVision({ fileBase64, mimeType: originalMimeType, fileName })
    : { fileBase64, mimeType: originalMimeType, fileName, warnings: [] as string[], converted: false }

  if (prepared.error) {
    return c.json({
      error: 'image_preprocess_failed',
      detail: prepared.error,
      message: prepared.error,
      originalMimeType,
    }, 415)
  }

  // Build the user message
  // For images/PDFs: vision payload · for text: plain text
  const isImage = prepared.mimeType.startsWith('image/')
  const isPdf = prepared.mimeType === 'application/pdf'
  const isText = prepared.mimeType.startsWith('text/') || prepared.mimeType.includes('csv')
  const decodedText = isText ? Buffer.from(prepared.fileBase64, 'base64').toString('utf-8').slice(0, 50000) : ''
  const preDetection = detectBankStatement({
    fileName,
    mimeType: prepared.mimeType,
    text: [hint, decodedText].filter(Boolean).join('\n'),
  })
  if (preDetection.isBankStatement) {
    await logBankStatementBlockedAttempt({
      prisma,
      orgId,
      userId: auth?.userId,
      source: 'agent.extract_document.pre_detection',
      entityType: 'Document',
      reasons: preDetection.reasons,
      metadata: { fileName: fileName || null, target },
    })
    return c.json({
      ...bankStatementBlockedResponse(preDetection.reasons),
      kind: 'unknown',
      confidence: 1,
      warnings: ['Bank statement auto-create blocked.'],
      _meta: { target, file: { originalMimeType, mimeType: prepared.mimeType, converted: prepared.converted } },
    })
  }

  // Resolve AI key (BYOK or hosted credits)
  let resolved
  try {
    resolved = await resolveAiKey(orgId)
  } catch (e: any) {
    return c.json({ error: 'ai_disabled', message: e?.message || 'AI not available' }, 503)
  }
  if (!resolved.apiKey) {
    return c.json({ error: 'no_key', message: 'مفتاح AI غير متوفر' }, 503)
  }

  let userContent: any
  if (isPdf) {
    // OpenRouter requires `file` content type for PDFs (Anthropic native PDF support)
    userContent = [
      {
        type: 'text',
        text: `Extract structured data from this PDF. Target: ${target}.${hint ? `\n\nUser hint: ${hint}` : ''}\n\nDefault tax rate: ${defaultTaxRate}\nDefault currency: ${currency}\nFile name: ${fileName || 'unknown'}`,
      },
      {
        type: 'file',
        file: {
          filename: fileName || 'document.pdf',
          file_data: `data:application/pdf;base64,${prepared.fileBase64}`,
        },
      },
    ]
  } else if (isImage) {
    userContent = [
      {
        type: 'text',
        text: `Extract structured data from this image. Target: ${target}.${hint ? `\n\nUser hint: ${hint}` : ''}\n\nDefault tax rate: ${defaultTaxRate}\nDefault currency: ${currency}\nFile name: ${fileName || 'unknown'}`,
      },
      {
        type: 'image_url',
        image_url: { url: `data:${prepared.mimeType};base64,${prepared.fileBase64}` },
      },
    ]
  } else if (isText) {
    userContent = `Extract structured data from this text. Target: ${target}.${hint ? `\n\nUser hint: ${hint}` : ''}\n\nDefault tax rate: ${defaultTaxRate}\nDefault currency: ${currency}\n\n--- DOCUMENT START ---\n${decodedText}\n--- DOCUMENT END ---`
  } else {
    return c.json({ error: 'unsupported_type', message: `نوع الملف ${prepared.mimeType} غير مدعوم` }, 400)
  }

  // Try each model in order · fall back on transient/model errors
  let r: Response | null = null
  let lastDetail = ''
  let usedModel = VISION_MODELS[0]
  for (const model of VISION_MODELS) {
    try {
      const attempt = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resolved.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://entix.io',
          'X-Title': 'Entix Books · Document Extractor',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
          max_tokens: 6000,
          // Required for PDF parsing on OpenRouter
          plugins: isPdf ? [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }] : undefined,
        }),
      })
      if (attempt.ok) { r = attempt; usedModel = model; break }
      lastDetail = await attempt.text()
      console.warn(`[extract] model ${model} failed (${attempt.status}):`, lastDetail.slice(0, 200))
      if (isOpenRouterModelIssue(attempt.status, lastDetail)) continue // try next model
      r = attempt; break // auth/quota error · don't retry
    } catch (fetchErr) {
      lastDetail = String(fetchErr)
      continue
    }
  }
  try {
    if (!r || !r.ok) {
      const detail = lastDetail
      console.error('[extract-document] all Claude vision models failed', detail)

      // Fallback to PaddleOCR · returns raw text only · we wrap in a minimal envelope
      const paddleText = await paddleOcrFallback(prepared.fileBase64, prepared.mimeType)
      if (paddleText) {
        const fallbackDetection = detectBankStatement({ fileName, mimeType: prepared.mimeType, text: paddleText })
        if (fallbackDetection.isBankStatement) {
          await logBankStatementBlockedAttempt({
            prisma,
            orgId,
            userId: auth?.userId,
            source: 'agent.extract_document.paddle_detection',
            entityType: 'Document',
            reasons: fallbackDetection.reasons,
            metadata: { fileName: fileName || null, target },
          })
          return c.json({
            ...bankStatementBlockedResponse(fallbackDetection.reasons),
            kind: 'unknown',
            confidence: 0.5,
            warnings: ['Bank statement auto-create blocked.'],
            _meta: { model: 'paddle-ocr-fallback', source: 'fallback', target },
          })
        }
        await logAiUsage({
          orgId, userId: auth?.userId,
          endpoint: '/api/agent/extract-document', model: 'paddle-ocr-fallback',
          source: 'HOSTED', provider: 'paddle',
          promptTokens: 0, completionTokens: 0, costUsd: 0, successful: true,
        })
        return c.json({
          kind: 'unknown',
          confidence: 0.5,
          warnings: ['تم استخدام PaddleOCR fallback · النص الخام فقط · يجب المراجعة'],
          rawText: paddleText,
          lines: [],
          totals: { subtotal: 0, discount: 0, tax: 0, total: 0 },
          _meta: { model: 'paddle-ocr-fallback', source: 'fallback', target },
        })
      }
      let userMsg = 'فشل الاستخراج · جرّب ملفاً أوضح'
      try {
        const j = JSON.parse(detail)
        if (j?.error?.message) userMsg = j.error.message
        if (j?.error?.code === 'insufficient_quota' || /credit|quota|insufficient/i.test(j?.error?.message || '')) {
          userMsg = 'رصيد OpenRouter منخفض · شحن الرصيد أو استخدم مفتاحاً خاصاً (BYOK)'
        }
        if (/model not found|not_found|no endpoints found/i.test(j?.error?.message || '')) {
          userMsg = 'جميع النماذج غير متاحة حالياً'
        }
        if (/file|pdf|attach/i.test(j?.error?.message || '')) {
          userMsg = 'النموذج لا يدعم هذا الملف · جرّب JPG/PNG'
        }
      } catch {}
      return c.json({ error: 'extraction_failed', detail: userMsg, raw: detail.slice(0, 600), status: r?.status || 502 }, 502)
    }
    const json = await r.json() as any
    const content = json.choices?.[0]?.message?.content || '{}'
    const promptTokens = json.usage?.prompt_tokens || 0
    const completionTokens = json.usage?.completion_tokens || 0
    const cost = estimateCost(usedModel, promptTokens, completionTokens)

    let parsed: any
    try { parsed = JSON.parse(content) } catch (e) {
      return c.json({ error: 'invalid_json', raw: content }, 500)
    }

    // Smart kind override based on target
    if (target === 'invoice-lines' && parsed.kind === 'quote') {
      parsed.kind = 'invoice' // user wants invoice · convert
      parsed.warnings = [...(parsed.warnings || []), 'document detected as quote · presented as invoice'];
    }
    if (prepared.warnings.length) {
      parsed.warnings = [...(parsed.warnings || []), ...prepared.warnings]
    }
    const postDetection = detectBankStatement({
      fileName,
      mimeType: prepared.mimeType,
      text: decodedText,
      extracted: parsed,
    })
    if (postDetection.isBankStatement) {
      await logBankStatementBlockedAttempt({
        prisma,
        orgId,
        userId: auth?.userId,
        source: 'agent.extract_document.post_detection',
        entityType: 'Document',
        reasons: postDetection.reasons,
        metadata: { fileName: fileName || null, target },
      })
      return c.json({
        ...bankStatementBlockedResponse(postDetection.reasons),
        kind: 'unknown',
        confidence: parsed?.confidence ?? 1,
        warnings: [
          ...(Array.isArray(parsed?.warnings) ? parsed.warnings : []),
          'Bank statement auto-create blocked.',
        ],
        _meta: {
          model: usedModel,
          cost: cost.toFixed(6),
          source: resolved.source,
          target,
          file: {
            originalMimeType,
            mimeType: prepared.mimeType,
            converted: prepared.converted,
          },
        },
      })
    }

    await logAiUsage({
      orgId, userId: auth?.userId,
      endpoint: '/api/agent/extract-document', model: usedModel,
      source: resolved.source, provider: resolved.provider,
      promptTokens, completionTokens, costUsd: cost, successful: true,
    })

    return c.json({
      ...parsed,
      _meta: {
        model: usedModel,
        cost: cost.toFixed(6),
        source: resolved.source,
        target,
        file: {
          originalMimeType,
          mimeType: prepared.mimeType,
          converted: prepared.converted,
        },
      },
    })
  } catch (e: any) {
    console.error('[extract-document] error', e)
    return c.json({ error: 'exception', message: e?.message || 'unknown' }, 500)
  }
})

agentExtractRoutes.post('/normalize-image', zValidator('json', normalizeImageSchema), async (c) => {
  const { fileBase64, fileName, mimeType, trimEdges } = c.req.valid('json')
  const originalMimeType = inferMimeType(mimeType, fileName)
  if (!isImageMime(originalMimeType)) {
    return c.json({ error: 'unsupported_type', message: 'هذا المسار يدعم الصور فقط' }, 400)
  }

  const prepared = await normalizeImageForVision({ fileBase64, mimeType: originalMimeType, fileName, trimEdges })
  if (prepared.error) {
    return c.json({
      error: 'image_preprocess_failed',
      detail: prepared.error,
      message: prepared.error,
      originalMimeType,
    }, 415)
  }

  return c.json({
    ok: true,
    fileBase64: prepared.fileBase64,
    mimeType: prepared.mimeType,
    fileName: prepared.fileName || fileName || 'document.jpg',
    warnings: prepared.warnings,
    converted: prepared.converted,
    originalMimeType,
  })
})
