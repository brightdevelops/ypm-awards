// Phase 3.1 voter-registration prototype: simulated only. These tests check
// that it stays that way, and that voter codes can't be confused with the
// admin-issued voting codes from migration 001.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEMO_RETURNING,
  DEMO_SUBMITTED,
  VOTER_CODE_PATTERN,
  demoVoterCode,
  maskPhone,
  normalizeVoterCode,
} from '../../src/prototype/simulator.js'
import { freshDb, call, login, issue } from '../db/helpers.mjs'

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url))

function filesUnder(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? filesUnder(p) : [p]
  })
}

describe('voter codes', () => {
  it('accept their own format in any case or spacing', () => {
    assert.equal(normalizeVoterCode('ypm-test-2345'), 'YPM-TEST-2345')
    assert.equal(normalizeVoterCode(' YPM TEST 2345 '), 'YPM-TEST-2345')
    assert.equal(normalizeVoterCode('YPMTEST2345'), 'YPM-TEST-2345')
  })

  it('reject anything else', () => {
    for (const bad of ['', 'YPM-TEST-234', 'XYZ-TEST-2345', 'YPM-TE0T-2345', 'YPM-TEST-1345', 'K7MQP-3XZRA']) {
      assert.equal(normalizeVoterCode(bad), null, bad)
    }
  })

  it('demo codes are valid and generated codes match the pattern', () => {
    assert.equal(normalizeVoterCode(DEMO_RETURNING.code), DEMO_RETURNING.code)
    assert.equal(normalizeVoterCode(DEMO_SUBMITTED.code), DEMO_SUBMITTED.code)
    for (let i = 0; i < 200; i++) assert.match(demoVoterCode(), VOTER_CODE_PATTERN)
    assert.equal(demoVoterCode(() => 0), 'YPM-AAAA-AAAA')
  })

  it('never overlap with real voting codes, in either direction', async () => {
    const db = await freshDb()
    const s = await login(db)
    const votingCodes = await issue(db, s, { count: 100, note: 'separation test' })
    for (const c of votingCodes) assert.equal(normalizeVoterCode(c.code), null, c.code)

    // The voting system refuses a voter code as a voting code.
    const r = await call(db, 'begin_ballot', {
      p_name: 'Test Person',
      p_phone: '08155550000',
      p_code: demoVoterCode(),
    })
    assert.equal(r.status, 'invalid_code')
  })

  it('masks phone numbers', () => {
    assert.equal(maskPhone('08012345678'), '•••• 5678')
    assert.equal(maskPhone(''), '')
  })
})

describe('the prototype collects and sends nothing', () => {
  const files = filesUnder(root('src/prototype'))

  it('has no camera, network, database, storage or logging calls', () => {
    const forbidden = [
      /getUserMedia/, /mediaDevices/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/,
      /sendBeacon/, /supabaseClient/, /@supabase/, /\.rpc\(/, /localStorage/, /sessionStorage/, /indexedDB/, /console\./,
    ]
    assert.ok(files.length >= 10)
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const re of forbidden) assert.ok(!re.test(src), `${f} matches ${re}`)
    }
  })

  it('is only reachable in local development', () => {
    const app = readFileSync(root('src/App.jsx'), 'utf8')
    assert.match(app, /const VoterPrototype = import\.meta\.env\.DEV\s*\?\s*lazy\(/)
    assert.match(app, /VoterPrototype && path === '\/prototype\/voter'/)
    // Nothing else imports it.
    for (const f of filesUnder(root('src')).filter((p) => !p.includes(`${join('src', 'prototype')}`))) {
      if (f.endsWith('App.jsx')) continue
      assert.ok(!/prototype\//.test(readFileSync(f, 'utf8')), `${f} imports the prototype`)
    }
  })

  it('labels itself as a prototype with simulated results', () => {
    const main = readFileSync(root('src/prototype/VoterPrototype.jsx'), 'utf8')
    assert.match(main, /Prototype/)
    assert.match(main, /Simulated results/)
    const camera = readFileSync(root('src/prototype/screens/Camera.jsx'), 'utf8')
    assert.match(camera, /Simulated camera · nothing recorded/)
  })
})
