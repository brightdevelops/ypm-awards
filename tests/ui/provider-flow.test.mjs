// Phase 4: the voter page's side of the simulated provider (start a check,
// relay signed deliveries, poll with back-off), against a test database
// with migrations 001–005. Synthetic identities only (0815550 06xx).
// No camera, no biometric data.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createVoterApi } from '../../src/prototype/voterApi.js'
import { runProviderCheck, relayDue } from '../../src/prototype/providerRelay.js'
import { CONSENT_VERSION, DELIVERIES, OUTCOMES, VERIFY_TIMING } from '../../src/prototype/simulator.js'
import { freshDb, call, sql, LEADER_KEY, DEV_SIM_SQL, PROVIDER_SQL } from '../db/helpers.mjs'

const FAST = { firstPollMs: 20, maxPollMs: 60, slowAfterMs: 250, giveUpAfterMs: 900 }

const dbRpc = (db) => (fn, args) =>
  call(db, fn, args).then((data) => ({ data, error: null }), (error) => ({ data: null, error }))

async function setup({ production = false } = {}) {
  const db = await freshDb({ migrate: '005' })
  if (!production) {
    await sql(db, `update ypm_private.deployment set environment = 'development'`)
    await sql(db, `update settings set verification_provider = 'simulated', registration_mode = 'optional' where id = 1`)
    await db.exec(DEV_SIM_SQL)
    await db.exec(PROVIDER_SQL)
  }
  const api = createVoterApi(dbRpc(db))
  const tester = (await api.adminLogin(LEADER_KEY)).data.session
  return { db, api, tester }
}

async function check(ctx, phone, outcomeId, deliveryId, extra = {}) {
  const s = await ctx.api.start('Test Flow', phone, true, CONSENT_VERSION)
  assert.equal(s.status, 'ok', JSON.stringify(s))
  const o = OUTCOMES[outcomeId]
  let slow = 0
  const res = await runProviderCheck({
    api: ctx.api, adminSession: extra.tester ?? ctx.tester, token: s.data.registration_token,
    outcome: o.server, reasonCode: o.reason, delivery: { ...DELIVERIES[deliveryId], delay: 0 },
    timing: FAST, onSlow: () => { slow += 1 }, isCancelled: extra.isCancelled,
  })
  return { res, slow, token: s.data.registration_token }
}

describe('simulated provider, voter page side', () => {
  it('the scenarios and timings the tester can choose', () => {
    assert.deepEqual(Object.keys(DELIVERIES), ['normal', 'slow', 'duplicate', 'bad_signature', 'never', 'conflict', 'out_of_order', 'instant'])
    assert.equal(DELIVERIES.instant.scenario, null, 'the Phase 3 simulator stays available')
    assert.ok(DELIVERIES.slow.delay * 1000 > VERIFY_TIMING.slowAfterMs, 'slow really triggers "still checking"')
    assert.ok(VERIFY_TIMING.giveUpAfterMs >= 60000)
  })

  it('normal: approved, then the voter claims the code once', async () => {
    const ctx = await setup()
    const { res, slow, token } = await check(ctx, '08155500601', 'approved', 'normal')
    assert.deepEqual(res, { type: 'status', status: 'approved' })
    assert.equal(slow, 0)
    assert.equal((await ctx.api.claim(token)).status, 'ok')
  })

  it('duplicate delivery: one approval, one account', async () => {
    const ctx = await setup()
    const { res, token } = await check(ctx, '08155500602', 'approved', 'duplicate')
    assert.equal(res.status, 'approved')
    assert.equal((await ctx.api.claim(token)).status, 'ok')
    assert.equal((await sql(ctx.db, `select count(*)::int n from voters`))[0].n, 1)
    assert.deepEqual((await sql(ctx.db, `select result from ypm_private.verification_events order by id`)).map((e) => e.result), ['applied', 'duplicate'])
  })

  it('bad signature: refused, still pending, the page says "still checking" then stops waiting', async () => {
    const ctx = await setup()
    const { res, slow, token } = await check(ctx, '08155500603', 'approved', 'bad_signature')
    assert.deepEqual(res, { type: 'still_pending' })
    assert.equal(slow, 1)
    assert.equal((await ctx.api.status(token)).status, 'pending')
  })

  it('never delivered: still pending after waiting, nothing lost', async () => {
    const ctx = await setup()
    const { res, token } = await check(ctx, '08155500604', 'approved', 'never')
    assert.equal(res.type, 'still_pending')
    assert.equal((await ctx.api.status(token)).status, 'pending')
  })

  it('conflict: if the voter claims before the contradicting result, admins are told about it', async () => {
    const ctx = await setup()
    const { res, token } = await check(ctx, '08155500605', 'approved', 'conflict')
    assert.equal(res.status, 'approved', 'the first result arrives first')
    assert.equal((await ctx.api.claim(token)).status, 'ok')
    // The contradicting "possible duplicate" arrives after the account exists.
    await sql(ctx.db, `update ypm_private.sim_outbox set deliver_after = now() where delivered_at is null`)
    assert.equal(await relayDue(ctx.api, ctx.tester), 'ok')
    assert.equal((await ctx.api.status(token)).status, 'claimed', 'a late result never undoes an account')
    const d = await call(ctx.db, 'admin_review_details', { p_session: ctx.tester })
    assert.equal(d.late_conflicts.length, 1)
    assert.deepEqual(
      [d.late_conflicts[0].full_name, d.late_conflicts[0].phone, d.late_conflicts[0].outcome, d.late_conflicts[0].reason_code],
      ['Test Flow', '•••• 0605', 'review', 'possible_duplicate'],
    )
    assert.equal((await sql(ctx.db, `select count(*)::int n from admin_audit where action = 'verification_conflict_after_claim'`))[0].n, 1)
  })

  it('conflict before a claim goes to review; out of order keeps the newer result', async () => {
    const ctx = await setup()
    const s = await ctx.api.start('Test Conflict', '08155500613', true, CONSENT_VERSION)
    const token = s.data.registration_token
    await ctx.api.providerStart(ctx.tester, token, 'approved', null, 0, 'conflict')
    await sql(ctx.db, `update ypm_private.sim_outbox set deliver_after = now()`) // both arrive together
    await relayDue(ctx.api, ctx.tester)
    assert.equal((await ctx.api.status(token)).status, 'review')
    assert.equal((await check(ctx, '08155500606', 'approved', 'out_of_order')).res.status, 'failed')
  })

  it('review and failed outcomes carry their reason codes', async () => {
    const ctx = await setup()
    assert.equal((await check(ctx, '08155500607', 'review', 'normal')).res.status, 'review')
    assert.equal((await check(ctx, '08155500608', 'failed_liveness', 'normal')).res.status, 'failed')
    assert.equal((await check(ctx, '08155500609', 'failed', 'normal')).res.status, 'failed')
    const reasons = (await sql(ctx.db, `select reason_code from ypm_private.provider_sessions order by created_at`)).map((r) => r.reason_code)
    assert.deepEqual(reasons, ['possible_duplicate', 'liveness_failed', 'poor_capture'])
  })

  it('a reload mid-check carries on with the same check ("already running") and gets the result', async () => {
    const ctx = await setup()
    const s = await ctx.api.start('Test Reload', '08155500610', true, CONSENT_VERSION)
    const token = s.data.registration_token
    assert.equal((await ctx.api.providerStart(ctx.tester, token, 'approved', null, 0, 'normal')).status, 'ok')
    // The page reloads before relaying anything, then runs the check again.
    const res = await runProviderCheck({
      api: ctx.api, adminSession: ctx.tester, token, outcome: 'approved', reasonCode: null,
      delivery: { ...DELIVERIES.normal, delay: 0 }, timing: FAST,
    })
    assert.deepEqual(res, { type: 'status', status: 'approved' })
    assert.equal((await sql(ctx.db, `select count(*)::int n from ypm_private.provider_sessions`))[0].n, 1)
  })

  it('no tester session, a production database, and leaving the screen', async () => {
    const ctx = await setup()
    assert.equal((await check(ctx, '08155500611', 'approved', 'normal', { tester: 'nope' })).res.type, 'tester_needed')
    assert.equal((await check(ctx, '08155500612', 'approved', 'never', { isCancelled: () => true })).res.type, 'cancelled')

    const prod = await setup({ production: true })
    assert.equal((await relayDue(prod.api, prod.tester)), 'failed')
    const r = await runProviderCheck({
      api: prod.api, adminSession: prod.tester, token: 'x', outcome: 'approved', reasonCode: null,
      delivery: DELIVERIES.normal, timing: FAST,
    })
    assert.deepEqual(r, { type: 'disabled' })
  })
})
