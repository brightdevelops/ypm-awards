// Phase 3.3: the development voter flow's API and session layers, against
// a real test database with migration 003 and the dev simulator. Synthetic
// identities only (0815550 0xxx), simulated verification only.
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { createVoterApi } from '../../src/prototype/voterApi.js'
import { createSessionStore, VOTER_KEY, REGISTRATION_KEY } from '../../src/prototype/voterSession.js'
import { CONSENT_VERSION } from '../../src/prototype/simulator.js'
import { freshDb, call, sql, LEADER_KEY, DEV_SIM_SQL } from '../db/helpers.mjs'

const CODE_RE = /^YPM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/

// The browser's supabase.rpc, played by the test database.
const dbRpc = (db, ip) => (fn, args) =>
  call(db, fn, args, ip ? { ip } : undefined).then(
    (data) => ({ data, error: null }),
    (error) => ({ data: null, error }),
  )

function memoryStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => [...m.values()].join('\n'),
  }
}

async function devDb() {
  const db = await freshDb()
  await sql(db, `update ypm_private.deployment set environment = 'development'`)
  await sql(db, `update settings set verification_provider = 'simulated', registration_mode = 'optional' where id = 1`)
  await db.exec(DEV_SIM_SQL)
  return db
}

// Register → simulate → status → claim, the way the screens do it.
async function registerThroughApi(api, tester, name, phone, outcome = 'approved') {
  const s = await api.start(name, phone, true, CONSENT_VERSION)
  assert.equal(s.status, 'ok', JSON.stringify(s))
  const token = s.data.registration_token
  const sim = await api.simulate(tester, token, outcome)
  assert.equal(sim.status, 'ok')
  return { token, status: (await api.status(token)).status }
}

describe('voterApi result handling', () => {
  it('sorts replies into answer, unauthorized and failed', async () => {
    const replies = {
      a: { data: { status: 'ok', x: 1 }, error: null },
      b: { data: { status: 'unauthorized' }, error: null },
      c: { data: null, error: { message: 'TypeError: Failed to fetch' } },
      d: { data: null, error: null },
    }
    const api = createVoterApi(async (fn, args) => {
      if (args.p_code === 'throw') throw new Error('offline')
      return replies[args.p_code]
    })
    assert.deepEqual(await api.login('a'), { kind: 'answer', status: 'ok', data: { status: 'ok', x: 1 } })
    assert.equal((await api.login('b')).kind, 'unauthorized')
    assert.deepEqual(await api.login('c'), { kind: 'failed' })
    assert.deepEqual(await api.login('d'), { kind: 'failed' })
    assert.deepEqual(await api.login('throw'), { kind: 'failed' })
  })

  it('sends one request for a double tap on claim or submit', async () => {
    let calls = 0
    let release
    const gate = new Promise((r) => (release = r))
    const api = createVoterApi(async () => {
      calls += 1
      await gate
      return { data: { status: 'ok' }, error: null }
    })
    const both = Promise.all([api.claim('t'), api.claim('t')])
    release()
    const [a, b] = await both
    assert.equal(calls, 1)
    assert.equal(a, b)
    await api.claim('t') // a later, separate tap is a new request
    assert.equal(calls, 2)
  })
})

describe('voterSession storage', () => {
  it('keeps the session and registration token, never codes or full numbers', () => {
    const storage = memoryStorage()
    const store = createSessionStore(storage, () => Date.parse('2026-11-25T10:00:00Z'))
    store.setVoter({ session: 'sess-1', expiresAt: '2026-11-26T10:00:00Z', firstName: 'Test', code: 'YPM-AAAA-BBBB-CCCC' })
    store.setRegistration({ token: 'reg-1', expiresAt: '2026-11-25T10:30:00Z', firstName: 'Test', maskedPhone: '•••• 0001', phone: '08155500001' })
    assert.equal(store.getVoter().session, 'sess-1')
    assert.equal(store.getRegistration().token, 'reg-1')
    const everything = storage.dump()
    assert.ok(!everything.includes('YPM-'), 'a voter code was stored')
    assert.ok(!everything.includes('08155500001'), 'a full phone number was stored')
  })

  it('forgets expired entries', () => {
    const storage = memoryStorage()
    let t = Date.parse('2026-11-25T10:00:00Z')
    const store = createSessionStore(storage, () => t)
    store.setVoter({ session: 's', expiresAt: '2026-11-25T11:00:00Z', firstName: 'A' })
    store.setRegistration({ token: 'r', expiresAt: '2026-11-25T10:30:00Z' })
    t = Date.parse('2026-11-25T10:45:00Z')
    assert.equal(store.getRegistration(), null)
    assert.ok(store.getVoter())
    t = Date.parse('2026-11-25T11:00:01Z')
    assert.equal(store.getVoter(), null)
    assert.equal(storage.getItem(VOTER_KEY), null)
    assert.equal(storage.getItem(REGISTRATION_KEY), null)
  })

  it('survives broken or missing storage', () => {
    const broken = { getItem() { throw new Error('no') }, setItem() { throw new Error('no') }, removeItem() { throw new Error('no') } }
    const store = createSessionStore(broken)
    store.setVoter({ session: 's', expiresAt: '2099-01-01T00:00:00Z' })
    assert.equal(store.getVoter(), null)
    assert.equal(createSessionStore(null).getRegistration(), null)
  })
})

describe('the connected flow, end to end (simulated verification)', () => {
  let db, api, tester
  before(async () => {
    db = await devDb()
    api = createVoterApi(dbRpc(db))
    const t = await api.adminLogin(LEADER_KEY)
    assert.equal(t.status, 'ok')
    tester = t.data.session
  })

  it('registers, signs in, votes, submits once, and signs out', async () => {
    const { token, status } = await registerThroughApi(api, tester, 'Test Voter One', '08155500001')
    assert.equal(status, 'approved')
    const claim = await api.claim(token)
    assert.equal(claim.status, 'ok')
    assert.match(claim.data.voter_code, CODE_RE)
    const session = claim.data.session

    assert.equal((await api.begin(session)).status, 'started')
    assert.equal((await api.save(session, 'most-reliable-youth', 'Peace Williams')).status, 'ok')

    // Sign in again with the code: same ballot, picks restored.
    const l = await api.login(claim.data.voter_code)
    assert.equal(l.status, 'ok')
    assert.deepEqual(l.data.ballot, { state: 'in_progress', answered: 1 })
    const resumed = await api.begin(l.data.session)
    assert.equal(resumed.status, 'resumed')
    assert.deepEqual(resumed.data.picks, [{ category_id: 'most-reliable-youth', nominee_name: 'Peace Williams' }])

    assert.equal((await api.submit(l.data.session)).status, 'ok')
    assert.equal((await api.begin(session)).status, 'already_voted')
    assert.equal((await api.save(session, 'most-reliable-youth', 'Sarah Bakare')).status, 'error')
    // Submitting again changes nothing and still says ok (safe to retry after a lost reply).
    assert.equal((await api.submit(session)).status, 'ok')
    assert.equal((await sql(db, `select count(*)::int n from ballots where voter_phone = '08155500001'`))[0].n, 1)

    await api.logout(session)
    assert.equal((await api.begin(session)).kind, 'unauthorized')
    assert.equal((await api.begin(l.data.session)).status, 'already_voted') // other sessions unaffected
  })

  it('a lost claim reply: the code can’t be fetched twice, and the status says so', async () => {
    const { token } = await registerThroughApi(api, tester, 'Test Voter Two', '08155500002')
    const first = await api.claim(token) // pretend this reply never arrived
    assert.equal(first.status, 'ok')
    assert.equal((await api.claim(token)).status, 'invalid')
    assert.equal((await api.status(token)).status, 'claimed')
    // Recovery is in person: a replacement code works, the lost one doesn't.
    const voterId = (await sql(db, `select id from voters where phone = '08155500002'`))[0].id
    const re = await call(db, 'admin_reissue_voter_code', { p_session: tester, p_voter_id: voterId })
    assert.equal((await api.login(re.voter_code)).status, 'ok')
    assert.equal((await api.login(first.data.voter_code)).status, 'invalid')
  })

  it('a reload mid-registration carries on from the stored token', async () => {
    const storage = memoryStorage()
    const s = await api.start('Test Voter Three', '08155500003', true, CONSENT_VERSION)
    createSessionStore(storage).setRegistration({
      token: s.data.registration_token, expiresAt: s.data.expires_at, firstName: 'Test', maskedPhone: '•••• 0003',
    })
    // "Reload": a fresh API object and store read the same tab storage.
    const api2 = createVoterApi(dbRpc(db))
    const reg = createSessionStore(storage).getRegistration()
    assert.equal((await api2.status(reg.token)).status, 'pending')
    await api2.simulate(tester, reg.token, 'approved')
    assert.equal((await api2.claim(reg.token)).status, 'ok')
  })

  it('simulated duplicate: review, tester approves, code handed over in person', async () => {
    const { token, status } = await registerThroughApi(api, tester, 'Test Voter Four', '08155500004', 'review')
    assert.equal(status, 'review')
    assert.deepEqual((await api.claim(token)).data, { status: 'not_ready', registration: 'review' })
    const list = await api.listReviews(tester)
    const item = list.data.reviews.find((r) => r.full_name === 'Test Voter Four')
    assert.equal(item.phone, '•••• 0004')
    const ok = await api.resolveReview(tester, item.id, 'approve')
    assert.equal(ok.status, 'ok')
    assert.equal((await api.status(token)).status, 'claimed') // the device learns it was handled
    assert.equal((await api.login(ok.data.voter_code)).status, 'ok')
  })

  it('failed and expired registrations, and numbers that need help', async () => {
    const f = await registerThroughApi(api, tester, 'Test Voter Five', '08155500005', 'failed')
    assert.equal(f.status, 'failed')
    assert.equal((await api.claim(f.token)).data.registration, 'failed')

    const e = await api.start('Test Voter Six', '08155500006', true, CONSENT_VERSION)
    await sql(db, `update voter_registrations set expires_at = now() - interval '1 second' where full_name = 'Test Voter Six'`)
    assert.equal((await api.status(e.data.registration_token)).status, 'expired')
    assert.equal(
      (await api.simulate(tester, e.data.registration_token, 'approved')).status,
      'error', // the simulator won't touch an expired registration
    )

    assert.equal((await api.start('Someone Else', '08155500001', true, CONSENT_VERSION)).status, 'needs_assistance')
    assert.equal((await api.start('Young Tester', '08155500007', false, CONSENT_VERSION)).status, 'adult_required')
  })

  it('the simulator needs a tester session and a development database', async () => {
    const s = await api.start('Test Voter Eight', '08155500008', true, CONSENT_VERSION)
    assert.equal((await api.simulate('not-a-session', s.data.registration_token, 'approved')).kind, 'unauthorized')
    await sql(db, `update ypm_private.deployment set environment = 'production'`)
    assert.equal((await api.simulate(tester, s.data.registration_token, 'approved')).status, 'disabled')
    await sql(db, `update ypm_private.deployment set environment = 'development'`)
    assert.equal((await api.status(s.data.registration_token)).status, 'pending')
  })

  it('an expired voter session is refused everywhere', async () => {
    const { token } = await registerThroughApi(api, tester, 'Test Voter Nine', '08155500009')
    const c = await api.claim(token)
    await sql(db, `update voter_sessions set expires_at = now() - interval '1 second'
                    where voter_id = (select id from voters where phone = '08155500009')`)
    for (const r of [
      await api.begin(c.data.session),
      await api.save(c.data.session, 'most-reliable-youth', 'Peace Williams'),
      await api.submit(c.data.session),
    ]) {
      assert.equal(r.kind, 'unauthorized')
    }
  })
})

describe('simultaneous requests', () => {
  it('two devices opening the same voter’s ballot at once get one ballot', async () => {
    const db = await devDb()
    const tester = (await createVoterApi(dbRpc(db)).adminLogin(LEADER_KEY)).data.session
    const phone = createVoterApi(dbRpc(db, '203.0.113.1'))
    const laptop = createVoterApi(dbRpc(db, '203.0.113.2'))
    const { token } = await registerThroughApi(phone, tester, 'Test Voter Ten', '08155500010')
    const code = (await phone.claim(token)).data.voter_code
    const [a, b] = await Promise.all([phone.login(code), laptop.login(code)])

    const results = await Promise.all([phone.begin(a.data.session), laptop.begin(b.data.session)])
    assert.deepEqual(results.map((r) => r.status).sort(), ['resumed', 'started'])
    assert.equal((await sql(db, `select count(*)::int n from ballots where voter_phone = '08155500010'`))[0].n, 1)

    const subs = await Promise.all([phone.submit(a.data.session), laptop.submit(b.data.session)])
    assert.deepEqual(subs.map((r) => r.status), ['ok', 'ok'])
    assert.equal((await sql(db, `select count(*)::int n from ballots where voter_phone = '08155500010' and completed_at is not null`))[0].n, 1)
  })

  // PGlite has one connection, so a truly parallel transaction can't be run
  // here. In production the per-number advisory lock makes the second
  // request wait and then find the first one's ballot; the unique index is
  // the last line of defence. This forces a collision at the insert and
  // checks the backstop: no second ballot, no crash, and retrying works.
  it('if the ballot insert collides, no second ballot is made and retrying works', async () => {
    const db = await devDb()
    const api = createVoterApi(dbRpc(db))
    const tester = (await api.adminLogin(LEADER_KEY)).data.session
    const { token } = await registerThroughApi(api, tester, 'Test Voter Eleven', '08155500011')
    const session = (await api.claim(token)).data.session

    // Force the race: just before this request's insert, a "parallel"
    // request inserts the same voter's ballot.
    await db.exec(`
      create table race_flag (armed boolean);
      insert into race_flag values (true);
      create function race_insert() returns trigger language plpgsql as $$
      begin
        if new.voter_id is not null and (select armed from race_flag) then
          update race_flag set armed = false;
          insert into ballots (voter_name, voter_phone, voter_id)
          values (new.voter_name, new.voter_phone, new.voter_id);
        end if;
        return new;
      end $$;
      create trigger race before insert on ballots for each row execute function race_insert();
    `)
    const r = await api.begin(session)
    assert.equal(r.kind, 'answer')
    assert.ok(['resumed', 'needs_assistance'].includes(r.status), r.status)
    assert.ok((await sql(db, `select count(*)::int n from ballots where voter_phone = '08155500011'`))[0].n <= 1)

    // The other request is over. Trying again (the screen's "Try again")
    // gives exactly one ballot.
    await db.exec(`drop trigger race on ballots`)
    const again = await api.begin(session)
    assert.ok(['started', 'resumed'].includes(again.status), again.status)
    assert.equal((await sql(db, `select count(*)::int n from ballots where voter_phone = '08155500011'`))[0].n, 1)
  })

  it('two registrations for one number at once: only one becomes a voter', async () => {
    const db = await devDb()
    const api = createVoterApi(dbRpc(db))
    const tester = (await api.adminLogin(LEADER_KEY)).data.session
    const one = await registerThroughApi(api, tester, 'Test Voter Twelve', '08155500012')
    const two = await registerThroughApi(createVoterApi(dbRpc(db)), tester, 'Test Voter Twelve', '08155500012')
    const claims = await Promise.all([api.claim(one.token), createVoterApi(dbRpc(db)).claim(two.token)])
    assert.deepEqual(claims.map((c) => c.status).sort(), ['needs_assistance', 'ok'])
    assert.equal((await sql(db, `select count(*)::int n from voters where phone = '08155500012'`))[0].n, 1)
  })
})
