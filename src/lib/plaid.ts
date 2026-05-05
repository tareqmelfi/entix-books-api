/**
 * Plaid · US bank/credit-card connectivity
 *
 * Per طارق · UX-78 · "اربط مع بليد للبنوك الأمريكية حتى لو الشركة سعودية"
 *
 * Flow:
 *   1. Frontend asks /api/plaid/link-token → opens Plaid Link UI in browser
 *   2. User picks bank · authorizes · Plaid returns a public_token
 *   3. Frontend POSTs public_token to /api/plaid/exchange → server swaps for access_token
 *   4. Server stores access_token (encrypted) tied to org + bank account
 *   5. Daily cron + on-demand refresh pulls /transactions/sync · creates Voucher entries
 *
 * Endpoints used:
 *   POST /link/token/create
 *   POST /item/public_token/exchange
 *   POST /transactions/sync           (incremental · returns added/modified/removed)
 *   POST /accounts/balance/get        (force fresh balance)
 *   POST /institutions/get_by_id      (institution metadata)
 *   POST /item/remove                 (disconnect)
 *
 * Env vars:
 *   PLAID_CLIENT_ID
 *   PLAID_SECRET
 *   PLAID_ENV = "sandbox" | "development" | "production"
 *   PLAID_WEBHOOK_URL = https://api.entix.io/api/plaid/webhook
 */

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || ''
const PLAID_SECRET = process.env.PLAID_SECRET || ''
const PLAID_ENV: 'sandbox' | 'development' | 'production' =
  (process.env.PLAID_ENV as any) || 'sandbox'

const PLAID_BASE_URLS = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
} as const

export const PLAID_BASE = PLAID_BASE_URLS[PLAID_ENV]

export class PlaidError extends Error {
  constructor(public code: string, public detail: string, public status = 500) {
    super(detail)
  }
}

/** Plaid request wrapper · injects credentials · throws on error */
async function plaidPost<T = any>(path: string, body: Record<string, any>): Promise<T> {
  if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
    throw new PlaidError('not_configured', 'PLAID_CLIENT_ID + PLAID_SECRET غير مضبوطة في الـenv')
  }
  const r = await fetch(`${PLAID_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      ...body,
    }),
  })
  const data: any = await r.json().catch(() => ({}))
  if (!r.ok || data.error_code) {
    throw new PlaidError(
      data.error_code || `http_${r.status}`,
      data.error_message || data.display_message || `Plaid error ${r.status}`,
      r.status,
    )
  }
  return data as T
}

// ─── Public API · used by routes ─────────────────────────────────────────────

/** Create a one-time Link token for the front-end Plaid Link widget. */
export async function createLinkToken(args: {
  userId: string
  /** Org/business name shown in the Plaid UI */
  clientName?: string
  /** Products requested · default: auth + transactions */
  products?: Array<'auth' | 'transactions' | 'liabilities' | 'investments' | 'identity' | 'income'>
  /** Country codes · US default · CA/GB available too */
  countryCodes?: Array<'US' | 'CA' | 'GB' | 'IE' | 'FR' | 'ES' | 'NL' | 'DE'>
  /** Webhook URL · receives transaction updates */
  webhookUrl?: string
}): Promise<{ linkToken: string; expiration: string }> {
  const data = await plaidPost<{ link_token: string; expiration: string }>('/link/token/create', {
    user: { client_user_id: args.userId },
    client_name: args.clientName || 'Entix Books',
    products: args.products || ['auth', 'transactions'],
    country_codes: args.countryCodes || ['US'],
    language: 'en',
    webhook: args.webhookUrl || process.env.PLAID_WEBHOOK_URL || undefined,
  })
  return { linkToken: data.link_token, expiration: data.expiration }
}

/** Exchange the front-end public_token for a long-lived access_token. */
export async function exchangePublicToken(publicToken: string): Promise<{
  accessToken: string
  itemId: string
}> {
  const data = await plaidPost<{ access_token: string; item_id: string }>(
    '/item/public_token/exchange',
    { public_token: publicToken },
  )
  return { accessToken: data.access_token, itemId: data.item_id }
}

/** List accounts for an item · used after exchange to populate UI. */
export async function getAccounts(accessToken: string): Promise<Array<{
  accountId: string
  name: string
  officialName?: string
  type: string
  subtype: string
  mask?: string
  balance: { available: number; current: number; iso: string }
}>> {
  const data: any = await plaidPost('/accounts/get', { access_token: accessToken })
  return (data.accounts || []).map((a: any) => ({
    accountId: a.account_id,
    name: a.name,
    officialName: a.official_name,
    type: a.type,
    subtype: a.subtype,
    mask: a.mask,
    balance: {
      available: Number(a.balances?.available) || 0,
      current: Number(a.balances?.current) || 0,
      iso: a.balances?.iso_currency_code || 'USD',
    },
  }))
}

/**
 * Sync transactions · returns added/modified/removed since last cursor.
 * Plaid's /transactions/sync is the recommended modern endpoint.
 */
export async function syncTransactions(
  accessToken: string,
  cursor?: string,
): Promise<{
  added: any[]
  modified: any[]
  removed: any[]
  cursor: string
  hasMore: boolean
}> {
  let allAdded: any[] = []
  let allModified: any[] = []
  let allRemoved: any[] = []
  let nextCursor = cursor || ''
  let hasMore = true

  while (hasMore) {
    const data: any = await plaidPost('/transactions/sync', {
      access_token: accessToken,
      cursor: nextCursor,
      count: 500,
    })
    allAdded = allAdded.concat(data.added || [])
    allModified = allModified.concat(data.modified || [])
    allRemoved = allRemoved.concat(data.removed || [])
    nextCursor = data.next_cursor || nextCursor
    hasMore = !!data.has_more
    if (!hasMore) break
  }
  return { added: allAdded, modified: allModified, removed: allRemoved, cursor: nextCursor, hasMore: false }
}

/** Force-refresh account balances (more accurate than /accounts/get for some banks) */
export async function refreshBalance(accessToken: string, accountIds?: string[]): Promise<any[]> {
  const data: any = await plaidPost('/accounts/balance/get', {
    access_token: accessToken,
    options: accountIds ? { account_ids: accountIds } : undefined,
  })
  return data.accounts || []
}

/** Disconnect / remove the Plaid Item · revokes access */
export async function removeItem(accessToken: string): Promise<void> {
  await plaidPost('/item/remove', { access_token: accessToken })
}

/** Get institution metadata · for display name/logo */
export async function getInstitution(institutionId: string, countryCodes: string[] = ['US']): Promise<{
  id: string
  name: string
  logo?: string
  primaryColor?: string
  url?: string
}> {
  const data: any = await plaidPost('/institutions/get_by_id', {
    institution_id: institutionId,
    country_codes: countryCodes,
    options: { include_optional_metadata: true },
  })
  const i = data.institution || {}
  return {
    id: i.institution_id,
    name: i.name,
    logo: i.logo ? `data:image/png;base64,${i.logo}` : undefined,
    primaryColor: i.primary_color,
    url: i.url,
  }
}
