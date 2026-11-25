// GENUINE concurrency tests for voter accounts (migrations 001–004), on a
// real, throwaway PostgreSQL server (see pg-cluster.mjs). Run with
//   npm run test:concurrency
// Not part of `npm test`: it needs PostgreSQL's programs installed, and the
// PGlite tests there are sequential only.
//
// How each scenario works:
//   1. A controller connection takes an advisory lock (the barrier).
//   2. N separate psql connections start; each first waits on the barrier.
//   3. We check in pg_locks that all N are waiting at the same time.
//   4. The controller is ended, releasing all N together. Each runs its
//      call in its own transaction and holds it open for HOLD seconds, so
//      the others must wait on its locks (we record how long each call
//      waited, as evidence of real contention).
//   5. We check the database afterwards: no duplicate voters, ballots or
//      valid codes, and no request failed with an error.
// Synthetic identities only (0815550 0xxx).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { findPgBin, startCluster } from './pg-cluster.mjs'
import {
  ROLES_SQL, SETUP_SQL, VAULT_STUB_SQL, MIGRATION_SQL, BALLOT_MIGRATION_SQL, BALLOT_SYNC_SQL,
  VOTER_MIGRATION_SQL, SAFEGUARDS_SQL, DEV_SIM_SQL, LEADER_KEY,
} from '../db/helpers.mjs'

const N = 6
const HOLD = 0.3 // seconds each transaction stays open after its call
const DB = 'ypm_concurrency'
const CV = 'draft-2026-11-dev'
const BARRIER = 4242
const bin = findPgBin()

let pg
const summary = []

const lit = (v) => (v === null ? 'null' : typeof v === 'boolean' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)
const callSql = (fn, args) =>
  `public.${fn}(${Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ')})`

// As the database owner (setup and checks).
function q(sqlText) {
  return pg.psql(DB, sqlText).trim()
}
function json(fn, args) {
  return JSON.parse(q(`select ${callSql(fn, args)}::text;`))
}
const num = (sqlText) => Number(q(sqlText))

async function waitUntil(check, what, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out: ${what}`)
}

// Release N calls (as the API role anon, each from its own IP) at once.
async function together(label, calls) {
  const controller = pg.spawnPsql(DB, `select pg_advisory_lock(${BARRIER}); select pg_sleep(120);`)
  await waitUntil(() => num(`select count(*) from pg_locks where locktype = 'advisory' and objid = ${BARRIER}
                             and mode = 'ExclusiveLock' and granted`) === 1, 'barrier held')
  const workers = calls.map(([fn, args], i) =>
    pg.spawnPsql(DB, `
      select pg_advisory_lock_shared(${BARRIER});
      select pg_advisory_unlock_shared(${BARRIER});
      select set_config('request.headers', '{"x-forwarded-for":"203.0.113.${i + 10}"}', false);
      set role anon;
      begin;
      select clock_timestamp() as t0 \\gset
      select 'RESULT:' || json_build_object(
        'r', ${callSql(fn, args)},
        'wait_ms', round(extract(epoch from clock_timestamp() - :'t0'::timestamptz) * 1000))::text;
      select pg_sleep(${HOLD});
      commit;
    `))
  await waitUntil(() => num(`select count(*) from pg_locks where locktype = 'advisory' and objid = ${BARRIER}
                             and mode = 'ShareLock' and not granted`) === calls.length, 'all requests queued')
  const queued = calls.length
  q(`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and objid = ${BARRIER}
      and mode = 'ExclusiveLock' and granted;`)
  const done = await Promise.all(workers)
  await controller
  const results = done.map((d) => {
    const line = d.out.split(/\r?\n/).find((l) => l.startsWith('RESULT:'))
    return line ? JSON.parse(line.slice(7)) : { error: (d.err || d.out).trim() }
  })
  const waits = results.map((r) => r.wait_ms ?? 0)
  summary.push({ scenario: label, queued, statuses: results.map((r) => r.r?.status ?? 'ERROR'), max_wait_ms: Math.max(...waits) })
  return { results, queued, maxWait: Math.max(...waits) }
}

function noErrors(results) {
  for (const r of results) assert.ok(!r.error, `a request failed: ${r.error}`)
}
const statuses = (results) => results.map((r) => r.r.status).sort()
// Real contention: some call waited for another transaction's locks.
function contended(maxWait) {
  assert.ok(maxWait >= HOLD * 1000 * 0.6, `calls didn't overlap (max wait ${maxWait} ms)`)
}

function adminSession() {
  return json('admin_login', { p_key: LEADER_KEY }).session
}

function inPerson(s, name, phone, link = false) {
  return json('admin_register_voter', {
    p_session: s, p_name: name, p_phone: phone, p_consent_version: CV,
    p_adult_confirmed: true, p_link_existing_ballot: link,
  })
}

function anonBallot(name, phone) {
  const b = json('begin_ballot', { p_name: name, p_phone: phone, p_code: null })
  json('save_vote', { p_ballot_id: b.ballot_id, p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams' })
  return b.ballot_id
}

describe('genuine concurrency on real PostgreSQL', { skip: bin ? false : 'PostgreSQL programs not found (set YPM_PG_BIN)', timeout: 300000 }, () => {
  before(async () => {
    pg = await startCluster(bin)
    pg.psql('postgres', `create database ${DB};`)
    for (const s of [ROLES_SQL, SETUP_SQL, VAULT_STUB_SQL, MIGRATION_SQL, BALLOT_MIGRATION_SQL, BALLOT_SYNC_SQL,
      VOTER_MIGRATION_SQL, SAFEGUARDS_SQL]) {
      pg.psql(DB, s)
    }
    pg.psql(DB, `update ypm_private.deployment set environment = 'development';
                 update settings set verification_provider = 'simulated', registration_mode = 'optional' where id = 1;`)
    pg.psql(DB, DEV_SIM_SQL)
  })

  after(() => {
    pg?.stop()
    if (summary.length) console.log('\nconcurrency summary:\n' + summary.map((s) => JSON.stringify(s)).join('\n'))
  })

  it('it really is PostgreSQL, separate from anything else', () => {
    assert.match(q('select version();'), /^PostgreSQL \d+/)
    assert.equal(q('select inet_server_addr()::text;'), '127.0.0.1/32')
    assert.equal(Number(q('show port;')), pg.port)
  })

  it('one voter opening their ballot on several devices at once gets ONE ballot', async () => {
    const s = adminSession()
    const reg = inPerson(s, 'Test Devices', '08155500801')
    const sessions = Array.from({ length: N }, () => json('voter_login', { p_code: reg.voter_code }).session)
    const { results, maxWait } = await together('voter_begin_ballot x6, same voter',
      sessions.map((v) => ['voter_begin_ballot', { p_session: v }]))
    noErrors(results)
    contended(maxWait)
    assert.deepEqual(statuses(results), ['resumed', 'resumed', 'resumed', 'resumed', 'resumed', 'started'])
    assert.equal(num(`select count(*) from ballots where voter_id = ${lit(reg.voter_id)};`), 1)
  })

  it('claiming one registration from several devices at once makes ONE account', async () => {
    const s = adminSession()
    const st = json('voter_registration_start', { p_name: 'Test Claims', p_phone: '08155500802', p_consent_version: CV, p_adult: true })
    json('dev_simulate_verification', { p_admin_session: s, p_registration_token: st.registration_token, p_outcome: 'approved' })
    const { results, maxWait } = await together('voter_registration_claim x6, same token',
      Array.from({ length: N }, () => ['voter_registration_claim', { p_token: st.registration_token }]))
    noErrors(results)
    contended(maxWait)
    assert.equal(results.filter((r) => r.r.status === 'ok').length, 1)
    assert.equal(num(`select count(*) from voters where phone = '08155500802';`), 1)
    assert.equal(num(`select count(*) from voter_consents c join voters v on v.id = c.voter_id where v.phone = '08155500802';`), 1)
  })

  it('two registrations for one number, claimed at once: ONE account', async () => {
    const s = adminSession()
    const tokens = [0, 1].map(() => {
      const st = json('voter_registration_start', { p_name: 'Test Twotokens', p_phone: '08155500803', p_consent_version: CV, p_adult: true })
      json('dev_simulate_verification', { p_admin_session: s, p_registration_token: st.registration_token, p_outcome: 'approved' })
      return st.registration_token
    })
    const { results } = await together('voter_registration_claim, two tokens, same number',
      [...tokens, ...tokens, ...tokens].map((t) => ['voter_registration_claim', { p_token: t }]))
    noErrors(results)
    assert.equal(results.filter((r) => r.r.status === 'ok').length, 1)
    assert.equal(num(`select count(*) from voters where phone = '08155500803';`), 1)
  })

  it('several admins approving one review with ballot linking at once: ONE account, ballot linked once, votes kept', async () => {
    const s = adminSession()
    const st = json('voter_registration_start', { p_name: 'Test Approvers', p_phone: '08155500804', p_consent_version: CV, p_adult: true })
    json('dev_simulate_verification', { p_admin_session: s, p_registration_token: st.registration_token, p_outcome: 'review' })
    const id = q(`select id from voter_registrations where phone = '08155500804';`)
    const ballot = anonBallot('Test Approvers', '08155500804')
    const admins = Array.from({ length: N }, () => adminSession())
    const { results, maxWait } = await together('admin_resolve_review approve+link x6, same review',
      admins.map((a) => ['admin_resolve_review', { p_session: a, p_registration_id: id, p_decision: 'approve', p_link_existing_ballot: true }]))
    noErrors(results)
    contended(maxWait)
    assert.equal(results.filter((r) => r.r.status === 'ok').length, 1)
    assert.equal(num(`select count(*) from voters where phone = '08155500804';`), 1)
    assert.equal(num(`select count(*) from ballots where voter_phone = '08155500804';`), 1)
    assert.equal(q(`select (voter_id is not null)::text from ballots where id = ${lit(ballot)};`), 'true')
    assert.equal(num(`select count(*) from votes where ballot_id = ${lit(ballot)};`), 1)
  })

  it('approving a review and registering in person for the same number at once: ONE account', async () => {
    const s = adminSession()
    const st = json('voter_registration_start', { p_name: 'Test Mixed', p_phone: '08155500805', p_consent_version: CV, p_adult: true })
    json('dev_simulate_verification', { p_admin_session: s, p_registration_token: st.registration_token, p_outcome: 'review' })
    const id = q(`select id from voter_registrations where phone = '08155500805';`)
    anonBallot('Test Mixed', '08155500805')
    const admins = Array.from({ length: N }, () => adminSession())
    const { results, maxWait } = await together('approve+link vs in-person+link, same number',
      admins.map((a, i) => (i % 2 === 0
        ? ['admin_resolve_review', { p_session: a, p_registration_id: id, p_decision: 'approve', p_link_existing_ballot: true }]
        : ['admin_register_voter', { p_session: a, p_name: 'Test Mixed', p_phone: '08155500805', p_consent_version: CV, p_adult_confirmed: true, p_link_existing_ballot: true }])))
    noErrors(results)
    contended(maxWait)
    assert.equal(results.filter((r) => r.r.status === 'ok').length, 1)
    assert.equal(num(`select count(*) from voters where phone = '08155500805';`), 1)
    assert.equal(num(`select count(*) from ballots where voter_phone = '08155500805' and voter_id is not null;`), 1)
  })

  it('restoring one voter from several dashboards at once: ONE new code, the old one still dead', async () => {
    const s = adminSession()
    const reg = inPerson(s, 'Test Restorers', '08155500806')
    json('admin_revoke_voter', { p_session: s, p_voter_id: reg.voter_id, p_reason: null })
    const admins = Array.from({ length: N }, () => adminSession())
    const { results, maxWait } = await together('admin_restore_voter x6, same voter',
      admins.map((a) => ['admin_restore_voter', { p_session: a, p_voter_id: reg.voter_id, p_reason: 'checked in person' }]))
    noErrors(results)
    contended(maxWait)
    const ok = results.filter((r) => r.r.status === 'ok')
    assert.equal(ok.length, 1)
    assert.equal(results.filter((r) => r.r.status === 'not_revoked').length, N - 1)
    assert.equal(json('voter_login', { p_code: ok[0].r.voter_code }).status, 'ok')
    assert.equal(json('voter_login', { p_code: reg.voter_code }).status, 'invalid')
  })

  it('reissuing one voter’s code from several dashboards at once: exactly ONE code works', async () => {
    const s = adminSession()
    const reg = inPerson(s, 'Test Reissuers', '08155500807')
    const admins = Array.from({ length: N }, () => adminSession())
    const { results, maxWait } = await together('admin_reissue_voter_code x6, same voter',
      admins.map((a) => ['admin_reissue_voter_code', { p_session: a, p_voter_id: reg.voter_id }]))
    noErrors(results)
    contended(maxWait)
    const codes = results.map((r) => r.r.voter_code)
    assert.equal(new Set(codes).size, N, 'every code is different')
    const working = [reg.voter_code, ...codes].filter((c) => json('voter_login', { p_code: c }).status === 'ok')
    assert.equal(working.length, 1)
    assert.equal(num(`select count(*) from ypm_private.retired_voter_codes;`) >= N, true)
  })

  it('legacy: the same number starting anonymous ballots from several phones at once gets ONE ballot', async () => {
    const { results, maxWait } = await together('begin_ballot x6, same number (anonymous)',
      Array.from({ length: N }, () => ['begin_ballot', { p_name: 'Test Anon', p_phone: '08155500808', p_code: null }]))
    noErrors(results)
    contended(maxWait)
    assert.equal(results.filter((r) => r.r.status === 'started').length, 1)
    assert.equal(num(`select count(*) from ballots where voter_phone = '08155500808';`), 1)
  })
})
