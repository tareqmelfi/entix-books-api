/**
 * Currency rates · multi-currency support
 *
 * GET    /api/currency/rates                   list rates (filter by date / pair)
 * GET    /api/currency/rates/latest            latest rate for a pair
 * POST   /api/currency/rates                   manual upsert of a rate
 * POST   /api/currency/rates/sync              fetch latest from openexchangerates / ECB (free tier)
 * GET    /api/currency/convert                 convert ?amount=...&from=...&to=...&date=...
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'

export const currencyRoutes = new Hono()

const upsertSchema = z.object({
  fromCurrency: z.string().min(3).max(3),
  toCurrency: z.string().min(3).max(3),
  rate: z.coerce.number().positive(),
  date: z.string().optional(),
  source: z.string().optional(),
})

currencyRoutes.get('/rates', async (c) => {
  const orgId = c.get('orgId') as string
  const from = c.req.query('from')
  const to = c.req.query('to')
  const where: any = { OR: [{ orgId }, { orgId: null }] }
  if (from) where.fromCurrency = from.toUpperCase()
  if (to) where.toCurrency = to.toUpperCase()
  const items = await prisma.currencyRate.findMany({
    where,
    orderBy: { date: 'desc' },
    take: 200,
  })
  return c.json({ items: items.map(r => ({ ...r, rate: Number(r.rate) })) })
})

currencyRoutes.get('/rates/latest', async (c) => {
  const orgId = c.get('orgId') as string
  const from = (c.req.query('from') || '').toUpperCase()
  const to = (c.req.query('to') || '').toUpperCase()
  if (!from || !to) return c.json({ error: 'from_and_to_required' }, 400)
  if (from === to) return c.json({ rate: 1, source: 'identity', date: new Date() })
  const r = await prisma.currencyRate.findFirst({
    where: {
      OR: [{ orgId }, { orgId: null }],
      fromCurrency: from,
      toCurrency: to,
    },
    orderBy: { date: 'desc' },
  })
  if (!r) return c.json({ error: 'no_rate' }, 404)
  return c.json({ rate: Number(r.rate), source: r.source, date: r.date })
})

currencyRoutes.post('/rates', zValidator('json', upsertSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const data = c.req.valid('json')
  const date = data.date ? new Date(data.date) : new Date()
  date.setUTCHours(0, 0, 0, 0)
  const rate = await prisma.currencyRate.upsert({
    where: {
      orgId_fromCurrency_toCurrency_date: {
        orgId,
        fromCurrency: data.fromCurrency.toUpperCase(),
        toCurrency: data.toCurrency.toUpperCase(),
        date,
      },
    },
    create: {
      orgId,
      fromCurrency: data.fromCurrency.toUpperCase(),
      toCurrency: data.toCurrency.toUpperCase(),
      rate: new Prisma.Decimal(data.rate),
      date,
      source: data.source || 'manual',
    },
    update: { rate: new Prisma.Decimal(data.rate), source: data.source || 'manual' },
  })
  return c.json({ ...rate, rate: Number(rate.rate) }, 201)
})

// Sync from openexchangerates.org (free tier needs APP_ID env var)
currencyRoutes.post('/rates/sync', async (c) => {
  const orgId = c.get('orgId') as string
  const appId = process.env.OPENEXCHANGERATES_APP_ID
  if (!appId) {
    // Fallback to ECB free public XML feed (EUR base)
    return await syncFromEcb(orgId, c)
  }
  try {
    const res = await fetch(`https://openexchangerates.org/api/latest.json?app_id=${appId}&base=USD`)
    if (!res.ok) return c.json({ error: 'fetch_failed', status: res.status }, 502)
    const data = await res.json() as any
    const today = new Date(); today.setUTCHours(0, 0, 0, 0)
    const rates = data.rates || {}
    const wanted = ['SAR', 'AED', 'EUR', 'GBP', 'USD']
    let count = 0
    for (const t of wanted) {
      if (!rates[t]) continue
      await prisma.currencyRate.upsert({
        where: {
          orgId_fromCurrency_toCurrency_date: {
            orgId: null as any,
            fromCurrency: 'USD',
            toCurrency: t,
            date: today,
          },
        },
        create: { orgId: null, fromCurrency: 'USD', toCurrency: t, rate: new Prisma.Decimal(rates[t]), date: today, source: 'oxr' },
        update: { rate: new Prisma.Decimal(rates[t]), source: 'oxr' },
      })
      count++
    }
    return c.json({ ok: true, count, source: 'oxr' })
  } catch (e: any) {
    return c.json({ error: 'sync_failed', message: e?.message || 'unknown' }, 500)
  }
})

async function syncFromEcb(orgId: string, c: any) {
  try {
    const res = await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml')
    if (!res.ok) return c.json({ error: 'ecb_fetch_failed' }, 502)
    const xml = await res.text()
    const today = new Date(); today.setUTCHours(0, 0, 0, 0)
    // Parse ECB XML <Cube currency='USD' rate='1.05'/>
    const matches = Array.from(xml.matchAll(/currency='([A-Z]{3})'\s+rate='([0-9.]+)'/g))
    let count = 0
    for (const m of matches) {
      const cur = m[1]; const rate = Number(m[2])
      if (!['SAR', 'AED', 'USD', 'GBP'].includes(cur)) continue
      await prisma.currencyRate.upsert({
        where: {
          orgId_fromCurrency_toCurrency_date: {
            orgId: null as any,
            fromCurrency: 'EUR',
            toCurrency: cur,
            date: today,
          },
        },
        create: { orgId: null, fromCurrency: 'EUR', toCurrency: cur, rate: new Prisma.Decimal(rate), date: today, source: 'ecb' },
        update: { rate: new Prisma.Decimal(rate), source: 'ecb' },
      })
      count++
    }
    return c.json({ ok: true, count, source: 'ecb' })
  } catch (e: any) {
    return c.json({ error: 'ecb_sync_failed', message: e?.message || 'unknown' }, 500)
  }
}

currencyRoutes.get('/convert', async (c) => {
  const orgId = c.get('orgId') as string
  const amount = Number(c.req.query('amount'))
  const from = (c.req.query('from') || '').toUpperCase()
  const to = (c.req.query('to') || '').toUpperCase()
  const dateStr = c.req.query('date')
  if (!amount || !from || !to) return c.json({ error: 'params_required' }, 400)
  if (from === to) return c.json({ amount, converted: amount, rate: 1 })

  const date = dateStr ? new Date(dateStr) : new Date()
  date.setUTCHours(0, 0, 0, 0)

  // Direct rate
  let r = await prisma.currencyRate.findFirst({
    where: { OR: [{ orgId }, { orgId: null }], fromCurrency: from, toCurrency: to, date: { lte: date } },
    orderBy: { date: 'desc' },
  })
  if (r) {
    const conv = amount * Number(r.rate)
    return c.json({ amount, converted: conv, rate: Number(r.rate), source: r.source, rateDate: r.date })
  }
  // Inverse rate
  const inv = await prisma.currencyRate.findFirst({
    where: { OR: [{ orgId }, { orgId: null }], fromCurrency: to, toCurrency: from, date: { lte: date } },
    orderBy: { date: 'desc' },
  })
  if (inv) {
    const rate = 1 / Number(inv.rate)
    return c.json({ amount, converted: amount * rate, rate, source: inv.source, rateDate: inv.date, inverse: true })
  }
  // Cross via USD
  const [a, b] = await Promise.all([
    prisma.currencyRate.findFirst({ where: { OR: [{ orgId }, { orgId: null }], fromCurrency: 'USD', toCurrency: from, date: { lte: date } }, orderBy: { date: 'desc' } }),
    prisma.currencyRate.findFirst({ where: { OR: [{ orgId }, { orgId: null }], fromCurrency: 'USD', toCurrency: to, date: { lte: date } }, orderBy: { date: 'desc' } }),
  ])
  if (a && b) {
    const rate = Number(b.rate) / Number(a.rate)
    return c.json({ amount, converted: amount * rate, rate, source: 'cross-USD', rateDate: a.date })
  }
  return c.json({ error: 'no_rate_available', message: 'لا يوجد سعر صرف لهذا الزوج · أضف سعراً يدوياً أو شغّل المزامنة' }, 404)
})
