import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  OWNER_ORG_BOOTSTRAPS,
  buildOwnerOrgAccountPlan,
  summarizeOwnerOrgPlan,
  validateOwnerOrgPlan,
} from './owner-org-bootstrap.js'

describe('owner org bootstrap plan', () => {
  it('contains the requested owner organizations', () => {
    const slugs = OWNER_ORG_BOOTSTRAPS.map((org) => org.slug).sort()
    assert.deepEqual(slugs, ['ensidex', 'falcon-core'])
  })

  it('builds a classified chart of accounts without missing parents', () => {
    const validation = validateOwnerOrgPlan()
    assert.equal(validation.missingParents.length, 0)
    assert.equal(validation.requiredCodesPresent, true)
    assert.ok(validation.accountCount >= 50)
    assert.ok(validation.countsByType.ASSET > 0)
    assert.ok(validation.countsByType.LIABILITY > 0)
    assert.ok(validation.countsByType.EQUITY > 0)
    assert.ok(validation.countsByType.REVENUE > 0)
    assert.ok(validation.countsByType.EXPENSE > 0)
  })

  it('marks bank and cash accounts as payment-enabled assets', () => {
    const accounts = buildOwnerOrgAccountPlan()
    const operatingBank = accounts.find((account) => account.code === '11110')
    assert.equal(operatingBank?.type, 'ASSET')
    assert.equal(operatingBank?.subtype, 'bank')
    assert.equal(operatingBank?.allowPayment, true)
    assert.equal(operatingBank?.cashFlowType, 'OPERATING')
  })

  it('includes the minimum customer, product, invoice, and bill samples for verification', () => {
    const summary = summarizeOwnerOrgPlan()
    for (const org of summary) {
      assert.ok(org.customers >= 2)
      assert.ok(org.suppliers >= 2)
      assert.ok(org.products >= 3)
      assert.ok(org.invoices >= 3)
      assert.ok(org.bills >= 2)
    }
  })
})
