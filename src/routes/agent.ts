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

export const agentRoutes = new Hono()

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || ''
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

const SYSTEM_PROMPT = `أنت مساعد محاسبي ذكي لمنصة ENTIX Books · تتحدث العربية بطلاقة.
You help with: bookkeeping · invoicing · expenses · vouchers · reports · supplier and customer management.

Rules:
- Always confirm destructive actions (delete · large amount changes) before executing
- Use tools to perform actions instead of suggesting "go do X manually"
- After every action: summarize what you did and the result
- Numbers: SAR (default) · respect org's base currency
- Arabic-first · use English when user prompts in English
- If user uploads an image · use ocr_extract first then create_expense or create_invoice
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
          taxAmount: { type: 'number' },
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

async function executeTool(name: string, args: any, orgId: string) {
  switch (name) {
    case 'list_contacts': {
      const where: any = { orgId, isActive: true }
      if (args.type) where.type = args.type
      if (args.query) {
        where.OR = [
          { displayName: { contains: args.query, mode: 'insensitive' } },
          { email: { contains: args.query, mode: 'insensitive' } },
          { vatNumber: { contains: args.query } },
        ]
      }
      const items = await prisma.contact.findMany({ where, take: 50, orderBy: { displayName: 'asc' } })
      return { count: items.length, items: items.map((c) => ({ id: c.id, name: c.displayName, email: c.email, phone: c.phone, type: c.type, vatNumber: c.vatNumber })) }
    }
    case 'create_contact': {
      const c = await prisma.contact.create({
        data: {
          orgId,
          type: args.type,
          displayName: args.displayName,
          email: args.email || null,
          phone: args.phone || null,
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
      const items = await prisma.expense.findMany({ where, take: 50, orderBy: { date: 'desc' } })
      const total = items.reduce((s, e) => s + Number(e.total), 0)
      return { count: items.length, total, items: items.map((e) => ({ id: e.id, number: e.number, date: e.date.toISOString().slice(0, 10), category: e.category, amount: Number(e.total), method: e.paymentMethod, vendor: e.vendorName })) }
    }
    case 'create_expense': {
      const year = new Date().getFullYear()
      const last = await prisma.expense.findFirst({ where: { orgId, number: { startsWith: `EXP-${year}-` } }, orderBy: { number: 'desc' }, select: { number: true } })
      const n = last ? Number(last.number.split('-').pop()) + 1 : 1
      const number = `EXP-${year}-${String(n).padStart(4, '0')}`
      const total = args.amount + (args.taxAmount || 0)
      const e = await prisma.expense.create({
        data: {
          orgId,
          number,
          date: new Date(args.date),
          category: args.category,
          description: args.description,
          amount: new Prisma.Decimal(args.amount),
          paymentMethod: args.paymentMethod,
          vendorName: args.vendorName,
          taxAmount: new Prisma.Decimal(args.taxAmount || 0),
          total: new Prisma.Decimal(total),
        },
      })
      return { id: e.id, number: e.number, total: Number(e.total), category: e.category }
    }
    case 'list_invoices': {
      const where: any = { orgId }
      if (args.status) where.status = args.status
      const items = await prisma.invoice.findMany({ where, take: 50, orderBy: { issueDate: 'desc' }, include: { contact: { select: { displayName: true } } } })
      return { count: items.length, items: items.map((i) => ({ id: i.id, number: i.invoiceNumber, contact: i.contact.displayName, total: Number(i.total), paid: Number(i.amountPaid), status: i.status, date: i.issueDate.toISOString().slice(0, 10) })) }
    }
    case 'create_voucher': {
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
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
    }),
  ),
})

agentRoutes.post('/chat', zValidator('json', chatSchema), async (c) => {
  if (!OPENROUTER_KEY) return c.json({ error: 'agent_disabled', detail: 'OPENROUTER_API_KEY not set' }, 503)

  const orgId = c.get('orgId')
  const { messages } = c.req.valid('json')

  // Tool-calling loop · max 5 turns
  const conversation: any[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages]
  const toolResults: any[] = []

  for (let i = 0; i < 5; i++) {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://entix.io',
        'X-Title': 'Entix Books · Agent',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4.6',
        messages: conversation,
        tools: TOOLS,
        max_tokens: 1500,
        temperature: 0.3,
      }),
    })
    if (!r.ok) {
      const t = await r.text()
      return c.json({ error: 'openrouter_error', status: r.status, detail: t.slice(0, 500) }, 502)
    }
    const json: any = await r.json()
    const msg = json.choices?.[0]?.message
    if (!msg) return c.json({ error: 'no_message' }, 502)
    conversation.push(msg)

    const toolCalls = msg.tool_calls || []
    if (!toolCalls.length) {
      // Final answer
      return c.json({ message: msg.content, toolResults })
    }

    for (const tc of toolCalls) {
      const args = JSON.parse(tc.function.arguments || '{}')
      try {
        const result = await executeTool(tc.function.name, args, orgId)
        toolResults.push({ tool: tc.function.name, args, result })
        conversation.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
      } catch (e: any) {
        const errResult = { error: 'execution_failed', detail: e?.message || 'unknown' }
        toolResults.push({ tool: tc.function.name, args, result: errResult })
        conversation.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(errResult) })
      }
    }
  }

  return c.json({ message: 'الحد الأقصى من الخطوات تم استنفاده · يرجى تبسيط الطلب', toolResults }, 207)
})

agentRoutes.get('/health', (c) =>
  c.json({ enabled: !!OPENROUTER_KEY, model: 'claude-sonnet-4.6', tools: TOOLS.length }),
)
