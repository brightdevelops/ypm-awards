// Simulated browser, Phase 4: the real screens with the simulated provider
// (migration 005). The voter flow end to end through the tester panel, and
// the admin tab's review reasons, late conflicts and 30-day clean-up.
// Synthetic identities only (0815550 08xx). No camera, no biometric data.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  installDom, startVite, mount, setRpc, waitFor, button, typeInto, text, sleep,
} from './dom-setup.mjs'
import { adminReply } from '../../../src/lib/rpcErrors.js'
import { freshDb, call, sql, login, LEADER_KEY, DEV_SIM_SQL, PROVIDER_SQL } from '../../db/helpers.mjs'

const CV = 'draft-2026-11-dev'
const CODE = /YPM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/
// The real deliveries are due after 2 s; waiting up to 6 s covers that.
// Deliveries are due after 2 s; waiting up to 6 s covers that.
const FAST = { firstPollMs: 30, maxPollMs: 300, slowAfterMs: 200, giveUpAfterMs: 6000 }

let vite
let VoterPrototype
let VotersTab
let win

before(async () => {
  win = installDom('http://localhost:5173/prototype/voter')
  vite = await startVite()
  VoterPrototype = (await vite.ssrLoadModule('/src/prototype/VoterPrototype.jsx')).default
  VotersTab = (await vite.ssrLoadModule('/src/components/admin/VotersTab.jsx')).default
})
after(async () => {
  await vite?.close()
  await win?.happyDOM.close()
})
beforeEach(() => window.sessionStorage.clear())

async function devDb() {
  const db = await freshDb({ migrate: '005' })
  await sql(db, `update ypm_private.deployment set environment = 'development'`)
  await sql(db, `update settings set verification_provider = 'simulated', registration_mode = 'optional' where id = 1`)
  await db.exec(DEV_SIM_SQL)
  await db.exec(PROVIDER_SQL)
  return db
}

const radio = (name, value) => document.querySelector(`input[name=${name}][value=${value}]`)

// Tester signs in on the panel and picks the scenario; then the voter
// registers, agrees, and runs the (simulated, camera-free) face check.
async function registerWithProvider(name, phone, deliveryId) {
  await waitFor(() => button('First time? Register to vote'), 'login screen')
  typeInto(document.querySelector('.testerForm input[type=password]'), LEADER_KEY)
  await sleep(20)
  button('Sign in as tester').click()
  await waitFor(() => text().includes('Signed in as tester'), 'tester signed in')
  radio('delivery', deliveryId).click()
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
  button('Start face check').click() // the simulated, camera-free check
}

describe('voter flow with the simulated provider (simulated browser)', () => {
  it('normal delivery: the signed result arrives, and the voter gets their code once', async () => {
    const db = await devDb()
    setRpc(db)
    const view = mount(VoterPrototype, { timing: FAST })
    try {
      await registerWithProvider('Test Async', '08155500801', 'normal')
      await waitFor(() => CODE.test(text()), 'voter code shown', 30000)
      const events = (await sql(db, `select result from ypm_private.verification_events`)).map((e) => e.result)
      assert.deepEqual(events, ['applied'])
      assert.equal((await sql(db, `select count(*)::int n from voters where phone = '08155500801'`))[0].n, 1)
    } finally {
      view.unmount()
    }
  })

  it('bad signature: "still checking", then a calm notice; nothing changes', async () => {
    const db = await devDb()
    setRpc(db)
    const view = mount(VoterPrototype, { timing: FAST })
    try {
      await registerWithProvider('Test Badsig', '08155500802', 'bad_signature')
      await waitFor(() => text().includes('Still checking'), 'still checking', 30000)
      await waitFor(() => text().includes('Your registration is saved'), 'still-pending notice', 30000)
      assert.ok(!CODE.test(text()))
      assert.equal((await sql(db, `select status from voter_registrations where phone = '08155500802'`))[0].status, 'pending')
      assert.deepEqual((await sql(db, `select result from ypm_private.verification_events`)).map((e) => e.result), ['bad_signature'])
    } finally {
      view.unmount()
    }
  })
})

const adminRpcFor = (db, session) => async (fn, args = {}) => {
  let res
  let err = null
  try {
    res = await call(db, fn, { p_session: session, ...args })
  } catch (e) {
    err = e
  }
  return adminReply(res, err)
}

async function providerResult(db, s, name, phone, outcome, scenario, { claim = false } = {}) {
  const r = await call(db, 'voter_registration_start', { p_name: name, p_phone: phone, p_consent_version: CV, p_adult: true })
  await call(db, 'dev_provider_start', {
    p_admin_session: s, p_registration_token: r.registration_token, p_outcome: outcome,
    p_reason_code: null, p_delay_seconds: 0, p_scenario: scenario,
  })
  const relay = async () => {
    const out = await call(db, 'dev_provider_outbox', { p_admin_session: s })
    for (const d of out.deliveries) await call(db, 'dev_provider_callback', { p_body: d.body, p_signature: d.signature })
  }
  await relay()
  if (claim) {
    await call(db, 'voter_registration_claim', { p_token: r.registration_token })
    await sql(db, `update ypm_private.sim_outbox set deliver_after = now()`)
    await relay()
  }
}

describe('admin tab with the simulated provider (simulated browser)', () => {
  it('shows why each review waits, warns on conflicts and late conflicts; clean-up keeps ballots', async () => {
    const db = await devDb()
    const s = await login(db)
    await providerResult(db, s, 'Test Dupreason', '08155500803', 'review', 'normal')
    // Approved then contradicted before any claim: goes to review.
    const r = await call(db, 'voter_registration_start', { p_name: 'Test Conflicting', p_phone: '08155500804', p_consent_version: CV, p_adult: true })
    await call(db, 'dev_provider_start', { p_admin_session: s, p_registration_token: r.registration_token, p_outcome: 'approved', p_reason_code: null, p_delay_seconds: 0, p_scenario: 'conflict' })
    await sql(db, `update ypm_private.sim_outbox set deliver_after = now()`)
    const out = await call(db, 'dev_provider_outbox', { p_admin_session: s })
    for (const d of out.deliveries) await call(db, 'dev_provider_callback', { p_body: d.body, p_signature: d.signature })
    // Claimed first, contradicted later: a late conflict.
    await providerResult(db, s, 'Test Lateone', '08155500805', 'approved', 'conflict', { claim: true })

    const view = mount(VotersTab, { adminRpc: adminRpcFor(db, s), adminLabel: 'leader' })
    try {
      await waitFor(() => /Reviews waiting \(2\)/.test(text()), 'reviews loaded')
      await waitFor(() => text().includes('Conflicting simulated results: decide in person'), 'conflict reason')
      assert.match(text(), /Simulated “possible duplicate” \(not biometric\) · 1 provider result/)
      assert.match(text(), /sent contradicting results\. Check this person in person/)
      assert.match(text(), /Check this account in person/)
      assert.match(text(), /Test Lateone \(•••• 0805\): Simulated “possible duplicate”/)
      assert.ok(!text().includes('08155500805'), 'numbers masked')
      assert.match(text(), /deleted 30 days after they finish/)

      // Clean up: nothing old yet.
      button('Clean up now').click()
      await waitFor(() => text().includes('Nothing older than 30 days to delete.'), 'nothing to delete')

      // Age everything finished by 31 days, then clean up.
      const ballots = (await sql(db, `select count(*)::int n from ballots`))[0].n
      await db.exec(`
        update voter_registrations set created_at = created_at - interval '31 days', expires_at = expires_at - interval '31 days';
        update ypm_private.verification_events set received_at = received_at - interval '31 days';
        update ypm_private.sim_outbox set created_at = created_at - interval '31 days'`)
      button('Clean up now').click()
      await waitFor(() => /Deleted 1 finished registration\(s\)/.test(text()), 'deleted the claimed one')
      assert.match(text(), /Ballots, votes and accounts are kept/)
      assert.equal((await sql(db, `select count(*)::int n from ballots`))[0].n, ballots)
      assert.equal((await sql(db, `select count(*)::int n from voters where phone = '08155500805'`))[0].n, 1, 'account kept')
      assert.equal((await sql(db, `select count(*)::int n from voter_registrations where status = 'review'`))[0].n, 2, 'reviews kept')
    } finally {
      view.unmount()
    }
  })

  it('on a database without 005 the tab looks as before (no clean-up link, no errors)', async () => {
    const db = await freshDb() // through 004
    await sql(db, `update ypm_private.deployment set environment = 'development'`)
    await sql(db, `update settings set verification_provider = 'simulated', registration_mode = 'optional' where id = 1`)
    const s = await login(db)
    const view = mount(VotersTab, { adminRpc: adminRpcFor(db, s), adminLabel: 'leader' })
    try {
      await waitFor(() => /Reviews waiting \(0\)/.test(text()), 'loaded')
      assert.ok(button('Clean up now'), 'offered until the server says it is missing')
      button('Clean up now').click()
      await waitFor(() => !button('Clean up now'), 'hidden once missing')
      assert.ok(!text().includes('Couldn’t clean up'))
    } finally {
      view.unmount()
    }
  })
})
