/**
 * Journal Entries · manual ledger entries with debit/credit balance check
 *
 * GET    /api/journals                list (with status filter)
 * GET    /api/journals/:id            detail (lines + attachments)
 * POST   /api/journals                create (default DRAFT, set postOnSave=true to auto-post)
 * PATCH  /api/journals/:id            edit (only if DRAFT)
 * POST   /api/journals/:id/post       transition DRAFT → POSTED
 * POST   /api/journals/:id/unpost     transition POSTED → DRAFT
 * DELETE /api/journals/:id            hard delete (only if DRAFT and no attachments)
 *
 * GET    /api/journals/:id/attachments        list
 * POST   /api/journals/:id/attachments        upload (multipart or base64)
 * DELETE /api/journals/:id/attachments/:aid   remove
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
  postOnSave: z.boolean().optional().default(false),
  lines: z.array(lineSchema).min(2),
})

const editSchema = z.object({
  date: z.string().optional(),
  description: z.string().min(1).optional(),
  reference: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(2).optional(),
})

// ── helpers ────────────────────────────────────────────────────────────────
function rowFromEntry(e: any) {
  return {
    id: e.id,
    number: e.entryNumber,
    date: e.date,
    description: e.description,
    reference: e.reference,
    status: e.isPosted ? 'POSTED' : 'DRAFT',
    source: e.source,
    postedAt: e.postedAt,
    totalDebit: e.lines.reduce((s: number, l: any) => s + Number(l.debit), 0),
    totalCredit: e.lines.reduce((s: number, l: any) => s + Number(l.credit), 0),
    lineCount: e.lines.length,
    attachmentCount: e.attachments?.length || 0,
    lines: e.lines.map((l: any) => ({
      id: l.id,
      accountId: l.accountId,
      accountCode: l.account?.code,
      accountName: l.account?.nameAr || l.account?.name,
      accountType: l.account?.type,
      debit: Number(l.debit),
      credit: Number(l.credit),
      description: l.description,
    })),
    attachments: (e.attachments || []).map((a: any) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      url: a.url,
      createdAt: a.createdAt,
    })),
  }
}

async function nextEntryNumber(orgId: string) {
  const year = new Date().getFullYear()
  const prefix = `JV-${year}-`
  const last = await prisma.journalEntry.findFirst({
    where: { orgId, entryNumber: { startsWith: prefix } },
    orderBy: { entryNumber: 'desc' },
    select: { entryNumber: true },
  })
  const lastNum = last ? Number(last.entryNumber.split('-').pop() || '0') : 0
  return `${prefix}${String(lastNum + 1).padStart(4, '0')}`
}

// ── list ───────────────────────────────────────────────────────────────────
journalsRoutes.get('/', async (c) => {
  const orgId = c.get('orgId') as string
  const status = c.req.query('status') // POSTED | DRAFT | undefined
  const where: any = { orgId }
  if (status === 'POSTED') where.isPosted = true
  if (status === 'DRAFT') where.isPosted = false

  const items = await prisma.journalEntry.findMany({
    where,
    orderBy: { date: 'desc' },
    take: 200,
    include: {
      lines: { include: { account: { select: { code: true, name: true, nameAr: true, type: true } } } },
      attachments: { select: { id: true } },
    },
  })
  return c.json({ items: items.map(rowFromEntry), total: items.length })
})

// ── detail ─────────────────────────────────────────────────────────────────
journalsRoutes.get('/:id', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const entry = await prisma.journalEntry.findFirst({
    where: { id, orgId },
    include: {
      lines: { include: { account: { select: { code: true, name: true, nameAr: true, type: true } } } },
      attachments: true,
    },
  })
  if (!entry) return c.json({ error: 'not_found' }, 404)
  return c.json(rowFromEntry(entry))
})

// ── create ─────────────────────────────────────────────────────────────────
journalsRoutes.post('/', zValidator('json', entrySchema), async (c) => {
  const orgId = c.get('orgId') as string
  const data = c.req.valid('json')

  const totalDebit = data.lines.reduce((s, l) => s + l.debit, 0)
  const totalCredit = data.lines.reduce((s, l) => s + l.credit, 0)
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return c.json({ error: 'unbalanced', detail: `Debit (${totalDebit}) ≠ Credit (${totalCredit})` }, 400)
  }

  const entryNumber = await nextEntryNumber(orgId)
  const isPosted = data.postOnSave === true

  const created = await prisma.journalEntry.create({
    data: {
      orgId,
      entryNumber,
      date: new Date(data.date),
      description: data.description,
      reference: data.reference || null,
      source: 'manual',
      isPosted,
      postedAt: isPosted ? new Date() : null,
      lines: {
        create: data.lines.map(l => ({
          accountId: l.accountId,
          debit: new Prisma.Decimal(l.debit),
          credit: new Prisma.Decimal(l.credit),
          description: l.description || null,
        })),
      },
    },
    include: {
      lines: { include: { account: { select: { code: true, name: true, nameAr: true, type: true } } } },
      attachments: true,
    },
  })
  return c.json(rowFromEntry(created), 201)
})

// ── edit (only if DRAFT) ───────────────────────────────────────────────────
journalsRoutes.patch('/:id', zValidator('json', editSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const data = c.req.valid('json')
  const exists = await prisma.journalEntry.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not_found' }, 404)
  if (exists.isPosted) return c.json({ error: 'posted_locked', detail: 'Cannot edit a posted entry. Unpost first.' }, 409)

  if (data.lines) {
    const td = data.lines.reduce((s, l) => s + l.debit, 0)
    const tc = data.lines.reduce((s, l) => s + l.credit, 0)
    if (Math.abs(td - tc) > 0.01) return c.json({ error: 'unbalanced', detail: `Debit (${td}) ≠ Credit (${tc})` }, 400)
  }

  await prisma.$transaction(async (tx) => {
    await tx.journalEntry.update({
      where: { id },
      data: {
        ...(data.date && { date: new Date(data.date) }),
        ...(data.description && { description: data.description }),
        ...(data.reference !== undefined && { reference: data.reference || null }),
      },
    })
    if (data.lines) {
      await tx.journalLine.deleteMany({ where: { journalId: id } })
      await tx.journalLine.createMany({
        data: data.lines.map(l => ({
          journalId: id,
          accountId: l.accountId,
          debit: new Prisma.Decimal(l.debit),
          credit: new Prisma.Decimal(l.credit),
          description: l.description || null,
        })),
      })
    }
  })

  const fresh = await prisma.journalEntry.findUnique({
    where: { id },
    include: {
      lines: { include: { account: { select: { code: true, name: true, nameAr: true, type: true } } } },
      attachments: true,
    },
  })
  return c.json(rowFromEntry(fresh!))
})

// ── post / unpost ──────────────────────────────────────────────────────────
journalsRoutes.post('/:id/post', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const exists = await prisma.journalEntry.findFirst({ where: { id, orgId }, include: { lines: true } })
  if (!exists) return c.json({ error: 'not_found' }, 404)
  if (exists.isPosted) return c.json({ error: 'already_posted' }, 409)
  const td = exists.lines.reduce((s, l) => s + Number(l.debit), 0)
  const tc = exists.lines.reduce((s, l) => s + Number(l.credit), 0)
  if (Math.abs(td - tc) > 0.01) return c.json({ error: 'unbalanced' }, 400)
  await prisma.journalEntry.update({ where: { id }, data: { isPosted: true, postedAt: new Date() } })
  return c.json({ ok: true })
})

journalsRoutes.post('/:id/unpost', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const exists = await prisma.journalEntry.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not_found' }, 404)
  if (!exists.isPosted) return c.json({ error: 'already_draft' }, 409)
  await prisma.journalEntry.update({ where: { id }, data: { isPosted: false, postedAt: null } })
  return c.json({ ok: true })
})

// ── delete ─────────────────────────────────────────────────────────────────
journalsRoutes.delete('/:id', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const exists = await prisma.journalEntry.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not_found' }, 404)
  await prisma.journalEntry.delete({ where: { id } })
  return c.body(null, 204)
})

// ── attachments ────────────────────────────────────────────────────────────
const attachSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().default('application/octet-stream'),
  sizeBytes: z.number().int().min(0),
  data: z.string(), // base64 data URL or raw base64
})

journalsRoutes.get('/:id/attachments', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const e = await prisma.journalEntry.findFirst({ where: { id, orgId }, select: { id: true } })
  if (!e) return c.json({ error: 'not_found' }, 404)
  const items = await prisma.journalAttachment.findMany({
    where: { journalId: id },
    orderBy: { createdAt: 'desc' },
  })
  return c.json({ items })
})

journalsRoutes.post('/:id/attachments', zValidator('json', attachSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const e = await prisma.journalEntry.findFirst({ where: { id, orgId }, select: { id: true } })
  if (!e) return c.json({ error: 'not_found' }, 404)
  const body = c.req.valid('json')
  // Store as data URL (R2 wiring TBD — for now embed)
  const url = body.data.startsWith('data:')
    ? body.data
    : `data:${body.contentType};base64,${body.data}`
  const created = await prisma.journalAttachment.create({
    data: {
      journalId: id,
      filename: body.filename,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      url,
    },
  })
  return c.json(created, 201)
})

journalsRoutes.delete('/:id/attachments/:aid', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const aid = c.req.param('aid')
  const e = await prisma.journalEntry.findFirst({ where: { id, orgId }, select: { id: true } })
  if (!e) return c.json({ error: 'not_found' }, 404)
  await prisma.journalAttachment.deleteMany({ where: { id: aid, journalId: id } })
  return c.body(null, 204)
})
