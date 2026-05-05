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

export const agentExtractRoutes = new Hono()

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const VISION_MODEL = 'anthropic/claude-haiku-4.5'

const extractSchema = z.object({
  /** base64-encoded file contents (for non-image files use plain text) */
  fileBase64: z.string().min(1).max(20_000_000), // ~15MB
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
      "notes": null
    }
  ],
  "totals": {
    "subtotal": 0.00,
    "discount": 0.00,
    "tax": 0.00,
    "total": 0.00
  },
  "paymentTerms": "...",
  "notes": "...",
  "warnings": ["..."]
}

Rules:
- Normalize Arabic-Indic digits (٠-٩) to Western (0-9).
- If you can't read the document at all, set kind="unknown" and confidence=0.
- For quotes/invoices: every line must have a description.
- VAT rate in KSA is 15% by default. If the document shows a different rate, use that.
- If "taxInclusive" cannot be determined, default to false (exclusive · price + tax).
- Dates in DD/MM/YYYY → convert to YYYY-MM-DD.
- Currency · default "SAR" if not stated.
- Round all numbers to 2 decimals.
- DO NOT invent data · leave fields null/empty if not present in the source.`

agentExtractRoutes.post('/extract-document', zValidator('json', extractSchema), async (c) => {
  const auth = c.get('auth') as any
  const orgId = c.get('orgId') as string
  const { fileBase64, fileName, mimeType, target, hint, defaultTaxRate, currency } = c.req.valid('json')

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

  // Build the user message
  // For images/PDFs: vision payload · for text: plain text
  const isImage = mimeType.startsWith('image/')
  const isPdf = mimeType === 'application/pdf'
  const isText = mimeType.startsWith('text/') || mimeType.includes('csv')

  let userContent: any
  if (isImage || isPdf) {
    userContent = [
      {
        type: 'text',
        text: `Extract structured data from this ${isPdf ? 'PDF' : 'image'}. Target: ${target}.${hint ? `\n\nUser hint: ${hint}` : ''}\n\nDefault tax rate: ${defaultTaxRate}\nDefault currency: ${currency}\nFile name: ${fileName || 'unknown'}`,
      },
      {
        type: 'image_url',
        image_url: { url: `data:${mimeType};base64,${fileBase64}` },
      },
    ]
  } else if (isText) {
    const text = Buffer.from(fileBase64, 'base64').toString('utf-8')
    userContent = `Extract structured data from this text. Target: ${target}.${hint ? `\n\nUser hint: ${hint}` : ''}\n\nDefault tax rate: ${defaultTaxRate}\nDefault currency: ${currency}\n\n--- DOCUMENT START ---\n${text.slice(0, 50000)}\n--- DOCUMENT END ---`
  } else {
    return c.json({ error: 'unsupported_type', message: `نوع الملف ${mimeType} غير مدعوم` }, 400)
  }

  try {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolved.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://entix.io',
        'X-Title': 'Entix Books · Document Extractor',
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 6000,
      }),
    })
    if (!r.ok) {
      const detail = await r.text()
      return c.json({ error: 'extraction_failed', detail, status: r.status }, 502)
    }
    const json = await r.json()
    const content = json.choices?.[0]?.message?.content || '{}'
    const promptTokens = json.usage?.prompt_tokens || 0
    const completionTokens = json.usage?.completion_tokens || 0
    const cost = estimateCost(VISION_MODEL, promptTokens, completionTokens)

    let parsed: any
    try { parsed = JSON.parse(content) } catch (e) {
      return c.json({ error: 'invalid_json', raw: content }, 500)
    }

    // Smart kind override based on target
    if (target === 'invoice-lines' && parsed.kind === 'quote') {
      parsed.kind = 'invoice' // user wants invoice · convert
      parsed.warnings = [...(parsed.warnings || []), 'document detected as quote · presented as invoice'];
    }

    await logAiUsage({
      orgId, userId: auth?.userId,
      endpoint: '/api/agent/extract-document', model: VISION_MODEL,
      source: resolved.source, provider: resolved.provider,
      promptTokens, completionTokens, costUsd: cost, successful: true,
    })

    return c.json({
      ...parsed,
      _meta: {
        model: VISION_MODEL,
        cost: cost.toFixed(6),
        source: resolved.source,
        target,
      },
    })
  } catch (e: any) {
    console.error('[extract-document] error', e)
    return c.json({ error: 'exception', message: e?.message || 'unknown' }, 500)
  }
})
