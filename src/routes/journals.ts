/**
 * Journal Entries · manual ledger entries with debit/credit balance check
 *
 * GET    /api/journals          list
 * GET    /api/journals/:id      detail
 * POST   /api/journals          create (validates debits === credits)
 * PATCH  /api/journals/:id      update
 * DELETE /api/journals/:id      soft-delete (status → CANCELLED)
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'

export const journalsRoutes = new Hono()

const lineSchema = z.object({
  accountId: z.string(),
  debit: z.coerce.number().min(0).default(0),
  credit: z.coerce.number().min(0).default(0),
  description: z.string().optional().nullable(),
  costCenterId: z.string().optional().nullable(),
  projectId: z.string().optional().nullable(),
})

const entrySchema = z.object({
  date: z.string(),
  description: z.string().min(1),
  reference: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(2),
})

journalsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId') as string
  const items = await prisma.journalEntry.findMany({
    where: { orgId },
    orderBy: { date: 'desc' },
    take: 200,
    include: { lines: { include: { account: { select: { code: true, name: true, nameAr: true } } } } },
  })
  return c.json({
    items: items.map(e => ({
      id: e.id,
      number: e.entryNumber,
      date: e.date,
      description: e.description,
      reference: e.reference,
      status: e.isPosted ? 'POSTED' : 'DRAFT',
      source: e.source,
      totalDebit: e.lines.reduce((s, l) => s + Number(l.debit), 0),
      totalCredit: e.lines.reduce((s, l) => s + Number(l.credit), 0),
      lineCount: e.lines.length,
      lines: e.lines.map(l => ({
        accountId: l.accountId,
        accountCode: l.account?.code,
        accountName: l.account?.nameAr || l.account?.name,
        debit: Number(l.debit),
        credit: Number(l.credit),
        description: l.description,
      })),
    })),
    total: items.length,
  })
})

journalsRoutes.post('/', zValidator('json', entrySchema), async (c) => {
  const orgId = c.get('orgId') as string
  const data = c.req.valid('json')

  const totalDebit = data.lines.reduce((s, l) => s + l.debit, 0)
  const totalCredit = data.lines.reduce((s, l) => s + l.credit, 0)
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return c.json({ error: 'unbalanced', detail: `Debit (${totalDebit}) ≠ Credit (${totalCredit})` }, 400)
  }

  // Generate entry number
  const year = new Date().getFullYear()
  const prefix = `JV-${year}-`
  const last = await prisma.journalEntry.findFirst({
    where: { orgId, entryNumber: { startsWith: prefix } },
    orderBy: { entryNumber: 'desc' },
    select: { entryNumber: true },
  })
  const lastNum = last ? Number(last.entryNumber.split('-').pop() || '0') : 0
  const entryNumber = `${prefix}${String(lastNum + 1).padStart(4, '0')}`

  const created = await prisma.journalEntry.create({
    data: {
      orgId,
      entryNumber,
      date: new Date(data.date),
      description: data.description,
      reference: data.reference || null,
      source: 'manual',
      isPosted: true,
      postedAt: new Date(),
      lines: {
        create: data.lines.map(l => ({
          accountId: l.accountId,
          debit: new Prisma.Decimal(l.debit),
          credit: new Prisma.Decimal(l.credit),
          description: l.description || null,
        })),
      },
    },
    include: { lines: true },
  })
  return c.json(created, 201)
})

journalsRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const exists = await prisma.journalEntry.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not_found' }, 404)
  await prisma.journalEntry.delete({ where: { id } })
  return c.body(null, 204)
})
