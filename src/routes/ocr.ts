/**
 * OCR · Claude Vision via OpenRouter
 *
 * Reads a receipt/invoice image or PDF · returns structured JSON
 * - vendor · date · amount · VAT · currency · line items
 *
 * Cost: ~$0.005 per scan with claude-haiku-4.5
 * Auto-fills the create-expense / create-invoice form on frontend.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

export const ocrRoutes = new Hono()

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || ''
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

const ocrSchema = z.object({
  fileBase64: z.string().min(100), // raw base64 (no data: prefix needed)
  mimeType: z.string().default('image/jpeg'),
  docType: z.enum(['receipt', 'invoice', 'bill']).default('receipt'),
})

const SYSTEM_PROMPT = `You extract structured data from receipts, invoices, and bills (Arabic and English).
Return ONLY valid JSON · no markdown · no extra text.

Schema:
{
  "vendor": string | null,            // seller / supplier name
  "vendorVat": string | null,          // seller VAT/EIN/CR if visible
  "buyer": string | null,              // buyer name if visible
  "documentNumber": string | null,     // invoice # / receipt #
  "issueDate": "YYYY-MM-DD" | null,
  "dueDate": "YYYY-MM-DD" | null,
  "currency": string | null,           // ISO code: SAR · USD · AED · EUR · GBP
  "subtotal": number | null,
  "taxRate": number | null,            // e.g. 0.15 for 15%
  "taxAmount": number | null,
  "discount": number | null,
  "total": number,                     // REQUIRED · grand total
  "paymentMethod": "CASH" | "BANK_TRANSFER" | "CARD" | "MADA" | "STC_PAY" | "CHECK" | "OTHER" | null,
  "category": string | null,           // best-guess: Rent · Utilities · Salaries · Office · Marketing · Travel · Other
  "lineItems": [
    {
      "description": string,
      "quantity": number,
      "unitPrice": number,
      "taxRate": number | null,
      "subtotal": number
    }
  ],
  "confidence": number,                // 0-1 · your confidence in the extraction
  "language": "ar" | "en" | "mixed",
  "warnings": string[]                 // anomalies · e.g. ["amount unclear", "date missing"]
}

Rules:
- Numbers: NO commas · NO currency symbols · just decimal numbers
- Dates: ISO YYYY-MM-DD only · convert from any source format
- Arabic text: keep in Arabic · don't translate
- Currency: infer from symbol/text · default to SAR if Saudi VAT pattern (300xxx) detected
- If unsure: return null + add warning
- DO NOT invent data · prefer null over guessing`

ocrRoutes.post('/extract', zValidator('json', ocrSchema), async (c) => {
  if (!OPENROUTER_KEY) {
    return c.json({ error: 'ocr_disabled', detail: 'OPENROUTER_API_KEY not set' }, 503)
  }

  const { fileBase64, mimeType, docType } = c.req.valid('json')

  const isPdf = mimeType === 'application/pdf'
  const userPrompt = `This is a ${docType}. Extract all visible fields per the schema.${isPdf ? ' Document is a PDF.' : ''}`

  const body = {
    model: 'anthropic/claude-haiku-4.5',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${fileBase64}` },
          },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 2000,
    temperature: 0,
  }

  try {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://entix.io',
        'X-Title': 'Entix Books',
      },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      const t = await r.text()
      return c.json({ error: 'openrouter_error', status: r.status, detail: t.slice(0, 500) }, 502)
    }
    const json: any = await r.json()
    const content = json?.choices?.[0]?.message?.content || ''
    let extracted: any
    try {
      extracted = JSON.parse(content)
    } catch {
      // strip ```json ... ``` if present
      const m = content.match(/\{[\s\S]*\}/)
      extracted = m ? JSON.parse(m[0]) : null
    }
    if (!extracted) return c.json({ error: 'parse_failed', raw: content }, 502)

    return c.json({
      extracted,
      cost: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
        totalCost: json.usage?.total_cost,
      },
      model: json.model,
    })
  } catch (e: any) {
    return c.json({ error: 'request_failed', detail: e?.message || 'unknown' }, 502)
  }
})

ocrRoutes.get('/health', (c) =>
  c.json({ enabled: !!OPENROUTER_KEY, provider: 'openrouter', model: 'claude-haiku-4.5' }),
)
