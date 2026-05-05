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
