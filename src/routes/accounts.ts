import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../db.js'
import { INDUSTRY_TEMPLATES, buildCoaForIndustry, BASE_COA, type AccountSeed } from '../lib/coa-templates.js'

export const accountsRoutes = new Hono()

const accountSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(255),
  nameAr: z.string().max(500).optional().nullable(),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
  subtype: z.string().optional().nullable(),
  parentId: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  cashFlowType: z.enum(['OPERATING', 'INVESTING', 'FINANCING', 'NON_CASH']).optional().nullable(),
  allowPosting: z.boolean().optional(),
  allowPayment: z.boolean().optional(),
  allowExpenseClaim: z.boolean().optional(),
})

// GET /accounts — full chart of accounts (no pagination · usually < 200 rows)
// Auto-seeds BASE_COA on first read if the org has no accounts (so new orgs aren't empty).
// Also returns balance per account = SUM(debit) - SUM(credit) for asset/expense ·
// SUM(credit) - SUM(debit) for liability/equity/revenue (so balances are positive in normal accounting).
accountsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  let accounts = await prisma.account.findMany({
    where: { orgId, isActive: true },
    orderBy: { code: 'asc' },
  })

  if (accounts.length === 0) {
    // Seed BASE_COA (no industry add-on) so org has a working chart immediately
    const seeds: AccountSeed[] = BASE_COA
    const created: Record<string, string> = {}
    for (const seed of seeds) {
      try {
        const a = await prisma.account.create({
          data: {
            orgId,
            code: seed.code,
            name: seed.name,
            nameAr: seed.nameAr,
            type: seed.type as any,
            subtype: seed.subtype || null,
            description: seed.description || null,
          },
        })
        created[seed.code] = a.id
      } catch { /* ignore unique-violation race */ }
    }
    // Wire up parents (best-effort)
    for (const seed of seeds) {
      if (!seed.parentCode) continue
      const childId = created[seed.code]
      const parentId = created[seed.parentCode]
      if (childId && parentId) {
        try { await prisma.account.update({ where: { id: childId }, data: { parentId } }) } catch {}
      }
    }
    accounts = await prisma.account.findMany({
      where: { orgId, isActive: true },
      orderBy: { code: 'asc' },
    })
  }

  // Compute balance per account · sums journal lines
  const lines = await prisma.journalLine.groupBy({
    by: ['accountId'],
    where: { account: { orgId } },
    _sum: { debit: true, credit: true },
  })
  const balanceById = new Map<string, number>()
  for (const l of lines) {
    const debit = Number(l._sum.debit || 0)
    const credit = Number(l._sum.credit || 0)
    balanceById.set(l.accountId, debit - credit) // raw signed balance
  }
  const itemsWithBalance = accounts.map(a => {
    const raw = balanceById.get(a.id) || 0
    // For LIABILITY/EQUITY/REVENUE, normal balance is credit · so flip sign
    const signed = (a.type === 'LIABILITY' || a.type === 'EQUITY' || a.type === 'REVENUE') ? -raw : raw
    return { ...a, balance: signed }
  })

  return c.json({ items: itemsWithBalance, total: itemsWithBalance.length })
})

// GET /accounts/:id/transactions · all journal lines hitting this account
accountsRoutes.get('/:id/transactions', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const a = await prisma.account.findFirst({ where: { id, orgId } })
  if (!a) return c.json({ error: 'not_found' }, 404)

  const lines = await prisma.journalLine.findMany({
    where: { accountId: id, journal: { orgId } },
    orderBy: [{ journal: { date: 'desc' } }, { id: 'desc' }],
    include: { journal: { select: { entryNumber: true, date: true, description: true, source: true, reference: true } } },
    take: 500,
  })

  // Running balance (oldest → newest, then reversed for display)
  const sortedAsc = [...lines].sort((x, y) => x.journal.date.getTime() - y.journal.date.getTime())
  let running = 0
  const flip = a.type === 'LIABILITY' || a.type === 'EQUITY' || a.type === 'REVENUE'
  const withBalance = sortedAsc.map(l => {
    const debit = Number(l.debit)
    const credit = Number(l.credit)
    running += flip ? (credit - debit) : (debit - credit)
    return {
      id: l.id,
      journalNumber: l.journal.entryNumber,
      date: l.journal.date,
      description: l.journal.description,
      lineDescription: l.description,
      source: l.journal.source,
      reference: l.journal.reference,
      debit, credit,
      runningBalance: running,
    }
  }).reverse() // newest first

  return c.json({
    account: { id: a.id, code: a.code, name: a.name, nameAr: a.nameAr, type: a.type },
    transactions: withBalance,
    total: withBalance.length,
    finalBalance: running,
  })
})

// POST /accounts/translate · AI suggests Arabic ↔ English + best account type
// Input: { input: "جهاز" } or { input: "Sales of laptops" }
// Output: { name: "Office Equipment", nameAr: "أجهزة مكتبية", type: "ASSET", suggestedCode: "13100", reasoning: "..." }
const translateSchema = z.object({
  input: z.string().min(1).max(200),
  hint: z.string().optional(),
})
accountsRoutes.post('/translate', zValidator('json', translateSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const { input, hint } = c.req.valid('json')

  // Get current accounts to suggest a non-conflicting code
  const existing = await prisma.account.findMany({ where: { orgId, isActive: true }, select: { code: true } })
  const existingCodes = new Set(existing.map(e => e.code))

  // Resolve AI key
  let resolved
  try {
    const { resolveAiKey } = await import('../lib/ai-billing.js')
    resolved = await resolveAiKey(orgId)
  } catch {
    return c.json({ error: 'ai_disabled', message: 'الذكاء غير مفعّل · اكمل يدوياً' }, 503)
  }
  if (!resolved.apiKey) return c.json({ error: 'no_key' }, 503)

  const SYSTEM = `You are an accounting assistant. Given a user's free-text input (Arabic OR English),
suggest a clean accounting account name in BOTH languages and pick the right type.

Output strict JSON only · no markdown · no commentary:
{
  "name": "<English name · standard accounting terminology>",
  "nameAr": "<Arabic name · accounting terminology>",
  "type": "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE",
  "category": "<sub-category in Arabic, e.g. 'أصول ثابتة' / 'مصروفات تشغيلية'>",
  "reasoning": "<one short sentence in Arabic explaining the choice>"
}

Rules:
- "جهاز / معدّات / سيارة / مبنى" → ASSET (Fixed Assets)
- "نقد / صندوق / بنك / إيداع" → ASSET
- "ذمم مدينة / ذمم على عملاء" → ASSET
- "مخزون / بضاعة" → ASSET (Inventory)
- "قرض / دين علينا" → LIABILITY
- "رأس مال / حصص شركاء" → EQUITY
- "مبيعات / إيراد / دخل / بيع X" → REVENUE
- "إيجار / رواتب / كهرباء / إنترنت / مصروف X / شراء خدمة" → EXPENSE
- Names should follow standard accounting (e.g. "Office Equipment" not "computer thing")
- Use accounting Arabic (e.g. "أصول ثابتة" not "اشياء مادية")`

  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolved.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://entix.io',
        'X-Title': 'Entix Books · Account Translator',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Input: "${input}"${hint ? `\nContext: ${hint}` : ''}` },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 400,
      }),
    })
    if (!r.ok) {
      const detail = await r.text()
      return c.json({ error: 'translate_failed', detail: detail.slice(0, 200) }, 502)
    }
    const j = await r.json() as any
    let parsed: any
    try { parsed = JSON.parse(j.choices?.[0]?.message?.content || '{}') } catch { parsed = {} }

    // Suggest code based on type
    const TYPE_PREFIX: Record<string, string> = { ASSET: '1', LIABILITY: '2', EQUITY: '3', REVENUE: '4', EXPENSE: '5' }
    const prefix = TYPE_PREFIX[parsed.type] || '1'
    let suggested = `${prefix}${(Math.floor(Math.random() * 9000) + 1000)}`
    // Find next available code starting from prefix0000+1000 step 100
    for (let n = 1000; n < 9999; n += 100) {
      const candidate = `${prefix}${n}`
      if (!existingCodes.has(candidate)) { suggested = candidate; break }
    }

    return c.json({
      name: parsed.name || input,
      nameAr: parsed.nameAr || input,
      type: parsed.type || 'EXPENSE',
      category: parsed.category || null,
      reasoning: parsed.reasoning || null,
      suggestedCode: suggested,
    })
  } catch (e: any) {
    return c.json({ error: 'exception', message: e?.message || 'unknown' }, 500)
  }
})

accountsRoutes.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const a = await prisma.account.findFirst({ where: { id: c.req.param('id'), orgId } })
  if (!a) return c.json({ error: 'not found' }, 404)
  return c.json(a)
})

accountsRoutes.post('/', zValidator('json', accountSchema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')
  try {
    const a = await prisma.account.create({ data: { ...data, orgId } })
    return c.json(a, 201)
  } catch (e: any) {
    if (e.code === 'P2002') return c.json({ error: 'code_already_exists' }, 409)
    throw e
  }
})

accountsRoutes.patch('/:id', zValidator('json', accountSchema.partial()), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.account.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  const data = c.req.valid('json')
  const a = await prisma.account.update({ where: { id }, data })
  return c.json(a)
})

accountsRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.account.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  // Block delete if has journal entries · soft delete only
  const hasJournals = await prisma.journalLine.findFirst({ where: { accountId: id } })
  if (hasJournals) {
    return c.json({ error: 'has_journals', message: 'الحساب مستخدم في قيود · يمكن إخفاؤه فقط (تعطيل)' }, 400)
  }
  await prisma.account.update({ where: { id }, data: { isActive: false } })
  return c.body(null, 204)
})

// ─── Industry Templates ──────────────────────────────────────────────────────

/** GET /accounts/templates · list available industry templates */
accountsRoutes.get('/templates/list', async (c) => {
  return c.json({
    templates: INDUSTRY_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      nameAr: t.nameAr,
      description: t.description,
      icon: t.icon,
      accountCount: t.extras.length,
    })),
    baseCount: BASE_COA.length,
  })
})

/** POST /accounts/templates/apply · install BASE + industry-specific accounts */
const applyTplSchema = z.object({
  industryId: z.string().nullable().optional(),
  /** If true · skip codes that already exist · default true */
  skipExisting: z.boolean().default(true),
})
accountsRoutes.post('/templates/apply', zValidator('json', applyTplSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const { industryId, skipExisting } = c.req.valid('json')

  const existing = await prisma.account.findMany({ where: { orgId }, select: { code: true } })
  const existingCodes = new Set(existing.map((e) => e.code))

  const seeds: AccountSeed[] = buildCoaForIndustry(industryId || null)

  // First pass · create all accounts without parent
  const created: Record<string, string> = {} // code → id
  const skipped: string[] = []
  for (const seed of seeds) {
    if (skipExisting && existingCodes.has(seed.code)) {
      skipped.push(seed.code)
      continue
    }
    try {
      const a = await prisma.account.create({
        data: {
          orgId,
          code: seed.code,
          name: seed.name,
          nameAr: seed.nameAr,
          type: seed.type as any,
          subtype: seed.subtype || null,
          description: seed.description || null,
        },
      })
      created[seed.code] = a.id
    } catch (e: any) {
      if (e.code !== 'P2002') throw e
      skipped.push(seed.code)
    }
  }

  // Second pass · link parents
  let linked = 0
  for (const seed of seeds) {
    if (!seed.parentCode) continue
    const childId = created[seed.code]
    if (!childId) continue
    let parentId = created[seed.parentCode]
    if (!parentId) {
      // Parent might have already existed (skipped) · find by code
      const p = await prisma.account.findFirst({
        where: { orgId, code: seed.parentCode },
        select: { id: true },
      })
      if (p) parentId = p.id
    }
    if (parentId) {
      await prisma.account.update({ where: { id: childId }, data: { parentId } })
      linked++
    }
  }

  return c.json({
    ok: true,
    industryId: industryId || null,
    created: Object.keys(created).length,
    skipped: skipped.length,
    linked,
    message: `تم إنشاء ${Object.keys(created).length} حساب · ${linked} رابط أبوي · ${skipped.length} مكرر`,
  })
})

// ─── Bulk Import ─────────────────────────────────────────────────────────────
// POST /accounts/import · accepts an array of rows · auto-detects type from
// code prefix if missing · links parents by parentCode · returns summary.
const importRowSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(255),
  nameAr: z.string().max(500).optional().nullable(),
  type: z.union([
    z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
    z.literal(''),
    z.null(),
  ]).optional().transform(v => v && v !== '' ? v : undefined),
  parentCode: z.string().max(40).optional().nullable(),
  description: z.string().max(1000).optional().nullable(),
})
const importSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(5000),
  skipExisting: z.boolean().default(true),
})

function inferTypeFromCode(code: string): 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE' | null {
  const first = code.charAt(0)
  if (first === '1') return 'ASSET'
  if (first === '2') return 'LIABILITY'
  if (first === '3') return 'EQUITY'
  if (first === '4') return 'REVENUE'
  if (first === '5' || first === '6' || first === '7') return 'EXPENSE'
  return null
}

accountsRoutes.post('/import', zValidator('json', importSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const { rows, skipExisting } = c.req.valid('json')

  const existing = await prisma.account.findMany({ where: { orgId }, select: { id: true, code: true } })
  const existingByCode = new Map(existing.map(e => [e.code, e.id]))

  // First pass · create
  const created: Record<string, string> = {}
  const skipped: string[] = []
  const errors: Array<{ code: string; reason: string }> = []
  for (const r of rows) {
    if (skipExisting && existingByCode.has(r.code)) {
      skipped.push(r.code)
      continue
    }
    const type = r.type || inferTypeFromCode(r.code)
    if (!type) {
      errors.push({ code: r.code, reason: 'cannot_infer_type' })
      continue
    }
    try {
      const a = await prisma.account.create({
        data: {
          orgId,
          code: r.code,
          name: r.name,
          nameAr: r.nameAr || null,
          type,
          description: r.description || null,
        },
      })
      created[r.code] = a.id
    } catch (e: any) {
      if (e.code === 'P2002') skipped.push(r.code)
      else errors.push({ code: r.code, reason: e.message })
    }
  }

  // Second pass · link parents
  let linked = 0
  for (const r of rows) {
    if (!r.parentCode) continue
    const childId = created[r.code] || existingByCode.get(r.code)
    if (!childId) continue
    const parentId = created[r.parentCode] || existingByCode.get(r.parentCode)
    if (parentId) {
      try {
        await prisma.account.update({ where: { id: childId }, data: { parentId } })
        linked++
      } catch {}
    }
  }

  return c.json({
    ok: true,
    created: Object.keys(created).length,
    skipped: skipped.length,
    linked,
    errors,
    message: `استورد ${Object.keys(created).length} · ${linked} رابط أبوي · تخطّى ${skipped.length} مكرر · ${errors.length} خطأ`,
  })
})
