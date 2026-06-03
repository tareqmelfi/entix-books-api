/**
 * Entix Agent · Claude with tool calling via OpenRouter
 *
 * Chat with the user · execute accounting actions:
 *  - List/create/delete: contacts · invoices · expenses · vouchers · accounts
 *  - Generate reports (revenue · expenses · cash position · top customers)
 *  - OCR a receipt and create the corresponding record
 *
 * Cost: ~$0.01 per turn with claude-sonnet-4.6 (better tool use)
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { resolveAiKey, logAiUsage, estimateCost, QuotaExceededError, DisabledByAdminError } from '../lib/ai-billing.js'
import { isOpenRouterModelIssue, openRouterAgentModels } from '../lib/openrouter-models.js'
import { nextContactCode } from '../lib/numbering.js'
import {
  bankStatementBlockedResponse,
  detectBankStatement,
  logBankStatementBlockedAttempt,
} from '../lib/bank-statement-guard.js'

export const agentRoutes = new Hono()

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || ''
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

// Fallback chain · if first model is unavailable, try the next one
// Order: best-quality first · cheaper/older as fallback
const MODEL_CHAIN = openRouterAgentModels(process.env.OPENROUTER_AGENT_MODEL)
const CONVERSATION_HISTORY_LIMIT = 40
const N8N_AGENT_WEBHOOK_URL = process.env.ENTIX_N8N_AGENT_WEBHOOK_URL || ''
const N8N_WEBHOOK_SECRET = process.env.ENTIX_N8N_WEBHOOK_SECRET || ''

type AgentChatMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

function buildConversationTitle(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return 'محادثة جديدة'
  return compact.length > 44 ? `${compact.slice(0, 44)}...` : compact
}

function serializeConversation(row: any) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messageCount: typeof row._count?.messages === 'number' ? row._count.messages : undefined,
  }
}

function serializeMessage(row: any) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    toolResults: row.toolResults,
    metadata: row.metadata,
    createdAt: row.createdAt,
  }
}

function getN8nHost() {
  if (!N8N_AGENT_WEBHOOK_URL) return null
  try {
    return new URL(N8N_AGENT_WEBHOOK_URL).host
  } catch {
    return 'invalid-url'
  }
}

async function ensureConversation(orgId: string, userId: string, conversationId: string | undefined, seedText: string) {
  if (conversationId) {
    const existing = await prisma.aiConversation.findFirst({
      where: { id: conversationId, orgId, userId, status: 'ACTIVE' },
    })
    if (existing) return existing
  }

  return prisma.aiConversation.create({
    data: {
      orgId,
      userId,
      title: buildConversationTitle(seedText),
      lastMessageAt: new Date(),
    },
  })
}

async function loadConversationMessages(conversationId: string): Promise<AgentChatMessage[]> {
  const rows = await prisma.aiMessage.findMany({
    where: { conversationId, role: { in: ['user', 'assistant'] } },
    orderBy: { createdAt: 'desc' },
    take: CONVERSATION_HISTORY_LIMIT,
  })

  return rows
    .reverse()
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
}

async function persistAssistantMessage(args: {
  conversationId: string
  orgId: string
  content: string
  toolResults?: any[]
  metadata?: Prisma.InputJsonValue
}) {
  const [message] = await prisma.$transaction([
    prisma.aiMessage.create({
      data: {
        conversationId: args.conversationId,
        orgId: args.orgId,
        role: 'assistant',
        content: args.content,
        toolResults: args.toolResults?.length ? (args.toolResults as Prisma.InputJsonValue) : undefined,
        metadata: args.metadata,
      },
    }),
    prisma.aiConversation.update({
      where: { id: args.conversationId },
      data: { lastMessageAt: new Date() },
    }),
  ])
  return message
}

async function callN8nAgentIfConfigured(args: {
  orgId: string
  userId: string
  conversationId: string
  message: string
  history: AgentChatMessage[]
}) {
  if (!N8N_AGENT_WEBHOOK_URL) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(N8N_AGENT_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(N8N_WEBHOOK_SECRET ? { 'X-Entix-Webhook-Secret': N8N_WEBHOOK_SECRET } : {}),
      },
      body: JSON.stringify({
        event: 'entix.agent.chat',
        source: 'api.entix.io',
        orgId: args.orgId,
        userId: args.userId,
        conversationId: args.conversationId,
        message: args.message,
        history: args.history,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.warn('[agent:n8n] webhook failed', res.status, detail.slice(0, 200))
      return null
    }

    const data = await res.json().catch(() => null) as any
    const message = data?.message || data?.reply || data?.assistantMessage || data?.output
    if (!message || typeof message !== 'string') return null
    return {
      message,
      toolResults: Array.isArray(data?.toolResults) ? data.toolResults : [],
      raw: data,
    }
  } catch (e: any) {
    console.warn('[agent:n8n] webhook unavailable', e?.message || e)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function callOpenRouterWithFallback(payload: any, apiKey: string): Promise<{ ok: true; json: any; model: string } | { ok: false; status: number; detail: string; triedModels: string[] }> {
  const tried: string[] = []
  for (const model of MODEL_CHAIN) {
    tried.push(model)
    try {
      const r = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://entix.io',
          'X-Title': 'Entix Books · Agent',
        },
        body: JSON.stringify({ ...payload, model }),
      })
      if (r.ok) {
        return { ok: true, json: await r.json(), model }
      }
      const txt = await r.text()
      // 4xx for unknown model · try next model. 5xx · retry once then give up
      const isModelIssue = isOpenRouterModelIssue(r.status, txt)
      if (!isModelIssue && r.status >= 500) {
        // brief retry on the same model (transient upstream)
        await new Promise((res) => setTimeout(res, 500))
        const r2 = await fetch(OPENROUTER_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://entix.io',
            'X-Title': 'Entix Books · Agent',
          },
          body: JSON.stringify({ ...payload, model }),
        })
        if (r2.ok) return { ok: true, json: await r2.json(), model }
        // fall through to try next model
      }
      console.warn(`[agent] model ${model} failed · status=${r.status}`, txt.slice(0, 200))
    } catch (e: any) {
      console.warn(`[agent] model ${model} threw`, e?.message)
    }
  }
  return { ok: false, status: 502, detail: 'كل نماذج الذكاء الاصطناعي غير متاحة حالياً · حاول بعد دقيقة', triedModels: tried }
}

const SYSTEM_PROMPT = `أنت مساعد محاسبي ذكي لمنصة ENTIX Books · تتحدث العربية بطلاقة.
You help with: bookkeeping · invoicing · expenses · vouchers · reports · supplier and customer management.

Rules:
- Always confirm destructive actions (delete · large amount changes) before executing
- Use tools to perform actions instead of suggesting "go do X manually"
- After every action: summarize what you did and the result
- Numbers: SAR (default) · respect org's base currency
- Arabic-first · use English when user prompts in English
- If user uploads an image · use OCR first, then choose the accounting route: create_expense for paid receipts/cash-card spend, create_bill for supplier purchase invoices/payables, and never treat contracts or statements as expenses.
- Difference: purchase bill/invoice = supplier payable document, possibly unpaid. Expense = paid cash/card/bank spend. Explain this when the user asks.
- When recording an expense or bill from OCR, preserve documentNumber, supplierTaxId/vendorVat, lineItems, paymentSplits, and duplicate warnings. Do not reduce a tax invoice to only amount.
- A bank statement is not an expense. Never create expenses, vouchers, journal entries, or GL postings from bank statements. Route them to bank statement review/staging.
- Screenshots of Entix dashboards/lists are context for analysis, not source financial documents to auto-register.
- Be concise · 2-4 sentences usually enough · use tables for lists
- If a tool fails · explain why and suggest alternative`

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_contacts',
      description: 'List customers and suppliers · returns up to 50',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['CUSTOMER', 'SUPPLIER', 'BOTH'], description: 'Filter by type' },
          query: { type: 'string', description: 'Search by name/email/VAT' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_contact',
      description: 'Create a new customer or supplier',
      parameters: {
        type: 'object',
        required: ['displayName', 'type'],
        properties: {
          displayName: { type: 'string' },
          type: { type: 'string', enum: ['CUSTOMER', 'SUPPLIER', 'BOTH'] },
          email: { type: 'string' },
          phone: { type: 'string' },
          vatNumber: { type: 'string' },
          city: { type: 'string' },
          country: { type: 'string', description: 'ISO 3166 code · default SA' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_expenses',
      description: 'List expenses with optional date range and category',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'YYYY-MM-DD' },
          to: { type: 'string', description: 'YYYY-MM-DD' },
          category: { type: 'string' },
          vendorName: { type: 'string' },
          documentNumber: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_expense',
      description: 'Record a cash expense',
      parameters: {
        type: 'object',
        required: ['date', 'category', 'amount', 'paymentMethod'],
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD' },
          category: { type: 'string' },
          amount: { type: 'number' },
          paymentMethod: { type: 'string', enum: ['CASH', 'BANK_TRANSFER', 'CARD', 'MADA', 'STC_PAY', 'CHECK', 'OTHER'] },
          description: { type: 'string' },
          vendorName: { type: 'string' },
          supplierTaxId: { type: 'string' },
          documentNumber: { type: 'string' },
          reference: { type: 'string' },
          taxAmount: { type: 'number' },
          currency: { type: 'string' },
          lineItems: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                quantity: { type: 'number' },
                unitPrice: { type: 'number' },
                taxRate: { type: 'number' },
                subtotal: { type: 'number' },
              },
            },
          },
          paymentSplits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                method: { type: 'string', enum: ['CASH', 'BANK_TRANSFER', 'CARD', 'MADA', 'STC_PAY', 'CHECK', 'OTHER'] },
                amount: { type: 'number' },
                reference: { type: 'string' },
                cardLast4: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_invoices',
      description: 'List sales invoices · filter by status or contact',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_bill',
      description: 'Create a supplier purchase bill/invoice draft for accounts payable. Use this for unpaid supplier invoices, not paid receipts.',
      parameters: {
        type: 'object',
        required: ['supplierName', 'issueDate', 'amount'],
        properties: {
          supplierName: { type: 'string' },
          supplierTaxId: { type: 'string' },
          billNumber: { type: 'string' },
          documentNumber: { type: 'string' },
          issueDate: { type: 'string', description: 'YYYY-MM-DD' },
          dueDate: { type: 'string', description: 'YYYY-MM-DD' },
          amount: { type: 'number' },
          taxAmount: { type: 'number' },
          currency: { type: 'string' },
          notes: { type: 'string' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                quantity: { type: 'number' },
                unitPrice: { type: 'number' },
              },
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_voucher',
      description: 'Create a receipt voucher (cash IN from customer) or payment voucher (cash OUT to supplier)',
      parameters: {
        type: 'object',
        required: ['type', 'date', 'amount', 'paymentMethod'],
        properties: {
          type: { type: 'string', enum: ['RECEIPT', 'PAYMENT'] },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          amount: { type: 'number' },
          paymentMethod: { type: 'string', enum: ['CASH', 'BANK_TRANSFER', 'CARD', 'MADA', 'STC_PAY', 'CHECK', 'OTHER'] },
          contactId: { type: 'string' },
          invoiceId: { type: 'string' },
          billId: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_summary',
      description: 'Financial summary for current org · revenue · expenses · cash position · top items',
      parameters: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['this_month', 'last_month', 'this_year', 'all'] },
        },
      },
    },
  },
]

async function executeTool(name: string, args: any, orgId: string, userId?: string) {
  switch (name) {
    case 'list_contacts': {
      const where: any = { orgId, isActive: true }
      if (args.type) where.type = args.type
      if (args.query) {
        where.OR = [
          { displayName: { contains: args.query, mode: 'insensitive' } },
          { email: { contains: args.query, mode: 'insensitive' } },
          { taxId: { contains: args.query } },
          { vatNumber: { contains: args.query } },
        ]
      }
      const items = await prisma.contact.findMany({ where, take: 50, orderBy: { displayName: 'asc' } })
      return { count: items.length, items: items.map((c) => ({ id: c.id, name: c.displayName, email: c.email, phone: c.phone, type: c.type, taxId: c.taxId, vatNumber: c.vatNumber })) }
    }
    case 'create_contact': {
      const c = await prisma.contact.create({
        data: {
          orgId,
          type: args.type,
          displayName: args.displayName,
          email: args.email || null,
          phone: args.phone || null,
          taxId: args.vatNumber || null,
          vatNumber: args.vatNumber || null,
          city: args.city || null,
          country: args.country || 'SA',
        },
      })
      return { id: c.id, name: c.displayName, type: c.type }
    }
    case 'list_expenses': {
      const where: any = { orgId }
      if (args.from || args.to) {
        where.date = {}
        if (args.from) where.date.gte = new Date(args.from)
        if (args.to) where.date.lte = new Date(args.to)
      }
      if (args.category) where.category = args.category
      if (args.vendorName) where.vendorName = { contains: args.vendorName, mode: 'insensitive' }
      if (args.documentNumber) where.documentNumber = { contains: args.documentNumber, mode: 'insensitive' }
      const items = await prisma.expense.findMany({ where, take: 50, orderBy: { date: 'desc' } })
      const total = items.reduce((s, e) => s + Number(e.total), 0)
      return { count: items.length, total, items: items.map((e) => ({ id: e.id, number: e.number, documentNumber: e.documentNumber, date: e.date.toISOString().slice(0, 10), category: e.category, amount: Number(e.total), taxAmount: Number(e.taxAmount), method: e.paymentMethod, vendor: e.vendorName, duplicateOfId: e.duplicateOfId })) }
    }
    case 'create_expense': {
      const statementDetection = detectBankStatement({
        extracted: args,
        text: [
          args.category,
          args.description,
          args.vendorName,
          args.documentNumber,
          args.reference,
          ...(Array.isArray(args.lineItems) ? args.lineItems.map((line: any) => line?.description || '') : []),
        ].filter(Boolean).join('\n'),
      })
      if (statementDetection.isBankStatement) {
        await logBankStatementBlockedAttempt({
          prisma,
          orgId,
          userId,
          source: 'agent.create_expense',
          entityType: 'Expense',
          reasons: statementDetection.reasons,
          metadata: {
            documentNumber: args.documentNumber || null,
            reference: args.reference || null,
          },
        })
        return bankStatementBlockedResponse(statementDetection.reasons)
      }
      const year = new Date().getFullYear()
      const last = await prisma.expense.findFirst({ where: { orgId, number: { startsWith: `EXP-${year}-` } }, orderBy: { number: 'desc' }, select: { number: true } })
      const n = last ? Number(last.number.split('-').pop()) + 1 : 1
      const number = `EXP-${year}-${String(n).padStart(4, '0')}`
      const total = args.amount + (args.taxAmount || 0)
      const vendorName = typeof args.vendorName === 'string' ? args.vendorName.trim() : ''
      const supplierTaxId = typeof args.supplierTaxId === 'string' ? args.supplierTaxId.replace(/[^\dA-Za-z]/g, '') : ''
      let contactId: string | null = null
      if (vendorName || supplierTaxId) {
        const existing = await prisma.contact.findFirst({
          where: {
            orgId,
            isActive: true,
            OR: [
              ...(supplierTaxId ? [{ taxId: { equals: supplierTaxId } }, { vatNumber: { equals: supplierTaxId } }] : []),
              ...(vendorName ? [{ displayName: { equals: vendorName, mode: 'insensitive' as const } }] : []),
            ],
          },
          select: { id: true, isSupplier: true, isCustomer: true },
        })
        if (existing) {
          contactId = existing.id
          if (!existing.isSupplier) {
            await prisma.contact.update({ where: { id: existing.id }, data: { isSupplier: true, type: existing.isCustomer ? 'BOTH' : 'SUPPLIER' } })
          }
        } else if (vendorName) {
          let customCode: string | null = null
          try { customCode = await nextContactCode(orgId) } catch { customCode = null }
          const created = await prisma.contact.create({
            data: {
              orgId,
              customCode,
              type: 'SUPPLIER',
              isCustomer: false,
              isSupplier: true,
              entityKind: 'COMPANY',
              displayName: vendorName,
              legalName: vendorName,
              taxId: supplierTaxId || null,
              vatNumber: supplierTaxId || null,
              country: 'SA',
              defaultCurrency: args.currency || 'SAR',
              notes: 'Auto-created by AI assistant expense entry.',
            },
            select: { id: true },
          })
          contactId = created.id
        }
      }
      const duplicateWhere: any = { orgId, documentNumber: args.documentNumber }
      const duplicateOr: any[] = [
        ...(contactId ? [{ contactId }] : []),
        ...(vendorName ? [{ vendorName: { equals: vendorName, mode: 'insensitive' as const } }] : []),
      ]
      if (duplicateOr.length) duplicateWhere.OR = duplicateOr
      const duplicate = args.documentNumber
        ? await prisma.expense.findFirst({
            where: duplicateWhere,
            select: { id: true, number: true, total: true, date: true, vendorName: true },
          })
        : null
      const e = await prisma.expense.create({
        data: {
          orgId,
          contactId,
          number,
          date: new Date(args.date),
          category: args.category,
          description: args.description,
          amount: new Prisma.Decimal(args.amount),
          subtotal: new Prisma.Decimal(args.amount),
          paymentMethod: args.paymentMethod,
          vendorName: vendorName || null,
          documentNumber: args.documentNumber || null,
          reference: args.reference || args.documentNumber || null,
          taxAmount: new Prisma.Decimal(args.taxAmount || 0),
          total: new Prisma.Decimal(total),
          currency: args.currency || 'SAR',
          lineItems: Array.isArray(args.lineItems) ? args.lineItems as Prisma.InputJsonValue : Prisma.JsonNull,
          paymentSplits: Array.isArray(args.paymentSplits) ? args.paymentSplits as Prisma.InputJsonValue : Prisma.JsonNull,
          duplicateOfId: duplicate?.id || null,
          duplicateReason: duplicate ? 'same_document_number' : null,
        },
      })
      return { id: e.id, number: e.number, documentNumber: e.documentNumber, total: Number(e.total), category: e.category, duplicateExpense: duplicate }
    }
    case 'create_bill': {
      const supplierName = typeof args.supplierName === 'string' ? args.supplierName.trim() : ''
      if (!supplierName) return { error: 'supplierName_required' }
      const supplierTaxId = typeof args.supplierTaxId === 'string' ? args.supplierTaxId.replace(/[^\dA-Za-z]/g, '') : ''
      const existing = await prisma.contact.findFirst({
        where: {
          orgId,
          isActive: true,
          OR: [
            ...(supplierTaxId ? [{ taxId: { equals: supplierTaxId } }, { vatNumber: { equals: supplierTaxId } }] : []),
            { displayName: { equals: supplierName, mode: 'insensitive' as const } },
          ],
        },
        select: { id: true, isSupplier: true, isCustomer: true },
      })
      let contactId = existing?.id || null
      if (existing && !existing.isSupplier) {
        await prisma.contact.update({ where: { id: existing.id }, data: { isSupplier: true, type: existing.isCustomer ? 'BOTH' : 'SUPPLIER' } })
      }
      if (!contactId) {
        let customCode: string | null = null
        try { customCode = await nextContactCode(orgId) } catch { customCode = null }
        const supplier = await prisma.contact.create({
          data: {
            orgId,
            customCode,
            type: 'SUPPLIER',
            isCustomer: false,
            isSupplier: true,
            entityKind: 'COMPANY',
            displayName: supplierName,
            legalName: supplierName,
            taxId: supplierTaxId || null,
            vatNumber: supplierTaxId || null,
            country: 'SA',
            defaultCurrency: args.currency || 'SAR',
            notes: 'Auto-created by AI assistant purchase bill entry.',
          },
          select: { id: true },
        })
        contactId = supplier.id
      }

      const year = new Date().getFullYear()
      const prefix = `BILL-${year}-`
      const last = await prisma.bill.findFirst({ where: { orgId, billNumber: { startsWith: prefix } }, orderBy: { billNumber: 'desc' }, select: { billNumber: true } })
      const nextNumber = `${prefix}${String((last ? Number(last.billNumber.split('-').pop() || '0') : 0) + 1).padStart(4, '0')}`
      const billNumber = args.billNumber || args.documentNumber || nextNumber
      const amount = Number(args.amount || 0)
      const taxAmount = Number(args.taxAmount || 0)
      const total = Math.max(amount + taxAmount, 0)
      const rawLines = Array.isArray(args.lines) && args.lines.length > 0
        ? args.lines
        : [{ description: args.notes || args.documentNumber || 'Purchase bill', quantity: 1, unitPrice: total || amount }]
      let subtotal = 0
      const lines = rawLines
        .map((line: any) => {
          const quantity = Number(line.quantity || 1)
          const unitPrice = Number(line.unitPrice || 0)
          const description = String(line.description || '').trim()
          if (!description || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) return null
          subtotal += quantity * unitPrice
          return {
            productId: null,
            description,
            quantity: new Prisma.Decimal(quantity),
            unitPrice: new Prisma.Decimal(unitPrice),
            taxRateId: null,
            subtotal: new Prisma.Decimal(quantity * unitPrice),
          }
        })
        .filter(Boolean) as any[]
      if (lines.length === 0) return { error: 'bill_lines_required' }
      const issueDate = args.issueDate ? new Date(args.issueDate) : new Date()
      const dueDate = args.dueDate ? new Date(args.dueDate) : new Date(issueDate.getTime() + 30 * 86400000)
      const bill = await prisma.bill.create({
        data: {
          orgId,
          contactId,
          billNumber,
          status: 'DRAFT',
          issueDate,
          dueDate,
          currency: args.currency || 'SAR',
          exchangeRate: new Prisma.Decimal(1),
          subtotal: new Prisma.Decimal(subtotal),
          taxTotal: new Prisma.Decimal(Math.max(total - subtotal, 0)),
          total: new Prisma.Decimal(total || subtotal),
          notes: args.notes || 'Created by AI assistant as purchase bill draft.',
          lines: { create: lines },
        },
        include: { contact: { select: { displayName: true } } },
      })
      return { id: bill.id, billNumber: bill.billNumber, number: bill.billNumber, supplier: bill.contact.displayName, total: Number(bill.total), status: bill.status }
    }
    case 'list_invoices': {
      const where: any = { orgId }
      if (args.status) where.status = args.status
      const items = await prisma.invoice.findMany({ where, take: 50, orderBy: { issueDate: 'desc' }, include: { contact: { select: { displayName: true } } } })
      return { count: items.length, items: items.map((i) => ({ id: i.id, number: i.invoiceNumber, contact: i.contact.displayName, total: Number(i.total), paid: Number(i.amountPaid), status: i.status, date: i.issueDate.toISOString().slice(0, 10) })) }
    }
    case 'create_voucher': {
      const statementDetection = detectBankStatement({
        extracted: args,
        text: [args.notes, args.reference].filter(Boolean).join('\n'),
      })
      if (statementDetection.isBankStatement) {
        await logBankStatementBlockedAttempt({
          prisma,
          orgId,
          userId,
          source: 'agent.create_voucher',
          entityType: 'Voucher',
          reasons: statementDetection.reasons,
          metadata: {
            type: args.type || null,
            reference: args.reference || null,
          },
        })
        return bankStatementBlockedResponse(statementDetection.reasons)
      }
      const year = new Date().getFullYear()
      const prefix = args.type === 'RECEIPT' ? `R-${year}-` : `P-${year}-`
      const last = await prisma.voucher.findFirst({ where: { orgId, type: args.type, number: { startsWith: prefix } }, orderBy: { number: 'desc' }, select: { number: true } })
      const n = last ? Number(last.number.split('-').pop()) + 1 : 1
      const number = `${prefix}${String(n).padStart(4, '0')}`
      const v = await prisma.voucher.create({
        data: {
          orgId,
          type: args.type,
          number,
          date: new Date(args.date),
          amount: new Prisma.Decimal(args.amount),
          paymentMethod: args.paymentMethod,
          contactId: args.contactId || null,
          invoiceId: args.invoiceId || null,
          billId: args.billId || null,
          notes: args.notes || null,
        },
      })
      return { id: v.id, number: v.number, type: v.type, amount: Number(v.amount) }
    }
    case 'get_summary': {
      const period = args.period || 'this_month'
      const now = new Date()
      let from: Date
      if (period === 'this_month') from = new Date(now.getFullYear(), now.getMonth(), 1)
      else if (period === 'last_month') from = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      else if (period === 'this_year') from = new Date(now.getFullYear(), 0, 1)
      else from = new Date(2000, 0, 1)

      const [invSum, expSum, recSum, paySum, contactCount, invoiceCount] = await Promise.all([
        prisma.invoice.aggregate({ where: { orgId, issueDate: { gte: from } }, _sum: { total: true, amountPaid: true } }),
        prisma.expense.aggregate({ where: { orgId, date: { gte: from } }, _sum: { total: true } }),
        prisma.voucher.aggregate({ where: { orgId, type: 'RECEIPT', date: { gte: from } }, _sum: { amount: true } }),
        prisma.voucher.aggregate({ where: { orgId, type: 'PAYMENT', date: { gte: from } }, _sum: { amount: true } }),
        prisma.contact.count({ where: { orgId, isActive: true } }),
        prisma.invoice.count({ where: { orgId } }),
      ])

      return {
        period,
        from: from.toISOString().slice(0, 10),
        revenue: { invoiced: Number(invSum._sum.total || 0), collected: Number(invSum._sum.amountPaid || 0) },
        expenses: { total: Number(expSum._sum.total || 0) },
        cashFlow: { receipts: Number(recSum._sum.amount || 0), payments: Number(paySum._sum.amount || 0), net: Number(recSum._sum.amount || 0) - Number(paySum._sum.amount || 0) },
        counts: { contacts: contactCount, invoices: invoiceCount },
      }
    }
    default:
      return { error: 'unknown_tool', name }
  }
}

const chatSchema = z.object({
  conversationId: z.string().optional(),
  message: z.string().trim().min(1).max(20000).optional(),
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
    }),
  ).optional(),
}).refine((data) => data.message || (Array.isArray(data.messages) && data.messages.length > 0), {
  message: 'message أو messages مطلوب',
})

const conversationListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(25),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional().default('ACTIVE'),
})

const createConversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(50000),
  toolResults: z.any().optional(),
  metadata: z.any().optional(),
})

agentRoutes.get('/conversations', zValidator('query', conversationListQuery), async (c) => {
  const orgId = c.get('orgId') as string
  const auth = c.get('auth') as { userId: string }
  const { limit, status } = c.req.valid('query')

  const items = await prisma.aiConversation.findMany({
    where: { orgId, userId: auth.userId, status },
    orderBy: { lastMessageAt: 'desc' },
    take: limit,
    include: { _count: { select: { messages: true } } },
  })

  return c.json({ items: items.map(serializeConversation) })
})

agentRoutes.post('/conversations', async (c) => {
  const orgId = c.get('orgId') as string
  const auth = c.get('auth') as { userId: string }
  const body = await c.req.json().catch(() => ({})) as { title?: string }

  const row = await prisma.aiConversation.create({
    data: {
      orgId,
      userId: auth.userId,
      title: buildConversationTitle(body.title || 'محادثة جديدة'),
      lastMessageAt: new Date(),
    },
    include: { _count: { select: { messages: true } } },
  })

  return c.json({ conversation: serializeConversation(row) }, 201)
})

agentRoutes.get('/conversations/:id/messages', async (c) => {
  const orgId = c.get('orgId') as string
  const auth = c.get('auth') as { userId: string }
  const id = c.req.param('id')

  const conversation = await prisma.aiConversation.findFirst({
    where: { id, orgId, userId: auth.userId },
    include: { _count: { select: { messages: true } } },
  })
  if (!conversation) return c.json({ error: 'conversation_not_found' }, 404)

  const messages = await prisma.aiMessage.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: 'asc' },
  })

  return c.json({
    conversation: serializeConversation(conversation),
    messages: messages.map(serializeMessage),
  })
})

agentRoutes.post('/conversations/:id/messages', zValidator('json', createConversationMessageSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const auth = c.get('auth') as { userId: string }
  const id = c.req.param('id')
  const body = c.req.valid('json')

  const existing = await prisma.aiConversation.findFirst({
    where: { id, orgId, userId: auth.userId, status: 'ACTIVE' },
  })
  if (!existing) return c.json({ error: 'conversation_not_found' }, 404)

  const [message, conversation] = await prisma.$transaction([
    prisma.aiMessage.create({
      data: {
        conversationId: id,
        orgId,
        userId: body.role === 'user' ? auth.userId : null,
        role: body.role,
        content: body.content,
        toolResults: body.toolResults ? (body.toolResults as Prisma.InputJsonValue) : undefined,
        metadata: body.metadata ? (body.metadata as Prisma.InputJsonValue) : undefined,
      },
    }),
    prisma.aiConversation.update({
      where: { id },
      data: {
        lastMessageAt: new Date(),
        ...(existing.title === 'محادثة جديدة' && body.role === 'user' ? { title: buildConversationTitle(body.content) } : {}),
      },
      include: { _count: { select: { messages: true } } },
    }),
  ])

  return c.json({
    message: serializeMessage(message),
    conversation: serializeConversation(conversation),
  }, 201)
})

agentRoutes.patch('/conversations/:id', async (c) => {
  const orgId = c.get('orgId') as string
  const auth = c.get('auth') as { userId: string }
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({})) as { title?: string; status?: 'ACTIVE' | 'ARCHIVED' }

  const existing = await prisma.aiConversation.findFirst({ where: { id, orgId, userId: auth.userId } })
  if (!existing) return c.json({ error: 'conversation_not_found' }, 404)

  const row = await prisma.aiConversation.update({
    where: { id },
    data: {
      ...(body.title ? { title: buildConversationTitle(body.title) } : {}),
      ...(body.status ? { status: body.status } : {}),
    },
    include: { _count: { select: { messages: true } } },
  })

  return c.json({ conversation: serializeConversation(row) })
})

agentRoutes.post('/chat', zValidator('json', chatSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const auth = c.get('auth') as { userId: string }
  const { conversationId, message, messages = [] } = c.req.valid('json')

  let activeConversation: any | null = null
  let conversationMessages: AgentChatMessage[] = messages

  if (message) {
    activeConversation = await ensureConversation(orgId, auth.userId, conversationId, message)
    await prisma.$transaction([
      prisma.aiMessage.create({
        data: {
          conversationId: activeConversation.id,
          orgId,
          userId: auth.userId,
          role: 'user',
          content: message,
        },
      }),
      prisma.aiConversation.update({
        where: { id: activeConversation.id },
        data: { lastMessageAt: new Date() },
      }),
    ])
    conversationMessages = await loadConversationMessages(activeConversation.id)

    const n8nResult = await callN8nAgentIfConfigured({
      orgId,
      userId: auth.userId,
      conversationId: activeConversation.id,
      message,
      history: conversationMessages,
    })
    if (n8nResult) {
      await persistAssistantMessage({
        conversationId: activeConversation.id,
        orgId,
        content: n8nResult.message,
        toolResults: n8nResult.toolResults,
        metadata: { source: 'n8n', raw: n8nResult.raw } as Prisma.InputJsonValue,
      })
      return c.json({
        message: n8nResult.message,
        toolResults: n8nResult.toolResults,
        conversationId: activeConversation.id,
        conversation: serializeConversation(activeConversation),
        source: 'n8n',
      })
    }
  }

  // Resolve API key based on org's billing config (BYOK or HOSTED)
  let resolved: Awaited<ReturnType<typeof resolveAiKey>>
  try {
    resolved = await resolveAiKey(orgId)
  } catch (e: any) {
    if (e instanceof QuotaExceededError) {
      return c.json({
        error: 'quota_exceeded',
        detail: e.upgradeHint,
        monthlyAllocation: e.monthlyAllocation,
        spentThisPeriod: e.spentThisPeriod,
        creditBalance: e.creditBalance,
      }, 402)
    }
    if (e instanceof DisabledByAdminError) {
      return c.json({ error: 'ai_disabled', detail: e.reason || 'تم تعطيل الذكاء الاصطناعي لهذه الشركة من قبل الإدارة' }, 403)
    }
    return c.json({ error: 'agent_disabled', detail: e.message || 'AI key not available' }, 503)
  }

  // Tool-calling loop · max 5 turns
  const conversation: any[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...conversationMessages]
  const toolResults: any[] = []

  let activeModel = MODEL_CHAIN[0]
  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  let totalCost = 0

  for (let i = 0; i < 5; i++) {
    const result = await callOpenRouterWithFallback({
      messages: conversation,
      tools: TOOLS,
      max_tokens: 1500,
      temperature: 0.3,
    }, resolved.apiKey)
    if (!result.ok) {
      // Log failure too
      await logAiUsage({
        orgId, userId: auth.userId,
        endpoint: '/api/agent/chat',
        model: MODEL_CHAIN[0],
        source: resolved.source,
        provider: resolved.provider,
        costUsd: 0,
        successful: false,
        errorCode: 'openrouter_error',
      })
      return c.json(
        { error: 'openrouter_error', detail: result.detail, triedModels: result.triedModels },
        502,
      )
    }
    activeModel = result.model

    // Accumulate usage stats
    const usage = result.json.usage || {}
    totalPromptTokens += usage.prompt_tokens || 0
    totalCompletionTokens += usage.completion_tokens || 0
    const turnCost = typeof usage.total_cost === 'number' && usage.total_cost > 0
      ? usage.total_cost
      : estimateCost(activeModel, usage.prompt_tokens || 0, usage.completion_tokens || 0)
    totalCost += turnCost

    const msg = result.json.choices?.[0]?.message
    if (!msg) {
      await logAiUsage({
        orgId, userId: auth.userId,
        endpoint: '/api/agent/chat', model: activeModel,
        source: resolved.source, provider: resolved.provider,
        promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens,
        costUsd: totalCost, successful: false, errorCode: 'no_message',
      })
      return c.json({ error: 'no_message' }, 502)
    }
    conversation.push(msg)

    const toolCalls = msg.tool_calls || []
    if (!toolCalls.length) {
      // Final answer · log usage and return
      await logAiUsage({
        orgId, userId: auth.userId,
        endpoint: '/api/agent/chat', model: activeModel,
        source: resolved.source, provider: resolved.provider,
        promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens,
        costUsd: totalCost, successful: true,
      })
      if (activeConversation) {
        await persistAssistantMessage({
          conversationId: activeConversation.id,
          orgId,
          content: msg.content || '',
          toolResults,
          metadata: { source: resolved.source, model: activeModel } as Prisma.InputJsonValue,
        })
      }
      return c.json({
        message: msg.content,
        toolResults,
        model: activeModel,
        source: resolved.source,
        conversationId: activeConversation?.id,
        conversation: activeConversation ? serializeConversation(activeConversation) : undefined,
      })
    }

    for (const tc of toolCalls) {
      const args = JSON.parse(tc.function.arguments || '{}')
      try {
        const result = await executeTool(tc.function.name, args, orgId, auth.userId)
        toolResults.push({ tool: tc.function.name, args, result })
        conversation.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
      } catch (e: any) {
        const errResult = { error: 'execution_failed', detail: e?.message || 'unknown' }
        toolResults.push({ tool: tc.function.name, args, result: errResult })
        conversation.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(errResult) })
      }
    }
  }

  // Loop exhausted · log + return partial
  await logAiUsage({
    orgId, userId: auth.userId,
    endpoint: '/api/agent/chat', model: activeModel,
    source: resolved.source, provider: resolved.provider,
    promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens,
    costUsd: totalCost, successful: true, errorCode: 'max_turns_reached',
  })
  const exhaustedMessage = 'الحد الأقصى من الخطوات تم استنفاده · يرجى تبسيط الطلب'
  if (activeConversation) {
    await persistAssistantMessage({
      conversationId: activeConversation.id,
      orgId,
      content: exhaustedMessage,
      toolResults,
      metadata: { source: resolved.source, model: activeModel, status: 'max_turns_reached' } as Prisma.InputJsonValue,
    })
  }
  return c.json({
    message: exhaustedMessage,
    toolResults,
    source: resolved.source,
    conversationId: activeConversation?.id,
    conversation: activeConversation ? serializeConversation(activeConversation) : undefined,
  }, 207)
})

agentRoutes.get('/health', (c) =>
  c.json({
    enabled: !!OPENROUTER_KEY,
    primaryModel: MODEL_CHAIN[0],
    fallbackChain: MODEL_CHAIN,
    tools: TOOLS.length,
    n8n: {
      configured: !!N8N_AGENT_WEBHOOK_URL,
      host: getN8nHost(),
    },
  }),
)

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/agent/parse-paste · UX-49 · smart paste parser
//
// Body: { text: string, hint?: "invoice" | "expense" | "bill" | "voucher" | "auto" }
// Response: {
//   kind: "invoice-lines" | "contact-list" | "expense-list" | "unknown",
//   confidence: number,
//   rows: any[],
//   warnings: string[]
// }
//
// Lightweight model · uses Haiku via OpenRouter for cheap structured extraction.
// Falls back to a deterministic CSV/TSV parser when the model is unavailable.
// ─────────────────────────────────────────────────────────────────────────────

const parsePasteSchema = z.object({
  text: z.string().min(1).max(50000),
  hint: z.enum(['invoice', 'expense', 'bill', 'voucher', 'contact', 'auto']).optional().default('auto'),
})

/** Deterministic CSV/TSV fallback · zero-cost parser that always succeeds for tabular blobs. */
function fallbackParse(text: string): { kind: string; rows: any[]; confidence: number; warnings: string[] } {
  const rows = text.split(/\r?\n/).filter((r) => r.trim())
  if (rows.length === 0) return { kind: 'unknown', rows: [], confidence: 0, warnings: ['empty'] }

  // Detect delimiter
  const useTab = rows[0].includes('\t')
  const delim = useTab ? '\t' : ','

  // Heuristic header sniff: first row is header if it has non-numeric cells
  const first = rows[0].split(delim).map((s) => s.trim())
  const looksLikeHeader = first.every((c) => isNaN(Number(c)) || /^[a-zA-Z؀-ۿ]/.test(c))
  const headers = looksLikeHeader
    ? first.map((h) => h.toLowerCase())
    : ['description', 'quantity', 'unitPrice'].slice(0, first.length)
  const dataRows = looksLikeHeader ? rows.slice(1) : rows

  const parsed = dataRows.map((row) => {
    const cols = row.split(delim).map((c) => c.trim())
    const obj: any = {}
    headers.forEach((h, i) => { obj[h] = cols[i] || '' })
    return obj
  })

  return {
    kind: 'invoice-lines',
    rows: parsed,
    confidence: looksLikeHeader ? 0.6 : 0.4,
    warnings: looksLikeHeader ? [] : ['no-header-detected · using default columns'],
  }
}

agentRoutes.post('/parse-paste', zValidator('json', parsePasteSchema), async (c) => {
  const auth = c.get('auth') as any
  const orgId = c.get('orgId') as string
  const { text, hint } = c.req.valid('json')

  // No API key → fall back deterministically
  let resolved
  try {
    resolved = await resolveAiKey(orgId)
  } catch (e: any) {
    if (e instanceof DisabledByAdminError || e instanceof QuotaExceededError) {
      return c.json({ ...fallbackParse(text), source: 'fallback', reason: 'ai_disabled' })
    }
    throw e
  }
  if (!resolved.apiKey) {
    return c.json({ ...fallbackParse(text), source: 'fallback', reason: 'no_key' })
  }

  // Cheap Haiku call · structured JSON output
  const systemPrompt = `You are a paste parser for an Arabic accounting app (Entix Books).
Input may be: Excel rows · CSV · WhatsApp text · receipt OCR · email body · free-form invoice items.
Output strict JSON with this schema:
{
  "kind": "invoice-lines" | "contact-list" | "expense-list" | "voucher-list" | "unknown",
  "confidence": 0.0-1.0,
  "rows": [
    // for invoice-lines: {description, quantity, unitPrice, taxRate?, notes?}
    // for contact-list: {displayName, email?, phone?, taxId?, country?}
    // for expense-list: {category, date?, amount, paymentMethod?, vendorName?, description?}
  ],
  "warnings": ["..."]
}
Hint from user: ${hint}
Rules:
- Normalize Arabic-Indic digits (٠-٩) to Western (0-9).
- Quantity defaults to 1 if missing.
- Numbers may use Arabic comma (،) or period · normalize to dot.
- If text is gibberish or empty, return kind="unknown" with confidence=0.
- Return ONLY the JSON · no markdown, no commentary.`

  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  let totalCost = 0
  const model = 'anthropic/claude-haiku-4.5'

  try {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolved.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://entix.io',
        'X-Title': 'Entix Books · Paste Parser',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text.slice(0, 20000) }, // safety cap
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 4000,
      }),
    })
    if (!r.ok) {
      console.warn('[parse-paste] AI failed · falling back', r.status)
      return c.json({ ...fallbackParse(text), source: 'fallback', reason: `ai_${r.status}` })
    }
    const json: any = await r.json()
    const content = json.choices?.[0]?.message?.content || '{}'
    totalPromptTokens = json.usage?.prompt_tokens || 0
    totalCompletionTokens = json.usage?.completion_tokens || 0
    totalCost = estimateCost(model, totalPromptTokens, totalCompletionTokens)

    let parsed: any
    try { parsed = JSON.parse(content) } catch {
      return c.json({ ...fallbackParse(text), source: 'fallback', reason: 'invalid_json' })
    }

    await logAiUsage({
      orgId, userId: auth.userId,
      endpoint: '/api/agent/parse-paste', model,
      source: resolved.source, provider: resolved.provider,
      promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens,
      costUsd: totalCost, successful: true,
    })

    return c.json({ ...parsed, source: 'ai', model })
  } catch (e: any) {
    console.error('[parse-paste] error', e)
    return c.json({ ...fallbackParse(text), source: 'fallback', reason: 'exception' })
  }
})
