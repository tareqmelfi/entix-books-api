import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'

export const bankAccountsRoutes = new Hono()

const schema = z.object({
  name: z.string().min(1),
  bankName: z.string().optional().nullable(),
  country: z.string().length(2).optional().nullable().or(z.literal('').transform(() => null)),
  accountNumber: z.string().optional().nullable(),
  iban: z.string().optional().nullable(),
  swiftCode: z.string().optional().nullable(),
  routingNumber: z.string().optional().nullable(),
  currency: z.string().length(3).optional(),
  balance: z.coerce.number().default(0),
})

const IBAN_COUNTRIES = new Set(['SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'JO', 'GB', 'DE', 'FR'])

function currencyForCountry(country?: string | null) {
  if (country === 'US') return 'USD'
  if (country === 'AE') return 'AED'
  if (country === 'EG') return 'EGP'
  if (country === 'GB') return 'GBP'
  if (country === 'DE' || country === 'FR') return 'EUR'
  return 'SAR'
}

function normalizeBankAccountInput(data: z.infer<typeof schema>, mode: 'create' | 'patch') {
  const normalized: any = { ...data }
  const includes = (key: keyof typeof data) => mode === 'create' || Object.prototype.hasOwnProperty.call(data, key)

  const country = data.country ? data.country.trim().toUpperCase() : data.country
  if (includes('country')) normalized.country = country
  if (includes('bankName')) normalized.bankName = data.bankName?.trim() || null
  if (includes('accountNumber')) normalized.accountNumber = data.accountNumber?.trim() || null
  if (includes('iban')) normalized.iban = data.iban?.replace(/\s/g, '').toUpperCase() || null
  if (includes('swiftCode')) normalized.swiftCode = data.swiftCode?.replace(/\s/g, '').toUpperCase() || null
  if (includes('routingNumber')) normalized.routingNumber = data.routingNumber?.replace(/\D/g, '') || null

  if (includes('currency') && data.currency) normalized.currency = data.currency.trim().toUpperCase()
  else if (mode === 'create') normalized.currency = currencyForCountry(country)
  return normalized
}

function validateBankAccountInput(data: z.infer<typeof schema>) {
  const country = data.country ? data.country.trim().toUpperCase() : null
  const routing = data.routingNumber?.replace(/\D/g, '') || ''
  const accountNumber = data.accountNumber?.trim() || ''
  const iban = data.iban?.replace(/\s/g, '') || ''

  if (country === 'US') {
    if (!/^\d{9}$/.test(routing)) return 'US bank accounts require a 9-digit routing number'
    if (!accountNumber) return 'US bank accounts require an account number'
  }
  if (country && IBAN_COUNTRIES.has(country) && !iban) {
    return 'IBAN is required for this country'
  }
  return null
}

bankAccountsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const items = await prisma.bankAccount.findMany({ where: { orgId, isActive: true }, orderBy: { name: 'asc' } })
  const totalBalance = items.reduce((s, b) => s + Number(b.balance), 0)
  return c.json({ items, total: items.length, totalBalance })
})

bankAccountsRoutes.post('/', zValidator('json', schema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')
  const validationError = validateBankAccountInput(data)
  if (validationError) return c.json({ error: validationError }, 400)
  const normalized = normalizeBankAccountInput(data, 'create')
  const b = await prisma.bankAccount.create({
    data: { orgId, ...normalized, balance: new Prisma.Decimal(data.balance) },
  })
  return c.json(b, 201)
})

bankAccountsRoutes.patch('/:id', zValidator('json', schema.partial()), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.bankAccount.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  const data = c.req.valid('json')
  const updates: any = normalizeBankAccountInput(data as z.infer<typeof schema>, 'patch')
  if (data.balance !== undefined) updates.balance = new Prisma.Decimal(data.balance)
  const b = await prisma.bankAccount.update({ where: { id }, data: updates })
  return c.json(b)
})

bankAccountsRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.bankAccount.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.bankAccount.update({ where: { id }, data: { isActive: false } })
  return c.body(null, 204)
})
