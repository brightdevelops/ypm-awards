// Migration 003: registered voter accounts. Simulated verification only;
// all names and numbers are fictional.
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import {
  freshDb, call, sql, login, issue, LEGACY,
  MIGRATION_SQL, DOWN_SQL, BALLOT_MIGRATION_SQL, BALLOT_DOWN_SQL, VOTER_MIGRATION_SQL, VOTER_DOWN_SQL, DEV_SIM_SQL,
} from './helpers.mjs'

const CODE_RE = /^YPM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/
const CONSENT = 'draft-2026-11'

async function devMode(db, { mode = 'optional' } = {}) {
  await sql(db, `update ypm_private.deployment set environment = 'development'`)
  await sql(db, `update settings set verification_provider = 'simulated', registration_mode = $1 where id = 1`, [mode])
  await db.exec(DEV_SIM_SQL)
}

const start = (db, name, phone, extra = {}, opts) =>
  call(db, 'voter_registration_start', {
    p_name: name, p_phone: phone, p_consent_version: CONSENT, p_adult: true, ...extra,
  }, opts)

const simulate = (db, admin, token, outcome) =>
  call(db, 'dev_simulate_verification', {
    p_admin_session: admin, p_registration_token: token, p_outcome: outcome,
  })

async function registerSelf(db, admin, name, phone) {
  const s = await start(db, name, phone)
  assert.equal(s.status, 'ok', JSON.stringify(s))
  assert.equal((await simulate(db, admin, s.registration_token, 'approved')).status, 'ok')
  const c = await call(db, 'voter_registration_claim', { p_token: s.registration_token })
  assert.equal(c.status, 'ok', JSON.stringify(c))
  return c
}

async function registerInPerson(db, admin, name, phone, link = false) {
  const r = await call(db, 'admin_register_voter', {
    p_session: admin, p_name: name, p_phone: phone, p_link_existing_ballot: link,
  })
  assert.equal(r.status, 'ok', JSON.stringify(r))
  return r
}

const voterLogin = (db, code, opts) => call(db, 'voter_login', { p_code: code }, opts)
const ballotRows = (db) =>
  sql(db, `select id, voter_name, voter_phone, started_at, completed_at from ballots order by id`)
const voteRows = (db) => sql(db, `select * from votes order by id`)

describe('003 defaults and existing data', () => {
  it('leaves every ballot and vote exactly as it was', async () => {
    const db = await freshDb({ migrate: '002' })
    const b = await call(db, 'begin_ballot', { p_name: 'Kemi Test', p_phone: '08150000001' })
    await call(db, 'save_vote', {
      p_ballot_id: b.ballot_id, p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams',
    })
    const ballotsBefore = await ballotRows(db)
    const votesBefore = await voteRows(db)

    await db.exec(VOTER_MIGRATION_SQL)

    assert.deepEqual(await ballotRows(db), ballotsBefore)
    assert.deepEqual(await voteRows(db), votesBefore)
    assert.equal((await sql(db, `select count(*)::int n from ballots where voter_id is not null`))[0].n, 0)
  })

  it('starts with registration off, no provider, and marked as production', async () => {
    const db = await freshDb({ migrate: '003' })
    const [s] = await sql(db, `select registration_mode, verification_provider from settings`)
    assert.deepEqual(s, { registration_mode: 'off', verification_provider: 'none' })
    assert.equal((await sql(db, `select environment from ypm_private.deployment`))[0].environment, 'production')
    assert.equal((await start(db, 'Kemi Test', '08150000002')).status, 'registration_off')
  })

  it('refuses to install without Vault', async () => {
    const db = await freshDb({ migrate: '002' })
    await db.exec(`drop schema vault cascade`)
    await assert.rejects(db.exec(VOTER_MIGRATION_SQL), /Vault is not available/)
  })

  it('keeps the browser out of every new table and private function', async () => {
    const db = await freshDb({ migrate: '003' })
    await db.exec('set role anon')
    try {
      for (const t of ['voters', 'voter_registrations', 'voter_sessions']) {
        await assert.rejects(db.query(`select * from public.${t}`), /permission denied/, t)
      }
      for (const q of [
        `select * from ypm_private.deployment`,
        `select ypm_private.voter_pepper()`,
        `select ypm_private.begin_ballot_001('x', '08150000003', null, null)`,
        `select ypm_private.save_vote_002(gen_random_uuid(), 'a', 'b')`,
        `select * from vault.decrypted_secrets`,
      ]) {
        await assert.rejects(db.query(q), /permission denied/, q)
      }
    } finally {
      await db.exec('reset role')
    }
  })
})

describe('voter codes and their hashes', () => {
  let db, admin
  before(async () => {
    db = await freshDb({ migrate: '003' })
    admin = await login(db)
  })

  it('computes HMAC-SHA-256 correctly (RFC 4231 test case 2)', async () => {
    const [r] = await sql(db, `select encode(ypm_private.hmac_sha256(
      convert_to('Jefe', 'UTF8'), convert_to('what do ya want for nothing?', 'UTF8')), 'hex') h`)
    assert.equal(r.h, '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
    const [long] = await sql(db, `select encode(ypm_private.hmac_sha256(
      decode(repeat('aa', 131), 'hex'),
      convert_to('Test Using Larger Than Block-Size Key - Hash Key First', 'UTF8')), 'hex') h`)
    assert.equal(long.h, '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54')
  })

  it('generates long, unique codes in the voter format', async () => {
    const rows = await sql(db, `select ypm_private.new_voter_code() c from generate_series(1, 500)`)
    for (const { c } of rows) assert.match(c, CODE_RE)
    assert.equal(new Set(rows.map((r) => r.c)).size, 500)
  })

  it('accepts a code in any case or spacing, and nothing else', async () => {
    const ok = await sql(db, `select ypm_private.normalize_voter_code(x) n from unnest(array[
      'YPM-ABCD-2345-HJKM', 'ypm abcd 2345 hjkm', 'YPMABCD2345HJKM']) x`)
    for (const { n } of ok) assert.equal(n, 'YPMABCD2345HJKM')
    const bad = await sql(db, `select ypm_private.normalize_voter_code(x) n from unnest(array[
      'YPM-ABCD-2345', 'YPM-ABCD-2345-HJK0', 'XYZ-ABCD-2345-HJKM', 'K7MQP-3XZRA', '']) x`)
    for (const { n } of bad) assert.equal(n, null)
  })

  it('stores only a keyed hash, never the code', async () => {
    const r = await registerInPerson(db, admin, 'Tolu Test', '08150000010')
    const norm = r.voter_code.replace(/-/g, '')
    const [v] = await sql(db, `select code_hash, row_to_json(v)::text as row,
        encode(sha256(convert_to($1, 'UTF8')), 'hex') as plain_sha
      from voters v where id = $2`, [norm, r.voter_id])
    assert.ok(!v.row.includes(r.voter_code) && !v.row.includes(norm))
    assert.notEqual(v.code_hash, v.plain_sha)
    const [keyed] = await sql(db, `select encode(ypm_private.hmac_sha256(ypm_private.voter_pepper(),
      convert_to($1, 'UTF8')), 'hex') h`, [norm])
    assert.equal(v.code_hash, keyed.h)
    const audit = await sql(db, `select detail::text d from admin_audit`)
    for (const { d } of audit) assert.ok(!d.includes(norm) && !d.includes(r.voter_code))
  })

  it('keeps the key when 003 is run again, so codes keep working', async () => {
    const r = await registerInPerson(db, admin, 'Rerun Test', '08150000011')
    await db.exec(VOTER_MIGRATION_SQL)
    assert.equal((await voterLogin(db, r.voter_code)).status, 'ok')
  })

  it('fails closed if the key is missing', async () => {
    const db2 = await freshDb({ migrate: '003' })
    const a = await login(db2)
    await sql(db2, `delete from vault.secrets`)
    await assert.rejects(
      call(db2, 'admin_register_voter', { p_session: a, p_name: 'No Key', p_phone: '08150000012' }),
      /voter code key is missing/,
    )
    await assert.rejects(voterLogin(db2, 'YPM-ABCD-2345-HJKM'), /voter code key is missing/)
  })

  it('never confuses voter codes with voting codes', async () => {
    const [vc] = await issue(db, admin, { count: 1 })
    assert.equal((await voterLogin(db, vc.code)).status, 'invalid')
    const r = await registerInPerson(db, admin, 'Cross Test', '08150000013')
    const b = await call(db, 'begin_ballot', {
      p_name: 'Someone Else', p_phone: '08150000014', p_code: r.voter_code,
    })
    assert.equal(b.status, 'invalid_code')
  })
})

describe('the simulated provider is development-only', () => {
  it('cannot be switched on, or installed, in a production project', async () => {
    const db = await freshDb({ migrate: '003' })
    await assert.rejects(
      sql(db, `update settings set verification_provider = 'simulated' where id = 1`),
      /only allowed in a development project/,
    )
    await assert.rejects(db.exec(DEV_SIM_SQL), /not marked as development/)
    await db.exec('rollback') // the SQL editor ends the failed transaction the same way
    assert.equal(
      (await sql(db, `select to_regprocedure('public.dev_simulate_verification(text,text,text)') f`))[0].f,
      null,
    )
  })

  it('needs an admin session, and stops working outside development', async () => {
    const db = await freshDb({ migrate: '003' })
    const admin = await login(db)
    await devMode(db)
    const s = await start(db, 'Sim Test', '08150000020')
    assert.equal((await simulate(db, 'not-a-session', s.registration_token, 'approved')).status, 'unauthorized')
    assert.equal((await simulate(db, null, s.registration_token, 'approved')).status, 'unauthorized')

    await sql(db, `update ypm_private.deployment set environment = 'production'`)
    assert.equal((await simulate(db, admin, s.registration_token, 'approved')).status, 'disabled')
    await sql(db, `update ypm_private.deployment set environment = 'development'`)
    await sql(db, `update settings set verification_provider = 'none' where id = 1`)
    assert.equal((await simulate(db, admin, s.registration_token, 'approved')).status, 'disabled')

    // Still pending: nothing was approved.
    assert.equal((await call(db, 'voter_registration_status', { p_token: s.registration_token })).status, 'pending')
  })

  it('without a provider, self-registration is unavailable', async () => {
    const db = await freshDb({ migrate: '003' })
    await sql(db, `update settings set registration_mode = 'optional' where id = 1`)
    assert.equal((await start(db, 'Kemi Test', '08150000021')).status, 'verification_unavailable')
  })
})

describe('self-registration (simulated)', () => {
  let db, admin
  before(async () => {
    db = await freshDb({ migrate: '003' })
    admin = await login(db)
    await devMode(db)
  })

  it('approved: the code is handed over once and signs the voter in', async () => {
    const s = await start(db, 'Ada Test Voter', '08150000030')
    assert.equal(s.status, 'ok')
    assert.equal((await call(db, 'voter_registration_status', { p_token: s.registration_token })).status, 'pending')
    assert.equal((await call(db, 'voter_registration_claim', { p_token: s.registration_token })).status, 'not_ready')

    await simulate(db, admin, s.registration_token, 'approved')
    const c = await call(db, 'voter_registration_claim', { p_token: s.registration_token })
    assert.equal(c.status, 'ok')
    assert.match(c.voter_code, CODE_RE)
    assert.equal(c.first_name, 'Ada')
    assert.ok(c.session)
    assert.equal((await call(db, 'voter_registration_claim', { p_token: s.registration_token })).status, 'invalid')

    const l = await voterLogin(db, c.voter_code.toLowerCase())
    assert.equal(l.status, 'ok')
    assert.deepEqual(l.ballot, { state: 'none', answered: 0 })
    const [v] = await sql(db, `select method, created_by, consent_version, adult_confirmed
                                 from voters where phone = '08150000030'`)
    assert.deepEqual(v, { method: 'face_simulated', created_by: 'self', consent_version: CONSENT, adult_confirmed: true })
  })

  it('refuses under-18s online and incomplete details', async () => {
    assert.equal((await start(db, 'Young Test', '08150000031', { p_adult: false })).status, 'adult_required')
    assert.equal((await start(db, 'Young Test', '08150000031', { p_adult: null })).status, 'adult_required')
    assert.equal((await start(db, 'X', '08150000031')).status, 'error')
    assert.equal((await start(db, 'No Consent', '08150000031', { p_consent_version: ' ' })).status, 'error')
    assert.equal((await start(db, 'Bad Phone', '123')).status, 'error')
  })

  it('possible duplicate: goes to review, decided by an admin in person', async () => {
    const s = await start(db, 'Review Test', '08150000032')
    await simulate(db, admin, s.registration_token, 'review')
    const c = await call(db, 'voter_registration_claim', { p_token: s.registration_token })
    assert.deepEqual(c, { status: 'not_ready', registration: 'review' })

    const list = await call(db, 'admin_list_reviews', { p_session: admin })
    const item = list.reviews.find((r) => r.full_name === 'Review Test')
    assert.equal(item.phone, '•••• 0032')
    assert.ok(!JSON.stringify(list).includes('08150000032'))

    const ok = await call(db, 'admin_resolve_review', {
      p_session: admin, p_registration_id: item.id, p_decision: 'approve',
    })
    assert.equal(ok.status, 'ok')
    assert.equal((await voterLogin(db, ok.voter_code)).status, 'ok')
    // Decided once only.
    const again = await call(db, 'admin_resolve_review', {
      p_session: admin, p_registration_id: item.id, p_decision: 'reject',
    })
    assert.equal(again.status, 'error')
  })

  it('a review can be rejected', async () => {
    const s = await start(db, 'Reject Test', '08150000033')
    await simulate(db, admin, s.registration_token, 'review')
    const { reviews } = await call(db, 'admin_list_reviews', { p_session: admin })
    const item = reviews.find((r) => r.full_name === 'Reject Test')
    const r = await call(db, 'admin_resolve_review', {
      p_session: admin, p_registration_id: item.id, p_decision: 'reject',
    })
    assert.equal(r.status, 'ok')
    assert.equal((await call(db, 'voter_registration_status', { p_token: s.registration_token })).status, 'rejected')
    assert.equal((await call(db, 'voter_registration_claim', { p_token: s.registration_token })).status, 'invalid')
  })

  it('failed verification creates nothing', async () => {
    const s = await start(db, 'Fail Test', '08150000034')
    await simulate(db, admin, s.registration_token, 'failed')
    assert.equal((await call(db, 'voter_registration_claim', { p_token: s.registration_token })).status, 'not_ready')
    assert.equal((await sql(db, `select count(*)::int n from voters where phone = '08150000034'`))[0].n, 0)
  })

  it('registrations expire after 30 minutes', async () => {
    const s = await start(db, 'Slow Test', '08150000035')
    await simulate(db, admin, s.registration_token, 'approved')
    await sql(db, `update voter_registrations set expires_at = now() - interval '1 second' where full_name = 'Slow Test'`)
    assert.equal((await call(db, 'voter_registration_claim', { p_token: s.registration_token })).status, 'expired')
    assert.equal((await call(db, 'voter_registration_status', { p_token: s.registration_token })).status, 'expired')
  })

  it('gives the same answer for a registered number and a number with a ballot', async () => {
    await registerSelf(db, admin, 'Taken Test', '08150000036')
    const registered = await start(db, 'Other Person', '08150000036')
    const hasBallot = await start(db, 'Other Person', LEGACY.open.phone)
    assert.deepEqual(registered, { status: 'needs_assistance' })
    assert.deepEqual(hasBallot, registered)
  })

  it('a number that votes anonymously while registering can’t then claim', async () => {
    const s = await start(db, 'Race Test', '08150000037')
    await simulate(db, admin, s.registration_token, 'approved')
    await call(db, 'begin_ballot', { p_name: 'Race Test', p_phone: '08150000037' })
    assert.equal((await call(db, 'voter_registration_claim', { p_token: s.registration_token })).status, 'needs_assistance')
    assert.equal((await call(db, 'voter_registration_status', { p_token: s.registration_token })).status, 'review')
  })

  it('limits registration attempts per phone number', async () => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await start(db, 'Spam Test', '08150000038', {}, { ip: `198.51.100.${i}` })).status, 'ok')
    }
    assert.equal((await start(db, 'Spam Test', '08150000038', {}, { ip: '198.51.100.99' })).status, 'rate_limited')
  })
})

describe('voter sign-in, sessions, replacement and revocation', () => {
  let db, admin
  before(async () => {
    db = await freshDb({ migrate: '003' })
    admin = await login(db)
  })

  it('rejects wrong and malformed codes the same way', async () => {
    assert.equal((await voterLogin(db, 'YPM-ABCD-2345-HJKM')).status, 'invalid')
    assert.equal((await voterLogin(db, 'nonsense')).status, 'invalid')
    assert.equal((await voterLogin(db, null)).status, 'invalid')
  })

  it('limits wrong codes per IP address, without blocking other addresses', async () => {
    const r = await registerInPerson(db, admin, 'Limit Test', '08150000040')
    for (let i = 0; i < 30; i++) {
      assert.equal((await voterLogin(db, 'YPM-ABCD-2345-HJKM', { ip: '203.0.113.50' })).status, 'invalid')
    }
    assert.equal((await voterLogin(db, r.voter_code, { ip: '203.0.113.50' })).status, 'rate_limited')
    assert.equal((await voterLogin(db, r.voter_code, { ip: '203.0.113.51' })).status, 'ok')
  })

  it('ends sessions on logout and on expiry', async () => {
    const r = await registerInPerson(db, admin, 'Session Test', '08150000041')
    const a = await voterLogin(db, r.voter_code)
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: a.session })).status, 'started')
    await call(db, 'voter_logout', { p_session: a.session })
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: a.session })).status, 'unauthorized')

    const b = await voterLogin(db, r.voter_code)
    await sql(db, `update voter_sessions set expires_at = now() - interval '1 second'`)
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: b.session })).status, 'unauthorized')
  })

  it('replacing a code stops the old one and its sessions', async () => {
    const r = await registerInPerson(db, admin, 'Lost Code Test', '08150000042')
    const s = await voterLogin(db, r.voter_code)
    const n = await call(db, 'admin_reissue_voter_code', { p_session: admin, p_voter_id: r.voter_id })
    assert.equal(n.status, 'ok')
    assert.match(n.voter_code, CODE_RE)
    assert.notEqual(n.voter_code, r.voter_code)
    assert.equal((await voterLogin(db, r.voter_code)).status, 'invalid')
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: s.session })).status, 'unauthorized')
    assert.equal((await voterLogin(db, n.voter_code)).status, 'ok')
  })

  it('revoking stops the account but keeps its ballot and votes', async () => {
    const r = await registerInPerson(db, admin, 'Revoke Test', '08150000043')
    const s = await voterLogin(db, r.voter_code)
    await call(db, 'voter_begin_ballot', { p_session: s.session })
    await call(db, 'voter_save_vote', {
      p_session: s.session, p_category_id: 'most-reliable-youth', p_nominee_name: 'Sarah Bakare',
    })
    await call(db, 'voter_submit_ballot', { p_session: s.session })
    const before = await sql(db, `select b.*, v.nominee_name from ballots b join votes v on v.ballot_id = b.id
                                   where b.voter_id = $1`, [r.voter_id])

    const rv = await call(db, 'admin_revoke_voter', { p_session: admin, p_voter_id: r.voter_id, p_reason: 'test' })
    assert.equal(rv.status, 'ok')
    assert.equal((await voterLogin(db, r.voter_code)).status, 'invalid')
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: s.session })).status, 'unauthorized')
    assert.equal(
      (await call(db, 'admin_reissue_voter_code', { p_session: admin, p_voter_id: r.voter_id })).status,
      'revoked',
    )
    assert.deepEqual(
      await sql(db, `select b.*, v.nominee_name from ballots b join votes v on v.ballot_id = b.id
                      where b.voter_id = $1`, [r.voter_id]),
      before,
    )
    // Still counted: it was submitted before the revocation.
    const dash = await call(db, 'admin_dashboard', { p_session: admin })
    assert.ok(dash.tally.some((t) => t.nominee_name === 'Sarah Bakare' && t.votes >= 1))
  })
})

describe('one ballot per registered voter', () => {
  let db, admin
  before(async () => {
    db = await freshDb({ migrate: '003' })
    admin = await login(db)
  })

  it('starts, resumes, saves, submits, then refuses a second ballot', async () => {
    const r = await registerInPerson(db, admin, 'Ballot Test', '08150000050')
    const s = (await voterLogin(db, r.voter_code)).session

    const first = await call(db, 'voter_begin_ballot', { p_session: s })
    assert.deepEqual(first, { status: 'started', picks: [] })
    assert.equal(first.ballot_id, undefined)

    const save = (cat, name) => call(db, 'voter_save_vote', { p_session: s, p_category_id: cat, p_nominee_name: name })
    assert.equal((await save('most-reliable-youth', 'Peace Williams')).status, 'ok')
    assert.equal((await save('most-reliable-youth', 'Not A Nominee')).reason, 'invalid_choice')

    const again = await call(db, 'voter_begin_ballot', { p_session: s })
    assert.equal(again.status, 'resumed')
    assert.deepEqual(again.picks, [{ category_id: 'most-reliable-youth', nominee_name: 'Peace Williams' }])
    assert.equal(again.ballot_id, undefined)

    assert.equal((await call(db, 'voter_submit_ballot', { p_session: s })).status, 'ok')
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: s })).status, 'already_voted')
    assert.equal((await save('most-reliable-youth', 'Sarah Bakare')).status, 'error')

    // Signing in again, or with a replacement code, finds the same ballot.
    const n = await call(db, 'admin_reissue_voter_code', { p_session: admin, p_voter_id: r.voter_id })
    const s2 = (await voterLogin(db, n.voter_code)).session
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: s2 })).status, 'already_voted')
    assert.equal((await sql(db, `select count(*)::int n from ballots where voter_id = $1`, [r.voter_id]))[0].n, 1)
  })

  it('the database itself refuses a second ballot for a voter', async () => {
    const r = await registerInPerson(db, admin, 'Unique Test', '08150000051')
    await sql(db, `insert into ballots (voter_name, voter_phone, voter_id) values ('a', '08150000052', $1)`, [r.voter_id])
    await assert.rejects(
      sql(db, `insert into ballots (voter_name, voter_phone, voter_id) values ('a', '08150000053', $1)`, [r.voter_id]),
      /ballots_voter_unique/,
    )
  })

  it('never links an anonymous ballot by phone number on its own', async () => {
    const r = await registerInPerson(db, admin, 'Legacy State Test', '08150000054')
    // A ballot for the same number with no voter (e.g. from an old page).
    await sql(db, `insert into ballots (voter_name, voter_phone) values ('Someone', '08150000054')`)
    const s = (await voterLogin(db, r.voter_code)).session
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: s })).status, 'needs_assistance')
    assert.equal((await sql(db, `select count(*)::int n from ballots where voter_id = $1`, [r.voter_id]))[0].n, 0)
  })
})

describe('the old voting functions can’t get around registration', () => {
  let db, admin, voter, voterBallotId
  before(async () => {
    db = await freshDb({ migrate: '003' })
    admin = await login(db)
    voter = await registerInPerson(db, admin, 'Bypass Test', '08150000060')
    const s = (await voterLogin(db, voter.voter_code)).session
    await call(db, 'voter_begin_ballot', { p_session: s })
    await call(db, 'voter_save_vote', {
      p_session: s, p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams',
    })
    voterBallotId = (await sql(db, `select id from ballots where voter_id = $1`, [voter.voter_id]))[0].id
  })

  it('a registered number can’t start or reopen an anonymous ballot', async () => {
    const r = await call(db, 'begin_ballot', { p_name: 'Bypass Test', p_phone: '+234 815 000 0060' })
    assert.deepEqual(r, { status: 'registered_voter' })
    await assert.rejects(
      call(db, 'start_ballot', { p_name: 'Bypass Test', p_phone: '08150000060' }),
      /start_ballot: registered_voter/,
    )
    const r2 = await call(db, 'begin_ballot', {
      p_name: 'Bypass Test', p_phone: '08150000060', p_ballot_id: voterBallotId,
    })
    assert.equal(r2.status, 'registered_voter')
  })

  it('a voting code doesn’t help, and isn’t used up', async () => {
    const [c] = await issue(db, admin, { count: 1 })
    const r = await call(db, 'begin_ballot', { p_name: 'Bypass Test', p_phone: '08150000060', p_code: c.code })
    assert.equal(r.status, 'registered_voter')
    const [row] = await sql(db, `select redeemed_at from voting_codes where id = $1`, [c.id])
    assert.equal(row.redeemed_at, null)
  })

  it('save_vote and submit_ballot refuse a voter’s ballot', async () => {
    const votesBefore = await voteRows(db)
    const s = await call(db, 'save_vote', {
      p_ballot_id: voterBallotId, p_category_id: 'most-reliable-youth', p_nominee_name: 'Sarah Bakare',
    })
    assert.equal(s.status, 'error')
    const sub = await call(db, 'submit_ballot', { p_ballot_id: voterBallotId })
    assert.equal(sub.status, 'error')
    assert.deepEqual(await voteRows(db), votesBefore)
    assert.equal((await sql(db, `select completed_at from ballots where id = $1`, [voterBallotId]))[0].completed_at, null)
  })

  it('anonymous voting is unchanged while registration is optional', async () => {
    await sql(db, `update settings set registration_mode = 'optional' where id = 1`)
    const b = await call(db, 'begin_ballot', { p_name: 'Anon Test', p_phone: '08150000061' })
    assert.equal(b.status, 'started')
    assert.equal((await call(db, 'save_vote', {
      p_ballot_id: b.ballot_id, p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams',
    })).status, 'ok')
    assert.equal((await call(db, 'submit_ballot', { p_ballot_id: b.ballot_id })).status, 'ok')
  })

  it('when registration is required: no new anonymous ballots, existing ones carry on', async () => {
    await sql(db, `update settings set registration_mode = 'required' where id = 1`)
    assert.deepEqual(
      await call(db, 'begin_ballot', { p_name: 'New Test', p_phone: '08150000062' }),
      { status: 'registration_required' },
    )
    const [c] = await issue(db, admin, { count: 1 })
    const withCode = await call(db, 'begin_ballot', { p_name: 'New Test', p_phone: '08150000062', p_code: c.code })
    assert.equal(withCode.status, 'registration_required')
    assert.equal((await sql(db, `select redeemed_at from voting_codes where id = $1`, [c.id]))[0].redeemed_at, null)

    const resumed = await call(db, 'begin_ballot', {
      p_name: LEGACY.open.name, p_phone: LEGACY.open.phone, p_ballot_id: LEGACY.open.ballotId,
    })
    assert.equal(resumed.status, 'resumed')
    assert.equal((await call(db, 'begin_ballot', { p_name: 'x', p_phone: LEGACY.done.phone })).status, 'already_voted')
    assert.equal((await call(db, 'save_vote', {
      p_ballot_id: LEGACY.open.ballotId, p_category_id: 'most-reliable-youth', p_nominee_name: 'Sarah Bakare',
    })).status, 'ok')

    // Closed voting still says closed first.
    await sql(db, `update settings set voting_open = false where id = 1`)
    assert.equal((await call(db, 'begin_ballot', { p_name: 'x', p_phone: '08150000063' })).status, 'closed')
    await sql(db, `update settings set voting_open = true, registration_mode = 'off' where id = 1`)
  })
})

describe('admin registration, in person', () => {
  let db, admin
  before(async () => {
    db = await freshDb({ migrate: '003' })
    admin = await login(db)
  })

  it('every admin voter function needs a session', async () => {
    const id = '00000000-0000-0000-0000-000000000000'
    for (const [fn, args] of [
      ['admin_register_voter', { p_name: 'A Test', p_phone: '08150000070' }],
      ['admin_list_voters', {}],
      ['admin_reissue_voter_code', { p_voter_id: id }],
      ['admin_revoke_voter', { p_voter_id: id }],
      ['admin_list_reviews', {}],
      ['admin_resolve_review', { p_registration_id: id, p_decision: 'approve' }],
      ['admin_set_registration_mode', { p_mode: 'required' }],
      ['admin_voter_stats', {}],
    ]) {
      assert.equal((await call(db, fn, { p_session: 'bogus', ...args })).status, 'unauthorized', fn)
    }
    assert.equal((await sql(db, `select count(*)::int n from voters`))[0].n, 0)
    assert.equal((await sql(db, `select registration_mode from settings`))[0].registration_mode, 'off')
  })

  it('works even while self-registration is off', async () => {
    const r = await registerInPerson(db, admin, 'In Person Test', '08150000071')
    assert.match(r.voter_code, CODE_RE)
    assert.equal(r.linked_ballot, false)
    const [v] = await sql(db, `select method, created_by, adult_confirmed from voters where id = $1`, [r.voter_id])
    assert.deepEqual(v, { method: 'in_person', created_by: 'leader', adult_confirmed: false })
    assert.equal(
      (await call(db, 'admin_register_voter', { p_session: admin, p_name: 'Dup', p_phone: '08150000071' })).status,
      'phone_registered',
    )
  })

  it('attaches an existing ballot only when the admin confirms it', async () => {
    const r = await call(db, 'admin_register_voter', {
      p_session: admin, p_name: LEGACY.open.name, p_phone: LEGACY.open.phone,
    })
    assert.deepEqual(r, { status: 'phone_has_ballot', ballot: 'in_progress' })
    assert.equal((await sql(db, `select count(*)::int n from voters`))[0].n, 1)

    const linked = await registerInPerson(db, admin, LEGACY.open.name, LEGACY.open.phone, true)
    assert.equal(linked.linked_ballot, true)
    const s = (await voterLogin(db, linked.voter_code)).session
    const b = await call(db, 'voter_begin_ballot', { p_session: s })
    assert.equal(b.status, 'resumed')
    assert.deepEqual(b.picks, [{ category_id: 'most-reliable-youth', nominee_name: 'Someone' }])

    const done = await registerInPerson(db, admin, LEGACY.done.name, LEGACY.done.phone, true)
    const s2 = (await voterLogin(db, done.voter_code)).session
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: s2 })).status, 'already_voted')
  })

  it('lists voters with masked numbers, and searches by name or last digits', async () => {
    const all = await call(db, 'admin_list_voters', { p_session: admin })
    assert.equal(all.status, 'ok')
    assert.ok(all.total >= 3)
    const text = JSON.stringify(all)
    assert.ok(!/0815000007\d/.test(text) && !text.includes(LEGACY.open.phone))
    assert.ok(all.voters.every((v) => v.phone.startsWith('•••• ')))
    const byDigits = await call(db, 'admin_list_voters', { p_session: admin, p_search: '0071' })
    assert.equal(byDigits.total, 1)
    assert.equal(byDigits.voters[0].full_name, 'In Person Test')
    const byName = await call(db, 'admin_list_voters', { p_session: admin, p_search: 'in person' })
    assert.equal(byName.total, 1)
    // A middle chunk of a number finds nothing.
    assert.equal((await call(db, 'admin_list_voters', { p_session: admin, p_search: '0815' })).total, 0)
  })

  it('sets the registration mode and reports voter numbers', async () => {
    assert.equal((await call(db, 'admin_set_registration_mode', { p_session: admin, p_mode: 'sometimes' })).status, 'error')
    assert.equal((await call(db, 'admin_set_registration_mode', { p_session: admin, p_mode: 'optional' })).status, 'ok')
    const st = await call(db, 'admin_voter_stats', { p_session: admin })
    assert.equal(st.registration_mode, 'optional')
    assert.equal(st.voters_active, 3)
    assert.equal(st.in_person, 3)
    assert.equal(st.voter_ballots_submitted, 1)
  })

  it('records admin actions in the audit log, without codes or full numbers', async () => {
    const rows = await sql(db, `select action, detail::text d from admin_audit order by id`)
    const actions = rows.map((r) => r.action)
    for (const a of ['voter_registered_in_person', 'set_registration_mode']) assert.ok(actions.includes(a), a)
    for (const r of rows) assert.ok(!/YPM/.test(r.d) && !/0815000007\d/.test(r.d), r.d)
  })
})

describe('rolling 003 back', () => {
  it('restores the original functions and keeps every ballot and vote', async () => {
    const db = await freshDb({ migrate: '003' })
    const admin = await login(db)
    await devMode(db)
    const v = await registerSelf(db, admin, 'Rollback Test', '08150000080')
    await call(db, 'voter_begin_ballot', { p_session: v.session })
    await call(db, 'voter_save_vote', {
      p_session: v.session, p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams',
    })
    const ballotsBefore = await ballotRows(db)
    const votesBefore = await voteRows(db)

    await db.exec(VOTER_DOWN_SQL)

    assert.deepEqual(await ballotRows(db), ballotsBefore)
    assert.deepEqual(await voteRows(db), votesBefore)
    const [gone] = await sql(db, `select
        to_regclass('public.voters') voters,
        to_regprocedure('public.voter_login(text)') login,
        to_regprocedure('public.dev_simulate_verification(text,text,text)') sim,
        to_regprocedure('ypm_private.begin_ballot_001(text,text,text,uuid)') moved,
        (select count(*)::int from vault.secrets) secrets,
        (select count(*)::int from information_schema.columns
          where table_name = 'settings' and column_name in ('registration_mode', 'verification_provider')) cols,
        (select count(*)::int from information_schema.columns
          where table_name = 'ballots' and column_name = 'voter_id') voter_col`)
    assert.deepEqual(gone, { voters: null, login: null, sim: null, moved: null, secrets: 0, cols: 0, voter_col: 0 })

    // The originals are back in public and work for the browser.
    const b = await call(db, 'begin_ballot', { p_name: 'After Test', p_phone: '08150000081' })
    assert.equal(b.status, 'started')
    assert.equal((await call(db, 'save_vote', {
      p_ballot_id: b.ballot_id, p_category_id: 'most-reliable-youth', p_nominee_name: 'Not A Nominee',
    })).reason, 'invalid_choice')
    assert.equal((await call(db, 'submit_ballot', { p_ballot_id: b.ballot_id })).status, 'ok')
    // The former voter's ballot can't be reopened by typing the number.
    assert.equal((await call(db, 'begin_ballot', { p_name: 'x', p_phone: '08150000080' })).status, 'resume_required')

    // And 003 applies cleanly again.
    await db.exec(VOTER_MIGRATION_SQL)
    assert.equal((await call(db, 'begin_ballot', { p_name: 'x', p_phone: '08150000082' })).status, 'started')
  })

  it('001, 002 and their undo files refuse to run over 003, leaving its protections in place', async () => {
    const db = await freshDb({ migrate: '003' })
    const admin = await login(db)
    await registerInPerson(db, admin, 'Rerun Test', '08150000090')
    for (const file of [MIGRATION_SQL, DOWN_SQL, BALLOT_MIGRATION_SQL, BALLOT_DOWN_SQL]) {
      await assert.rejects(db.exec(file), /Migration 003 is installed/)
      await db.exec('rollback') // the refusal aborts the file's transaction
    }
    // Still protected: the registered number can't get an anonymous ballot.
    assert.equal((await call(db, 'begin_ballot', { p_name: 'x', p_phone: '08150000090' })).status, 'registered_voter')
    // And 003 itself (no 004 here) can still be re-run.
    await db.exec(VOTER_MIGRATION_SQL)
    assert.equal((await call(db, 'begin_ballot', { p_name: 'x', p_phone: '08150000090' })).status, 'registered_voter')
  })
})
