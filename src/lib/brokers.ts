/**
 * Trading brokers integration · UX-79
 *
 * Per طارق · "افتح محفظة تداول واربطها مع بروكر · انتراكتف بروكرز · تريدستيشن"
 *
 * Supported:
 *   - Interactive Brokers (IBKR) Flex Web Service · token + query ID → daily statement XML
 *   - TradeStation API · OAuth 2.0 · /v3/brokerage/accounts/{id}/positions + /balances
 *   - Manual statement upload · CSV/PDF fallback (any broker)
 *
 * Daily flow:
 *   1. Cron (or webhook) triggers /api/brokers/sync
 *   2. For each connected broker · pull latest positions + cash balance
 *   3. Compare to last snapshot · post journal entries for:
 *      - Realized gains/losses (from closed trades)
 *      - Unrealized PnL adjustment (mark-to-market on open positions)
 *      - Dividends received
 *      - Interest paid/received
 *      - Commissions
 *   4. Update broker.lastSyncAt
 */

// ─── Interactive Brokers (IBKR) · Flex Web Service ────────────────────────────

/**
 * IBKR Flex Web Service · 2-step process:
 *   1. POST /Universal/servlet/FlexStatementService.SendRequest
 *      with token + query_id → returns reference_code
 *   2. POST /Universal/servlet/FlexStatementService.GetStatement
 *      with token + reference_code → returns XML statement
 *
 * Setup (one-time per user):
 *   - Login to IBKR Account Management
 *   - Reports & Tax Docs → Flex Queries → Activity Flex Query
 *   - Configure: include trades, cash report, positions, dividends
 *   - Generate Token: Reports → Settings → Flex Web Service → Generate
 */

const IBKR_BASE = 'https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService'

export interface IbkrSendResult {
  status: 'Success' | 'Warn' | 'Fail'
  referenceCode?: string
  errorCode?: string
  errorMessage?: string
}

export async function ibkrSendRequest(token: string, queryId: string): Promise<IbkrSendResult> {
  const url = `${IBKR_BASE}.SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`
  const r = await fetch(url, { method: 'POST' })
  const xml = await r.text()
  // Parse very lightly · IBKR returns simple XML
  const status = xml.match(/<Status>(.+?)<\/Status>/)?.[1] as IbkrSendResult['status']
  const referenceCode = xml.match(/<ReferenceCode>(.+?)<\/ReferenceCode>/)?.[1]
  const errorCode = xml.match(/<ErrorCode>(.+?)<\/ErrorCode>/)?.[1]
  const errorMessage = xml.match(/<ErrorMessage>(.+?)<\/ErrorMessage>/)?.[1]
  return { status: status || 'Fail', referenceCode, errorCode, errorMessage }
}

export async function ibkrGetStatement(token: string, referenceCode: string): Promise<string> {
  const url = `${IBKR_BASE}.GetStatement?t=${encodeURIComponent(token)}&q=${encodeURIComponent(referenceCode)}&v=3`
  // IBKR may return "Statement is not available yet" up to ~30 seconds after SendRequest
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, { method: 'POST' })
    const xml = await r.text()
    if (xml.includes('<Status>Warn') && /not available yet/i.test(xml)) {
      await new Promise((res) => setTimeout(res, 5000))
      continue
    }
    return xml
  }
  throw new Error('IBKR statement timed out after 30s')
}

/** Parse IBKR Flex XML into structured positions + trades + cash */
export function parseIbkrStatement(xml: string): {
  accountId: string
  asOf: string
  cash: Array<{ currency: string; balance: number }>
  positions: Array<{ symbol: string; qty: number; avgCost: number; marketValue: number; unrealizedPnL: number; currency: string }>
  trades: Array<{ tradeId: string; date: string; symbol: string; side: 'BUY' | 'SELL'; qty: number; price: number; commission: number; currency: string }>
  dividends: Array<{ date: string; symbol: string; amount: number; currency: string }>
} {
  const accountId = xml.match(/accountId="([^"]+)"/)?.[1] || ''
  const asOf = xml.match(/toDate="([^"]+)"/)?.[1] || new Date().toISOString().slice(0, 10)
  const cash: any[] = []
  const positions: any[] = []
  const trades: any[] = []
  const dividends: any[] = []

  // Cash entries
  const cashMatches = xml.matchAll(/<CashReportCurrency[^>]*currency="([^"]+)"[^>]*endingCash="([^"]+)"/g)
  for (const m of cashMatches) cash.push({ currency: m[1], balance: Number(m[2]) || 0 })

  // Open positions
  const posMatches = xml.matchAll(/<OpenPosition[^>]*symbol="([^"]+)"[^>]*position="([^"]+)"[^>]*costBasisPrice="([^"]+)"[^>]*markPrice="([^"]+)"[^>]*currency="([^"]+)"[^>]*fifoPnlUnrealized="([^"]+)"/g)
  for (const m of posMatches) {
    const qty = Number(m[2])
    positions.push({
      symbol: m[1],
      qty,
      avgCost: Number(m[3]),
      marketValue: qty * Number(m[4]),
      unrealizedPnL: Number(m[6]),
      currency: m[5],
    })
  }

  // Trades
  const tradeMatches = xml.matchAll(/<Trade[^>]*tradeID="([^"]+)"[^>]*tradeDate="([^"]+)"[^>]*symbol="([^"]+)"[^>]*buySell="([^"]+)"[^>]*quantity="([^"]+)"[^>]*tradePrice="([^"]+)"[^>]*ibCommission="([^"]+)"[^>]*currency="([^"]+)"/g)
  for (const m of tradeMatches) {
    trades.push({
      tradeId: m[1],
      date: m[2],
      symbol: m[3],
      side: m[4] as 'BUY' | 'SELL',
      qty: Math.abs(Number(m[5])),
      price: Number(m[6]),
      commission: Math.abs(Number(m[7])),
      currency: m[8],
    })
  }

  // Cash transactions filter for dividends
  const divMatches = xml.matchAll(/<CashTransaction[^>]*type="Dividends"[^>]*settleDate="([^"]+)"[^>]*symbol="([^"]+)"[^>]*amount="([^"]+)"[^>]*currency="([^"]+)"/g)
  for (const m of divMatches) {
    dividends.push({ date: m[1], symbol: m[2], amount: Number(m[3]), currency: m[4] })
  }

  return { accountId, asOf, cash, positions, trades, dividends }
}

// ─── TradeStation · OAuth 2.0 ────────────────────────────────────────────────

const TRADESTATION_BASE = 'https://api.tradestation.com/v3'
const TRADESTATION_AUTH = 'https://signin.tradestation.com'

export async function tradestationOAuthUrl(args: {
  clientId: string
  redirectUri: string
  state: string
}): Promise<string> {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    state: args.state,
    scope: 'openid offline_access ReadAccount Trade',
    audience: 'https://api.tradestation.com',
  })
  return `${TRADESTATION_AUTH}/authorize?${params.toString()}`
}

export async function tradestationExchangeCode(args: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const r = await fetch(`${TRADESTATION_AUTH}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    }).toString(),
  })
  const data: any = await r.json()
  if (!r.ok) throw new Error(data.error_description || `TradeStation auth ${r.status}`)
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  }
}

export async function tradestationListAccounts(accessToken: string): Promise<any[]> {
  const r = await fetch(`${TRADESTATION_BASE}/brokerage/accounts`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data: any = await r.json()
  return data.Accounts || []
}

export async function tradestationGetPositions(accessToken: string, accountIds: string[]): Promise<any[]> {
  const ids = accountIds.join(',')
  const r = await fetch(`${TRADESTATION_BASE}/brokerage/accounts/${ids}/positions`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data: any = await r.json()
  return data.Positions || []
}

export async function tradestationGetBalances(accessToken: string, accountIds: string[]): Promise<any[]> {
  const ids = accountIds.join(',')
  const r = await fetch(`${TRADESTATION_BASE}/brokerage/accounts/${ids}/balances`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data: any = await r.json()
  return data.Balances || []
}
