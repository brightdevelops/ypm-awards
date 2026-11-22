import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import {
  freshDb, call, sql, login, issue, LEGACY, LEADER_KEY, INVENTOR_KEY,
  MIGRATION_SQL, DOWN_SQL,
} from './helpers.mjs'
import { normalizePhone } from '../../src/lib/phone.js'

const begin = (db, name, phone, extra = {}, opts) =>
  call(db, 'begin_ballot', { p_name: name, p_phone: phone, ...extra }, opts)

describe('migration', () => {
  let db
  before(async () => {
    db = await freshDb({ migrate: false })
  })

  it('leaves existing ballots and votes untouched', async () => {
    const before = await sql(db, `select * from ballots order by voter_phone`)
    const votesBefore = await sql(db, `select * from votes order by id`)
    await db.exec(MIGRATION_SQL)
    const after = await sql(db,
      `select id, voter_name, voter_phone, started_at, completed_at from ballots order by voter_phone`)
    assert.deepEqual(after, before)
    assert.deepEqual(await sql(db, `select * from votes order by id`), votesBefore)
    assert.deepEqual(await sql(db, `select voting_code_id from ballots where voting_code_id is not null`), [])
  })

  it('carries admin keys over hashed and defaults the code requirement off', async () => {
    const users = await sql(db, `select label, key_hash from admin_users order by label`)
    assert.deepEqual(users.map((u) => u.label), ['inventor', 'leader'])
    for (const u of users) assert.match(u.key_hash, /^[0-9a-f]{64}$/)
    const [s] = await sql(db, `select require_voting_code from settings`)
    assert.equal(s.require_voting_code, false)
  })

  it('can be run twice', async () => {
    await db.exec(MIGRATION_SQL)
    const users = await sql(db, `select count(*)::int n from admin_users`)
    assert.equal(users[0].n, 2)
  })

  it('rolls back cleanly, keeping ballots, and can be re-applied', async () => {
    await db.exec(DOWN_SQL)
    assert.equal((await sql(db, `select count(*)::int n from ballots`))[0].n, 2)
    const old = await call(db, 'get_tally', { p_key: LEADER_KEY })
    assert.equal(old.status, 'ok')
    await db.exec(MIGRATION_SQL)
    assert.equal((await call(db, 'get_tally', { p_key: LEADER_KEY })).status, 'ok')
  })
})

describe('the resume hole is closed', () => {
  let db
  before(async () => {
    db = await freshDb()
  })

  it('does not reopen an unfinished ballot from the phone number alone', async () => {
    const r = await begin(db, 'Intruder', LEGACY.open.phone)
    assert.deepEqual(r, { status: 'resume_required' })
  })

  it('does not reopen it through the old start_ballot either', async () => {
    await assert.rejects(
      call(db, 'start_ballot', { p_name: 'Intruder', p_phone: LEGACY.open.phone }),
      /resume_required/
    )
  })

  it('does not reopen it with someone else\'s ballot id', async () => {
    const other = await begin(db, 'Chi New', '08033333333')
    const r = await begin(db, 'Intruder', LEGACY.open.phone, { p_ballot_id: other.ballot_id })
    assert.equal(r.status, 'resume_required')
  })

  it('reopens it for the device that started it', async () => {
    const r = await begin(db, LEGACY.open.name, LEGACY.open.phone, {
      p_ballot_id: LEGACY.open.ballotId,
    })
    assert.equal(r.status, 'resumed')
    assert.equal(r.ballot_id, LEGACY.open.ballotId)
    assert.deepEqual(r.picks, [{ category_id: 'most-reliable-youth', nominee_name: 'Someone' }])
  })

  it('still tells a finished voter they have voted', async () => {
    assert.equal((await begin(db, 'x', LEGACY.done.phone)).status, 'already_voted')
    const old = await call(db, 'start_ballot', { p_name: 'x', p_phone: LEGACY.done.phone })
    assert.equal(old.status, 'already_voted')
  })

  it('normalises phone formats to the same voter, matching the browser', async () => {
    for (const typed of ['+234 802 222 2222', '2348022222222', '8022222222', '0802-222-2222']) {
      assert.equal(normalizePhone(typed), LEGACY.open.phone)
      const [{ n }] = await sql(db, `select ypm_private.normalize_phone($1) n`, [typed])
      assert.equal(n, LEGACY.open.phone)
      assert.equal((await begin(db, 'x', typed, {}, { ip: null })).status, 'resume_required')
    }
  })
})

describe('without the code requirement (backward compatible)', () => {
  let db
  before(async () => {
    db = await freshDb()
  })

  it('starts a new ballot with no code, through both functions', async () => {
    const a = await begin(db, 'Dayo', '08044444444')
    assert.equal(a.status, 'started')
    assert.deepEqual(a.picks, [])
    const b = await call(db, 'start_ballot', { p_name: 'Efe', p_phone: '08055555555' })
    assert.equal(b.status, 'started')
  })

  it('votes, resumes and submits exactly as before', async () => {
    const s = await begin(db, 'Funmi', '08066666666')
    assert.equal((await call(db, 'save_vote', {
      p_ballot_id: s.ballot_id, p_category_id: 'consistency', p_nominee_name: 'Nora Oboh',
    })).status, 'ok')
    // change of mind overwrites, never duplicates
    await call(db, 'save_vote', {
      p_ballot_id: s.ballot_id, p_category_id: 'consistency', p_nominee_name: 'Blessing Ukuoha',
    })
    const r = await begin(db, 'Funmi', '08066666666', { p_ballot_id: s.ballot_id })
    assert.deepEqual(r.picks, [{ category_id: 'consistency', nominee_name: 'Blessing Ukuoha' }])
    assert.equal((await call(db, 'submit_ballot', { p_ballot_id: s.ballot_id })).status, 'ok')
    assert.equal((await call(db, 'save_vote', {
      p_ballot_id: s.ballot_id, p_category_id: 'consistency', p_nominee_name: 'Ebenezer Obi',
    })).message, 'already submitted')
  })

  it('still accepts a code when one is given', async () => {
    const [c] = await issue(db, await login(db))
    const r = await begin(db, 'Gbenga', '08077777777', { p_code: c.code })
    assert.equal(r.status, 'started')
    const [row] = await sql(db, `select redeemed_at from voting_codes where id = $1`, [c.id])
    assert.ok(row.redeemed_at)
  })

  it('reports closed when voting is closed', async () => {
    await sql(db, `update settings set voting_open = false`)
    assert.equal((await begin(db, 'Late', '08088888888')).status, 'closed')
    await sql(db, `update settings set voting_open = true`)
  })

  it('rejects a missing name or bad phone', async () => {
    assert.equal((await begin(db, '  ', '08099999999')).status, 'error')
    assert.equal((await begin(db, 'Ok', '123')).status, 'error')
  })
})

describe('with the code requirement on', () => {
  let db, session
  before(async () => {
    db = await freshDb()
    session = await login(db)
    const r = await call(db, 'admin_set_code_required', { p_session: session, p_required: true })
    assert.equal(r.require_voting_code, true)
  })

  it('reports it in voting_status', async () => {
    assert.deepEqual(await call(db, 'voting_status'), {
      voting_open: true, require_voting_code: true,
    })
  })

  it('needs a code for a new ballot, through both functions', async () => {
    assert.equal((await begin(db, 'Ife', '08100000001')).status, 'code_required')
    await assert.rejects(
      call(db, 'start_ballot', { p_name: 'Ife', p_phone: '08100000001' }),
      /code_required/
    )
    assert.equal((await sql(db, `select count(*)::int n from ballots where voter_phone = '08100000001'`))[0].n, 0)
  })

  it('rejects an unknown code', async () => {
    assert.equal((await begin(db, 'Ife', '08100000001', { p_code: 'ZZZZZ-ZZZZZ' })).status, 'invalid_code')
  })

  it('accepts a valid code in any case or spacing, once', async () => {
    const [c] = await issue(db, session)
    assert.match(c.code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/)
    const typed = c.code.toLowerCase().replace('-', ' ')
    const r = await begin(db, 'Jide', '08100000002', { p_code: typed })
    assert.equal(r.status, 'started')

    // same code, another person: refused
    assert.equal((await begin(db, 'Kemi', '08100000003', { p_code: c.code })).status, 'invalid_code')

    // same code, same person, another device: reopens their ballot
    const again = await begin(db, 'Jide', '08100000002', { p_code: c.code })
    assert.equal(again.status, 'resumed')
    assert.equal(again.ballot_id, r.ballot_id)
  })

  it('lets each code open exactly one ballot', async () => {
    const [c] = await issue(db, session)
    const results = await Promise.all(
      ['08100000011', '08100000012', '08100000013'].map((p) => begin(db, 'Race', p, { p_code: c.code }))
    )
    assert.equal(results.filter((r) => r.status === 'started').length, 1)
    assert.equal((await sql(db, `select count(*)::int n from ballots where voting_code_id = $1`, [c.id]))[0].n, 1)
  })

  it('refuses a code another device redeemed a moment ago (unique index)', async () => {
    // The other transaction has inserted its ballot but not yet marked the code used.
    const [c] = await issue(db, session)
    await sql(db, `insert into ballots (voter_name, voter_phone, voting_code_id)
                   values ('Other', '08100000020', $1)`, [c.id])
    assert.equal((await begin(db, 'Me', '08100000021', { p_code: c.code })).status, 'invalid_code')
    assert.equal((await sql(db, `select count(*)::int n from ballots where voter_phone = '08100000021'`))[0].n, 0)
  })

  it('honours a code tied to a phone number', async () => {
    const [c] = await issue(db, session, { phone: '+2348100000004' })
    assert.equal(c.phone, '08100000004')
    assert.equal((await begin(db, 'Wrong', '08100000005', { p_code: c.code })).status, 'invalid_code')
    assert.equal((await begin(db, 'Right', '08100000004', { p_code: c.code })).status, 'started')
  })

  it('refuses revoked and expired codes', async () => {
    const [a, b] = await issue(db, session, { count: 2, expiresHours: 1 })
    assert.equal((await call(db, 'admin_revoke_code', { p_session: session, p_code_id: a.id })).status, 'ok')
    assert.equal((await begin(db, 'Rev', '08100000006', { p_code: a.code })).status, 'invalid_code')
    await sql(db, `update voting_codes set expires_at = now() - interval '1 minute' where id = $1`, [b.id])
    assert.equal((await begin(db, 'Exp', '08100000007', { p_code: b.code })).status, 'invalid_code')
  })

  it('does not use up a code on someone who has already voted', async () => {
    const [c] = await issue(db, session)
    assert.equal((await begin(db, 'x', LEGACY.done.phone, { p_code: c.code })).status, 'already_voted')
    const [row] = await sql(db, `select redeemed_at from voting_codes where id = $1`, [c.id])
    assert.equal(row.redeemed_at, null)
  })

  it('lets a pre-migration voter finish on the same device without a code', async () => {
    const r = await begin(db, LEGACY.open.name, LEGACY.open.phone, { p_ballot_id: LEGACY.open.ballotId })
    assert.equal(r.status, 'resumed')
  })

  it('lets a leader reopen a pre-migration ballot on a new device with a code for that number', async () => {
    // an unbound code is not enough to take over someone's ballot
    const [loose] = await issue(db, session)
    assert.equal((await begin(db, 'x', LEGACY.open.phone, { p_code: loose.code })).status, 'resume_required')

    const [c] = await issue(db, session, { phone: LEGACY.open.phone })
    const r = await begin(db, LEGACY.open.name, LEGACY.open.phone, { p_code: c.code })
    assert.equal(r.status, 'resumed')
    assert.equal(r.ballot_id, LEGACY.open.ballotId)
    assert.equal(r.picks.length, 1)

    // ...and from then on the same code reopens it
    assert.equal((await begin(db, LEGACY.open.name, LEGACY.open.phone, { p_code: c.code })).status, 'resumed')
  })

  it('exposes code state, but never the code, to admins', async () => {
    const r = await call(db, 'admin_list_codes', { p_session: session })
    assert.equal(r.status, 'ok')
    assert.ok(r.codes.length > 0)
    for (const c of r.codes) {
      assert.equal(c.code, undefined)
      assert.equal(c.code_hash, undefined)
      assert.ok(['available', 'used', 'revoked', 'expired'].includes(c.state))
    }
    const d = await call(db, 'admin_dashboard', { p_session: session })
    assert.ok(d.codes.issued >= d.codes.redeemed)
  })
})

describe('rate limits', () => {
  let db
  before(async () => {
    db = await freshDb()
  })

  it('locks a phone number after 8 failed attempts', async () => {
    for (let i = 0; i < 8; i++) {
      const r = await begin(db, 'x', LEGACY.open.phone, {}, { ip: `198.51.100.${i}` })
      assert.equal(r.status, 'resume_required')
    }
    const r = await begin(db, LEGACY.open.name, LEGACY.open.phone, { p_ballot_id: LEGACY.open.ballotId })
    assert.equal(r.status, 'rate_limited')
    // other numbers are unaffected
    assert.equal((await begin(db, 'Other', '08200000001')).status, 'started')
  })

  it('locks an IP address after 30 failed codes', async () => {
    const ip = '192.0.2.50'
    for (let i = 0; i < 30; i++) {
      await begin(db, 'x', `0820000${String(1000 + i)}`, { p_code: 'AAAAA-AAAAA' }, { ip })
    }
    assert.equal((await begin(db, 'x', '08209999999', {}, { ip })).status, 'rate_limited')
    assert.equal((await begin(db, 'x', '08209999999', {}, { ip: '192.0.2.51' })).status, 'started')
  })

  it('locks admin sign-in from an IP address after 10 wrong keys', async () => {
    const ip = '192.0.2.99'
    for (let i = 0; i < 10; i++) {
      assert.equal((await call(db, 'admin_login', { p_key: `guess-${i}` }, { ip })).status, 'unauthorized')
    }
    assert.equal((await call(db, 'admin_login', { p_key: LEADER_KEY }, { ip })).status, 'rate_limited')
    assert.equal((await call(db, 'get_tally', { p_key: LEADER_KEY }, { ip })).status, 'unauthorized')
    assert.equal((await call(db, 'admin_login', { p_key: LEADER_KEY }, { ip: '192.0.2.98' })).status, 'ok')
  })

  it('caps admin failures overall at 60, whatever the IP', async () => {
    for (let i = 0; i < 60; i++) {
      await call(db, 'admin_login', { p_key: 'nope' }, { ip: `10.0.${Math.floor(i / 9)}.${i}` })
    }
    assert.equal((await call(db, 'admin_login', { p_key: LEADER_KEY }, { ip: '10.9.9.9' })).status, 'rate_limited')
  })
})

describe('admin sessions', () => {
  let db
  before(async () => {
    db = await freshDb()
  })

  it('signs in with a key and returns a session, not the key', async () => {
    const r = await call(db, 'admin_login', { p_key: INVENTOR_KEY })
    assert.equal(r.status, 'ok')
    assert.equal(r.label, 'inventor')
    assert.match(r.session, /^[0-9a-f]{64}$/)
    assert.equal(r.weak_key, false)
    const stored = await sql(db, `select token_hash from admin_sessions`)
    assert.ok(stored.every((s) => s.token_hash !== r.session))
  })

  it('flags keys shorter than 16 characters', async () => {
    await sql(db, `insert into admin_users (label, key_hash) values ('weak', ypm_private.sha256_hex('short'))`)
    assert.equal((await call(db, 'admin_login', { p_key: 'short' })).weak_key, true)
  })

  it('rejects a wrong key and logs the attempt without the key', async () => {
    assert.equal((await call(db, 'admin_login', { p_key: 'wrong-key' })).status, 'unauthorized')
    const [row] = await sql(db, `select detail::text d from admin_audit where action = 'login_failed'`)
    assert.ok(!row.d.includes('wrong-key'))
  })

  it('serves the dashboard to a valid session only', async () => {
    const s = await login(db)
    const d = await call(db, 'admin_dashboard', { p_session: s })
    assert.equal(d.status, 'ok')
    assert.equal(d.key_label, 'leader')
    assert.equal(d.ballots_started, 2)
    assert.equal(d.ballots_completed, 1)
    assert.equal((await call(db, 'admin_dashboard', { p_session: 'f'.repeat(64) })).status, 'unauthorized')
    assert.equal((await call(db, 'admin_dashboard', { p_session: null })).status, 'unauthorized')
  })

  it('expires sessions', async () => {
    const s = await login(db)
    await sql(db, `update admin_sessions set expires_at = now() - interval '1 second'`)
    assert.equal((await call(db, 'admin_dashboard', { p_session: s })).status, 'unauthorized')
  })

  it('signs out', async () => {
    const s = await login(db)
    await call(db, 'admin_logout', { p_session: s })
    assert.equal((await call(db, 'admin_dashboard', { p_session: s })).status, 'unauthorized')
  })

  it('ends sessions when a key is revoked or replaced', async () => {
    const s = await login(db, INVENTOR_KEY)
    await sql(db, `select ypm_private.revoke_admin('inventor')`)
    assert.equal((await call(db, 'admin_dashboard', { p_session: s })).status, 'unauthorized')
    assert.equal((await call(db, 'admin_login', { p_key: INVENTOR_KEY })).status, 'unauthorized')

    await assert.rejects(sql(db, `select ypm_private.set_admin_key('inventor', 'too-short')`), /16 characters/)
    await sql(db, `select ypm_private.set_admin_key('inventor', 'a-much-longer-new-secret')`)
    assert.equal((await call(db, 'admin_login', { p_key: 'a-much-longer-new-secret' })).status, 'ok')
  })

  it('keeps the old key-based functions working for open pages', async () => {
    const t = await call(db, 'get_tally', { p_key: LEADER_KEY })
    assert.equal(t.status, 'ok')
    assert.equal(t.key_label, 'leader')
    assert.ok(Array.isArray(t.tally) && Array.isArray(t.voters))
    assert.equal((await call(db, 'set_voting_open', { p_key: LEADER_KEY, p_open: false })).status, 'ok')
    assert.equal((await call(db, 'voting_status')).voting_open, false)
    assert.equal((await call(db, 'set_voting_open', { p_key: 'nope', p_open: true })).status, 'unauthorized')
    await call(db, 'set_voting_open', { p_key: LEADER_KEY, p_open: true })
  })

  it('requires a session for every admin action', async () => {
    const bad = 'not-a-session'
    for (const [fn, args] of [
      ['admin_set_voting_open', { p_open: false }],
      ['admin_set_code_required', { p_required: true }],
      ['admin_issue_codes', { p_count: 5 }],
      ['admin_list_codes', {}],
      ['admin_revoke_code', { p_code_id: '00000000-0000-0000-0000-000000000000' }],
      ['admin_audit_log', {}],
    ]) {
      const r = await call(db, fn, { p_session: bad, ...args })
      assert.equal(r.status, 'unauthorized', fn)
    }
    const [s] = await sql(db, `select voting_open, require_voting_code from settings`)
    assert.deepEqual(s, { voting_open: true, require_voting_code: false })
    assert.equal((await sql(db, `select count(*)::int n from voting_codes`))[0].n, 0)
  })

  it('validates code issuing', async () => {
    const s = await login(db)
    const bad = async (args) =>
      (await call(db, 'admin_issue_codes', { p_session: s, p_count: 1, ...args })).status
    assert.equal(await bad({ p_count: 0 }), 'error')
    assert.equal(await bad({ p_count: 201 }), 'error')
    assert.equal(await bad({ p_count: 2, p_phone: '08011112222' }), 'error')
    assert.equal(await bad({ p_phone: '123' }), 'error')
    assert.equal(await bad({ p_expires_hours: 0 }), 'error')

    const codes = await issue(db, s, { count: 50, note: 'Sunday' })
    assert.equal(new Set(codes.map((c) => c.code)).size, 50)
  })

  it('records admin actions in the audit log', async () => {
    const s = await login(db)
    await call(db, 'admin_set_code_required', { p_session: s, p_required: false })
    const r = await call(db, 'admin_audit_log', { p_session: s })
    const actions = r.events.map((e) => e.action)
    for (const a of ['login', 'login_failed', 'codes_issued', 'set_code_required', 'set_voting_open']) {
      assert.ok(actions.includes(a), a)
    }
  })
})

describe('the browser cannot reach private data', () => {
  let db
  before(async () => {
    db = await freshDb()
  })

  // Existing tables: granted by Supabase's defaults, but RLS returns nothing.
  for (const table of ['ballots', 'votes', 'admin_keys', 'settings']) {
    it(`sees no rows in ${table}`, async () => {
      await db.exec('set role anon')
      try {
        assert.deepEqual((await db.query(`select * from public.${table}`)).rows, [])
        await db.query(`delete from public.${table}`)
      } finally {
        await db.exec('reset role')
      }
      assert.ok((await sql(db, `select count(*)::int n from public.${table}`))[0].n > 0)
    })
  }

  // New tables: privileges revoked outright, with RLS as a second wall.
  for (const table of ['voting_codes', 'admin_users', 'admin_sessions', 'admin_audit', 'rate_events']) {
    it(`cannot touch ${table} at all`, async () => {
      await db.exec('set role anon')
      try {
        await assert.rejects(db.query(`select * from public.${table}`), /permission denied/)
        await assert.rejects(db.query(`delete from public.${table}`), /permission denied/)
      } finally {
        await db.exec('reset role')
      }
    })
  }

  it('cannot call the private helpers', async () => {
    await db.exec('set role anon')
    try {
      await assert.rejects(
        db.query(`select ypm_private.issue_codes('anon', 5, null, null, null)`),
        /permission denied/
      )
    } finally {
      await db.exec('reset role')
    }
  })
})
