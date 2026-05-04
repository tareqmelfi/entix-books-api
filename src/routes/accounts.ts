import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../db.js'

export const accountsRoutes = new Hono()

const accountSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(120),
  nameAr: z.string().optional().nullable(),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
  subtype: z.string().optional().nullable(),
  parentId: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
})

// GET /accounts — full chart of accounts (no pagination · usually < 200 rows)
accountsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const accounts = await prisma.account.findMany({
    where: { orgId, isActive: true },
    orderBy: { code: 'asc' },
  })
  return c.json({ items: accounts, total: accounts.length })
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
  await prisma.account.update({ where: { id }, data: { isActive: false } })
  return c.body(null, 204)
})
