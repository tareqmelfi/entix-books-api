/**
 * Payroll · GOSI calculations + SIF (مدد) file generator (UX-60)
 *
 * GOSI (General Organization for Social Insurance · KSA):
 *   For Saudi employees (salary capped at 45,000 SAR/month for contribution base):
 *     Employee:   9.00% Annuities + 0.75% SANED (unemployment, optional) = 9.00–9.75%
 *     Employer:   9.00% Annuities + 2.00% Occupational Hazards + 0.75% SANED = 11.00–11.75%
 *   For Non-Saudi employees:
 *     Employer only: 2.00% Occupational Hazards
 *     Employee: nil
 *
 * Reference base = Basic Salary + Housing Allowance (per GOSI rules).
 *
 * Other deductions handled separately:
 *   - Income tax: KSA = 0% for residents · withhold for non-residents per category
 *   - Loans / advances: ad-hoc deductions
 *
 * SIF (Salary Information File) for Mudad:
 *   Generated as CSV per Mudad spec · uploaded to GOSI portal monthly.
 */

const GOSI_SALARY_CAP = 45_000 // SAR/month · contribution base ceiling
const GOSI_SALARY_FLOOR = 1_500 // SAR/month · minimum base for Saudi employees

export interface PayrollEmployeeInput {
  employeeId: string
  /** "SA" for Saudi · anything else for expat */
  nationalityCode: string
  basicSalary: number
  housingAllowance?: number
  transportAllowance?: number
  otherAllowances?: number
  /** Optional · ad-hoc deductions (loans, advances, etc.) */
  otherDeductions?: number
  /** Toggle SANED contribution (0.75%) · default true for Saudis */
  sanedEnabled?: boolean
}

export interface PayrollEmployeeResult {
  employeeId: string
  isSaudi: boolean
  grossSalary: number
  gosiBase: number
  employeeGosi: number
  employerGosi: number
  totalDeductions: number
  netSalary: number
  breakdown: {
    annuities: { employee: number; employer: number }
    occupationalHazards: { employer: number }
    saned: { employee: number; employer: number }
    otherDeductions: number
  }
}

export function calculatePayroll(input: PayrollEmployeeInput): PayrollEmployeeResult {
  const {
    employeeId,
    nationalityCode,
    basicSalary,
    housingAllowance = 0,
    transportAllowance = 0,
    otherAllowances = 0,
    otherDeductions = 0,
    sanedEnabled = true,
  } = input

  const isSaudi = nationalityCode.toUpperCase() === 'SA'
  const grossSalary = basicSalary + housingAllowance + transportAllowance + otherAllowances

  // GOSI base = Basic + Housing only · capped + floored
  const rawBase = basicSalary + housingAllowance
  const gosiBase = Math.min(GOSI_SALARY_CAP, Math.max(isSaudi ? GOSI_SALARY_FLOOR : rawBase, rawBase))

  let annuitiesEmployee = 0
  let annuitiesEmployer = 0
  let occupationalEmployer = 0
  let sanedEmployee = 0
  let sanedEmployer = 0

  if (isSaudi) {
    annuitiesEmployee = round2(gosiBase * 0.09)
    annuitiesEmployer = round2(gosiBase * 0.09)
    occupationalEmployer = round2(gosiBase * 0.02)
    if (sanedEnabled) {
      sanedEmployee = round2(gosiBase * 0.0075)
      sanedEmployer = round2(gosiBase * 0.0075)
    }
  } else {
    occupationalEmployer = round2(gosiBase * 0.02)
  }

  const employeeGosi = annuitiesEmployee + sanedEmployee
  const employerGosi = annuitiesEmployer + occupationalEmployer + sanedEmployer
  const totalDeductions = employeeGosi + otherDeductions
  const netSalary = round2(grossSalary - totalDeductions)

  return {
    employeeId,
    isSaudi,
    grossSalary: round2(grossSalary),
    gosiBase: round2(gosiBase),
    employeeGosi: round2(employeeGosi),
    employerGosi: round2(employerGosi),
    totalDeductions: round2(totalDeductions),
    netSalary,
    breakdown: {
      annuities: { employee: annuitiesEmployee, employer: annuitiesEmployer },
      occupationalHazards: { employer: occupationalEmployer },
      saned: { employee: sanedEmployee, employer: sanedEmployer },
      otherDeductions,
    },
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ─── SIF (مدد) file generator ────────────────────────────────────────────────

export interface SifEmployeeRow {
  iban: string // 24-char SA IBAN
  basicSalary: number
  housingAllowance?: number
  otherAllowances?: number
  deductions?: number
  netSalary: number
  /** 10-digit Iqama or National ID */
  identifier: string
  /** ID type: 1 = National, 2 = Iqama */
  identifierType: 1 | 2
  /** Bank ID (4-letter SWIFT prefix · "RJHI" for AlRajhi etc.) */
  bankId?: string
}

export interface SifFileInput {
  employerId: string // GOSI employer number
  /** Establishment / company ID */
  establishmentId: string
  /** Period: "YYYY-MM" */
  period: string
  /** Currency · "SAR" */
  currency?: string
  rows: SifEmployeeRow[]
}

/**
 * Generate the SIF CSV per Mudad spec (simplified · v1.4 columns).
 *
 * Column order:
 *   IDType, IDNumber, BasicSalary, HousingAllowance, OtherAllowances, Deductions, NetPay, IBAN, BankID, NotesField
 *
 * Note: Mudad accepts headerless CSV with comma delimiter · UTF-8 with BOM.
 */
export function generateSifCsv(input: SifFileInput): string {
  const BOM = '﻿'
  const lines: string[] = []
  for (const r of input.rows) {
    const cols = [
      r.identifierType,
      r.identifier,
      r.basicSalary.toFixed(2),
      (r.housingAllowance || 0).toFixed(2),
      (r.otherAllowances || 0).toFixed(2),
      (r.deductions || 0).toFixed(2),
      r.netSalary.toFixed(2),
      r.iban,
      r.bankId || '',
      '', // notes
    ]
    lines.push(cols.join(','))
  }
  return BOM + lines.join('\r\n') + '\r\n'
}

/**
 * Validate basic SIF row constraints before generation.
 * Returns array of error strings · empty if valid.
 */
export function validateSifRows(rows: SifEmployeeRow[]): string[] {
  const errs: string[] = []
  rows.forEach((r, i) => {
    if (!/^SA\d{22}$/.test(r.iban || '')) errs.push(`Row ${i + 1}: invalid IBAN (must be SA + 22 digits)`)
    if (!r.identifier || r.identifier.length !== 10) errs.push(`Row ${i + 1}: identifier must be 10 digits`)
    if (r.netSalary < 0) errs.push(`Row ${i + 1}: net salary cannot be negative`)
    const expected = (r.basicSalary || 0) + (r.housingAllowance || 0) + (r.otherAllowances || 0) - (r.deductions || 0)
    if (Math.abs(expected - r.netSalary) > 0.5) {
      errs.push(`Row ${i + 1}: net salary mismatch (expected ${expected.toFixed(2)})`)
    }
  })
  return errs
}
