import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../db.js'

export const contactsRoutes = new Hono()

const contactSchema = z.object({
  type: z.enum(['CUSTOMER', 'SUPPLIER', 'BOTH']).default('CUSTOMER'),
  displayName: z.string().min(1).max(200),
  legalName: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  vatNumber: z.string().optional().nullable(),
  crNumber: z.string().optional().nullable(),
  addressLine1: z.string().optional().nullable(),
  addressLine2: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  region: z.string().optional().nullable(),
  country: z.string().length(2).default('SA'),
  postalCode: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
})

// GET /contacts — list with optional filters
contactsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId')
  const type = c.req.query('type') as 'CUSTOMER' | 'SUPPLIER' | 'BOTH' | undefined
  const q = c.req.query('q')
  const page = Number(c.req.query('page') || '1')
  const limit = Math.min(Number(c.req.query('limit') || '50'), 200)

  const where: any = { orgId, isActive: true }
  if (type) where.type = type
  if (q) {
    where.OR = [
      { displayName: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q } },
      { vatNumber: { contains: q } },
    ]
  }

  const [items, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: { displayName: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.contact.count({ where }),
  ])

  c.header('X-Total-Count', String(total))
  return c.json({ items, total, page, limit })
})

// GET /contacts/:id
contactsRoutes.get('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const contact = await prisma.contact.findFirst({ where: { id, orgId } })
  if (!contact) return c.json({ error: 'not found' }, 404)
  return c.json(contact)
})

// POST /contacts
contactsRoutes.post('/', zValidator('json', contactSchema), async (c) => {
  const orgId = c.get('orgId')
  const data = c.req.valid('json')
  const contact = await prisma.contact.create({ data: { ...data, orgId } })
  return c.json(contact, 201)
})

// PATCH /contacts/:id
contactsRoutes.patch('/:id', zValidator('json', contactSchema.partial()), async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.contact.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  const data = c.req.valid('json')
  const contact = await prisma.contact.update({ where: { id }, data })
  return c.json(contact)
})

// DELETE /contacts/:id (soft delete)
contactsRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId')
  const id = c.req.param('id')
  const exists = await prisma.contact.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not found' }, 404)
  await prisma.contact.update({ where: { id }, data: { isActive: false } })
  return c.body(null, 204)
})
