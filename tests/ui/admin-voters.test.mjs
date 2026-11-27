// Phase 3.4: the development-only "Registered voters" admin tab. Its call
// layer and its lost-reply rules, against a real test database with
// migration 003. Synthetic identities only (0815550 0xxx).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  VERIFY_LIMIT,
  createVoterAdmin,
  inPersonOutcome,
  lastDigits,
  maskLikeServer,
  reviewOutcome,
  voterAccess,
  voterStatusNow,
} from '../../src/lib/voters.js'
import { adminReply, isMissingFunction } from '../../src/lib/rpcErrors.js'
import { START_REFUSALS, isAccountBallot } from '../../src/lib/ballotMessages.js'
import { freshDb, call, sql, login, LEGACY, INVENTOR_KEY, DEV_SIM_SQL } from '../db/helpers.mjs'

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
const CV = 'draft-2026-11-dev' // the seeded development consent notice
const CODE_RE = /^YPM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/

// The dashboard's adminRpc, played by the test database. `lose` makes the
// reply disappear: 'before' = the request never arrived; 'after' = the
// server did the work but the reply was lost.
function adminRpcFor(db, session, opts = {}) {
  const calls = []
  async function rpc(fn, args = {}) {
    calls.push(fn)
    const lose = opts.lose?.(fn)
    if (lose === 'before') return adminReply(null, { message: 'TypeError: Failed to fetch' })
    let res
    let err = null
    try {
      res = await call(db, fn, { p_session: session(), ...args })
    } catch (e) {
      err = e
    }
    if (lose === 'after') return adminReply(null, { message: 'TypeError: Failed to fetch' })
    return adminReply(res, err)
  }
  rpc.calls = calls
  return rpc
}

async function devDb() {
  const db = await freshDb()
  await sql(db, `update ypm_private.deployment set environment = 'development'`)
  await sql(db, `update settings set verification_provider = 'simulated', registration_mode = 'optional' where id = 1`)
  await db.exec(DEV_SIM_SQL)
  return db
}

async function setup(opts) {
  const db = await devDb()
  const session = await login(db)
  const rpc = adminRpcFor(db, () => session, opts)
  return { db, session, rpc, api: createVoterAdmin(rpc) }
}

// An online registration that the (simulated) check sent to review.
async function reviewFor(db, session, name, phone) {
  const s = await call(db, 'voter_registration_start', {
    p_name: name, p_phone: phone, p_consent_version: 'draft-2026-11-dev', p_adult: true,
  })
  assert.equal(s.status, 'ok', JSON.stringify(s))
  const sim = await call(db, 'dev_simulate_verification', {
    p_admin_session: session, p_registration_token: s.registration_token, p_outcome: 'review',
  })
  assert.equal(sim.status, 'ok')
  const list = await call(db, 'admin_list_reviews', { p_session: session })
  return { token: s.registration_token, review: list.reviews.find((r) => r.full_name === name) }
}

const voterCount = async (db, phone) =>
  Number((await sql(db, `select count(*) n from voters where phone = $1`, [phone]))[0].n)

describe('who can use the Registered voters tab', () => {
  it('never in a production build, whatever the database says', () => {
    assert.equal(voterAccess(false, { kind: 'ok', res: { verification_provider: 'simulated' } }), 'not_development', 'a production build never opens for the simulator alone')
  })

  it('on a database without migration 003 (production today): "not installed"', async () => {
    const db = await freshDb({ migrate: '002' })
    const session = await login(db)
    const api = createVoterAdmin(adminRpcFor(db, () => session))
    const stats = await api.stats()
    assert.deepEqual(stats, { kind: 'network', missing: true })
    assert.equal(voterAccess(true, stats), 'not_installed')
    // ...and the rest of the dashboard is untouched there.
    assert.equal((await call(db, 'admin_dashboard', { p_session: session })).status, 'ok')
    assert.equal((await call(db, 'admin_list_codes', { p_session: session })).status, 'ok')
  })

  it('on a database marked production: switched off, and it can’t be faked from the browser', async () => {
    const db = await freshDb() // 003 installed, environment = production
    const session = await login(db)
    const api = createVoterAdmin(adminRpcFor(db, () => session))
    assert.equal(voterAccess(true, await api.stats()), 'not_development')
    // The server refuses the setting the tab looks for.
    await assert.rejects(
      sql(db, `update settings set verification_provider = 'simulated' where id = 1`),
      /only allowed in a development project/,
    )
    // And the simulator isn't there.
    await assert.rejects(call(db, 'dev_simulate_verification', {
      p_admin_session: session, p_registration_token: 'x', p_outcome: 'approved',
    }))
  })

  it('on a development database with simulated verification: ready', async () => {
    const { api } = await setup()
    assert.equal(voterAccess(true, await api.stats()), 'ready')
    assert.equal(voterAccess(true, { kind: 'network' }), 'unreachable')
    assert.equal(voterAccess(true, null), 'loading')
  })

  it('reads missing-function errors from PostgREST and Postgres', () => {
    assert.equal(isMissingFunction({ code: 'PGRST202', message: 'Could not find the function public.admin_voter_stats(p_session)' }), true)
    assert.equal(isMissingFunction({ code: '42883', message: 'function x does not exist' }), true)
    assert.equal(isMissingFunction({ message: 'TypeError: Failed to fetch' }), false)
    assert.equal(isMissingFunction(null), false)
  })
})

describe('server-side authorization', () => {
  const ADMIN_FUNCTIONS = {
    admin_voter_stats: {},
    admin_list_voters: { p_search: null, p_limit: 50, p_offset: 0 },
    admin_list_reviews: {},
    admin_register_voter: {
      p_name: 'Test Person', p_phone: '08155500700', p_consent_version: 'draft-2026-11-dev',
      p_adult_confirmed: true, p_link_existing_ballot: false,
    },
    admin_reissue_voter_code: { p_voter_id: '00000000-0000-0000-0000-000000000000' },
    admin_revoke_voter: { p_voter_id: '00000000-0000-0000-0000-000000000000', p_reason: null },
    admin_resolve_review: {
      p_registration_id: '00000000-0000-0000-0000-000000000000', p_decision: 'approve', p_link_existing_ballot: false,
    },
    admin_restore_voter: { p_voter_id: '00000000-0000-0000-0000-000000000000', p_reason: 'test reason' },
    admin_set_registration_mode: { p_mode: 'required' },
  }

  it('every voter admin function refuses a missing, wrong, ended, expired or revoked session', async () => {
    const db = await devDb()
    const ended = await login(db)
    await call(db, 'admin_logout', { p_session: ended })
    const expired = await login(db)
    await sql(db, `update admin_sessions set expires_at = now() - interval '1 second'
                    where token_hash = ypm_private.sha256_hex($1)`, [expired])
    const revokedKey = await login(db, INVENTOR_KEY)
    await sql(db, `update admin_users set revoked_at = now() where label = 'inventor'`)

    for (const bad of [null, '', 'not-a-session', ended, expired, revokedKey]) {
      for (const [fn, args] of Object.entries(ADMIN_FUNCTIONS)) {
        const r = await call(db, fn, { p_session: bad, ...args })
        assert.equal(r.status, 'unauthorized', `${fn} with ${bad === null ? 'null' : 'a bad session'}`)
      }
    }
    // Nothing changed.
    assert.equal(Number((await sql(db, `select count(*) n from voters`))[0].n), 0)
    assert.equal((await sql(db, `select registration_mode m from settings`))[0].m, 'optional')
  })

  it('anonymous callers can’t read the voter tables directly', async () => {
    const db = await devDb()
    for (const t of ['voters', 'voter_registrations', 'voter_sessions']) {
      await db.exec('set role anon')
      try {
        await assert.rejects(db.query(`select * from public.${t}`), /permission denied/, t)
      } finally {
        await db.exec('reset role')
      }
    }
  })
})

describe('registration mode', () => {
  it('required stops new numbers on the voting page; started ballots and registered voters carry on', async () => {
    const { db, api } = await setup()
    assert.equal((await api.setMode('required')).kind, 'ok')
    const fresh = await call(db, 'begin_ballot', { p_name: 'New Person', p_phone: '08155500701', p_code: null })
    assert.equal(fresh.status, 'registration_required')
    assert.ok(START_REFUSALS[fresh.status])
    // A ballot started before the switch can still be resumed.
    const old = await call(db, 'begin_ballot', {
      p_name: LEGACY.open.name, p_phone: LEGACY.open.phone, p_ballot_id: LEGACY.open.ballotId,
    })
    assert.equal(old.status, 'resumed')

    assert.equal((await api.setMode('off')).kind, 'ok')
    const back = await call(db, 'begin_ballot', { p_name: 'New Person', p_phone: '08155500701', p_code: null })
    assert.equal(back.status, 'started')
    assert.equal((await api.setMode('sometimes')).kind, 'unexpected')
    assert.equal((await api.stats()).res.registration_mode, 'off')
  })
})

describe('in-person registration (no biometrics)', () => {
  it('creates an account, shows the code once, and the code works', async () => {
    const { db, api } = await setup()
    const r = await api.registerInPerson('Test Inperson', '08155500710', CV, true)
    assert.equal(r.kind, 'ok')
    assert.match(r.res.voter_code, CODE_RE)
    const login1 = await call(db, 'voter_login', { p_code: r.res.voter_code })
    assert.equal(login1.status, 'ok')

    const list = await api.list('Inperson')
    const v = list.res.voters[0]
    assert.equal(v.phone, '•••• 0710')
    assert.equal(v.method, 'in_person')
    assert.notEqual(v.created_by, 'self')
    assert.equal(v.ballot, 'none')
    assert.ok(!JSON.stringify(list.res).includes('08155500710'), 'full number never sent')
    assert.ok(!JSON.stringify(list.res).includes(r.res.voter_code), 'code never listed')

    const again = await api.registerInPerson('Test Inperson', '08155500710', CV, true)
    assert.equal(again.kind, 'unexpected')
    assert.equal(again.res.status, 'phone_registered')
    assert.equal(await voterCount(db, '08155500710'), 1)
  })

  it('a number with an anonymous ballot is linked only after a second confirmation', async () => {
    const { db, api } = await setup()
    const b = await call(db, 'begin_ballot', { p_name: 'Test Linked', p_phone: '08155500711', p_code: null })
    await call(db, 'save_vote', { p_ballot_id: b.ballot_id, p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams' })

    const first = await api.registerInPerson('Test Linked', '08155500711', CV, true)
    assert.equal(first.kind, 'unexpected')
    assert.deepEqual(first.res, { status: 'phone_has_ballot', ballot: 'in_progress', answered: 1 })
    assert.equal(await voterCount(db, '08155500711'), 0)

    const linked = await api.registerInPerson('Test Linked', '08155500711', CV, true, true)
    assert.equal(linked.kind, 'ok')
    assert.equal(linked.res.linked_ballot, true)

    // The voting page on their phone now gets the "see a youth leader" screen.
    const save = await call(db, 'save_vote', { p_ballot_id: b.ballot_id, p_category_id: 'most-reliable-youth', p_nominee_name: 'Other' })
    assert.equal(isAccountBallot(save), true)
    assert.equal(isAccountBallot(await call(db, 'submit_ballot', { p_ballot_id: b.ballot_id })), true)
    const start = await call(db, 'begin_ballot', { p_name: 'Test Linked', p_phone: '08155500711', p_code: null })
    assert.equal(start.status, 'registered_voter')
    assert.ok(START_REFUSALS[start.status])
    // The saved vote is kept and the voter continues the same ballot.
    const session = (await call(db, 'voter_login', { p_code: linked.res.voter_code })).session
    const resumed = await call(db, 'voter_begin_ballot', { p_session: session })
    assert.equal(resumed.status, 'resumed')
    assert.equal(resumed.picks.length, 1)
    assert.equal(resumed.picks[0].nominee_name, 'Peace Williams')
  })

  it('a lost reply is checked before anything else, and never makes a second account', async () => {
    const after = await setup({ lose: (fn) => (fn === 'admin_register_voter' ? 'after' : null) })
    const r = await after.api.registerInPerson('Test Lostreply', '08155500712', CV, true)
    assert.equal(r.kind, 'network')
    const masked = maskLikeServer('08155500712')
    const out = inPersonOutcome('Test Lostreply', masked, await after.api.list(lastDigits(masked), 0, VERIFY_LIMIT), 'leader')
    assert.equal(out.outcome, 'created')
    // Seen from another admin's dashboard, it isn't theirs to reissue.
    assert.equal(inPersonOutcome('Test Lostreply', masked, await after.api.list(lastDigits(masked), 0, VERIFY_LIMIT), 'inventor').outcome, 'other')
    assert.equal(after.rpc.calls.filter((f) => f === 'admin_register_voter').length, 1)
    assert.equal(await voterCount(after.db, '08155500712'), 1)

    const before = await setup({ lose: (fn) => (fn === 'admin_register_voter' ? 'before' : null) })
    await before.api.registerInPerson('Test Lostreply', '08155500712', CV, true)
    const out2 = inPersonOutcome('Test Lostreply', masked, await before.api.list(lastDigits(masked), 0, VERIFY_LIMIT), 'leader')
    assert.equal(out2.outcome, 'not_created')
    assert.equal(await voterCount(before.db, '08155500712'), 0)

    // A different person on that number is reported as such, not as "created".
    const other = inPersonOutcome('Somebody Else', masked, await after.api.list(lastDigits(masked), 0, VERIFY_LIMIT), 'leader')
    assert.equal(other.outcome, 'other')
    assert.equal(inPersonOutcome('X', masked, { kind: 'network' }).outcome, 'unknown')
  })
})

describe('reissue and revoke', () => {
  it('reissue: the old code and sessions stop, the new code works, a double click sends one request', async () => {
    const { db, api, rpc } = await setup()
    const reg = await api.registerInPerson('Test Reissue', '08155500720', CV, true)
    const oldCode = reg.res.voter_code
    const oldSession = (await call(db, 'voter_login', { p_code: oldCode })).session
    const voterId = reg.res.voter_id

    const [a, b] = await Promise.all([api.reissue(voterId), api.reissue(voterId)])
    assert.equal(a, b)
    assert.equal(rpc.calls.filter((f) => f === 'admin_reissue_voter_code').length, 1)
    const newCode = a.res.voter_code
    assert.match(newCode, CODE_RE)
    assert.notEqual(newCode, oldCode)

    assert.equal((await call(db, 'voter_login', { p_code: oldCode })).status, 'invalid')
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: oldSession })).status, 'unauthorized')
    assert.equal((await call(db, 'voter_login', { p_code: newCode })).status, 'ok')
    const audits = await sql(db, `select count(*) n from admin_audit where action = 'voter_code_reissued'`)
    assert.equal(Number(audits[0].n), 1)
  })

  it('revoke: the account stops at once, the ballot is kept, and it can’t be reissued', async () => {
    const { db, api } = await setup()
    const reg = await api.registerInPerson('Test Revoke', '08155500721', CV, true)
    const session = (await call(db, 'voter_login', { p_code: reg.res.voter_code })).session
    await call(db, 'voter_begin_ballot', { p_session: session })
    await call(db, 'voter_save_vote', { p_session: session, p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams' })

    assert.equal((await api.revoke(reg.res.voter_id, 'synthetic test')).kind, 'ok')
    assert.equal((await call(db, 'voter_login', { p_code: reg.res.voter_code })).status, 'invalid')
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: session })).status, 'unauthorized')
    assert.equal(Number((await sql(db, `select count(*) n from votes v join ballots b on b.id = v.ballot_id
      where b.voter_id = $1`, [reg.res.voter_id]))[0].n), 1)

    const again = await api.reissue(reg.res.voter_id)
    assert.equal(again.kind, 'unexpected')
    assert.equal(again.res.status, 'revoked')
    assert.equal((await api.revoke(reg.res.voter_id)).kind, 'unexpected')
    // The number stays registered: no way back through the voting page.
    const start = await call(db, 'begin_ballot', { p_name: 'Test Revoke', p_phone: '08155500721', p_code: null })
    assert.equal(start.status, 'registered_voter')
  })

  it('a lost revoke reply is checked with the server', async () => {
    const { api, db } = await setup({ lose: (fn) => (fn === 'admin_revoke_voter' ? 'after' : null) })
    const reg = await api.registerInPerson('Test Revokelost', '08155500722', CV, true)
    assert.equal((await api.revoke(reg.res.voter_id)).kind, 'network')
    const now = voterStatusNow(reg.res.voter_id, await api.list('0722', 0, VERIFY_LIMIT))
    assert.equal(now.outcome, 'revoked')
    assert.equal((await sql(db, `select status from voters where id = $1`, [reg.res.voter_id]))[0].status, 'revoked')
  })
})

describe('reviews', () => {
  it('approve shows the code once and completes the registration on the voter’s phone', async () => {
    const { db, session, api } = await setup()
    const { token, review } = await reviewFor(db, session, 'Test Review', '08155500730')
    assert.equal(review.phone, '•••• 0730')
    assert.equal(review.provider, 'simulated')
    const r = await api.resolveReview(review.id, 'approve')
    assert.equal(r.kind, 'ok')
    assert.match(r.res.voter_code, CODE_RE)
    assert.equal((await call(db, 'voter_registration_status', { p_token: token })).status, 'claimed')
    assert.equal((await call(db, 'voter_login', { p_code: r.res.voter_code })).status, 'ok')
    assert.equal((await api.reviews()).res.reviews.length, 0)
  })

  it('reject closes it without an account', async () => {
    const { db, session, api } = await setup()
    const { token, review } = await reviewFor(db, session, 'Test Reject', '08155500731')
    assert.equal((await api.resolveReview(review.id, 'reject')).kind, 'ok')
    assert.equal((await call(db, 'voter_registration_status', { p_token: token })).status, 'rejected')
    assert.equal(await voterCount(db, '08155500731'), 0)
  })

  it('a double click approves once', async () => {
    const { db, session, api, rpc } = await setup()
    const { review } = await reviewFor(db, session, 'Test Doubleclick', '08155500732')
    const [a, b] = await Promise.all([api.resolveReview(review.id, 'approve'), api.resolveReview(review.id, 'approve')])
    assert.equal(a, b)
    assert.equal(rpc.calls.filter((f) => f === 'admin_resolve_review').length, 1)
    assert.equal(await voterCount(db, '08155500732'), 1)
  })

  it('a review missing from the queue is never assumed to be approved', async () => {
    const check = async (api, review, me = 'leader') =>
      reviewOutcome(review, await api.reviews(), await api.list(lastDigits(review.phone), 0, VERIFY_LIMIT), me)

    // Lost reply, but the server approved it: confirmed by the account.
    const s1 = await setup({ lose: (fn) => (fn === 'admin_resolve_review' ? 'after' : null) })
    const { review: r1 } = await reviewFor(s1.db, s1.session, 'Test Lostapprove', '08155500733')
    assert.equal((await s1.api.resolveReview(r1.id, 'approve')).kind, 'network')
    const o1 = await check(s1.api, r1)
    assert.equal(o1.outcome, 'approved')
    assert.equal(o1.voter.full_name, 'Test Lostapprove')
    assert.equal(o1.byMe, true)
    // ...and the recommended reissue works.
    const re = await s1.api.reissue(o1.voter.id)
    assert.equal((await call(s1.db, 'voter_login', { p_code: re.res.voter_code })).status, 'ok')

    // Lost before arriving: still waiting, nothing decided.
    const s2 = await setup({ lose: (fn) => (fn === 'admin_resolve_review' ? 'before' : null) })
    const { review: r2 } = await reviewFor(s2.db, s2.session, 'Test Neverarrived', '08155500734')
    await s2.api.resolveReview(r2.id, 'approve')
    assert.equal((await check(s2.api, r2)).outcome, 'still_waiting')

    // Gone from the queue because ANOTHER admin rejected it: not approved.
    const s3 = await setup({ lose: (fn) => (fn === 'admin_resolve_review' ? 'before' : null) })
    const { review: r3 } = await reviewFor(s3.db, s3.session, 'Test Otheradmin', '08155500735')
    const other = await login(s3.db, INVENTOR_KEY)
    await call(s3.db, 'admin_resolve_review', { p_session: other, p_registration_id: r3.id, p_decision: 'reject' })
    await s3.api.resolveReview(r3.id, 'approve')
    assert.equal((await check(s3.api, r3)).outcome, 'not_approved')

    // Rejected, then the same person registered in person: still "not
    // approved" (that account didn't come from this review).
    const inPerson = await s3.api.registerInPerson('Test Otheradmin', '08155500735', CV, true)
    assert.equal(inPerson.kind, 'ok')
    assert.equal((await check(s3.api, r3)).outcome, 'not_approved')

    // Gone because ANOTHER admin approved it: approved, but not this admin's
    // code to reissue (that would cancel the code already handed over).
    const s4 = await setup()
    const { review: r4 } = await reviewFor(s4.db, s4.session, 'Test Twoadmins', '08155500737')
    const otherAdmin = await login(s4.db, INVENTOR_KEY)
    const theirs = await call(s4.db, 'admin_resolve_review', { p_session: otherAdmin, p_registration_id: r4.id, p_decision: 'approve' })
    assert.equal(theirs.status, 'ok')
    const mine = await s4.api.resolveReview(r4.id, 'approve')
    assert.equal(mine.kind, 'unexpected')
    const o4 = await check(s4.api, r4)
    assert.equal(o4.outcome, 'approved')
    assert.equal(o4.byMe, false)
    assert.equal(o4.voter.created_by, 'inventor')
    assert.equal((await check(s4.api, r4, 'inventor')).byMe, true)
    assert.equal((await check(s4.api, r4, undefined)).byMe, false)

    // The check itself failing is "unknown", never "approved".
    assert.equal(reviewOutcome(r3, { kind: 'network' }, { kind: 'ok', res: { voters: [] } }).outcome, 'unknown')
    assert.equal(reviewOutcome(r3, { kind: 'ok', res: { reviews: [] } }, { kind: 'network' }).outcome, 'unknown')
  })

  it('a number that already has a ballot can’t be approved from the queue', async () => {
    const { db, session, api } = await setup()
    const { review } = await reviewFor(db, session, 'Test Hasballot', '08155500736')
    await call(db, 'begin_ballot', { p_name: 'Test Hasballot', p_phone: '08155500736', p_code: null })
    const r = await api.resolveReview(review.id, 'approve')
    assert.equal(r.kind, 'unexpected')
    assert.equal(r.res.status, 'phone_has_ballot')
    assert.equal(await voterCount(db, '08155500736'), 0)
  })
})

describe('legacy compatibility', () => {
  it('voting codes still work for anonymous voters; registered voters don’t need one', async () => {
    const { db, session, api } = await setup()
    assert.equal((await call(db, 'admin_set_code_required', { p_session: session, p_required: true })).status, 'ok')
    const noCode = await call(db, 'begin_ballot', { p_name: 'Test Anon', p_phone: '08155500740', p_code: null })
    assert.equal(noCode.status, 'code_required')
    const issued = await call(db, 'admin_issue_codes', { p_session: session, p_count: 1, p_phone: null, p_note: 'test', p_expires_hours: null })
    const withCode = await call(db, 'begin_ballot', { p_name: 'Test Anon', p_phone: '08155500740', p_code: issued.codes[0].code })
    assert.equal(withCode.status, 'started')

    const reg = await api.registerInPerson('Test Nocode', '08155500741', CV, true)
    const vs = (await call(db, 'voter_login', { p_code: reg.res.voter_code })).session
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: vs })).status, 'started')
  })

  it('the dashboard totals include registered voters’ ballots', async () => {
    const { db, session, api } = await setup()
    const before = await call(db, 'admin_dashboard', { p_session: session })
    const reg = await api.registerInPerson('Test Totals', '08155500742', CV, true)
    const vs = (await call(db, 'voter_login', { p_code: reg.res.voter_code })).session
    await call(db, 'voter_begin_ballot', { p_session: vs })
    const after = await call(db, 'admin_dashboard', { p_session: session })
    assert.equal(after.ballots_started, before.ballots_started + 1)
    assert.equal((await api.stats()).res.voters_active, 1)
  })

  it('other errors on the voting page are left exactly as before', () => {
    assert.equal(isAccountBallot({ status: 'error', message: 'unknown ballot' }), false)
    assert.equal(isAccountBallot({ status: 'ok' }), false)
    assert.equal(isAccountBallot(null), false)
    const vote = readFileSync(root('src/pages/Vote.jsx'), 'utf8')
    for (const s of ['code_required', 'invalid_code', 'resume_required', 'rate_limited', 'already_voted', 'closed']) {
      assert.ok(vote.includes(`case '${s}'`), s)
    }
  })
})

describe('the tab keeps codes and numbers to itself', () => {
  const files = [
    'src/lib/voters.js',
    'src/components/admin/VotersTab.jsx',
    'src/components/admin/VoterDialogs.jsx',
  ].map((f) => [f, readFileSync(root(f), 'utf8')])

  it('no storage, logging, clipboard, downloads or raw network calls', () => {
    for (const [f, src] of files) {
      for (const re of [
        /sessionStorage/, /localStorage/, /indexedDB/, /console\./, /clipboard/, /createObjectURL/,
        /\bfetch\s*\(/, /XMLHttpRequest/, /getUserMedia/, /mediaDevices/, /supabase/,
      ]) {
        assert.ok(!re.test(src), `${f} matches ${re}`)
      }
    }
  })

  it('is loaded lazily, and only the database switches it on (no build flag)', () => {
    const admin = readFileSync(root('src/pages/Admin.jsx'), 'utf8')
    assert.match(admin, /const VotersTab = lazy\(/)
    assert.ok(!/VITE_/.test(admin), 'no environment variable switches it on or off')
    for (const f of ['src/App.jsx', 'src/pages/Vote.jsx', 'src/components/admin/CodesTab.jsx']) {
      assert.ok(!/VotersTab|lib\/voters/.test(readFileSync(root(f), 'utf8')), f)
    }
  })

  it('offers a reissue after a lost approval only when it was this admin’s own', () => {
    const dialogs = files[2][1]
    assert.match(dialogs, /setMine\(approve && r\.kind === 'network' && out\.byMe === true\)/)
    assert.match(dialogs, /\{step === 'approved' && mine && \(/)
  })

  it('explains that a revoked account can be restored, with a new code', () => {
    const dialogs = files[2][1]
    assert.match(dialogs, /restoring always issues a new code/)
    assert.match(files[1][1], /not a biometric comparison/)
  })
})

describe('the synthetic-credential revocation procedure (not run on any real database)', () => {
  const doc = readFileSync(root('migrations/dev/revoke-synthetic-test-credentials.md'), 'utf8')
  const blocks = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1])
  const steps = blocks.filter((b) => !b.includes('set_admin_key')) // the key step needs a real key

  async function seeded(environment) {
    const { db, session, api } = await setup()
    const keep = await api.registerInPerson('Test Keepvotes', '08155500901', CV, true)
    const vs = (await call(db, 'voter_login', { p_code: keep.res.voter_code })).session
    await call(db, 'voter_begin_ballot', { p_session: vs })
    const { token } = await reviewFor(db, session, 'Test Waiting', '08155500902')
    const pending = await call(db, 'voter_registration_start', {
      p_name: 'Test Pending', p_phone: '08155500903', p_consent_version: 'draft-2026-11-dev', p_adult: true,
    })
    const approved = await call(db, 'voter_registration_start', {
      p_name: 'Test Unclaimed', p_phone: '08155500904', p_consent_version: 'draft-2026-11-dev', p_adult: true,
    })
    await call(db, 'dev_simulate_verification', {
      p_admin_session: session, p_registration_token: approved.registration_token, p_outcome: 'approved',
    })
    if (environment !== 'development') {
      // 004: registration and the simulator must be off before leaving development.
      await sql(db, `update settings set registration_mode = 'off', verification_provider = 'none' where id = 1`)
    }
    await sql(db, `update ypm_private.deployment set environment = $1`, [environment])
    return { db, code: keep.res.voter_code, vs, reviewToken: token, pending: pending.registration_token, approved: approved.registration_token }
  }

  it('on Development: every synthetic credential stops working, nothing is deleted', async () => {
    const t = await seeded('development')
    const before = await sql(t.db, `select (select count(*) from ballots) b, (select count(*) from voter_registrations) r, (select count(*) from voters) v`)
    for (const s of steps) await t.db.query(s)
    assert.equal((await call(t.db, 'voter_login', { p_code: t.code })).status, 'invalid')
    assert.equal((await call(t.db, 'voter_begin_ballot', { p_session: t.vs })).status, 'unauthorized')
    assert.equal((await call(t.db, 'voter_registration_claim', { p_token: t.approved })).status, 'expired')
    assert.equal((await call(t.db, 'voter_registration_claim', { p_token: t.pending })).status, 'expired')
    assert.equal((await call(t.db, 'voter_registration_status', { p_token: t.reviewToken })).status, 'rejected')
    const after = await sql(t.db, `select (select count(*) from ballots) b, (select count(*) from voter_registrations) r, (select count(*) from voters) v`)
    assert.deepEqual(after, before)
    const check = (await t.db.query(steps[steps.length - 2])).rows[0]
    assert.equal(Number(check.active_voters), 0)
    assert.equal(Number(check.sessions), 0)
    assert.equal(Number(check.open_regs), 0)
  })

  it('on a database not marked development: changes nothing', async () => {
    const t = await seeded('production')
    const before = await sql(t.db, `select (select json_agg(v order by id) from voters v) a,
      (select json_agg(r order by id) from voter_registrations r) b, (select count(*) from voter_sessions) c`)
    for (const s of steps) await t.db.query(s)
    const after = await sql(t.db, `select (select json_agg(v order by id) from voters v) a,
      (select json_agg(r order by id) from voter_registrations r) b, (select count(*) from voter_sessions) c`)
    assert.deepEqual(after, before)
    // And on a production-marked database every voter function is off anyway.
    assert.equal((await call(t.db, 'voter_login', { p_code: t.code })).status, 'disabled')
    assert.equal(Number((await sql(t.db, `select count(*) n from admin_audit where action = 'synthetic_credentials_revoked'`))[0].n), 0)
  })
})

describe('voterAccess with in-person requests (migration 006)', () => {
  it('no face check configured: ready only if 006 answered (development only)', () => {
    const none = { kind: 'ok', res: { verification_provider: 'none' } }
    assert.equal(voterAccess(true, none), 'not_development')
    assert.equal(voterAccess(true, { ...none, inPerson: false }), 'not_development')
    assert.equal(voterAccess(true, { ...none, inPerson: true }), 'ready')
    assert.equal(voterAccess(false, { ...none, inPerson: true }), 'ready', 'a production build opens once the database answers (007 switched on)')
    assert.equal(voterAccess(true, { kind: 'unexpected', res: { status: 'disabled' }, inPerson: true }), 'not_development')
  })
})
