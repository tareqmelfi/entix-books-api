/**
 * Payroll routes · UX-60
 *
 * POST /api/payroll/calculate          { employees[] } → returns full payroll breakdown
 * POST /api/payroll/sif                { period, rows[] } → returns SIF CSV (text/csv)
 * POST /api/payroll/run                Persists a payroll run for a given period
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { calculatePayroll, generateSifCsv, validateSifRows } from '../lib/payroll.js'

export const payrollRoutes = new Hono()

const calcInputSchema = z.object({
  employees: z.array(z.object({
    employeeId: z.string(),
    nationalityCode: z.string().length(2).default('SA'),
    basicSalary: z.coerce.number().min(0),
    housingAllowance: z.coerce.number().min(0).optional(),
    transportAllowance: z.coerce.number().min(0).optional(),
    otherAllowances: z.coerce.number().min(0).optional(),
    otherDeductions: z.coerce.number().min(0).optional(),
    sanedEnabled: z.boolean().optional(),
  })).min(1),
})

const employeeInputSchema = calcInputSchema.shape.employees.element

payrollRoutes.post('/calculate', zValidator('json', calcInputSchema), async (c) => {
  const { employees } = c.req.valid('json')
  const results = employees.map(calculatePayroll)
  const totals = results.reduce((acc, r) => ({
    grossSalary: acc.grossSalary + r.grossSalary,
    employeeGosi: acc.employeeGosi + r.employeeGosi,
    employerGosi: acc.employerGosi + r.employerGosi,
    netSalary: acc.netSalary + r.netSalary,
    employerCost: acc.employerCost + r.grossSalary + r.employerGosi,
  }), { grossSalary: 0, employeeGosi: 0, employerGosi: 0, netSalary: 0, employerCost: 0 })
  return c.json({ results, totals })
})

const sifSchema = z.object({
  employerId: z.string(),
  establishmentId: z.string(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  currency: z.string().length(3).default('SAR'),
  rows: z.array(z.object({
    iban: z.string().regex(/^SA\d{22}$/, 'IBAN must be SA + 22 digits'),
    basicSalary: z.coerce.number().min(0),
    housingAllowance: z.coerce.number().min(0).optional(),
    otherAllowances: z.coerce.number().min(0).optional(),
    deductions: z.coerce.number().min(0).optional(),
    netSalary: z.coerce.number().min(0),
    identifier: z.string().length(10),
    identifierType: z.union([z.literal(1), z.literal(2)]),
    bankId: z.string().optional(),
  })).min(1),
})

payrollRoutes.post('/sif', zValidator('json', sifSchema), async (c) => {
  const data = c.req.valid('json')
  const errors = validateSifRows(data.rows)
  if (errors.length > 0) return c.json({ error: 'invalid_rows', errors }, 400)
  const csv = generateSifCsv(data)
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="SIF-${data.period}.csv"`)
  return c.body(csv)
})

// ── Persistent payroll settings/contracts/runs ─────────────────────────────

const payrollSettingsSchema = z.object({
  employerId: z.string().optional().nullable(),
  establishmentId: z.string().optional().nullable(),
  currency: z.string().length(3).default('SAR'),
})

payrollRoutes.get('/settings', async (c) => {
  const orgId = c.get('orgId') as string
  const settings = await prisma.payrollSetting.upsert({
    where: { orgId },
    update: {},
    create: { orgId, currency: 'SAR' },
  })
  return c.json(settings)
})

payrollRoutes.patch('/settings', zValidator('json', payrollSettingsSchema.partial()), async (c) => {
  const orgId = c.get('orgId') as string
  const data = c.req.valid('json')
  const settings = await prisma.payrollSetting.upsert({
    where: { orgId },
    update: data,
    create: { orgId, currency: data.currency || 'SAR', employerId: data.employerId || null, establishmentId: data.establishmentId || null },
  })
  return c.json(settings)
})

const contractSchema = z.object({
  contactId: z.string(),
  employeeNumber: z.string().optional().nullable(),
  jobTitle: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  nationalityCode: z.string().length(2).default('SA'),
  iban: z.string().optional().nullable(),
  bankId: z.string().optional().nullable(),
  basicSalary: z.coerce.number().min(0).default(0),
  housingAllowance: z.coerce.number().min(0).default(0),
  transportAllowance: z.coerce.number().min(0).default(0),
  otherAllowances: z.coerce.number().min(0).default(0),
  otherDeductions: z.coerce.number().min(0).default(0),
  sanedEnabled: z.boolean().default(true),
  startDate: z.string().optional().nullable(),
  endDate: z.string().optional().nullable(),
  status: z.string().default('ACTIVE'),
})

payrollRoutes.get('/contracts', async (c) => {
  const orgId = c.get('orgId') as string
  const items = await prisma.employeeContract.findMany({
    where: { orgId },
    include: { contact: { select: { id: true, displayName: true, email: true, phone: true, nationalId: true, country: true } } },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 500,
  })
  return c.json({ items, total: items.length })
})

payrollRoutes.post('/contracts', zValidator('json', contractSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const data = c.req.valid('json')
  const contact = await prisma.contact.findFirst({ where: { id: data.contactId, orgId, isEmployee: true } })
  if (!contact) return c.json({ error: 'invalid_employee' }, 400)
  const item = await prisma.employeeContract.upsert({
    where: { orgId_contactId: { orgId, contactId: data.contactId } },
    update: contractPatch(data),
    create: { orgId, ...contractPatch(data), contactId: data.contactId },
    include: { contact: true },
  })
  return c.json(item, 201)
})

payrollRoutes.patch('/contracts/:id', zValidator('json', contractSchema.partial()), async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const exists = await prisma.employeeContract.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not_found' }, 404)
  const data = c.req.valid('json')
  const item = await prisma.employeeContract.update({
    where: { id },
    data: contractPatch(data),
    include: { contact: true },
  })
  return c.json(item)
})

function contractPatch(data: Partial<z.infer<typeof contractSchema>>) {
  const patch: any = { ...data }
  delete patch.contactId
  if (data.basicSalary !== undefined) patch.basicSalary = new Prisma.Decimal(data.basicSalary)
  if (data.housingAllowance !== undefined) patch.housingAllowance = new Prisma.Decimal(data.housingAllowance)
  if (data.transportAllowance !== undefined) patch.transportAllowance = new Prisma.Decimal(data.transportAllowance)
  if (data.otherAllowances !== undefined) patch.otherAllowances = new Prisma.Decimal(data.otherAllowances)
  if (data.otherDeductions !== undefined) patch.otherDeductions = new Prisma.Decimal(data.otherDeductions)
  if (data.startDate !== undefined) patch.startDate = data.startDate ? new Date(data.startDate) : null
  if (data.endDate !== undefined) patch.endDate = data.endDate ? new Date(data.endDate) : null
  return patch
}

async function nextPayrollRunNumber(orgId: string) {
  const year = new Date().getFullYear()
  const prefix = `PAY-${year}-`
  const last = await prisma.payrollRun.findFirst({
    where: { orgId, runNumber: { startsWith: prefix } },
    orderBy: { runNumber: 'desc' },
    select: { runNumber: true },
  })
  const lastNum = last ? Number(last.runNumber.split('-').pop() || '0') : 0
  return `${prefix}${String(lastNum + 1).padStart(4, '0')}`
}

const runSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  runNumber: z.string().optional(),
  notes: z.string().optional().nullable(),
  employees: z.array(employeeInputSchema).optional(),
})

payrollRoutes.get('/runs', async (c) => {
  const orgId = c.get('orgId') as string
  const items = await prisma.payrollRun.findMany({
    where: { orgId },
    include: {
      lines: {
        include: { employee: { select: { id: true, displayName: true, email: true, nationalId: true } } },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return c.json({ items, total: items.length })
})

payrollRoutes.post('/run', zValidator('json', runSchema), async (c) => {
  const orgId = c.get('orgId') as string
  const auth = c.get('auth') as any
  const data = c.req.valid('json')

  let employees = data.employees || []
  let contractsByContact = new Map<string, any>()

  if (employees.length === 0) {
    const contracts = await prisma.employeeContract.findMany({
      where: { orgId, status: 'ACTIVE' },
      include: { contact: true },
    })
    contractsByContact = new Map(contracts.map((contract) => [contract.contactId, contract]))
    employees = contracts.map((contract) => ({
      employeeId: contract.contactId,
      nationalityCode: contract.nationalityCode,
      basicSalary: Number(contract.basicSalary),
      housingAllowance: Number(contract.housingAllowance),
      transportAllowance: Number(contract.transportAllowance),
      otherAllowances: Number(contract.otherAllowances),
      otherDeductions: Number(contract.otherDeductions),
      sanedEnabled: contract.sanedEnabled,
    }))
  } else {
    const employeeIds = employees.map((employee) => employee.employeeId)
    const [validEmployees, contracts] = await Promise.all([
      prisma.contact.findMany({ where: { orgId, id: { in: employeeIds }, isEmployee: true }, select: { id: true } }),
      prisma.employeeContract.findMany({ where: { orgId, contactId: { in: employeeIds } } }),
    ])
    if (validEmployees.length !== new Set(employeeIds).size) return c.json({ error: 'invalid_employee' }, 400)
    contractsByContact = new Map(contracts.map((contract) => [contract.contactId, contract]))
  }

  if (employees.length === 0) return c.json({ error: 'no_employees', message: 'لا يوجد موظفون أو عقود نشطة لحساب المسير' }, 400)

  const results = employees.map(calculatePayroll)
  const totals = results.reduce((acc, result) => ({
    grossSalary: acc.grossSalary + result.grossSalary,
    employeeGosi: acc.employeeGosi + result.employeeGosi,
    employerGosi: acc.employerGosi + result.employerGosi,
    netSalary: acc.netSalary + result.netSalary,
    employerCost: acc.employerCost + result.grossSalary + result.employerGosi,
  }), { grossSalary: 0, employeeGosi: 0, employerGosi: 0, netSalary: 0, employerCost: 0 })

  const runNumber = data.runNumber || (await nextPayrollRunNumber(orgId))
  const run = await prisma.payrollRun.create({
    data: {
      orgId,
      runNumber,
      period: data.period,
      status: 'DRAFT',
      currency: 'SAR',
      grossSalary: new Prisma.Decimal(totals.grossSalary),
      employeeGosi: new Prisma.Decimal(totals.employeeGosi),
      employerGosi: new Prisma.Decimal(totals.employerGosi),
      netSalary: new Prisma.Decimal(totals.netSalary),
      employerCost: new Prisma.Decimal(totals.employerCost),
      notes: data.notes || null,
      createdById: auth?.userId || null,
      lines: {
        create: results.map((result) => {
          const input = employees.find((employee) => employee.employeeId === result.employeeId)!
          const contract = contractsByContact.get(result.employeeId)
          return {
            orgId,
            employeeId: result.employeeId,
            contractId: contract?.id || null,
            nationalityCode: input.nationalityCode,
            basicSalary: new Prisma.Decimal(input.basicSalary),
            housingAllowance: new Prisma.Decimal(input.housingAllowance || 0),
            transportAllowance: new Prisma.Decimal(input.transportAllowance || 0),
            otherAllowances: new Prisma.Decimal(input.otherAllowances || 0),
            otherDeductions: new Prisma.Decimal(input.otherDeductions || 0),
            grossSalary: new Prisma.Decimal(result.grossSalary),
            gosiBase: new Prisma.Decimal(result.gosiBase),
            employeeGosi: new Prisma.Decimal(result.employeeGosi),
            employerGosi: new Prisma.Decimal(result.employerGosi),
            totalDeductions: new Prisma.Decimal(result.totalDeductions),
            netSalary: new Prisma.Decimal(result.netSalary),
            iban: contract?.iban || null,
            bankId: contract?.bankId || null,
          }
        }),
      },
    },
    include: { lines: { include: { employee: { select: { id: true, displayName: true, email: true, nationalId: true } } } } },
  })

  return c.json(run, 201)
})

payrollRoutes.post('/runs/:id/status', zValidator('json', z.object({ status: z.enum(['DRAFT', 'APPROVED', 'POSTED', 'PAID', 'CANCELLED']) })), async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const exists = await prisma.payrollRun.findFirst({ where: { id, orgId } })
  if (!exists) return c.json({ error: 'not_found' }, 404)
  const { status } = c.req.valid('json')
  const run = await prisma.payrollRun.update({ where: { id }, data: { status } })
  return c.json(run)
})

payrollRoutes.get('/runs/:id/sif', async (c) => {
  const orgId = c.get('orgId') as string
  const id = c.req.param('id')
  const [run, settings] = await Promise.all([
    prisma.payrollRun.findFirst({ where: { id, orgId }, include: { lines: { include: { employee: true } } } }),
    prisma.payrollSetting.findUnique({ where: { orgId } }),
  ])
  if (!run) return c.json({ error: 'not_found' }, 404)
  if (!settings?.employerId || !settings.establishmentId) return c.json({ error: 'wps_settings_missing' }, 400)
  const rows = run.lines.map((line) => ({
    iban: line.iban || '',
    basicSalary: Number(line.basicSalary),
    housingAllowance: Number(line.housingAllowance),
    otherAllowances: Number(line.otherAllowances),
    deductions: Number(line.totalDeductions),
    netSalary: Number(line.netSalary),
    identifier: line.employee.nationalId || '',
    identifierType: line.nationalityCode === 'SA' ? 1 as const : 2 as const,
    bankId: line.bankId || undefined,
  }))
  const errors = validateSifRows(rows)
  if (errors.length > 0) return c.json({ error: 'invalid_rows', errors }, 400)
  const csv = generateSifCsv({
    employerId: settings.employerId,
    establishmentId: settings.establishmentId,
    period: run.period,
    currency: settings.currency,
    rows,
  })
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="SIF-${run.period}.csv"`)
  return c.body(csv)
})
