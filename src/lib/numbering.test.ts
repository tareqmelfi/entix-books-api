import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildNextNumber,
  findUnsupportedNumberingTokens,
  hasLegacyPlaceholder,
  normalizeContactShortCode,
} from './numbering.js'

const june2026 = new Date('2026-06-03T12:00:00Z')

describe('numbering helpers', () => {
  it('builds the current recommended invoice format', () => {
    const number = buildNextNumber('EN-INV-{YYYY}{MM}-', 4, 1, null, { now: june2026, docCode: 'INV' })
    assert.equal(number, 'EN-INV-202606-0001')
  })

  it('supports client and explicit sequence tokens', () => {
    const number = buildNextNumber('EN-{CLIENT}-INV-{YYYY}{MM}-{SEQ}', 4, 1, null, {
      now: june2026,
      clientCode: 'SNBL',
      docCode: 'INV',
    })
    assert.equal(number, 'EN-SNBL-INV-202606-0001')
  })

  it('normalizes short codes and catches unsafe prefixes', () => {
    assert.equal(normalizeContactShortCode('snbl'), 'SNBL')
    assert.throws(() => normalizeContactShortCode('SNBLA'), /short_code_too_long/)
    assert.deepEqual(findUnsupportedNumberingTokens('EN-{BAD}-INV-'), ['BAD'])
    assert.equal(hasLegacyPlaceholder('EN-XXXX-INV-'), true)
  })
})
