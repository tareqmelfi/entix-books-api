/**
 * AI Billing helpers · used by agent.ts and ocr.ts on every AI request.
 *
 * Flow:
 *   1. resolveAiKey(orgId) → { apiKey, source: 'BYOK' | 'HOSTED', mode, billing }
 *      - If mode=BYOK and byokKey present → decrypt, return as apiKey
 *      - Else if HOSTED and within quota → return platform key
 *      - Else throw QuotaExceededError (caller returns 402)
 *      - Also handles period reset (monthly rollover)
 *
 *   2. After AI call returns: logAiUsage(...) writes AiUsageLog and increments
 *      spentThisPeriod (only for HOSTED · BYOK is free for us).
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { decryptSecret } from './crypto.js'

const PLATFORM_KEY = process.env.OPENROUTER_API_KEY || ''

export class QuotaExceededError extends Error {
  monthlyAllocation: number
  spentThisPeriod: number
  creditBalance: number
  upgradeHint: string
  constructor(opts: { monthlyAllocation: number; spentThisPeriod: number; creditBalance: number }) {
    super('quota_exceeded')
    this.monthlyAllocation = opts.monthlyAllocation
    this.spentThisPeriod = opts.spentThisPeriod
    this.creditBalance = opts.creditBalance
    this.upgradeHint = 'يرجى ترقية الباقة أو إضافة رصيد · أو ضع مفتاحك الخاص (BYOK)'
  }
}

export class DisabledByAdminError extends Error {
  reason: string | null
  constructor(reason: string | null) {
    super('disabled_by_admin')
    this.reason = reason
  }
}

interface ResolvedKey {
  apiKey: string
  source: 'BYOK' | 'HOSTED'
  mode: string
  provider: string  // openrouter | anthropic
  billingId: string
}

async function ensureBilling(orgId: string) {
  let b = await prisma.aiBilling.findUnique({ where: { orgId } })
  if (!b) {
    b = await prisma.aiBilling.create({
      data: { orgId, mode: 'HOSTED_FREE', monthlyAllocation: new Prisma.Decimal(5) },
    })
  }
  return b
}

/** Reset spentThisPeriod if periodResetAt is older than 1 month. */
async function maybeResetPeriod(billingId: string, periodResetAt: Date) {
  const now = new Date()
  const diffMs = now.getTime() - periodResetAt.getTime()
  const oneMonthMs = 30 * 24 * 60 * 60 * 1000
  if (diffMs >= oneMonthMs) {
    await prisma.aiBilling.update({
      where: { id: billingId },
      data: {
        spentThisPeriod: new Prisma.Decimal(0),
        periodResetAt: now,
        alertedAt80: false,
        alertedAt100: false,
      },
    })
    return true
  }
  return false
}

export async function resolveAiKey(orgId: string): Promise<ResolvedKey> {
  const billing = await ensureBilling(orgId)

  if (billing.disabled) {
    throw new DisabledByAdminError(billing.disabledReason)
  }

  // Auto-rollover monthly period
  await maybeResetPeriod(billing.id, billing.periodResetAt)
  const fresh = await prisma.aiBilling.findUnique({ where: { id: billing.id } })
  if (!fresh) throw new Error('billing_record_disappeared')

  // BYOK · use org's key
  if (fresh.mode === 'BYOK' && fresh.byokKeyEncrypted) {
    try {
      const apiKey = decryptSecret(fresh.byokKeyEncrypted)
      return {
        apiKey,
        source: 'BYOK',
        mode: fresh.mode,
        provider: fresh.byokProvider || 'openrouter',
        billingId: fresh.id,
      }
    } catch (e) {
      console.error('[ai-billing] BYOK key decrypt failed', e)
      // fall through to hosted as a courtesy (or throw?)
      throw new Error('byok_key_decrypt_failed')
    }
  }

  // HOSTED · check quota
  const allocation = Number(fresh.monthlyAllocation)
  const spent = Number(fresh.spentThisPeriod)
  const credits = Number(fresh.creditBalance)
  const totalAllowed = allocation + credits

  if (fresh.mode !== 'PAYG' && spent >= totalAllowed) {
    throw new QuotaExceededError({
      monthlyAllocation: allocation,
      spentThisPeriod: spent,
      creditBalance: credits,
    })
  }
  // PAYG has no hard cap (just billed at $1.20 per $1 spent)

  if (!PLATFORM_KEY) {
    throw new Error('platform_key_not_configured')
  }

  return {
    apiKey: PLATFORM_KEY,
    source: 'HOSTED',
    mode: fresh.mode,
    provider: 'openrouter',
    billingId: fresh.id,
  }
}

interface UsagePayload {
  orgId: string
  userId?: string | null
  endpoint: string
  model: string
  source: 'BYOK' | 'HOSTED'
  provider: string
  promptTokens?: number
  completionTokens?: number
  /**
   * Cost in USD · pulled from OpenRouter response.usage.total_cost when available,
   * else estimated by tokens × per-million pricing for the model.
   */
  costUsd: number
  successful?: boolean
  errorCode?: string | null
}

export async function logAiUsage(payload: UsagePayload): Promise<void> {
  try {
    await prisma.aiUsageLog.create({
      data: {
        orgId: payload.orgId,
        userId: payload.userId ?? null,
        endpoint: payload.endpoint,
        model: payload.model,
        source: payload.source,
        provider: payload.provider,
        promptTokens: payload.promptTokens ?? 0,
        completionTokens: payload.completionTokens ?? 0,
        costUsd: new Prisma.Decimal(payload.costUsd.toFixed(6)),
        successful: payload.successful ?? true,
        errorCode: payload.errorCode ?? null,
      },
    })

    // Increment spent only for HOSTED (BYOK is free for us)
    if (payload.source === 'HOSTED' && payload.successful !== false) {
      const updated = await prisma.aiBilling.update({
        where: { orgId: payload.orgId },
        data: { spentThisPeriod: { increment: new Prisma.Decimal(payload.costUsd.toFixed(6)) } },
      })

      // Threshold alerts (only fire once per period)
      const allocation = Number(updated.monthlyAllocation) + Number(updated.creditBalance)
      const spent = Number(updated.spentThisPeriod)
      const pct = spent / Math.max(allocation, 0.01)

      if (pct >= 1 && !updated.alertedAt100) {
        await prisma.aiBilling.update({ where: { id: updated.id }, data: { alertedAt100: true } })
        // TODO: send email + create Notification record
        console.warn(`[ai-billing] org ${payload.orgId} hit 100% quota`)
      } else if (pct >= 0.8 && !updated.alertedAt80) {
        await prisma.aiBilling.update({ where: { id: updated.id }, data: { alertedAt80: true } })
        console.warn(`[ai-billing] org ${payload.orgId} hit 80% quota`)
      }
    }
  } catch (e) {
    // Logging must NEVER break the main request
    console.error('[ai-billing] logAiUsage failed', e)
  }
}

/**
 * Estimate cost when OpenRouter doesn't return total_cost.
 * Conservative · uses per-million-token pricing for major models.
 */
export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const m = model.toLowerCase()
  // USD per million tokens · approximate · update as pricing changes
  let pricePromptPerMillion = 3
  let priceCompletionPerMillion = 15

  if (m.includes('haiku')) {
    pricePromptPerMillion = 1
    priceCompletionPerMillion = 5
  } else if (m.includes('sonnet')) {
    pricePromptPerMillion = 3
    priceCompletionPerMillion = 15
  } else if (m.includes('opus')) {
    pricePromptPerMillion = 15
    priceCompletionPerMillion = 75
  } else if (m.includes('gpt-4o-mini')) {
    pricePromptPerMillion = 0.15
    priceCompletionPerMillion = 0.6
  } else if (m.includes('gpt-4o')) {
    pricePromptPerMillion = 2.5
    priceCompletionPerMillion = 10
  }

  const cost = (promptTokens * pricePromptPerMillion + completionTokens * priceCompletionPerMillion) / 1_000_000
  return Math.max(cost, 0.0001) // floor to track even tiny calls
}
