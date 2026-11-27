// Migration 006: "verify with a youth leader" (no biometrics, works with no
// provider configured), the sandbox provider, and the service-role-only
// result entry point. Synthetic identities only (0815550 07xx).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  freshDb, call, sql, login, LEGACY, DEV_SIM_SQL, SAFEGUARDS_SQL, PROVIDER_SQL, PROVIDER_DOWN_SQL,
  CHOICE_SQL, CHOICE_DOWN_SQL,
} from './helpers.mjs'

const CV = 'draft-2026-11-dev'
const REF = /^[A-HJ-NP-Z2-9]{6}$/

async function devDb({ provider = 'none', mode = 'optional' } = {}) {
  const db = await freshDb({ migrate: '006' })
  await sql(db, `update ypm_private.deployment set environment = 'development'`)
  await sql(db, `update settings set verification_provider = $1, registration_mode = $2 where id = 1`, [provider, mode])
  if (provider === 'simulated') {
    await db.exec(DEV_SIM_SQL)
    await db.exec(PROVIDER_SQL) // the simulator key is only created on a development database
  }
  return db
}

const request = (db, name, phone, extra = {}) =>
  call(db, 'voter_request_in_person', {
    p_name: name, p_phone: phone, p_consent_version: extra.cv ?? CV, p_adult: extra.adult ?? true,
  }, extra.ip ? { ip: extra.ip } : {})

const confirm = (db, s, id, decision = 'approve', link = false) =>
  call(db, 'admin_confirm_in_person', {
    p_session: s, p_registration_id: id, p_decision: decision, p_link_existing_ballot: link,
  })

async function regId(db, phone) {
  return (await sql(db, `select id from voter_registrations where phone = $1 order by created_at desc limit 1`, [phone]))[0].id
}

async function asRole(db, role, text) {
  await db.exec(`set role ${role}`)
  try {
    return await db.query(text)
  } finally {
    await db.exec('reset role')
  }
}

async function sandboxDb() {
  const db = await devDb({ provider: 'simulated' })
  const s = await login(db)
  return { db, s }
}
async function startSandbox(db, s, phone) {
  const st = await call(db, 'voter_registration_start', { p_name: 'Test Sandbox', p_phone: phone, p_consent_version: CV, p_adult: true })
  const r = await call(db, 'dev_sandbox_start', { p_admin_session: s, p_registration_token: st.registration_token })
  return { token: st.registration_token, ...r }
}
const result = (db, args, role = 'service_role') =>
  call(db, 'provider_webhook_result', {
    p_provider: 'sandbox', p_delivery_id: 'evt_1', p_outcome: 'approved', p_reason_code: null,
    p_issued_at: new Date().toISOString(), ...args,
  }, { role })

describe('006: verify with a youth leader', () => {
  it('works with no verification provider configured, where online registration says unavailable', async () => {
    const db = await devDb({ provider: 'none' })
    const online = await call(db, 'voter_registration_start', { p_name: 'Test Online', p_phone: '08155500700', p_consent_version: CV, p_adult: true })
    assert.equal(online.status, 'verification_unavailable')

    const r = await request(db, 'Test Inperson', '08155500701')
    assert.equal(r.status, 'ok')
    assert.match(r.reference, REF)
    assert.ok(r.registration_token.length >= 32)
    assert.equal((await call(db, 'voter_registration_status', { p_token: r.registration_token })).status, 'review')
    const [row] = await sql(db, `select provider, status, adult_confirmed, consent_version,
                                        expires_at > now() + interval '13 days' as long_enough
                                   from voter_registrations where phone = '08155500701'`)
    assert.deepEqual(row, { provider: 'in_person', status: 'review', adult_confirmed: true, consent_version: CV, long_enough: true })
    // Claiming isn't possible: only a leader, in person, creates the account.
    assert.equal((await call(db, 'voter_registration_claim', { p_token: r.registration_token })).status, 'not_ready')
  })

  it('refuses the same things online registration refuses', async () => {
    const db = await devDb()
    assert.equal((await request(db, 'Test Old', '08155500702', { cv: 'not-a-version' })).status, 'consent_outdated')
    assert.equal((await request(db, 'Test Young', '08155500702', { adult: false })).status, 'adult_required')
    assert.equal((await request(db, 'T', '08155500702')).status, 'error')
    assert.equal((await request(db, 'Test Nophone', '123')).status, 'error')
    // A number with a ballot, and a registered number, get the same answer.
    assert.equal((await request(db, 'Test Ballot', LEGACY.open.phone)).status, 'needs_assistance')
    const s = await login(db)
    await call(db, 'admin_register_voter', { p_session: s, p_name: 'Test Have', p_phone: '08155500703', p_consent_version: CV, p_adult_confirmed: true })
    assert.equal((await request(db, 'Test Have', '08155500703')).status, 'needs_assistance')

    await sql(db, `update settings set registration_mode = 'off' where id = 1`)
    assert.equal((await request(db, 'Test Off', '08155500704')).status, 'registration_off')
  })

  it('is disabled on a production database', async () => {
    const db = await freshDb({ migrate: '006' })
    assert.equal((await request(db, 'Test Prod', '08155500705')).status, 'disabled')
    const s = await login(db)
    assert.equal((await call(db, 'admin_in_person_requests', { p_session: s })).status, 'disabled')
    assert.equal((await confirm(db, s, '00000000-0000-0000-0000-000000000000')).status, 'disabled')
    assert.equal((await sql(db, `select count(*)::int n from voter_registrations`))[0].n, 0)
  })

  it('shares the per-number limit with online registration (5 an hour)', async () => {
    const db = await devDb({ provider: 'simulated' })
    for (let i = 0; i < 3; i++) {
      assert.equal((await call(db, 'voter_registration_start', { p_name: 'Test Limit', p_phone: '08155500706', p_consent_version: CV, p_adult: true })).status, 'ok')
    }
    assert.equal((await request(db, 'Test Limit', '08155500706')).status, 'ok')
    assert.equal((await request(db, 'Test Limit', '08155500706')).status, 'ok')
    assert.equal((await request(db, 'Test Limit', '08155500706')).status, 'rate_limited')
  })

  it('a leader sees the reference and confirms in person: same kind of account, votes the same way', async () => {
    const db = await devDb()
    const s = await login(db)
    const r = await request(db, 'Test Confirmed Person', '08155500707')
    const id = await regId(db, '08155500707')

    const list = await call(db, 'admin_in_person_requests', { p_session: s })
    assert.equal(list.status, 'ok')
    assert.deepEqual(list.requests.map((q) => [q.registration_id, q.reference]), [[id, r.reference]])
    assert.ok(!JSON.stringify(list).includes('08155500707'), 'no phone numbers in the list')
    assert.equal((await call(db, 'admin_in_person_requests', { p_session: 'nope' })).status, 'unauthorized')
    // It also sits in the ordinary review queue (masked number).
    const queue = await call(db, 'admin_list_reviews', { p_session: s })
    assert.deepEqual(queue.reviews.map((q) => [q.id, q.provider, q.phone]), [[id, 'in_person', '•••• 0707']])

    const c = await confirm(db, s, id)
    assert.equal(c.status, 'ok')
    assert.match(c.voter_code, /^YPM-/)
    assert.equal(c.linked_ballot, false)
    const [v] = await sql(db, `select method, created_by, consent_version, adult_confirmed, status from voters where phone = '08155500707'`)
    assert.deepEqual(v, { method: 'in_person', created_by: 'leader', consent_version: CV, adult_confirmed: true, status: 'active' })
    assert.equal((await sql(db, `select count(*)::int n from voter_consents c join voters v on v.id = c.voter_id where v.phone = '08155500707'`))[0].n, 1)
    assert.equal((await call(db, 'voter_registration_status', { p_token: r.registration_token })).status, 'claimed')
    assert.equal((await sql(db, `select count(*)::int n from admin_audit where action = 'registration_confirmed_in_person'`))[0].n, 1)

    // Signs in and votes like anyone else.
    const login1 = await call(db, 'voter_login', { p_code: c.voter_code })
    assert.equal(login1.status, 'ok')
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: login1.session })).status, 'started')

    // Once only.
    assert.equal((await confirm(db, s, id)).status, 'error')
    assert.equal((await call(db, 'admin_in_person_requests', { p_session: s })).requests.length, 0)
  })

  it('reject closes it; nothing is created', async () => {
    const db = await devDb()
    const s = await login(db)
    const r = await request(db, 'Test Rejected', '08155500708')
    assert.equal((await confirm(db, s, await regId(db, '08155500708'), 'reject')).status, 'ok')
    assert.equal((await call(db, 'voter_registration_status', { p_token: r.registration_token })).status, 'rejected')
    assert.equal((await sql(db, `select count(*)::int n from voters`))[0].n, 0)
    assert.equal((await sql(db, `select count(*)::int n from admin_audit where action = 'in_person_request_rejected'`))[0].n, 1)
    assert.equal((await confirm(db, s, await regId(db, '08155500708'), 'maybe')).status, 'error')
  })

  it('a ballot started on this number in the meantime is offered for linking, keeping its votes', async () => {
    const db = await devDb()
    const s = await login(db)
    await request(db, 'Test Linker', '08155500709')
    const id = await regId(db, '08155500709')
    const [b] = await sql(db, `insert into ballots (voter_name, voter_phone) values ('Test Linker', '08155500709') returning id`)
    await sql(db, `insert into votes (ballot_id, category_id, nominee_name)
                  select $1, category_id, name from ballot_nominees where active order by category_id, position limit 1`, [b.id])

    const first = await confirm(db, s, id)
    assert.deepEqual([first.status, first.ballot, first.answered], ['phone_has_ballot', 'in_progress', 1])
    assert.equal((await sql(db, `select count(*)::int n from voters`))[0].n, 0, 'nothing created yet')
    const linked = await confirm(db, s, id, 'approve', true)
    assert.equal(linked.status, 'ok')
    assert.equal(linked.linked_ballot, true)
    const [row] = await sql(db, `select b.voter_id = v.id as linked, (select count(*)::int from votes where ballot_id = b.id) as votes
                                   from ballots b, voters v where b.id = $1 and v.phone = '08155500709'`, [b.id])
    assert.deepEqual(row, { linked: true, votes: 1 })
  })

  it('a number registered in the meantime: refused, nothing changes', async () => {
    const db = await devDb()
    const s = await login(db)
    await request(db, 'Test Racer', '08155500710')
    await call(db, 'admin_register_voter', { p_session: s, p_name: 'Test Racer', p_phone: '08155500710', p_consent_version: CV, p_adult_confirmed: true })
    assert.equal((await confirm(db, s, await regId(db, '08155500710'))).status, 'phone_registered')
    assert.equal((await sql(db, `select count(*)::int n from voters`))[0].n, 1)
  })

  it('requests close after 14 days, and a changed notice needs agreeing again', async () => {
    const db = await devDb()
    const s = await login(db)
    const r = await request(db, 'Test Late', '08155500711')
    const id = await regId(db, '08155500711')
    await sql(db, `update voter_registrations set expires_at = now() - interval '1 second' where id = $1`, [id])
    assert.equal((await confirm(db, s, id)).status, 'expired')
    assert.equal((await call(db, 'voter_registration_status', { p_token: r.registration_token })).status, 'expired')

    await request(db, 'Test Late Two', '08155500712')
    const id2 = await regId(db, '08155500712')
    await sql(db, `update voter_registrations set expires_at = now() - interval '1 second' where id = $1`, [id2])
    assert.equal((await call(db, 'admin_in_person_requests', { p_session: s })).requests.length, 0, 'listing closes old ones')
    assert.equal((await sql(db, `select status from voter_registrations where id = $1`, [id2]))[0].status, 'expired')

    await request(db, 'Test Notice', '08155500713')
    await sql(db, `insert into ypm_private.consent_versions (version, description, is_draft, is_current) values ('draft-2026-12-dev', 'test notice', true, false)`)
    await sql(db, `update ypm_private.consent_versions set is_current = false, retired_at = now() where version = $1`, [CV])
    await sql(db, `update ypm_private.consent_versions set is_current = true where version = 'draft-2026-12-dev'`)
    assert.equal((await confirm(db, s, await regId(db, '08155500713'))).status, 'consent_outdated')
    assert.equal((await sql(db, `select count(*)::int n from voters`))[0].n, 0)
  })

  it('the two review paths stay separate: each confirm function refuses the other kind', async () => {
    const db = await devDb({ provider: 'simulated' })
    const s = await login(db)
    await request(db, 'Test Sep', '08155500714')
    const inPersonId = await regId(db, '08155500714')
    const res = await call(db, 'admin_resolve_review', { p_session: s, p_registration_id: inPersonId, p_decision: 'approve' })
    assert.equal(res.status, 'error', '004 refuses in-person requests (unsupported provider)')

    const st = await call(db, 'voter_registration_start', { p_name: 'Test Face', p_phone: '08155500715', p_consent_version: CV, p_adult: true })
    await call(db, 'dev_simulate_verification', { p_admin_session: s, p_registration_token: st.registration_token, p_outcome: 'review' })
    assert.equal((await confirm(db, s, await regId(db, '08155500715'))).status, 'error')
    assert.equal((await sql(db, `select count(*)::int n from voters`))[0].n, 0)
  })

  it('stores only a reference and a time beside the registration', async () => {
    const db = await devDb()
    const cols = await sql(db, `select column_name from information_schema.columns
                                 where table_schema = 'ypm_private' and table_name = 'in_person_requests' order by ordinal_position`)
    assert.deepEqual(cols.map((c) => c.column_name), ['registration_id', 'reference', 'created_at'])
  })
})

describe('006: sandbox provider and the service-role entry point', () => {
  it('only the service role can call the entry point', async () => {
    const { db, s } = await sandboxDb()
    const { provider_ref: ref } = await startSandbox(db, s, '08155500720')
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(result(db, { p_provider_ref: ref }, role), /permission denied/)
    }
    assert.deepEqual(await result(db, { p_provider_ref: ref }), { status: 'ok', result: 'applied' })
    // Re-running 004 and 005 (allowed) doesn't reopen it.
    await db.exec(SAFEGUARDS_SQL)
    await db.exec(PROVIDER_SQL)
    await assert.rejects(result(db, { p_provider_ref: ref, p_delivery_id: 'evt_2' }, 'anon'), /permission denied/)
    await assert.rejects(asRole(db, 'anon', `select * from ypm_private.in_person_requests`), /permission denied/)
  })

  it('sandbox sessions: tester only, one per registration, and only on development with the simulated setting', async () => {
    const { db, s } = await sandboxDb()
    const st = await call(db, 'voter_registration_start', { p_name: 'Test Sbx', p_phone: '08155500721', p_consent_version: CV, p_adult: true })
    assert.equal((await call(db, 'dev_sandbox_start', { p_admin_session: 'nope', p_registration_token: st.registration_token })).status, 'unauthorized')
    const a = await call(db, 'dev_sandbox_start', { p_admin_session: s, p_registration_token: st.registration_token })
    assert.equal(a.status, 'ok')
    assert.match(a.provider_ref, /^sbx_[0-9a-f]{64}$/)
    const b = await call(db, 'dev_sandbox_start', { p_admin_session: s, p_registration_token: st.registration_token })
    assert.deepEqual(b, { status: 'already_running', provider_ref: a.provider_ref })

    const st2 = await call(db, 'voter_registration_start', { p_name: 'Test Sim', p_phone: '08155500722', p_consent_version: CV, p_adult: true })
    await call(db, 'dev_provider_start', { p_admin_session: s, p_registration_token: st2.registration_token, p_outcome: 'approved', p_reason_code: null, p_delay_seconds: 0, p_scenario: 'never' })
    assert.equal((await call(db, 'dev_sandbox_start', { p_admin_session: s, p_registration_token: st2.registration_token })).status, 'error')

    await sql(db, `update settings set verification_provider = 'none' where id = 1`)
    assert.equal((await call(db, 'dev_sandbox_start', { p_admin_session: s, p_registration_token: st.registration_token })).status, 'disabled')
    assert.equal((await result(db, { p_provider_ref: a.provider_ref })).status, 'disabled')
  })

  it('applies results with 005 rules: duplicate, stale, conflict to review, and never touches a simulated session', async () => {
    const { db, s } = await sandboxDb()
    const t0 = Date.now()
    const at = (ms) => new Date(t0 + ms).toISOString()

    const one = await startSandbox(db, s, '08155500723')
    assert.equal((await result(db, { p_provider_ref: one.provider_ref, p_delivery_id: 'evt_a', p_issued_at: at(0) })).result, 'applied')
    assert.equal((await result(db, { p_provider_ref: one.provider_ref, p_delivery_id: 'evt_a', p_issued_at: at(0) })).result, 'duplicate')
    assert.equal((await result(db, { p_provider_ref: one.provider_ref, p_delivery_id: 'evt_old', p_outcome: 'failed', p_reason_code: 'poor_capture', p_issued_at: at(-5000) })).result, 'stale')
    assert.equal((await result(db, { p_provider_ref: one.provider_ref, p_delivery_id: 'evt_b', p_outcome: 'review', p_reason_code: 'possible_duplicate', p_issued_at: at(1000) })).result, 'conflict_review')
    assert.equal((await call(db, 'voter_registration_status', { p_token: one.token })).status, 'review')

    // A simulated session's reference can't be driven through the sandbox path.
    const st = await call(db, 'voter_registration_start', { p_name: 'Test Simref', p_phone: '08155500724', p_consent_version: CV, p_adult: true })
    await call(db, 'dev_provider_start', { p_admin_session: s, p_registration_token: st.registration_token, p_outcome: 'approved', p_reason_code: null, p_delay_seconds: 0, p_scenario: 'never' })
    const [simRef] = await sql(db, `select provider_ref from ypm_private.provider_sessions where provider = 'simulated'`)
    assert.equal((await result(db, { p_provider_ref: simRef.provider_ref, p_delivery_id: 'evt_c' })).result, 'unknown_ref')
    assert.equal((await call(db, 'voter_registration_status', { p_token: st.registration_token })).status, 'pending')

    // Claimed after approval: the voter gets the code once, as with the simulator.
    const two = await startSandbox(db, s, '08155500725')
    await result(db, { p_provider_ref: two.provider_ref, p_delivery_id: 'evt_d' })
    const claim = await call(db, 'voter_registration_claim', { p_token: two.token })
    assert.equal(claim.status, 'ok')
    assert.equal((await sql(db, `select method from voters where phone = '08155500725'`))[0].method, 'face_simulated')
  })

  it('refuses malformed, unknown-provider and stale-dated deliveries, logging only the result', async () => {
    const { db, s } = await sandboxDb()
    const { provider_ref: ref, token } = await startSandbox(db, s, '08155500726')
    const bad = [
      { p_provider_ref: ref, p_provider: 'simulated' },
      { p_provider_ref: ref, p_provider: 'vendor_x' },
      { p_provider_ref: ref, p_outcome: 'maybe' },
      { p_provider_ref: ref, p_reason_code: 'face_score_0.93' },
      { p_provider_ref: ref, p_delivery_id: "x'; drop table votes; --" },
      { p_provider_ref: 'a'.repeat(200) },
      { p_provider_ref: ref, p_issued_at: null },
    ]
    for (const b of bad) assert.deepEqual(await result(db, b), { status: 'rejected' }, JSON.stringify(b))
    assert.deepEqual(await result(db, { p_provider_ref: ref, p_issued_at: new Date(Date.now() - 11 * 60000).toISOString() }), { status: 'rejected' })
    assert.deepEqual(await result(db, { p_provider_ref: ref, p_issued_at: new Date(Date.now() + 5 * 60000).toISOString() }), { status: 'rejected' })
    assert.equal((await call(db, 'voter_registration_status', { p_token: token })).status, 'pending')
    const events = await sql(db, `select result, count(*)::int n from ypm_private.verification_events group by result order by result`)
    assert.deepEqual(events, [{ result: 'expired_delivery', n: 2 }, { result: 'malformed', n: 7 }])
  })
})

describe('006: install, re-run and undo', () => {
  it('needs 005', async () => {
    const db = await freshDb() // through 004
    await assert.rejects(db.exec(CHOICE_SQL), /Run 005_simulated_provider.sql first/)
    await db.exec('rollback')
  })

  it('re-running 006 changes nothing; 005 re-run keeps the sandbox allowed', async () => {
    const db = await devDb({ provider: 'simulated' })
    const s = await login(db)
    const r = await request(db, 'Test Rerun', '08155500730')
    await db.exec(CHOICE_SQL)
    await db.exec(PROVIDER_SQL)
    const list = await call(db, 'admin_in_person_requests', { p_session: s })
    assert.deepEqual(list.requests.map((q) => q.reference), [r.reference])
    const st = await call(db, 'voter_registration_start', { p_name: 'Test Rerun Sbx', p_phone: '08155500731', p_consent_version: CV, p_adult: true })
    assert.equal((await call(db, 'dev_sandbox_start', { p_admin_session: s, p_registration_token: st.registration_token })).status, 'ok')
  })

  it('undo keeps every account, ballot and vote, closes waiting requests, and then 005 can be undone', async () => {
    const db = await devDb({ provider: 'simulated' })
    const s = await login(db)
    await request(db, 'Test Kept', '08155500732')
    const kept = await confirm(db, s, await regId(db, '08155500732'))
    assert.equal(kept.status, 'ok')
    const waiting = await request(db, 'Test Waiting', '08155500733')
    await startSandbox(db, s, '08155500734')
    const before = await sql(db, `select (select count(*)::int from voters) v, (select count(*)::int from ballots) b, (select count(*)::int from votes) vo, (select count(*)::int from voter_consents) c`)

    await assert.rejects(db.exec(PROVIDER_DOWN_SQL), /Migration 006 is installed/)
    await db.exec('rollback')

    await db.exec(CHOICE_DOWN_SQL)
    assert.deepEqual(await sql(db, `select (select count(*)::int from voters) v, (select count(*)::int from ballots) b, (select count(*)::int from votes) vo, (select count(*)::int from voter_consents) c`), before)
    assert.equal((await call(db, 'voter_registration_status', { p_token: waiting.registration_token })).status, 'expired')
    assert.equal((await sql(db, `select count(*)::int n from ypm_private.provider_sessions`))[0].n, 0)
    assert.equal((await sql(db, `select to_regprocedure('public.provider_webhook_result(text,text,text,text,text,timestamptz)') is null as gone`))[0].gone, true)
    assert.equal((await call(db, 'voter_login', { p_code: kept.voter_code })).status, 'ok', 'accounts confirmed in person keep working')

    await db.exec(PROVIDER_DOWN_SQL)
    await assert.rejects(db.exec(CHOICE_SQL), /Run 005_simulated_provider.sql first/)
    await db.exec('rollback')
    assert.equal((await sql(db, `select to_regclass('ypm_private.in_person_requests') is null as gone`))[0].gone, true)

    // Reinstall the chain.
    await db.exec(PROVIDER_SQL)
    await db.exec(CHOICE_SQL)
    assert.equal((await request(db, 'Test Again', '08155500735')).status, 'ok')
  })
})
