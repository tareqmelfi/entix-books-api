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

export const ocrRoutes = new Hono()

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || ''
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

const VISION_MODEL_CHAIN = [
  process.env.OPENROUTER_OCR_MODEL || 'anthropic/claude-haiku-4.5',
  'anthropic/claude-3.5-haiku',
  'anthropic/claude-3.5-sonnet',
  'openai/gpt-4o-mini',
]

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
- "tags" should help classification (e.g. ["restaurant","mada","Q1-2026","food"]) · short kebab-case-ar/en
- "summary": one Arabic sentence max 120 chars`

async function callOpenRouter(payload: any): Promise<{ ok: true; json: any; model: string } | { ok: false; status: number; detail: string; tried: string[] }> {
  const tried: string[] = []
  for (const model of VISION_MODEL_CHAIN) {
    tried.push(model)
    try {
      const r = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://entix.io',
          'X-Title': 'Entix Books · OCR',
        },
        body: JSON.stringify({ ...payload, model }),
      })
      if (r.ok) return { ok: true, json: await r.json(), model }
      const txt = await r.text()
      console.warn(`[ocr] model ${model} status=${r.status}`, txt.slice(0, 200))
      const isModelIssue = r.status === 400 || r.status === 404 || /model.*not.*found|invalid.*model|no longer available/i.test(txt)
      if (!isModelIssue) {
        // 5xx · brief retry on same model
        if (r.status >= 500) {
          await new Promise((res) => setTimeout(res, 400))
          const r2 = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${OPENROUTER_KEY}`,
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
  const mime = file.mimeType || 'application/octet-stream'
  const isVisual = VISION_MIMES.has(mime) || mime.startsWith('image/')
  const intro = `File: ${file.fileName || '(unnamed)'} · type: ${mime}${hint ? ` · hint: ${hint}` : ''}`

  if (isVisual) {
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

const singleSchema = z.object({
  fileBase64: z.string().min(20),
  mimeType: z.string().default('application/octet-stream'),
  fileName: z.string().optional(),
  rawText: z.string().optional(),
  docType: z.string().optional(), // hint
})

ocrRoutes.post('/extract', zValidator('json', singleSchema), async (c) => {
  if (!OPENROUTER_KEY) {
    return c.json({ error: 'ocr_disabled', detail: 'OPENROUTER_API_KEY not set' }, 503)
  }
  const f = c.req.valid('json')
  const result = await callOpenRouter({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserContent(f, f.docType) },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 2000,
    temperature: 0,
  })
  if (!result.ok) {
    return c.json({ error: 'openrouter_error', detail: result.detail, triedModels: result.tried }, 502)
  }
  const content = result.json?.choices?.[0]?.message?.content || ''
  let extracted: any
  try { extracted = JSON.parse(content) } catch {
    const m = content.match(/\{[\s\S]*\}/)
    extracted = m ? JSON.parse(m[0]) : null
  }
  if (!extracted) return c.json({ error: 'parse_failed', raw: content.slice(0, 500) }, 502)
  return c.json({
    extracted,
    model: result.model,
    cost: {
      promptTokens: result.json.usage?.prompt_tokens,
      completionTokens: result.json.usage?.completion_tokens,
      totalCost: result.json.usage?.total_cost,
    },
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
  if (!OPENROUTER_KEY) {
    return c.json({ error: 'ocr_disabled', detail: 'OPENROUTER_API_KEY not set' }, 503)
  }
  const { files, hint } = c.req.valid('json')

  // Process in parallel · cap concurrency at 5 to avoid rate limits
  const results: Array<{ fileName?: string; mimeType: string; ok: boolean; extracted?: any; error?: string; model?: string }> = []
  const queue = [...files]
  const workers = Array.from({ length: Math.min(5, files.length) }, async () => {
    while (queue.length > 0) {
      const f = queue.shift()
      if (!f) break
      const r = await callOpenRouter({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserContent(f, hint) },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 2000,
        temperature: 0,
      })
      if (!r.ok) {
        results.push({ fileName: f.fileName, mimeType: f.mimeType, ok: false, error: r.detail })
        continue
      }
      const content = r.json?.choices?.[0]?.message?.content || ''
      let extracted: any
      try { extracted = JSON.parse(content) } catch {
        const m = content.match(/\{[\s\S]*\}/)
        extracted = m ? JSON.parse(m[0]) : null
      }
      if (!extracted) {
        results.push({ fileName: f.fileName, mimeType: f.mimeType, ok: false, error: 'parse_failed' })
        continue
      }
      results.push({ fileName: f.fileName, mimeType: f.mimeType, ok: true, extracted, model: r.model })
    }
  })
  await Promise.all(workers)

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
