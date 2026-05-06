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
  currency: z.string().length(3).default('SAR'),
  balance: z.coerce.number().default(0),
})

bankAccountsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const items = await prisma.bankAccount.findMany({ where: { orgId, isActive: true }, orderBy: { name: 'asc' } })
  const totalBalance = items.reduce((s, b) => s + Number(b.balance), 0)
  return c.json({ items, total: items.length, totalBalance })
})

bankAccountsRoutes.post('/', zValidator('json', schema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')
  const b = await prisma.bankAccount.create({
    data: { orgId, ...data, balance: new Prisma.Decimal(data.balance) },
  })
  return c.json(b, 201)
})

bankAccountsRoutes.patch('/:id', zValidator('json', schema.partial()), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.bankAccount.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  const data = c.req.valid('json')
  const updates: any = { ...data }
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
