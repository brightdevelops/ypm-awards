// Production release (migration 007): the whole chain 001–007 on a
// PRODUCTION-marked database that already has ballots and votes, then the
// youth-leader path switched on. Face checks, the simulator, the sandbox and
// the webhook entry point must stay disabled. Synthetic identities only
// (0815550 03xx). No biometric data.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  freshDb, call, sql, login, issue, LEGACY, MIGRATION_SQL, BALLOT_MIGRATION_SQL, BALLOT_SYNC_SQL,
  VOTER_MIGRATION_SQL, SAFEGUARDS_SQL, PROVIDER_SQL, CHOICE_SQL, CHOICE_DOWN_SQL, LIVE_SQL, LIVE_DOWN_SQL,
  DEV_SIM_SQL,
} from './helpers.mjs'

const PROD_CV = 'ypm-register-2026-12-v1'
const DEV_CV = 'draft-2026-11-dev'

// Results exactly as the database holds them: every vote on every ballot.
const SNAPSHOT = `
  select (select count(*)::int from ballots) as ballots,
         (select count(completed_at)::int from ballots) as submitted,
         (select count(*)::int from votes) as votes,
         (select md5(coalesce(string_agg(b.id || ':' || coalesce(b.completed_at::text, '-') || ':' || v.category_id || '=' || v.nominee_name, ',' order by b.id, v.category_id), ''))
            from ballots b left join votes v on v.ballot_id = b.id) as fingerprint`

async function prodChain() {
  const db = await freshDb({ migrate: false }) // production today: setup only, with ballots and votes
  const before = (await sql(db, SNAPSHOT))[0]
  for (const m of [MIGRATION_SQL, BALLOT_MIGRATION_SQL, BALLOT_SYNC_SQL, VOTER_MIGRATION_SQL, SAFEGUARDS_SQL, PROVIDER_SQL, CHOICE_SQL, LIVE_SQL]) {
    await db.exec(m)
  }
  return { db, before }
}

async function goLive(db) {
  await sql(db, `update ypm_private.deployment set voter_accounts_live = true`)
  const s = await login(db)
  assert.equal((await call(db, 'admin_set_registration_mode', { p_session: s, p_mode: 'optional' })).status, 'ok')
  return s
}

async function nominee(db) {
  return (await sql(db, `select category_id, name from ballot_nominees where active order by category_id, position limit 1`))[0]
}

describe('007 on Production: installing the chain', () => {
  it('keeps every existing ballot and vote exactly as it was', async () => {
    const { db, before } = await prodChain()
    assert.deepEqual((await sql(db, SNAPSHOT))[0], before)
    assert.deepEqual(before.ballots, 2)
    const [d] = await sql(db, `select environment, voter_accounts_live from ypm_private.deployment`)
    assert.deepEqual(d, { environment: 'production', voter_accounts_live: false })
  })

  it('publishes the notice: current in Production, the draft retired', async () => {
    const { db } = await prodChain()
    const rows = await sql(db, `select version, is_draft, is_current, retired_at is not null as retired
                                  from ypm_private.consent_versions order by version`)
    assert.deepEqual(rows, [
      { version: DEV_CV, is_draft: true, is_current: false, retired: true },
      { version: PROD_CV, is_draft: false, is_current: true, retired: false },
    ])
  })

  it('until the switch is on, voter accounts stay disabled and anonymous voting works as before', async () => {
    const { db } = await prodChain()
    assert.equal((await call(db, 'voter_request_in_person', { p_name: 'Test Prod', p_phone: '08155500301', p_consent_version: PROD_CV, p_adult: true })).status, 'disabled')
    const s = await login(db)
    assert.equal((await call(db, 'admin_register_voter', { p_session: s, p_name: 'Test Prod', p_phone: '08155500301', p_consent_version: PROD_CV, p_adult_confirmed: true })).status, 'disabled')
    await assert.rejects(call(db, 'admin_set_registration_mode', { p_session: s, p_mode: 'optional' }).then((r) => { if (r.status !== 'ok') throw new Error(r.status) }))

    const b = await call(db, 'begin_ballot', { p_name: 'Test Anon', p_phone: '08155500302', p_code: null })
    assert.equal(b.status, 'started')
    const n = await nominee(db)
    assert.equal((await call(db, 'save_vote', { p_ballot_id: b.ballot_id, p_category_id: n.category_id, p_nominee_name: n.name })).status, 'ok')
    assert.equal((await call(db, 'submit_ballot', { p_ballot_id: b.ballot_id })).status, 'ok')
  })
})

describe('007 on Production: the youth-leader path switched on', () => {
  it('request → leader confirms → voter signs in and votes; old ballots untouched', async () => {
    const { db, before } = await prodChain()
    const s = await goLive(db)
    const r = await call(db, 'voter_request_in_person', { p_name: 'Test Prod Voter', p_phone: '08155500303', p_consent_version: PROD_CV, p_adult: true })
    assert.equal(r.status, 'ok')
    const list = await call(db, 'admin_in_person_requests', { p_session: s })
    assert.equal(list.requests[0].reference, r.reference)
    const c = await call(db, 'admin_confirm_in_person', { p_session: s, p_registration_id: list.requests[0].registration_id, p_decision: 'approve', p_link_existing_ballot: false })
    assert.equal(c.status, 'ok')
    const [consent] = await sql(db, `select c.consent_version, c.method, c.biometric from voter_consents c join voters v on v.id = c.voter_id where v.phone = '08155500303'`)
    assert.deepEqual(consent, { consent_version: PROD_CV, method: 'in_person', biometric: false })

    const lg = await call(db, 'voter_login', { p_code: c.voter_code })
    assert.equal(lg.status, 'ok')
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: lg.session })).status, 'started')
    const n = await nominee(db)
    assert.equal((await call(db, 'voter_save_vote', { p_session: lg.session, p_category_id: n.category_id, p_nominee_name: n.name })).status, 'ok')
    assert.equal((await call(db, 'voter_submit_ballot', { p_session: lg.session })).status, 'ok')

    // The number now belongs to an account: no anonymous ballot for it.
    assert.equal((await call(db, 'begin_ballot', { p_name: 'Test Prod Voter', p_phone: '08155500303', p_code: null })).status, 'registered_voter')
    // The ballots that existed before are exactly as they were.
    const legacy = await sql(db, `select count(*)::int n from votes where ballot_id in ($1, $2)`, [LEGACY.done.ballotId, LEGACY.open.ballotId])
    assert.equal(legacy[0].n, 2)
    assert.equal((await sql(db, SNAPSHOT))[0].ballots, before.ballots + 1)
  })

  it('the development draft notice is refused in Production', async () => {
    const { db } = await prodChain()
    const s = await goLive(db)
    assert.equal((await call(db, 'voter_request_in_person', { p_name: 'Test Draft', p_phone: '08155500304', p_consent_version: DEV_CV, p_adult: true })).status, 'consent_outdated')
    assert.equal((await call(db, 'admin_register_voter', { p_session: s, p_name: 'Test Draft', p_phone: '08155500304', p_consent_version: DEV_CV, p_adult_confirmed: true })).status, 'consent_outdated')
    assert.equal((await call(db, 'admin_voter_stats', { p_session: s })).consent_version, PROD_CV)
  })

  it('face checks, the simulator, the sandbox and the webhook entry point stay disabled', async () => {
    const { db } = await prodChain()
    const s = await goLive(db)
    const online = await call(db, 'voter_registration_start', { p_name: 'Test Face', p_phone: '08155500305', p_consent_version: PROD_CV, p_adult: true })
    assert.equal(online.status, 'verification_unavailable')
    await assert.rejects(sql(db, `update settings set verification_provider = 'simulated' where id = 1`), /only allowed in a development project/)
    await assert.rejects(db.exec(DEV_SIM_SQL))
    await db.exec('rollback').catch(() => {})
    assert.equal((await call(db, 'dev_provider_start', { p_admin_session: s, p_registration_token: 'x', p_outcome: 'approved', p_reason_code: null, p_delay_seconds: 0, p_scenario: 'normal' })).status, 'disabled')
    assert.equal((await call(db, 'dev_provider_outbox', { p_admin_session: s })).status, 'disabled')
    assert.equal((await call(db, 'dev_provider_callback', { p_body: '{}', p_signature: 'x' })).status, 'disabled')
    assert.equal((await call(db, 'dev_sandbox_start', { p_admin_session: s, p_registration_token: 'x' })).status, 'disabled')
    assert.equal((await call(db, 'provider_webhook_result', {
      p_provider: 'sandbox', p_provider_ref: 'sbx_x', p_delivery_id: 'evt_x', p_outcome: 'approved', p_reason_code: null, p_issued_at: new Date().toISOString(),
    }, { role: 'service_role' })).status, 'disabled')
    await assert.rejects(call(db, 'provider_webhook_result', {
      p_provider: 'sandbox', p_provider_ref: 'sbx_x', p_delivery_id: 'evt_x', p_outcome: 'approved', p_reason_code: null, p_issued_at: new Date().toISOString(),
    }), /permission denied/)
    assert.equal((await sql(db, `select count(*)::int n from vault.secrets where name = 'ypm_sim_provider_key'`))[0].n, 0, 'no simulator key in Production')
  })

  it('the switch can only be turned on with a published current notice; off disables everything again, keeping data', async () => {
    const { db } = await prodChain()
    await sql(db, `update ypm_private.consent_versions set is_current = false`)
    await assert.rejects(sql(db, `update ypm_private.deployment set voter_accounts_live = true`), /No published consent notice/)
    await sql(db, `update ypm_private.consent_versions set is_current = true where version = $1`, [PROD_CV])

    const s = await goLive(db)
    const r = await call(db, 'admin_register_voter', { p_session: s, p_name: 'Test Switch', p_phone: '08155500306', p_consent_version: PROD_CV, p_adult_confirmed: true })
    assert.equal(r.status, 'ok')
    await sql(db, `update ypm_private.deployment set voter_accounts_live = false`)
    assert.equal((await call(db, 'voter_login', { p_code: r.voter_code })).status, 'disabled')
    assert.equal((await call(db, 'voter_request_in_person', { p_name: 'Test Off', p_phone: '08155500307', p_consent_version: PROD_CV, p_adult: true })).status, 'disabled')
    assert.equal((await sql(db, `select count(*)::int n from voters`))[0].n, 1, 'account kept')
    await sql(db, `update ypm_private.deployment set voter_accounts_live = true`)
    assert.equal((await call(db, 'voter_login', { p_code: r.voter_code })).status, 'ok', 'works again when switched back on')
  })

  it('the API roles can’t read or change the switch', async () => {
    const { db } = await prodChain()
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`)
      try {
        await assert.rejects(db.query(`update ypm_private.deployment set voter_accounts_live = true`), /permission denied/)
        await assert.rejects(db.query(`select voter_accounts_live from ypm_private.deployment`), /permission denied/)
      } finally {
        await db.exec('reset role')
      }
    }
  })
})

describe('007: re-run, undo, and Development', () => {
  it('re-running 007 changes nothing; 004 refuses while registration is open, and after it accounts are off until 007 runs again', async () => {
    const { db } = await prodChain()
    const s = await goLive(db)
    await db.exec(LIVE_SQL)
    assert.equal((await call(db, 'voter_request_in_person', { p_name: 'Test Rerun', p_phone: '08155500308', p_consent_version: PROD_CV, p_adult: true })).status, 'ok')
    await assert.rejects(db.exec(SAFEGUARDS_SQL), /not marked as development, but registration/)
    await db.exec('rollback')
    assert.equal((await call(db, 'admin_in_person_requests', { p_session: s })).requests.length, 1, 'nothing changed')
    assert.equal((await call(db, 'admin_set_registration_mode', { p_session: s, p_mode: 'off' })).status, 'ok')
    await db.exec(SAFEGUARDS_SQL)
    assert.equal((await call(db, 'admin_in_person_requests', { p_session: s })).status, 'disabled')
    await db.exec(LIVE_SQL)
    assert.equal((await call(db, 'admin_in_person_requests', { p_session: s })).requests.length, 1)
  })

  it('undo: back to development-only, data kept; 006’s undo refuses while 007 is installed', async () => {
    const { db } = await prodChain()
    const s = await goLive(db)
    const r = await call(db, 'admin_register_voter', { p_session: s, p_name: 'Test Undo', p_phone: '08155500309', p_consent_version: PROD_CV, p_adult_confirmed: true })
    const before = (await sql(db, SNAPSHOT))[0]

    await assert.rejects(db.exec(CHOICE_DOWN_SQL), /Migration 007 is installed/)
    await db.exec('rollback')
    await db.exec(LIVE_DOWN_SQL)
    assert.equal((await call(db, 'voter_login', { p_code: r.voter_code })).status, 'disabled')
    assert.deepEqual((await sql(db, SNAPSHOT))[0], before)
    assert.equal((await sql(db, `select count(*)::int n from voters`))[0].n, 1)
    assert.equal((await sql(db, `select count(*)::int n from voter_consents where consent_version = $1`, [PROD_CV]))[0].n, 1)
    await db.exec(CHOICE_DOWN_SQL) // now allowed
    await db.exec(CHOICE_SQL)
    await db.exec(LIVE_SQL)
    assert.equal((await sql(db, `select voter_accounts_live from ypm_private.deployment`))[0].voter_accounts_live, false, 'reinstalling starts switched off')
  })

  it('on Development the draft stays current and both notices are accepted', async () => {
    const db = await freshDb({ migrate: '006' })
    await sql(db, `update ypm_private.deployment set environment = 'development'`)
    await sql(db, `update settings set registration_mode = 'optional' where id = 1`)
    await db.exec(LIVE_SQL)
    const rows = await sql(db, `select version, is_current, retired_at is null as open from ypm_private.consent_versions order by version`)
    assert.deepEqual(rows, [
      { version: DEV_CV, is_current: true, open: true },
      { version: PROD_CV, is_current: false, open: true },
    ])
    for (const [cv, phone] of [[DEV_CV, '08155500310'], [PROD_CV, '08155500311']]) {
      assert.equal((await call(db, 'voter_request_in_person', { p_name: 'Test Both', p_phone: phone, p_consent_version: cv, p_adult: true })).status, 'ok')
    }
  })
})

// Under-18s can't register for a voter account (adults only), so their
// non-biometric way to vote is the anonymous voting page, with an optional
// voting code from a leader. Neither asks for age or any biometric data.
describe('007 on Production: under-18 participants still have a way to vote', () => {
  it('with voter accounts on and registration Optional: anonymous voting and leader-issued voting codes work', async () => {
    const { db } = await prodChain()
    const s = await goLive(db)
    // Registration refuses under-18s…
    assert.equal((await call(db, 'voter_request_in_person', { p_name: 'Test Young', p_phone: '08155500320', p_consent_version: PROD_CV, p_adult: false })).status, 'adult_required')
    // …but the voting page takes them as before: no age question.
    const n = await nominee(db)
    const b = await call(db, 'begin_ballot', { p_name: 'Test Young', p_phone: '08155500320', p_code: null })
    assert.equal(b.status, 'started')
    assert.equal((await call(db, 'save_vote', { p_ballot_id: b.ballot_id, p_category_id: n.category_id, p_nominee_name: n.name })).status, 'ok')
    assert.equal((await call(db, 'submit_ballot', { p_ballot_id: b.ballot_id })).status, 'ok')
    // A leader can issue a voting code for a number (for example one that
    // needs to continue on another phone).
    const [code] = await issue(db, s, { phone: '08155500321', note: 'release test' })
    const c = await call(db, 'begin_ballot', { p_name: 'Test Young Two', p_phone: '08155500321', p_code: code.code })
    assert.equal(c.status, 'started')
  })

  it('Required mode would shut them out: new numbers can no longer start a ballot (keep Optional)', async () => {
    const { db } = await prodChain()
    const s = await goLive(db)
    assert.equal((await call(db, 'admin_set_registration_mode', { p_session: s, p_mode: 'required' })).status, 'ok')
    assert.equal((await call(db, 'begin_ballot', { p_name: 'Test Young', p_phone: '08155500322', p_code: null })).status, 'registration_required')
  })
})
