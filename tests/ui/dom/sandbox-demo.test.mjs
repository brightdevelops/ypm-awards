// Simulated browser, Phase 5 sandbox demonstration: the real voter screens
// with the "Sandbox vendor through the webhook" delivery. The page opens a
// sandbox session and shows its reference; the sandbox vendor (here: a
// signed webhook built exactly as scripts/sandbox-vendor.mjs builds it) goes
// through the provider-webhook handler as the service role. Synthetic
// identities (0815550 07 5x); no camera; the vendor decides the outcome, so
// nothing about anyone's face is analysed.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  installDom, startVite, mount, setRpc, waitFor, button, typeInto, text, sleep,
} from './dom-setup.mjs'
import { handle } from '../../../supabase/functions/provider-webhook/handler.ts'
import { sandbox, signSandbox, SIGNATURE_HEADER } from '../../../supabase/functions/provider-webhook/adapters/sandbox.ts'
import { freshDb, call, sql, LEADER_KEY, DEV_SIM_SQL, PROVIDER_SQL } from '../../db/helpers.mjs'

const CODE = /YPM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/
const SECRET = 'sandbox-demo-secret-0123456789abcdef'
const FAST = { firstPollMs: 30, maxPollMs: 200, slowAfterMs: 5000, giveUpAfterMs: 60000 }

let vite
let VoterPrototype
let win

before(async () => {
  win = installDom('http://localhost:5173/prototype/voter')
  vite = await startVite()
  VoterPrototype = (await vite.ssrLoadModule('/src/prototype/VoterPrototype.jsx')).default
})
after(async () => {
  await vite?.close()
  await win?.happyDOM.close()
})
beforeEach(() => window.sessionStorage.clear())

async function devDb() {
  const db = await freshDb({ migrate: '006' })
  await sql(db, `update ypm_private.deployment set environment = 'development'`)
  await sql(db, `update settings set verification_provider = 'simulated', registration_mode = 'optional' where id = 1`)
  await db.exec(DEV_SIM_SQL)
  await db.exec(PROVIDER_SQL)
  return db
}

// The sandbox vendor: one signed webhook through the function's handler,
// which calls the database as the service role.
async function vendorSends(db, ref, status, reason = null) {
  const now = Math.floor(Date.now() / 1000)
  const body = JSON.stringify({
    id: `evt_${Math.random().toString(36).slice(2, 12)}`, type: 'verification.completed', created: now,
    data: { session_id: ref, status, reason },
  })
  const req = new Request('http://127.0.0.1:8787/functions/v1/provider-webhook', {
    method: 'POST', headers: { [SIGNATURE_HEADER]: await signSandbox(SECRET, body, now) }, body,
  })
  return handle(req, {
    adapters: { sandbox },
    env: { PROVIDER_ADAPTER: 'sandbox', SANDBOX_WEBHOOK_SECRET: SECRET },
    rpc: async (fn, args) => {
      try {
        return { ok: true, data: await call(db, fn, args, { role: 'service_role' }) }
      } catch {
        return { ok: false }
      }
    },
  })
}

async function startSandboxCheck(name, phone) {
  await waitFor(() => button('First time? Register to vote'), 'login screen')
  typeInto(document.querySelector('.testerForm input[type=password]'), LEADER_KEY)
  await sleep(20)
  button('Sign in as tester').click()
  await waitFor(() => text().includes('Signed in as tester'), 'tester signed in')
  document.querySelector('input[name=delivery][value=sandbox]').click()
  await sleep(20)
  button('First time? Register to vote').click()
  await waitFor(() => text().includes('Register to vote'), 'register screen')
  const [n, p] = document.querySelectorAll('.inner form input')
  typeInto(n, name)
  typeInto(p, phone)
  await sleep(20)
  button('Continue').click()
  await waitFor(() => document.querySelector('input[value=adult]'), 'consent screen')
  document.querySelector('input[value=adult]').click()
  await sleep(20)
  document.querySelector('.protoCheck input').click()
  await sleep(20)
  button('I agree, continue').click()
  await waitFor(() => button('Start face check'), 'camera screen')
  button('Start face check').click()
  await waitFor(() => document.querySelector('.sandboxCmd'), 'sandbox reference shown')
  const ref = document.querySelector('.sandboxCmd').textContent.match(/sbx_[0-9a-f]{64}/)[0]
  return ref
}

describe('sandbox demonstration (simulated browser)', () => {
  it('liveness passed: the vendor says verified, the voter gets their code', async () => {
    const db = await devDb()
    setRpc(db)
    const view = mount(VoterPrototype, { timing: FAST })
    try {
      const ref = await startSandboxCheck('Test Sandbox Pass', '08155500751')
      assert.equal((await sql(db, `select provider from ypm_private.provider_sessions where provider_ref = $1`, [ref]))[0].provider, 'sandbox')
      assert.equal((await vendorSends(db, ref, 'verified')).status, 200)
      await waitFor(() => CODE.test(text()), 'voter code shown')
      assert.ok(!document.querySelector('.sandboxCmd'), 'reference cleared once the result is in')
    } finally {
      view.unmount()
    }
  })

  it('liveness failed: the vendor says rejected (liveness); nothing is created', async () => {
    const db = await devDb()
    setRpc(db)
    const view = mount(VoterPrototype, { timing: FAST })
    try {
      const ref = await startSandboxCheck('Test Sandbox Fail', '08155500752')
      await vendorSends(db, ref, 'rejected', 'liveness')
      await waitFor(() => text().includes('We couldn’t complete the face check'), 'failed notice')
      assert.equal((await sql(db, `select reason_code from ypm_private.provider_sessions where provider_ref = $1`, [ref]))[0].reason_code, 'liveness_failed')
      assert.equal((await sql(db, `select count(*)::int n from voters`))[0].n, 0)
    } finally {
      view.unmount()
    }
  })

  it('possible duplicate person (the vendor’s claim): goes to a person for review, never auto-rejected', async () => {
    const db = await devDb()
    setRpc(db)
    const view = mount(VoterPrototype, { timing: FAST })
    try {
      const ref = await startSandboxCheck('Test Sandbox Dup', '08155500753')
      await vendorSends(db, ref, 'requires_review', 'duplicate')
      await waitFor(() => text().includes('We may already have you registered'), 'review screen')
      const [r] = await sql(db, `select r.status, s.reason_code from voter_registrations r
                                   join ypm_private.provider_sessions s on s.registration_id = r.id where s.provider_ref = $1`, [ref])
      assert.deepEqual(r, { status: 'review', reason_code: 'possible_duplicate' })
    } finally {
      view.unmount()
    }
  })
})

describe('local webhook runner (scripts/serve-webhook-local.mjs)', () => {
  const script = fileURLToPath(new URL('../../../scripts/serve-webhook-local.mjs', import.meta.url))
  const run = (env) => spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, encoding: 'utf8', timeout: 20000 })

  it('refuses any project but Development, and a missing key or short secret', () => {
    const prod = run({ SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'x', SANDBOX_WEBHOOK_SECRET: 'y'.repeat(40) })
    assert.equal(prod.status, 2)
    assert.match(prod.stderr, /must be the Development project/)
    const nokey = run({ SUPABASE_URL: 'https://vliytvqhjvuhulpvmuat.supabase.co', SANDBOX_WEBHOOK_SECRET: 'short' })
    assert.equal(nokey.status, 2)
    assert.match(nokey.stderr, /SUPABASE_SERVICE_ROLE_KEY and SANDBOX_WEBHOOK_SECRET/)
  })
})
