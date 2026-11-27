// The development voter flow (/prototype/voter): code formats, and checks
// that it stays development-only, camera-free and log-free.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  VOTER_CODE_PATTERN,
  isTestPhone,
  looksLikeVotingCode,
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
    assert.equal(normalizeVoterCode('ypm-test-2345-hjkm'), 'YPM-TEST-2345-HJKM')
    assert.equal(normalizeVoterCode(' YPM TEST 2345 HJKM '), 'YPM-TEST-2345-HJKM')
    assert.equal(normalizeVoterCode('YPMTEST2345HJKM'), 'YPM-TEST-2345-HJKM')
    assert.match('YPM-TEST-2345-HJKM', VOTER_CODE_PATTERN)
  })

  it('reject anything else, including the old 8-character format', () => {
    for (const bad of [
      '', 'YPM-TEST-2345', 'YPM-TEST-2345-HJK', 'XYZ-TEST-2345-HJKM', 'YPM-TE0T-2345-HJKM',
      'YPM-TEST-1345-HJKM', 'K7MQP-3XZRA',
    ]) {
      assert.equal(normalizeVoterCode(bad), null, bad)
    }
  })

  it('recognise an admin voting code, so the screen can redirect', () => {
    assert.equal(looksLikeVotingCode('K7MQP-3XZRA'), true)
    assert.equal(looksLikeVotingCode('YPM-TEST-2345-HJKM'), false)
  })

  it('the browser and the database agree on the format', async () => {
    const db = await freshDb()
    const rows = (await db.query(`select ypm_private.new_voter_code() c from generate_series(1, 200)`)).rows
    for (const { c } of rows) assert.equal(normalizeVoterCode(c), c)
    const r = await db.query(`select ypm_private.normalize_voter_code($1) n`, ['YPM-TEST-2345-HJKM'])
    assert.equal(r.rows[0].n, 'YPMTEST2345HJKM')
  })

  it('never overlap with real voting codes, in either direction', async () => {
    const db = await freshDb()
    const s = await login(db)
    const votingCodes = await issue(db, s, { count: 100, note: 'separation test' })
    for (const c of votingCodes) assert.equal(normalizeVoterCode(c.code), null, c.code)
    const r = await call(db, 'begin_ballot', {
      p_name: 'Test Person', p_phone: '08155500900', p_code: 'YPM-TEST-2345-HJKM',
    })
    assert.equal(r.status, 'invalid_code')
  })

  it('accepts only synthetic test numbers, and masks numbers', () => {
    assert.equal(isTestPhone('08155500001'), true)
    assert.equal(isTestPhone('08155500999'), true)
    assert.equal(isTestPhone('08155501000'), false)
    assert.equal(isTestPhone('08031234567'), false)
    assert.equal(maskPhone('08155500012'), '•••• 0012')
  })
})

describe('the development voter flow collects nothing it shouldn’t', () => {
  // The prototype and the production voter page (src/voter) it shares screens with.
  const files = [...filesUnder(root('src/prototype')), ...filesUnder(root('src/voter'))]
  const rel = (f) => f.slice(root('').length).replace(/\\/g, '/')

  it('has no camera, raw network, storage of codes, or logging', () => {
    const forbidden = [
      /getUserMedia/, /mediaDevices/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/,
      /sendBeacon/, /localStorage/, /indexedDB/, /console\./,
    ]
    assert.ok(files.length >= 15)
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const re of forbidden) assert.ok(!re.test(src), `${rel(f)} matches ${re}`)
    }
  })

  it('talks to Supabase only through connection.js (prototype) and VoterApp.jsx (voter page)', () => {
    for (const f of files) {
      if (['src/prototype/connection.js', 'src/voter/VoterApp.jsx'].includes(rel(f))) continue
      const src = readFileSync(f, 'utf8')
      assert.ok(!/supabaseClient|@supabase|supabase\.rpc/.test(src), `${rel(f)} uses Supabase directly`)
    }
  })

  it('uses sessionStorage only in the session store', () => {
    for (const f of files) {
      if (rel(f) === 'src/voter/session.js') continue
      assert.ok(!/sessionStorage/.test(readFileSync(f, 'utf8')), `${rel(f)} uses sessionStorage`)
    }
  })

  it('is only reachable in local development', () => {
    const app = readFileSync(root('src/App.jsx'), 'utf8')
    assert.match(app, /const VoterPrototype = import\.meta\.env\.DEV\s*\?\s*lazy\(/)
    assert.match(app, /VoterPrototype && path === '\/prototype\/voter'/)
    for (const f of filesUnder(root('src')).filter((p) => !p.includes(join('src', 'prototype')))) {
      if (f.endsWith('App.jsx')) continue
      assert.ok(!/prototype\//.test(readFileSync(f, 'utf8')), `${f} imports the prototype`)
    }
  })

  it('labels simulated results as simulated, not biometric', () => {
    const main = readFileSync(root('src/prototype/VoterPrototype.jsx'), 'utf8')
    assert.match(main, /Simulated verification · No camera is used/)
    assert.match(readFileSync(root('src/prototype/screens/Camera.jsx'), 'utf8'), /Simulated camera · nothing recorded/)
    assert.match(
      readFileSync(root('src/prototype/screens/Duplicate.jsx'), 'utf8'),
      /not the\s+result of any face comparison/,
    )
    assert.match(readFileSync(root('src/prototype/TesterPanel.jsx'), 'utf8'), /not a\s+biometric comparison/)
    assert.match(readFileSync(root('src/prototype/simulator.js'), 'utf8'), /simulated, not biometric/)
  })
})
