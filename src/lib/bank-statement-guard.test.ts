import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bankStatementBlockedResponse,
  detectBankStatement,
} from './bank-statement-guard.js'

test('statement-like extraction is detected and blocked', () => {
  const result = detectBankStatement({
    extracted: { docType: 'STATEMENT', total: 1250, confidence: 0.9 },
    text: 'Account Statement\nAccount number SA1234567890123456789012\nOpening balance 100\n2026-05-01 credit 200 balance 300\n2026-05-02 debit 50 balance 250\n2026-05-03 debit 25 balance 225\nClosing balance 225',
  })

  assert.equal(result.isBankStatement, true)
})

test('generic statement classification without bank structure is not blocked', () => {
  const result = detectBankStatement({
    extracted: { docType: 'STATEMENT', vendor: 'ENTIX.IO', total: 283436.99, confidence: 0.8 },
    text: 'Screenshot of an expenses dashboard table',
  })

  assert.equal(result.isBankStatement, false)
})

test('Arabic bank statement filename and text are detected', () => {
  const result = detectBankStatement({
    fileName: 'كشف حساب مايو.pdf',
    text: 'كشف الحساب\nرقم الحساب SA1234567890123456789012\nالرصيد الافتتاحي 100\n2026-05-01 ايداع 200\n2026-05-02 سحب 50\n2026-05-03 تحويل 30\nالرصيد الختامي 220',
  })

  assert.equal(result.isBankStatement, true)
})

test('English bank statement filename and account statement text are detected', () => {
  const fromFilename = detectBankStatement({ fileName: 'bank_statement.pdf' })
  const fromText = detectBankStatement({ text: 'Account Statement\nOpening balance 10\nClosing balance 25' })

  assert.equal(fromFilename.isBankStatement, true)
  assert.equal(fromText.isBankStatement, true)
})

test('receipt-like extraction is not blocked', () => {
  const result = detectBankStatement({
    fileName: 'receipt-429299.jpg',
    extracted: {
      docType: 'RECEIPT',
      vendor: 'Elite Trading Company',
      documentNumber: '429299',
      total: 290,
      lineItems: [{ description: 'Product', quantity: 1, unitPrice: 290, subtotal: 290 }],
    },
  })

  assert.equal(result.isBankStatement, false)
})

test('blocked helper response uses the bank statement review status', () => {
  const response = bankStatementBlockedResponse(['filename:bank_statement.pdf'])

  assert.equal(response.status, 'needs_bank_statement_review')
  assert.equal(response.documentType, 'bank_statement')
})
