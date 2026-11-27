// The production voter notice (src/voter/consentNotice.js) can't be marked
// approved while it still has gaps, and says nothing about biometrics
// except that none are collected.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CONSENT_APPROVED, CONSENT_NOTICE, CONSENT_VERSION } from '../../src/voter/consentNotice.js'
import { LIVE_SQL } from '../db/helpers.mjs'

const text = CONSENT_NOTICE.map((s) => `${s.heading} ${s.body}`).join('\n')

describe('production voter notice', () => {
  it('can’t be approved while anything is marked missing', () => {
    if (CONSENT_APPROVED) assert.ok(!/\[MISSING|TO BE CONFIRMED/i.test(text), 'fill in every [MISSING: …] first')
    else assert.ok(true)
  })

  it('matches the version migration 007 publishes', () => {
    assert.match(LIVE_SQL, new RegExp(`'${CONSENT_VERSION}'`))
  })

  it('collects no biometric data and says so; points under-18s to the voting page', () => {
    assert.match(text, /No photo, face scan, fingerprint or ID document is taken or stored/)
    assert.ok(!/face check|we scan|template/i.test(text))
    assert.match(text, /under 18 you can still vote on the main voting page/)
  })
})
