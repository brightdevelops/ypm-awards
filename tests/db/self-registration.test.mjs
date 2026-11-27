// Migration 008: voter self-registration on top of 001, 002 and ballot-sync.
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  freshDb, call, sql, login, issue, LEGACY,
  SELF_REG_SQL, SELF_REG_DOWN_SQL,
} from './helpers.mjs'

const begin = (db, name, phone, extra = {}, opts) =>
  call(db, 'begin_ballot', { p_name: name, p_phone: phone, ...extra }, opts)
const vote = (db, ballotId) =>
  call(db, 'save_vote', { p_ballot_id: ballotId, p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams' })
const sha = (s) => createHash('sha256').update(s).digest('hex')
// Line endings depend on how the .sql file was checked out; ignore them.
const fnDef = async (db) =>
  (await sql(db, `select pg_get_functiondef('public.begin_ballot(text,text,text,uuid)'::regprocedure) d`))[0].d.replace(/\r/g, '')
const snapshot = (db) => sql(db, `
  select (select json_agg(b order by b.id) from (select id, voter_name, voter_phone, started_at, completed_at, voting_code_id from ballots) b) ballots,
         (select json_agg(v order by v.id) from votes v) votes`)

describe('008 installs over 001 + 002 without touching existing data', () => {
  it('keeps every ballot and vote, and can be run twice', async () => {
    const db = await freshDb({ migrate: '002' })
    const before = await snapshot(db)
    await db.exec(SELF_REG_SQL)
    await db.exec(SELF_REG_SQL)
    assert.deepEqual(await snapshot(db), before)
    const [s] = await sql(db, `select self_registration_per_ip_hour n, require_voting_code r from settings`)
    assert.equal(s.n, 30)
    assert.equal(s.r, false)
  })

  it('refuses a database without 001, and one with voter accounts (003)', async () => {
    const bare = await freshDb({ migrate: false })
    await assert.rejects(bare.exec(SELF_REG_SQL), /Migration 001 is not installed/)
    const withAccounts = await freshDb({ migrate: true })
    await assert.rejects(withAccounts.exec(SELF_REG_SQL), /Migration 003 is installed/)
  })
})

describe('self-registration (codes optional)', () => {
  let db, first
  before(async () => {
    db = await freshDb({ migrate: '008' })
  })

  it('registers a new voter straight away with a unique code tied to their number', async () => {
    first = await begin(db, 'Tola New', '0803 000 0001')
    assert.equal(first.status, 'started')
    assert.match(first.voter_code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/)
    const [c] = await sql(db, `select c.* from voting_codes c join ballots b on b.voting_code_id = c.id where b.id = $1`, [first.ballot_id])
    assert.equal(c.phone, '08030000001')
    assert.equal(c.created_by, 'self-registration')
    assert.ok(c.redeemed_at, 'used by its own ballot from the start')
    assert.equal(c.code_hash, sha(first.voter_code.replace('-', '')), 'only the hash is stored')
    const plain = await sql(db, `select count(*)::int n from voting_codes where row_to_json(voting_codes)::text like '%' || $1 || '%'`, [first.voter_code.replace('-', '')])
    assert.equal(plain[0].n, 0)
    assert.equal((await vote(db, first.ballot_id)).status, 'ok')
  })

  it('gives different voters different codes', async () => {
    const a = await begin(db, 'Voter A', '08030000002')
    const b = await begin(db, 'Voter B', '08030000003')
    assert.notEqual(a.voter_code, b.voter_code)
  })

  it('does not reopen the ballot from the phone number alone', async () => {
    assert.deepEqual(await begin(db, 'Someone Else', '08030000001'), { status: 'resume_required' })
  })

  it('reopens it on another device with the voter code, picks included', async () => {
    const r = await begin(db, 'Tola New', '08030000001', { p_code: first.voter_code.toLowerCase() })
    assert.equal(r.status, 'resumed')
    assert.equal(r.ballot_id, first.ballot_id)
    assert.deepEqual(r.picks, [{ category_id: 'most-reliable-youth', nominee_name: 'Peace Williams' }])
    assert.equal(r.voter_code, undefined, 'the code is shown only once')
  })

  it('refuses that code with any other phone number', async () => {
    assert.deepEqual(await begin(db, 'Thief', '08030000099', { p_code: first.voter_code }), { status: 'invalid_code' })
    assert.equal((await sql(db, `select count(*)::int n from ballots where voter_phone = '08030000099'`))[0].n, 0)
  })

  it('allows one submitted ballot per phone number and per code', async () => {
    assert.equal((await call(db, 'submit_ballot', { p_ballot_id: first.ballot_id })).status, 'ok')
    assert.deepEqual(await begin(db, 'Tola Again', '08030000001'), { status: 'already_voted' })
    assert.deepEqual(await begin(db, 'Tola Again', '08030000001', { p_code: first.voter_code }), { status: 'already_voted' })
    assert.equal((await sql(db, `select count(*)::int n from ballots where voter_phone = '08030000001'`))[0].n, 1)
    // A submitted ballot can't be changed or submitted again.
    assert.notEqual((await vote(db, first.ballot_id)).status, 'ok')
  })

  it('leaves ballots from before 008 as they were', async () => {
    assert.deepEqual(await begin(db, 'Intruder', LEGACY.open.phone), { status: 'resume_required' })
    assert.equal((await begin(db, LEGACY.open.name, LEGACY.open.phone, { p_ballot_id: LEGACY.open.ballotId })).status, 'resumed')
    assert.deepEqual(await begin(db, 'Ada', LEGACY.done.phone), { status: 'already_voted' })
  })
})

describe('per-IP limit on new self-registrations', () => {
  let db
  before(async () => {
    db = await freshDb({ migrate: '008' })
    await sql(db, `update settings set self_registration_per_ip_hour = 3 where id = 1`)
  })
  const wifi = { ip: '198.51.100.10' }

  it('only successful registrations count, not typos or refusals', async () => {
    assert.equal((await begin(db, 'X', '123', {}, wifi)).status, 'error')
    assert.equal((await begin(db, 'Intruder', LEGACY.open.phone, {}, wifi)).status, 'resume_required')
    for (let i = 1; i <= 3; i++) {
      assert.equal((await begin(db, `Shared ${i}`, `0804000000${i}`, {}, wifi)).status, 'started')
    }
  })

  it('pauses new self-registrations from that address once the limit is reached', async () => {
    assert.deepEqual(await begin(db, 'Shared 4', '08040000004', {}, wifi), { status: 'rate_limited', reason: 'network' })
    assert.equal((await sql(db, `select count(*)::int n from ballots where voter_phone = '08040000004'`))[0].n, 0)
    assert.equal((await sql(db, `select count(*)::int n from voting_codes where phone = '08040000004'`))[0].n, 0, 'no orphan code')
  })

  it('never blocks other addresses, resuming, or a leader-issued code', async () => {
    assert.equal((await begin(db, 'Mobile', '08040000005', {}, { ip: '198.51.100.11' })).status, 'started')
    const mine = await sql(db, `select id from ballots where voter_phone = '08040000001'`)
    assert.equal((await begin(db, 'Shared 1', '08040000001', { p_ballot_id: mine[0].id }, wifi)).status, 'resumed')
    const session = await login(db)
    const [code] = await issue(db, session, { phone: '08040000004' })
    const r = await begin(db, 'Shared 4', '08040000004', { p_code: code.code }, wifi)
    assert.equal(r.status, 'started')
    assert.equal(r.voter_code, undefined, 'a leader code is the voter’s code already')
  })

  it('frees up again after an hour', async () => {
    await sql(db, `update rate_events set at = at - interval '61 minutes' where bucket like 'voter:self-reg-ip:%'`)
    assert.equal((await begin(db, 'Shared 6', '08040000006', {}, wifi)).status, 'started')
  })
})

describe('with Codes required, and manual codes', () => {
  let db, session
  before(async () => {
    db = await freshDb({ migrate: '008' })
    session = await login(db)
    assert.equal((await call(db, 'admin_set_code_required', { p_session: session, p_required: true })).status, 'ok')
  })

  it('needs a leader-issued code for a new ballot, as before', async () => {
    assert.deepEqual(await begin(db, 'No Code', '08050000001'), { status: 'code_required' })
    assert.equal((await sql(db, `select count(*)::int n from voting_codes`))[0].n, 0)
  })

  it('accepts a code tied to that phone, and refuses it for another', async () => {
    const [code] = await issue(db, session, { phone: '08050000002' })
    assert.deepEqual(await begin(db, 'Other', '08050000003', { p_code: code.code }), { status: 'invalid_code' })
    assert.equal((await begin(db, 'Right', '08050000002', { p_code: code.code })).status, 'started')
  })

  it('shows self-registered codes in the admin code list as such', async () => {
    await call(db, 'admin_set_code_required', { p_session: session, p_required: false })
    await begin(db, 'Self', '08050000004')
    const list = await call(db, 'admin_list_codes', { p_session: session })
    const self = list.codes.find((c) => c.phone === '08050000004')
    assert.equal(self.created_by, 'self-registration')
    assert.equal(self.state, 'used')
    assert.equal(self.voter_name, 'Self')
  })
})

describe('undo (008_self_registration.down.sql)', () => {
  it('restores 001’s begin_ballot exactly and keeps every ballot, vote and code', async () => {
    const reference = await fnDef(await freshDb({ migrate: '002' }))
    const db = await freshDb({ migrate: '008' })
    const r = await begin(db, 'Before Undo', '08060000001')
    await vote(db, r.ballot_id)
    const before = await snapshot(db)
    const codes = await sql(db, `select * from voting_codes order by id`)
    await db.exec(SELF_REG_DOWN_SQL)
    await db.exec(SELF_REG_DOWN_SQL)
    assert.equal(await fnDef(db), reference)
    assert.deepEqual(await snapshot(db), before)
    assert.deepEqual(await sql(db, `select * from voting_codes order by id`), codes)
    // The voter code given out before the undo still reopens its ballot.
    assert.equal((await begin(db, 'Before Undo', '08060000001', { p_code: r.voter_code })).status, 'resumed')
    // New ballots get no code any more.
    const after = await begin(db, 'After Undo', '08060000002')
    assert.equal(after.status, 'started')
    assert.equal(after.voter_code, undefined)
    // And 008 can be installed again.
    await db.exec(SELF_REG_SQL)
    assert.ok((await begin(db, 'Again', '08060000003')).voter_code)
  })
})
