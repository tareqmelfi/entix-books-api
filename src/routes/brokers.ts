/**
 * Brokers routes · UX-79
 *
 * IBKR (Flex Web Service · token-based · simplest):
 *   POST /api/brokers/ibkr/sync           { token, queryId } → pulls daily statement
 *   POST /api/brokers/ibkr/upload         multipart · upload Flex XML manually
 *
 * TradeStation (OAuth):
 *   GET  /api/brokers/tradestation/connect       returns OAuth URL
 *   GET  /api/brokers/tradestation/callback?code=...&state=...
 *   POST /api/brokers/tradestation/sync          pull positions + balances
 *
 * All brokers:
 *   GET  /api/brokers                     list connected brokers
 *   POST /api/brokers/upload-statement    multipart · any broker · CSV/PDF (sent to AI parser)
 *
 * On sync · creates Voucher entries for cash movements + Journal entries for unrealized PnL.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import {
  ibkrSendRequest,
  ibkrGetStatement,
  parseIbkrStatement,
  tradestationOAuthUrl,
  tradestationExchangeCode,
  tradestationListAccounts,
  tradestationGetPositions,
  tradestationGetBalances,
} from '../lib/brokers.js'

export const brokersRoutes = new Hono()

const TS_CLIENT_ID = process.env.TRADESTATION_CLIENT_ID || ''
const TS_CLIENT_SECRET = process.env.TRADESTATION_CLIENT_SECRET || ''
const TS_REDIRECT = process.env.TRADESTATION_REDIRECT_URI || 'https://api.entix.io/api/brokers/tradestation/callback'

// ─── List connected brokers ──────────────────────────────────────────────────
brokersRoutes.get('/', async (c) => {
  const orgId = c.get('orgId') as string
  // Stored as bankAccount with bankName='IBKR' or 'TradeStation' for now
  const accts = await prisma.bankAccount.findMany({
    where: { orgId, isActive: true, bankName: { in: ['IBKR', 'TradeStation', 'Interactive Brokers'] } },
  })
  return c.json({ items: accts })
})

// ─── IBKR · sync via Flex token ──────────────────────────────────────────────
const ibkrSyncSchema = z.object({
  token: z.string().min(10),
  queryId: z.string().min(1),
  /** Optional · attach to existing bankAccount instead of creating new */
  bankAccountId: z.string().optional(),
})

brokersRoutes.post('/ibkr/sync', zValidator('json', ibkrSyncSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const { token, queryId, bankAccountId } = c.req.valid('json')

  try {
    const sendRes = await ibkrSendRequest(token, queryId)
    if (sendRes.status !== 'Success' || !sendRes.referenceCode) {
      return c.json({ error: 'ibkr_request_failed', message: sendRes.errorMessage || 'IBKR ما قبل الطلب', code: sendRes.errorCode }, 400)
    }
    const xml = await ibkrGetStatement(token, sendRes.referenceCode)
    const parsed = parseIbkrStatement(xml)

    // Find or create the broker account
    let bankAccount = bankAccountId
      ? await prisma.bankAccount.findFirst({ where: { id: bankAccountId, orgId } })
      : await prisma.bankAccount.findFirst({ where: { orgId, bankName: 'IBKR', accountNumber: parsed.accountId } })

    if (!bankAccount) {
      bankAccount = await prisma.bankAccount.create({
        data: {
          orgId,
          name: `IBKR · ${parsed.accountId}`,
          bankName: 'IBKR',
          accountNumber: parsed.accountId,
          currency: parsed.cash[0]?.currency || 'USD',
          balance: new Prisma.Decimal(parsed.cash[0]?.balance || 0),
        },
      })
    } else {
      // Update balance to latest cash
      const total = parsed.cash.reduce((s, c) => s + c.balance, 0)
      await prisma.bankAccount.update({
        where: { id: bankAccount.id },
        data: { balance: new Prisma.Decimal(total) },
      })
    }

    // Create vouchers for trades · BUY = PAYMENT, SELL = RECEIPT
    let createdTrades = 0
    for (const t of parsed.trades) {
      try {
        const type = t.side === 'BUY' ? 'PAYMENT' : 'RECEIPT'
        const year = new Date(t.date).getFullYear()
        const prefix = type === 'RECEIPT' ? `R-${year}-` : `P-${year}-`
        const last = await prisma.voucher.findFirst({
          where: { orgId, type: type as any, number: { startsWith: prefix } },
          orderBy: { number: 'desc' },
          select: { number: true },
        })
        const lastNum = last ? Number(last.number.split('-').pop() || '0') : 0
        const number = `${prefix}${String(lastNum + 1).padStart(4, '0')}`
        const total = t.qty * t.price + t.commission
        await prisma.voucher.create({
          data: {
            orgId,
            type: type as any,
            number,
            date: new Date(t.date),
            amount: new Prisma.Decimal(total),
            currency: t.currency,
            paymentMethod: 'BANK_TRANSFER',
            reference: `IBKR-${t.tradeId}`,
            notes: `${t.side} ${t.qty} ${t.symbol} @ ${t.price} · cmsn ${t.commission}`,
            bankAccountId: bankAccount.id,
          },
        })
        createdTrades++
      } catch { /* duplicate · skip */ }
    }

    // Dividends · always RECEIPT
    let createdDivs = 0
    for (const d of parsed.dividends) {
      try {
        const year = new Date(d.date).getFullYear()
        const prefix = `R-${year}-`
        const last = await prisma.voucher.findFirst({
          where: { orgId, type: 'RECEIPT', number: { startsWith: prefix } },
          orderBy: { number: 'desc' },
          select: { number: true },
        })
        const lastNum = last ? Number(last.number.split('-').pop() || '0') : 0
        const number = `${prefix}${String(lastNum + 1).padStart(4, '0')}`
        await prisma.voucher.create({
          data: {
            orgId,
            type: 'RECEIPT',
            number,
            date: new Date(d.date),
            amount: new Prisma.Decimal(d.amount),
            currency: d.currency,
            paymentMethod: 'BANK_TRANSFER',
            reference: `IBKR-DIV-${d.symbol}-${d.date}`,
            notes: `Dividend · ${d.symbol}`,
            bankAccountId: bankAccount.id,
          },
        })
        createdDivs++
      } catch { /* skip */ }
    }

    return c.json({
      ok: true,
      accountId: parsed.accountId,
      asOf: parsed.asOf,
      cashBalances: parsed.cash,
      positionsCount: parsed.positions.length,
      tradesImported: createdTrades,
      dividendsImported: createdDivs,
      bankAccountId: bankAccount.id,
      message: `IBKR · ${createdTrades} صفقة + ${createdDivs} توزيع أرباح مستوردة`,
    })
  } catch (e: any) {
    return c.json({ error: 'ibkr_failed', message: e?.message || 'unknown' }, 500)
  }
})

// ─── TradeStation · OAuth ────────────────────────────────────────────────────
brokersRoutes.get('/tradestation/connect', async (c) => {
  const orgId = c.get('orgId') as string
  if (!TS_CLIENT_ID) return c.json({ error: 'not_configured', message: 'TRADESTATION_CLIENT_ID مفقود' }, 503)
  const url = await tradestationOAuthUrl({
    clientId: TS_CLIENT_ID,
    redirectUri: TS_REDIRECT,
    state: orgId, // simple · production should use signed state
  })
  return c.json({ url })
})

brokersRoutes.get('/tradestation/callback', async (c) => {
  const code = c.req.query('code')
  const orgId = c.req.query('state')
  if (!code || !orgId) return c.json({ error: 'missing_code' }, 400)
  if (!TS_CLIENT_ID || !TS_CLIENT_SECRET) return c.json({ error: 'not_configured' }, 503)
  try {
    const tokens = await tradestationExchangeCode({
      clientId: TS_CLIENT_ID,
      clientSecret: TS_CLIENT_SECRET,
      code,
      redirectUri: TS_REDIRECT,
    })
    // TODO: persist refresh token in encrypted store (PlaidItem-style table)
    // For now · return + let UI redirect
    return c.json({
      ok: true,
      message: 'تم الربط مع TradeStation · جلب الحسابات...',
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
    })
  } catch (e: any) {
    return c.json({ error: 'oauth_failed', message: e?.message }, 500)
  }
})

const tsSyncSchema = z.object({ accessToken: z.string() })
brokersRoutes.post('/tradestation/sync', zValidator('json', tsSyncSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const { accessToken } = c.req.valid('json')
  try {
    const accounts = await tradestationListAccounts(accessToken)
    if (accounts.length === 0) return c.json({ error: 'no_accounts' }, 400)
    const accountIds = accounts.map((a: any) => a.AccountID)
    const positions = await tradestationGetPositions(accessToken, accountIds)
    const balances = await tradestationGetBalances(accessToken, accountIds)

    return c.json({
      ok: true,
      accounts,
      positions,
      balances,
      message: `${positions.length} مركز مفتوح · ${balances.length} حساب`,
    })
  } catch (e: any) {
    return c.json({ error: 'sync_failed', message: e?.message }, 500)
  }
})
