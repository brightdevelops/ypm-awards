// The Development path for migration 008: a database like Development
// (001–006, marked development, with synthetic voter accounts and ballots)
// has 006, 005, 004 and 003 undone, then gets 008. Every ballot and vote
// must survive each step, and self-registration must then work end to end.
// Synthetic identities only (0815550 0xxx).
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import {
  freshDb, call, sql, login, issue,
  DEV_SIM_SQL, PROVIDER_SQL, CHOICE_DOWN_SQL, PROVIDER_DOWN_SQL, SAFEGUARDS_DOWN_SQL, VOTER_DOWN_SQL,
  SELF_REG_SQL,
} from './helpers.mjs'

const CV = 'draft-2026-11-dev'
const NOMINEE = { p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams' }
const begin = (db, name, phone, extra = {}, opts) =>
  call(db, 'begin_ballot', { p_name: name, p_phone: phone, ...extra }, opts)
const snapshot = async (db) => (await sql(db, `
  select (select json_agg(b order by b.id) from (select id, voter_name, voter_phone, started_at, completed_at, voting_code_id from ballots) b) ballots,
         (select json_agg(v order by v.id) from votes v) votes,
         (select json_agg(c order by c.id) from voting_codes c) codes`))[0]
const exists = async (db, reg) => (await sql(db, `select to_regclass($1) is not null e`, [reg]))[0].e

describe('Development: undo 006–003, then install 008', () => {
  let db, session, before0, seeded
  before(async () => {
    db = await freshDb({ migrate: '006' })
    await sql(db, `update ypm_private.deployment set environment = 'development'`)
    await sql(db, `update settings set verification_provider = 'simulated', registration_mode = 'optional' where id = 1`)
    await db.exec(DEV_SIM_SQL)
    await db.exec(PROVIDER_SQL)
    session = await login(db)

    // Anonymous ballots: one submitted, one unfinished.
    const anonDone = await begin(db, 'Test Anondone', '08155500801')
    await call(db, 'save_vote', { p_ballot_id: anonDone.ballot_id, ...NOMINEE })
    await call(db, 'submit_ballot', { p_ballot_id: anonDone.ballot_id })
    const anonOpen = await begin(db, 'Test Anonopen', '08155500802')
    await call(db, 'save_vote', { p_ballot_id: anonOpen.ballot_id, ...NOMINEE })
    // A ballot started with a leader-issued code for that phone.
    const [lc] = await issue(db, session, { phone: '08155500803' })
    const coded = await begin(db, 'Test Coded', '08155500803', { p_code: lc.code })
    // Registered voters: one voted, one with an unfinished ballot.
    const regs = []
    for (const [name, phone, submit] of [['Test Votervoted', '08155500804', true], ['Test Voteropen', '08155500805', false]]) {
      const r = await call(db, 'admin_register_voter', {
        p_session: session, p_name: name, p_phone: phone, p_consent_version: CV, p_adult_confirmed: true,
      })
      assert.equal(r.status, 'ok', JSON.stringify(r))
      const vs = (await call(db, 'voter_login', { p_code: r.voter_code })).session
      assert.equal((await call(db, 'voter_begin_ballot', { p_session: vs })).status, 'started')
      assert.equal((await call(db, 'voter_save_vote', { p_session: vs, ...NOMINEE })).status, 'ok')
      if (submit) assert.equal((await call(db, 'voter_submit_ballot', { p_session: vs })).status, 'ok')
      regs.push(r)
    }
    seeded = { anonDone, anonOpen, coded, lc, regs }
    before0 = await snapshot(db)
    assert.equal(before0.ballots.length, 7) // 2 legacy + 5 seeded
  })

  it('each undo runs (006, 005, 004, 003) and keeps every ballot, vote and voting code', async () => {
    for (const [name, file] of [['006', CHOICE_DOWN_SQL], ['005', PROVIDER_DOWN_SQL], ['004', SAFEGUARDS_DOWN_SQL], ['003', VOTER_DOWN_SQL]]) {
      await db.exec(file)
      assert.deepEqual(await snapshot(db), before0, `after undoing ${name}`)
    }
    // Voter accounts are gone (their tables are dropped by 003's undo); 001 and 002 remain.
    assert.equal(await exists(db, 'public.voters'), false)
    assert.equal(await exists(db, 'public.voter_registrations'), false)
    assert.equal(await exists(db, 'ypm_private.deployment'), false)
    assert.equal(await exists(db, 'public.admin_sessions'), true)
    assert.equal(await exists(db, 'public.ballot_nominees'), true)
    const [fns] = await sql(db, `select to_regprocedure('ypm_private.begin_ballot_001(text,text,text,uuid)') is null a,
                                        to_regprocedure('ypm_private.save_vote_002(uuid,text,text)') is null b`)
    assert.deepEqual(fns, { a: true, b: true }, 'the original voting functions are back in public')
  })

  it('008 installs and changes no ballot, vote or code', async () => {
    await db.exec(SELF_REG_SQL)
    assert.deepEqual(await snapshot(db), before0)
  })

  it('a new voter registers without an administrator and gets a code automatically', async () => {
    const r = await begin(db, 'Test Selfdev', '08155500810')
    assert.equal(r.status, 'started')
    assert.match(r.voter_code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/)
    assert.equal((await call(db, 'save_vote', { p_ballot_id: r.ballot_id, ...NOMINEE })).status, 'ok')
    // Resume on another device with the code, then submit once.
    const again = await begin(db, 'Test Selfdev', '08155500810', { p_code: r.voter_code })
    assert.equal(again.status, 'resumed')
    assert.equal(again.picks.length, 1)
    assert.equal((await call(db, 'submit_ballot', { p_ballot_id: r.ballot_id })).status, 'ok')
    assert.deepEqual(await begin(db, 'Test Selfdev', '08155500810', { p_code: r.voter_code }), { status: 'already_voted' })
  })

  it('a duplicate phone number never gets a second ballot', async () => {
    assert.deepEqual(await begin(db, 'Dup', '08155500801'), { status: 'already_voted' })
    assert.deepEqual(await begin(db, 'Dup', '08155500802'), { status: 'resume_required' })
    assert.deepEqual(await begin(db, 'Dup', '08155500810'), { status: 'already_voted' })
    const [n] = await sql(db, `select count(*)::int n, count(distinct voter_phone)::int d from ballots`)
    assert.equal(n.n, n.d)
  })

  it('earlier voters keep their ballots: device, leader code, and registered voters', async () => {
    assert.equal((await begin(db, 'Test Anonopen', '08155500802', { p_ballot_id: seeded.anonOpen.ballot_id })).status, 'resumed')
    assert.equal((await begin(db, 'Test Coded', '08155500803', { p_code: seeded.lc.code })).status, 'resumed')
    // Former voter-account ballots are ordinary ballots now: the one that
    // was submitted stays submitted; the unfinished one reopens with a
    // leader-issued code for that number.
    assert.deepEqual(await begin(db, 'Test Votervoted', '08155500804'), { status: 'already_voted' })
    assert.deepEqual(await begin(db, 'Test Voteropen', '08155500805'), { status: 'resume_required' })
    const [c] = await issue(db, session, { phone: '08155500805' })
    const r = await begin(db, 'Test Voteropen', '08155500805', { p_code: c.code })
    assert.equal(r.status, 'resumed')
    assert.equal(r.picks.length, 1)
  })

  it('the per-IP limit pauses mass registration from one address only', async () => {
    await sql(db, `update settings set self_registration_per_ip_hour = 2 where id = 1`)
    const ip = { ip: '198.51.100.77' }
    assert.equal((await begin(db, 'Test Ipone', '08155500821', {}, ip)).status, 'started')
    assert.equal((await begin(db, 'Test Iptwo', '08155500822', {}, ip)).status, 'started')
    assert.deepEqual(await begin(db, 'Test Ipthree', '08155500823', {}, ip), { status: 'rate_limited', reason: 'network' })
    assert.equal((await begin(db, 'Test Ipthree', '08155500823', {}, { ip: '198.51.100.78' })).status, 'started')
    await sql(db, `update settings set self_registration_per_ip_hour = 30 where id = 1`)
  })

  it('manual codes still work, and Codes required still needs one', async () => {
    const [c] = await issue(db, session, { phone: '08155500830' })
    assert.deepEqual(await begin(db, 'Other', '08155500831', { p_code: c.code }), { status: 'invalid_code' })
    await call(db, 'admin_set_code_required', { p_session: session, p_required: true })
    assert.deepEqual(await begin(db, 'No Code', '08155500832'), { status: 'code_required' })
    assert.equal((await begin(db, 'Test Manual', '08155500830', { p_code: c.code })).status, 'started')
    await call(db, 'admin_set_code_required', { p_session: session, p_required: false })
  })

  it('every ballot and vote from before is still exactly as it was', async () => {
    const now = await snapshot(db)
    const ids = new Set(before0.ballots.map((b) => b.id))
    const old = now.ballots.filter((b) => ids.has(b.id))
    // Only change allowed: the leader code attached to the unfinished
    // former voter-account ballot when that voter came back.
    const fixed = before0.ballots.map((b) => (b.voter_phone === '08155500805' ? { ...b, voting_code_id: old.find((o) => o.id === b.id).voting_code_id } : b))
    assert.deepEqual(old, fixed)
    const voteIds = new Set(before0.votes.map((v) => v.id))
    assert.deepEqual(now.votes.filter((v) => voteIds.has(v.id)), before0.votes)
  })
})
