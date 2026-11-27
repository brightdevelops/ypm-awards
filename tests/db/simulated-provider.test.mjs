// Migration 005 (Phase 4): the simulated verification provider with
// asynchronous, signed results. Development only. Synthetic identities
// only (0815550 07xx). No biometric data of any kind.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  freshDb, call, sql, login, DEV_SIM_SQL, LEGACY,
  SAFEGUARDS_SQL, SAFEGUARDS_DOWN_SQL, PROVIDER_SQL, PROVIDER_DOWN_SQL, VOTER_MIGRATION_SQL,
} from './helpers.mjs'

const CV = 'draft-2026-11-dev'
const NEW_PUBLIC = ['dev_provider_start', 'dev_provider_outbox', 'dev_provider_callback',
  'admin_review_details', 'admin_purge_verification_records']

async function devDb() {
  const db = await freshDb({ migrate: '005' })
  await sql(db, `update ypm_private.deployment set environment = 'development'`)
  await sql(db, `update settings set verification_provider = 'simulated', registration_mode = 'optional' where id = 1`)
  await db.exec(DEV_SIM_SQL)
  await db.exec(PROVIDER_SQL) // on a development project: creates the signing key
  return { db, s: await login(db) }
}

async function register(db, phone, name = 'Test Provider') {
  const r = await call(db, 'voter_registration_start', { p_name: name, p_phone: phone, p_consent_version: CV, p_adult: true })
  assert.equal(r.status, 'ok', JSON.stringify(r))
  return r.registration_token
}

const start = (db, s, token, outcome, scenario = 'normal', extra = {}) =>
  call(db, 'dev_provider_start', {
    p_admin_session: s, p_registration_token: token, p_outcome: outcome,
    p_reason_code: extra.reason ?? null, p_delay_seconds: extra.delay ?? 0, p_scenario: scenario,
  })

// The tester's page playing the provider's network: fetch due deliveries,
// post each to the public callback (as anon, from another IP).
async function relay(db, s) {
  const out = await call(db, 'dev_provider_outbox', { p_admin_session: s })
  assert.equal(out.status, 'ok')
  const replies = []
  for (const d of out.deliveries) {
    replies.push(await call(db, 'dev_provider_callback', { p_body: d.body, p_signature: d.signature }, { ip: '198.51.100.9' }))
  }
  return replies
}

const status = async (db, token) => (await call(db, 'voter_registration_status', { p_token: token })).status
const events = async (db) => (await sql(db, `select result from ypm_private.verification_events order by id`)).map((e) => e.result)
const sign = async (db, body) => (await sql(db, `select ypm_private.sim_sign(ypm_private.sim_provider_key(), $1) s`, [body]))[0].s
const refOf = async (db, token) =>
  (await sql(db, `select s.provider_ref from ypm_private.provider_sessions s
                    join voter_registrations r on r.id = s.registration_id
                   where r.token_hash = ypm_private.sha256_hex($1)`, [token]))[0].provider_ref

describe('005: switched off outside development', () => {
  it('every new public function answers "disabled" on a production database, even for a signed-in admin', async () => {
    const db = await freshDb({ migrate: '005' }) // production
    const s = await login(db)
    const replies = {
      dev_provider_start: await call(db, 'dev_provider_start', { p_admin_session: s, p_registration_token: 'x', p_outcome: 'approved', p_reason_code: null, p_delay_seconds: 0, p_scenario: 'normal' }),
      dev_provider_outbox: await call(db, 'dev_provider_outbox', { p_admin_session: s }),
      dev_provider_callback: await call(db, 'dev_provider_callback', { p_body: '{}', p_signature: 'x' }),
      admin_review_details: await call(db, 'admin_review_details', { p_session: s }),
      admin_purge_verification_records: await call(db, 'admin_purge_verification_records', { p_session: s }),
    }
    for (const fn of NEW_PUBLIC) assert.equal(replies[fn].status, 'disabled', fn)
    assert.equal(await sql(db, `select 1 from vault.decrypted_secrets where name = 'ypm_sim_provider_key'`).then((r) => r.length), 0,
      'no signing key is created on a production project')
  })

  it('the provider needs the simulated provider setting too', async () => {
    const { db, s } = await devDb()
    await sql(db, `update settings set verification_provider = 'none' where id = 1`)
    assert.equal((await call(db, 'dev_provider_outbox', { p_admin_session: s })).status, 'disabled')
    assert.equal((await call(db, 'dev_provider_callback', { p_body: '{}', p_signature: 'x' })).status, 'disabled')
  })

  it('nothing new in ypm_private is reachable from the API roles', async () => {
    const { db } = await devDb()
    const tables = await sql(db, `
      select c.relname from pg_class c
       where c.relnamespace = 'ypm_private'::regnamespace
         and c.relname in ('provider_sessions', 'verification_events', 'sim_outbox')
         and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select')
              or has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('anon', c.oid, 'update'))`)
    assert.deepEqual(tables, [])
    await assert.rejects(db.exec(`set role anon; select * from ypm_private.verification_events`))
    await db.exec('reset role')
    const exec = await sql(db, `
      select p.proname from pg_proc p
       where p.pronamespace = 'ypm_private'::regnamespace
         and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`)
    assert.deepEqual(exec, [])
  })

  it('tester functions need an admin session', async () => {
    const { db } = await devDb()
    const token = await register(db, '08155500701')
    assert.equal((await start(db, 'not-a-session', token, 'approved')).status, 'unauthorized')
    assert.equal((await call(db, 'dev_provider_outbox', { p_admin_session: 'nope' })).status, 'unauthorized')
    assert.equal((await call(db, 'admin_review_details', { p_session: 'nope' })).status, 'unauthorized')
    assert.equal((await call(db, 'admin_purge_verification_records', { p_session: 'nope' })).status, 'unauthorized')
  })
})

describe('005: results arrive through the signed callback', () => {
  it('approved: nothing changes until the delivery arrives; then the voter claims as before', async () => {
    const { db, s } = await devDb()
    const token = await register(db, '08155500702')
    assert.deepEqual(await start(db, s, token, 'approved', 'normal', { delay: 60 }), { status: 'ok', deliveries: 1 })
    assert.deepEqual(await relay(db, s), [], 'not due yet')
    assert.equal(await status(db, token), 'pending')
    await sql(db, `update ypm_private.sim_outbox set deliver_after = now()`)
    assert.deepEqual(await relay(db, s), [{ status: 'ok', result: 'applied' }])
    assert.equal(await status(db, token), 'approved')
    assert.deepEqual(await relay(db, s), [], 'each delivery is handed out once')
    const claim = await call(db, 'voter_registration_claim', { p_token: token })
    assert.equal(claim.status, 'ok')
  })

  it('review and failed carry a reason code; the voter sees only the status', async () => {
    const { db, s } = await devDb()
    const t1 = await register(db, '08155500703')
    const t2 = await register(db, '08155500704')
    await start(db, s, t1, 'review')
    await start(db, s, t2, 'failed', 'normal', { reason: 'liveness_failed' })
    await relay(db, s)
    assert.deepEqual(await call(db, 'voter_registration_status', { p_token: t1 }), { status: 'review' })
    assert.deepEqual(await call(db, 'voter_registration_status', { p_token: t2 }), { status: 'failed' })
    const reasons = await sql(db, `select reason_code from ypm_private.provider_sessions order by created_at`)
    assert.deepEqual(reasons.map((r) => r.reason_code), ['possible_duplicate', 'liveness_failed'])
  })

  it('a duplicate delivery is applied once', async () => {
    const { db, s } = await devDb()
    const token = await register(db, '08155500705')
    assert.equal((await start(db, s, token, 'approved', 'duplicate')).deliveries, 2)
    assert.deepEqual((await relay(db, s)).map((r) => r.result), ['applied', 'duplicate'])
    assert.equal(await status(db, token), 'approved')
  })

  it('a bad signature is refused and changes nothing; the reply reveals nothing', async () => {
    const { db, s } = await devDb()
    const token = await register(db, '08155500706')
    await start(db, s, token, 'approved', 'bad_signature')
    assert.deepEqual(await relay(db, s), [{ status: 'rejected' }])
    assert.equal(await status(db, token), 'pending')
    assert.deepEqual(await events(db), ['bad_signature'])
    // A forged body with a guessed signature is refused the same way.
    const forged = JSON.stringify({ provider: 'simulated', provider_ref: await refOf(db, token), delivery_id: 'x', outcome: 'approved', issued_at: new Date().toISOString() })
    assert.deepEqual(await call(db, 'dev_provider_callback', { p_body: forged, p_signature: '00'.repeat(32) }), { status: 'rejected' })
    assert.equal(await status(db, token), 'pending')
  })

  it('a replayed old delivery, or one from the future, is refused', async () => {
    const { db, s } = await devDb()
    const token = await register(db, '08155500707')
    await start(db, s, token, 'approved', 'never')
    const ref = await refOf(db, token)
    for (const issued of [new Date(Date.now() - 11 * 60e3), new Date(Date.now() + 5 * 60e3)]) {
      const body = JSON.stringify({ provider: 'simulated', provider_ref: ref, delivery_id: `d${issued.getTime()}`, outcome: 'approved', reason_code: null, issued_at: issued.toISOString() })
      assert.deepEqual(await call(db, 'dev_provider_callback', { p_body: body, p_signature: await sign(db, body) }), { status: 'rejected' })
    }
    assert.equal(await status(db, token), 'pending')
    assert.deepEqual(await events(db), ['expired_delivery', 'expired_delivery'])
  })

  it('malformed, unknown-provider and unknown-reference deliveries change nothing', async () => {
    const { db, s } = await devDb()
    const token = await register(db, '08155500708')
    await start(db, s, token, 'approved', 'never')
    const now = new Date().toISOString()
    const bodies = [
      'not json',
      JSON.stringify({ provider: 'other', provider_ref: await refOf(db, token), delivery_id: 'a', outcome: 'approved', issued_at: now }),
      JSON.stringify({ provider: 'simulated', provider_ref: await refOf(db, token), delivery_id: 'b', outcome: 'claimed', issued_at: now }),
      JSON.stringify({ provider: 'simulated', provider_ref: await refOf(db, token), delivery_id: 'c', outcome: 'failed', reason_code: 'free text here', issued_at: now }),
    ]
    for (const b of bodies) {
      assert.deepEqual(await call(db, 'dev_provider_callback', { p_body: b, p_signature: await sign(db, b) }), { status: 'rejected' })
    }
    const unknown = JSON.stringify({ provider: 'simulated', provider_ref: 'simref_nope', delivery_id: 'd', outcome: 'approved', issued_at: now })
    assert.deepEqual(await call(db, 'dev_provider_callback', { p_body: unknown, p_signature: await sign(db, unknown) }), { status: 'ok', result: 'unknown_ref' })
    assert.equal(await status(db, token), 'pending')
    assert.deepEqual(await events(db), ['malformed', 'malformed', 'malformed', 'malformed', 'unknown_ref'])
  })

  it('out of order: a newer result wins, the older one is ignored as stale', async () => {
    const { db, s } = await devDb()
    const token = await register(db, '08155500709')
    await start(db, s, token, 'approved', 'out_of_order')
    // Delivered in insertion order: the newer "failed" first, then the older approval.
    await sql(db, `update ypm_private.sim_outbox set deliver_after = now() - interval '1 hour' + interval '1 second' * id`)
    const replies = await relay(db, s)
    assert.deepEqual(replies.map((r) => r.result), ['applied', 'stale'])
    assert.equal(await status(db, token), 'failed', 'the newer "failed" stands; approved never overrides it')
  })

  it('conflict after approval goes to review for a person; a later approval never upgrades a failure', async () => {
    const { db, s } = await devDb()
    const t1 = await register(db, '08155500710')
    await start(db, s, t1, 'approved', 'conflict')
    await sql(db, `update ypm_private.sim_outbox set deliver_after = now()`)
    assert.deepEqual((await relay(db, s)).map((r) => r.result), ['applied', 'conflict_review'])
    assert.equal(await status(db, t1), 'review')
    assert.equal((await sql(db, `select reason_code from ypm_private.provider_sessions`))[0].reason_code, 'conflicting_results')
    assert.equal((await call(db, 'voter_registration_claim', { p_token: t1 })).status, 'not_ready')

    const t2 = await register(db, '08155500711')
    await start(db, s, t2, 'failed', 'conflict')
    await sql(db, `update ypm_private.sim_outbox set deliver_after = now()`)
    assert.deepEqual((await relay(db, s)).map((r) => r.result), ['applied', 'conflict_ignored'])
    assert.equal(await status(db, t2), 'failed')
  })

  it('a result for a claimed account changes nothing', async () => {
    const { db, s } = await devDb()
    const token = await register(db, '08155500712')
    await start(db, s, token, 'approved')
    await relay(db, s)
    assert.equal((await call(db, 'voter_registration_claim', { p_token: token })).status, 'ok')
    const body = JSON.stringify({ provider: 'simulated', provider_ref: await refOf(db, token), delivery_id: 'late', outcome: 'review', reason_code: 'possible_duplicate', issued_at: new Date(Date.now() + 1000).toISOString() })
    assert.deepEqual(await call(db, 'dev_provider_callback', { p_body: body, p_signature: await sign(db, body) }), { status: 'ok', result: 'conflict_ignored' })
    assert.equal(await status(db, token), 'claimed')
  })

  it('a result after the registration expired is too late', async () => {
    const { db, s } = await devDb()
    const token = await register(db, '08155500713')
    await start(db, s, token, 'approved', 'normal', { delay: 60 })
    await sql(db, `update voter_registrations set expires_at = now() - interval '1 second'`)
    await sql(db, `update ypm_private.sim_outbox set deliver_after = now()`)
    assert.deepEqual(await relay(db, s), [{ status: 'ok', result: 'too_late' }])
    assert.equal(await status(db, token), 'expired')
  })

  it('refuses a second check for the same registration, finished ones, bad input and a missing key', async () => {
    const { db, s } = await devDb()
    const token = await register(db, '08155500714')
    assert.equal((await start(db, s, token, 'approved', 'never')).status, 'ok')
    assert.match((await start(db, s, token, 'approved')).message, /already running/)
    const t2 = await register(db, '08155500715')
    assert.equal((await start(db, s, t2, 'claimed')).status, 'error')
    assert.equal((await start(db, s, t2, 'approved', 'sideways')).status, 'error')
    assert.equal((await start(db, s, t2, 'failed', 'normal', { reason: 'face_matched_123' })).status, 'error')
    assert.equal((await start(db, s, 'no-such-token', 'approved')).status, 'error')
    await sql(db, `delete from vault.secrets where name = 'ypm_sim_provider_key'`)
    assert.match((await start(db, s, t2, 'approved')).message, /key missing/)
  })

  it('the synchronous tester path (dev_simulate_verification) still works alongside', async () => {
    const { db, s } = await devDb()
    const token = await register(db, '08155500716')
    assert.equal((await call(db, 'dev_simulate_verification', { p_admin_session: s, p_registration_token: token, p_outcome: 'approved' })).status, 'ok')
    assert.equal(await status(db, token), 'approved')
  })

  it('the callback is rate limited per address', async () => {
    const { db } = await devDb()
    await sql(db, `insert into rate_events (bucket) select 'provider_callback:198.51.100.77' from generate_series(1, 300)`)
    assert.deepEqual(await call(db, 'dev_provider_callback', { p_body: '{}', p_signature: 'x' }, { ip: '198.51.100.77' }), { status: 'rate_limited' })
  })
})

describe('005: what is stored', () => {
  it('only outcomes, reason codes, references and times: no names, numbers, images or scores', async () => {
    const { db } = await devDb()
    const cols = await sql(db, `
      select table_name t, column_name c from information_schema.columns
       where table_schema = 'ypm_private' and table_name in ('provider_sessions', 'verification_events', 'sim_outbox')
       order by 1, 2`)
    assert.deepEqual(cols.map((r) => `${r.t}.${r.c}`), [
      'provider_sessions.created_at', 'provider_sessions.decided_at', 'provider_sessions.last_issued_at',
      'provider_sessions.provider', 'provider_sessions.provider_ref', 'provider_sessions.reason_code',
      'provider_sessions.registration_id',
      'sim_outbox.body', 'sim_outbox.created_at', 'sim_outbox.deliver_after', 'sim_outbox.delivered_at',
      'sim_outbox.id', 'sim_outbox.registration_id', 'sim_outbox.signature',
      'verification_events.delivery_id', 'verification_events.id', 'verification_events.outcome',
      'verification_events.reason_code', 'verification_events.received_at', 'verification_events.registration_id',
      'verification_events.result',
    ])
  })

  it('the signed body carries no name or number', async () => {
    const { db, s } = await devDb()
    const token = await register(db, '08155500717', 'Test Bodycheck')
    await start(db, s, token, 'approved', 'never')
    await start(db, s, await register(db, '08155500718', 'Test Bodycheck'), 'approved')
    const bodies = (await sql(db, `select body from ypm_private.sim_outbox`)).map((r) => r.body).join('\n')
    assert.ok(!bodies.includes('Bodycheck') && !bodies.includes('0815550071'))
    assert.deepEqual(Object.keys(JSON.parse(bodies.split('\n')[0])).sort(),
      ['delivery_id', 'issued_at', 'outcome', 'provider', 'provider_ref', 'reason_code'])
  })
})

describe('005: admin visibility', () => {
  it('admin_review_details explains each waiting review and its deliveries', async () => {
    const { db, s } = await devDb()
    const t1 = await register(db, '08155500719')
    const t2 = await register(db, '08155500720')
    await start(db, s, t1, 'review')
    await start(db, s, t2, 'approved', 'conflict')
    await sql(db, `update ypm_private.sim_outbox set deliver_after = now()`)
    await relay(db, s)
    const d = await call(db, 'admin_review_details', { p_session: s })
    assert.equal(d.status, 'ok')
    assert.deepEqual(d.reviews.map((r) => [r.reason_code, r.deliveries, r.conflicts]),
      [['possible_duplicate', 1, 0], ['conflicting_results', 2, 1]])
    assert.deepEqual(d.reviews[1].history.map((h) => h.result), ['applied', 'conflict_review'])
    assert.ok(!JSON.stringify(d).includes('0815550072'), 'no numbers')
  })
})

describe('005: 30-day retention', () => {
  async function aged(db, s) {
    // One of each kind, then everything made 31 days old except as noted.
    const claimed = await register(db, '08155500721')
    await start(db, s, claimed, 'approved')
    await relay(db, s)
    const voter = await call(db, 'voter_registration_claim', { p_token: claimed })
    await call(db, 'voter_begin_ballot', { p_session: voter.session })
    await call(db, 'voter_save_vote', { p_session: voter.session, p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams' })
    const failed = await register(db, '08155500722')
    await start(db, s, failed, 'failed')
    const review = await register(db, '08155500723')
    await start(db, s, review, 'review')
    await relay(db, s)
    await call(db, 'dev_provider_callback', { p_body: 'forged', p_signature: 'x' })
    const recent = await register(db, '08155500724')
    await start(db, s, recent, 'failed')
    return { claimed, failed, review, recent }
  }
  const backdate = (db, days, where = 'true') => db.exec(`
    update voter_registrations set created_at = created_at - interval '${days} days',
           expires_at = expires_at - interval '${days} days',
           reviewed_at = reviewed_at - interval '${days} days' where ${where};
    update ypm_private.verification_events set received_at = received_at - interval '${days} days';
    update ypm_private.sim_outbox set created_at = created_at - interval '${days} days', deliver_after = deliver_after - interval '${days} days'`)

  it('deletes finished verification records after 30 days, and nothing else', async () => {
    const { db, s } = await devDb()
    const t = await aged(db, s)
    await backdate(db, 31, `phone <> '08155500724'`)
    await relay(db, s)
    const before = {
      ballots: (await sql(db, `select count(*)::int n from ballots`))[0].n,
      votes: (await sql(db, `select count(*)::int n from votes`))[0].n,
      voters: (await sql(db, `select count(*)::int n from voters`))[0].n,
      consents: (await sql(db, `select count(*)::int n from voter_consents`))[0].n,
      audit: (await sql(db, `select count(*)::int n from admin_audit`))[0].n,
    }
    const r = await call(db, 'admin_purge_verification_records', { p_session: s })
    assert.equal(r.status, 'ok')
    assert.equal(r.registrations, 2, 'claimed and failed')
    assert.equal(r.older_than_days, 30)

    assert.equal(await status(db, t.claimed), 'invalid', 'claimed registration deleted')
    assert.equal(await status(db, t.failed), 'invalid', 'failed registration deleted')
    assert.equal(await status(db, t.review), 'review', 'a waiting review is kept, however old')
    assert.equal(await status(db, t.recent), 'failed', 'a recent one is kept')
    assert.equal((await sql(db, `select count(*)::int n from ypm_private.verification_events where registration_id is null`))[0].n, 0, 'old bad-signature entries gone')
    assert.equal((await sql(db, `select count(*)::int n from ypm_private.provider_sessions`))[0].n, 2)

    assert.equal((await sql(db, `select count(*)::int n from ballots`))[0].n, before.ballots)
    assert.equal((await sql(db, `select count(*)::int n from votes`))[0].n, before.votes)
    assert.equal((await sql(db, `select count(*)::int n from voters`))[0].n, before.voters)
    assert.equal((await sql(db, `select count(*)::int n from voter_consents`))[0].n, before.consents)
    assert.equal((await sql(db, `select count(*)::int n from admin_audit`))[0].n, before.audit + 1)
    const a = (await sql(db, `select actor, detail from admin_audit where action = 'verification_records_purged'`))[0]
    assert.equal(a.actor, 'leader')
    assert.equal(a.detail.registrations, 2)
    assert.equal((await sql(db, `select count(*)::int n from ballots where voter_phone = $1`, [LEGACY.done.phone]))[0].n, 1)
  })

  it('at 29 days nothing is deleted; the clean-up also runs when a check starts', async () => {
    const { db, s } = await devDb()
    await aged(db, s)
    await backdate(db, 29)
    assert.deepEqual(await call(db, 'admin_purge_verification_records', { p_session: s }),
      { status: 'ok', registrations: 0, events: 0, outbox: 0, older_than_days: 30 })
    await backdate(db, 2)
    await start(db, s, await register(db, '08155500725'), 'approved', 'never')
    assert.equal((await sql(db, `select count(*)::int n from admin_audit where action = 'verification_records_purged' and actor = 'retention'`))[0].n, 1)
  })

  it('erasing a voter removes their verification records too', async () => {
    const { db, s } = await devDb()
    const token = await register(db, '08155500726')
    await start(db, s, token, 'approved')
    await relay(db, s)
    const c = await call(db, 'voter_registration_claim', { p_token: token })
    const id = (await sql(db, `select id from voters where phone = '08155500726'`))[0].id
    assert.ok(c.voter_code)
    await sql(db, `select ypm_private.erase_voter($1, 'synthetic test')`, [id])
    assert.equal((await sql(db, `select count(*)::int n from ypm_private.provider_sessions`))[0].n, 0)
    assert.equal((await sql(db, `select count(*)::int n from ypm_private.verification_events where registration_id is not null`))[0].n, 0)
  })
})

describe('005: install, re-run and undo', () => {
  it('needs 004; runs twice; 004 can be re-run on top; undo removes only 005', async () => {
    const old = await freshDb({ migrate: '003' })
    await assert.rejects(old.exec(PROVIDER_SQL), /Run 004_voter_safeguards.sql first/)
    await old.exec('rollback')

    const { db, s } = await devDb()
    const token = await register(db, '08155500727')
    await start(db, s, token, 'approved')
    await relay(db, s)
    await db.exec(PROVIDER_SQL)
    await db.exec(SAFEGUARDS_SQL)
    assert.equal((await call(db, 'admin_review_details', { p_session: s })).status, 'ok', '005 survives a 004 re-run')

    await assert.rejects(db.exec(SAFEGUARDS_DOWN_SQL), /Migration 005 is installed/)
    await db.exec('rollback')
    await assert.rejects(db.exec(VOTER_MIGRATION_SQL), /Migration 004 is installed/)
    await db.exec('rollback')

    const regs = (await sql(db, `select count(*)::int n from voter_registrations`))[0].n
    await db.exec(PROVIDER_DOWN_SQL)
    assert.equal((await sql(db, `select to_regclass('ypm_private.provider_sessions') r`))[0].r, null)
    assert.equal((await sql(db, `select count(*)::int n from voter_registrations`))[0].n, regs)
    assert.equal(await status(db, token), 'approved', 'registrations untouched')
    for (const fn of NEW_PUBLIC) {
      assert.equal((await sql(db, `select count(*)::int n from pg_proc where proname = $1`, [fn]))[0].n, 0, fn)
    }
    await db.exec(SAFEGUARDS_DOWN_SQL) // now allowed
    await db.exec(SAFEGUARDS_SQL)
    await db.exec(PROVIDER_SQL) // reinstall reuses the key
    assert.equal((await start(db, s, await register(db, '08155500728'), 'approved')).status, 'ok')
  })
})
