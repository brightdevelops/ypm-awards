// Migration 004: voter account safeguards.
//
// These run on PGlite, which has ONE connection: every test here is
// SEQUENTIAL. "Twice in a row" checks prove the rules (locks, unique
// indexes, status checks) give the right answer when requests arrive one
// after another; they do not prove behaviour under truly simultaneous
// transactions. Those are in tests/concurrency/ and run against a real,
// throwaway PostgreSQL server (npm run test:concurrency).
//
// Synthetic identities only (0815550 0xxx).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  freshDb, call, sql, login, LEGACY, INVENTOR_KEY, DEV_SIM_SQL,
  VOTER_MIGRATION_SQL, VOTER_DOWN_SQL, SAFEGUARDS_SQL, SAFEGUARDS_DOWN_SQL,
  BALLOT_DOWN_SQL, DOWN_SQL,
} from './helpers.mjs'
import { BALLOT } from '../../src/data/categories.js'

const CV = 'draft-2026-11-dev'
const NIL = '00000000-0000-0000-0000-000000000000'
const CODE_RE = /^YPM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/
const NOMINEE = { p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams' }

async function devDb(migrate = true) {
  const db = await freshDb({ migrate })
  await sql(db, `update ypm_private.deployment set environment = 'development'`)
  await sql(db, `update settings set verification_provider = 'simulated', registration_mode = 'optional' where id = 1`)
  await db.exec(DEV_SIM_SQL)
  return { db, s: await login(db) }
}

async function inPerson(db, s, name, phone, extra = {}) {
  return call(db, 'admin_register_voter', {
    p_session: s, p_name: name, p_phone: phone, p_consent_version: CV,
    p_adult_confirmed: true, p_link_existing_ballot: false, ...extra,
  })
}

async function review(db, s, name, phone) {
  const st = await call(db, 'voter_registration_start', {
    p_name: name, p_phone: phone, p_consent_version: CV, p_adult: true,
  })
  assert.equal(st.status, 'ok', JSON.stringify(st))
  await call(db, 'dev_simulate_verification', {
    p_admin_session: s, p_registration_token: st.registration_token, p_outcome: 'review',
  })
  const list = await call(db, 'admin_list_reviews', { p_session: s })
  return { token: st.registration_token, id: list.reviews.find((r) => r.full_name === name).id }
}

async function anonBallot(db, name, phone, votes = 1) {
  const b = await call(db, 'begin_ballot', { p_name: name, p_phone: phone, p_code: null })
  assert.equal(b.status, 'started', JSON.stringify(b))
  // The first nominee of each of the first `votes` categories on the real ballot.
  for (const c of BALLOT.slice(0, votes)) {
    const r = await call(db, 'save_vote', { p_ballot_id: b.ballot_id, p_category_id: c.id, p_nominee_name: c.nominees[0].name })
    assert.equal(r.status, 'ok', JSON.stringify(r))
  }
  return b.ballot_id
}

const count = async (db, q, p = []) => Number((await sql(db, q, p))[0].n)

// Every public function that belongs to voter accounts, with valid-looking
// arguments.
const VOTER_FUNCTIONS = (s) => ({
  voter_registration_start: { p_name: 'Test Person', p_phone: '08155500600', p_consent_version: CV, p_adult: true },
  voter_registration_status: { p_token: 'x' },
  voter_registration_claim: { p_token: 'x' },
  voter_login: { p_code: 'YPM-AAAA-BBBB-CCCC' },
  voter_logout: { p_session: 'x' },
  voter_begin_ballot: { p_session: 'x' },
  voter_save_vote: { p_session: 'x', ...NOMINEE },
  voter_submit_ballot: { p_session: 'x' },
  admin_register_voter: { p_session: s, p_name: 'Test Person', p_phone: '08155500601', p_consent_version: CV, p_adult_confirmed: true, p_link_existing_ballot: false },
  admin_list_voters: { p_session: s, p_search: null, p_limit: 50, p_offset: 0 },
  admin_reissue_voter_code: { p_session: s, p_voter_id: NIL },
  admin_revoke_voter: { p_session: s, p_voter_id: NIL, p_reason: null },
  admin_list_reviews: { p_session: s },
  admin_resolve_review: { p_session: s, p_registration_id: NIL, p_decision: 'approve', p_link_existing_ballot: false },
  admin_set_registration_mode: { p_session: s, p_mode: 'optional' },
  admin_voter_stats: { p_session: s },
  admin_restore_voter: { p_session: s, p_voter_id: NIL, p_reason: 'test reason' },
})

describe('004: production stays disabled, enforced by the database', () => {
  it('every voter-account function answers "disabled" on a production database, even for a signed-in admin', async () => {
    const db = await freshDb() // 004 installed; environment defaults to production
    const s = await login(db)
    const fns = VOTER_FUNCTIONS(s)
    assert.equal(Object.keys(fns).length, 17)
    for (const [fn, args] of Object.entries(fns)) {
      assert.deepEqual(await call(db, fn, args), { status: 'disabled' }, fn)
    }
    assert.equal(await count(db, `select count(*) n from voters`), 0)
    assert.equal(await count(db, `select count(*) n from voter_registrations`), 0)
  })

  it('every public voter function is covered (none can slip past the switch)', async () => {
    const db = await freshDb()
    const s = await login(db)
    const names = (await sql(db, `
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and (p.proname like 'voter\\_%' or p.proname like 'admin\\_%voter%'
              or p.proname in ('admin_list_reviews', 'admin_resolve_review', 'admin_set_registration_mode'))
       order by 1`)).map((r) => r.proname)
    assert.deepEqual(names, Object.keys(VOTER_FUNCTIONS(s)).sort())
  })

  it('registration can’t be switched on outside development, but other settings still change', async () => {
    const db = await freshDb()
    const s = await login(db)
    await assert.rejects(sql(db, `update settings set registration_mode = 'optional' where id = 1`),
      /only be switched on in a development project/)
    // Voting open / codes required are untouched by the guard.
    assert.equal((await call(db, 'admin_set_voting_open', { p_session: s, p_open: false })).status, 'ok')
    assert.equal((await call(db, 'admin_set_voting_open', { p_session: s, p_open: true })).status, 'ok')
    assert.equal((await call(db, 'admin_set_code_required', { p_session: s, p_required: true })).status, 'ok')
  })

  it('a project can’t leave development while registration or the simulator is on', async () => {
    const { db } = await devDb()
    await assert.rejects(sql(db, `update ypm_private.deployment set environment = 'production'`),
      /Before marking this project as production/)
    await sql(db, `update settings set registration_mode = 'off' where id = 1`)
    await assert.rejects(sql(db, `update ypm_private.deployment set environment = 'production'`))
    await sql(db, `update settings set verification_provider = 'none' where id = 1`)
    await sql(db, `update ypm_private.deployment set environment = 'production'`)
    const s = await login(db)
    assert.equal((await call(db, 'admin_voter_stats', { p_session: s })).status, 'disabled')
  })

  it('refuses to install on a production database that has registration switched on', async () => {
    const db = await freshDb({ migrate: '003' })
    await sql(db, `update settings set registration_mode = 'optional' where id = 1`) // 003 allowed this
    await assert.rejects(db.exec(SAFEGUARDS_SQL), /not marked as development/)
    await db.exec('rollback').catch(() => {})
    assert.equal(await count(db, `select count(*) n from pg_proc where proname = 'admin_restore_voter'`), 0)
  })

  it('the development simulator stays off in production too', async () => {
    const { db, s } = await devDb()
    const { token } = await review(db, s, 'Test Simoff', '08155500602')
    await sql(db, `update settings set registration_mode = 'off', verification_provider = 'none' where id = 1`)
    await sql(db, `update ypm_private.deployment set environment = 'production'`)
    const r = await call(db, 'dev_simulate_verification', { p_admin_session: s, p_registration_token: token, p_outcome: 'approved' })
    assert.equal(r.status, 'disabled')
  })
})

describe('004: private functions can’t be used to get around the switch', () => {
  it('no API role can run anything in ypm_private, or use the schema', async () => {
    const db = await freshDb()
    const fns = await sql(db, `
      select p.oid::regprocedure::text as sig,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as auth
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'ypm_private'`)
    assert.ok(fns.length > 40, `found ${fns.length}`)
    for (const f of fns) {
      assert.equal(f.anon, false, `anon can run ${f.sig}`)
      assert.equal(f.auth, false, `authenticated can run ${f.sig}`)
    }
    for (const role of ['anon', 'authenticated']) {
      const u = await sql(db, `select has_schema_privilege($1, 'ypm_private', 'usage') u`, [role])
      assert.equal(u[0].u, false, role)
    }
    // Including the moved 003 originals and erase_voter.
    for (const sig of ['voter_login_003(text)', 'admin_register_voter_003(text,text,text,boolean)',
      'admin_resolve_review_003(text,uuid,text)', 'erase_voter(uuid,text)']) {
      assert.ok(fns.some((f) => f.sig === `ypm_private.${sig}`), sig)
    }
  })

  it('calling a moved 003 function directly as anon or authenticated is refused', async () => {
    const db = await freshDb()
    for (const role of ['anon', 'authenticated']) {
      for (const q of [
        `select ypm_private.voter_login_003('YPM-AAAA-BBBB-CCCC')`,
        `select ypm_private.admin_voter_stats_003('x')`,
        `select ypm_private.erase_voter('${NIL}', 'test')`,
        `select * from ypm_private.retired_voter_codes`,
        `select * from ypm_private.consent_versions`,
        `select * from public.voter_consents`,
        `insert into public.voter_consents (voter_id, consent_version, method, adult_confirmed, consented_at, recorded_by, recorded_from)
           values ('${NIL}', 'x', 'online', true, now(), 'x', 'account_created')`,
      ]) {
        await db.exec(`set role ${role}`)
        try {
          await assert.rejects(db.query(q), /permission denied/, `${role}: ${q}`)
        } finally {
          await db.exec('reset role')
        }
      }
    }
  })
})

describe('004: restoring a revoked voter', () => {
  it('gives a NEW code; the old one stays invalid; ballot and votes unchanged', async () => {
    const { db, s } = await devDb()
    const reg = await inPerson(db, s, 'Test Restore', '08155500610')
    const oldCode = reg.voter_code
    const vs = (await call(db, 'voter_login', { p_code: oldCode })).session
    await call(db, 'voter_begin_ballot', { p_session: vs })
    await call(db, 'voter_save_vote', { p_session: vs, ...NOMINEE })
    const votesBefore = await sql(db, `select * from votes v join ballots b on b.id = v.ballot_id where b.voter_id = $1`, [reg.voter_id])

    assert.equal((await call(db, 'admin_revoke_voter', { p_session: s, p_voter_id: reg.voter_id, p_reason: 'lost phone' })).status, 'ok')
    const r = await call(db, 'admin_restore_voter', { p_session: s, p_voter_id: reg.voter_id, p_reason: 'found phone, checked ID' })
    assert.equal(r.status, 'ok')
    assert.match(r.voter_code, CODE_RE)
    assert.notEqual(r.voter_code, oldCode)

    assert.equal((await call(db, 'voter_login', { p_code: oldCode })).status, 'invalid')
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: vs })).status, 'unauthorized')
    const again = await call(db, 'voter_login', { p_code: r.voter_code })
    assert.equal(again.status, 'ok')
    assert.equal(again.ballot.answered, 1)
    assert.deepEqual(
      await sql(db, `select * from votes v join ballots b on b.id = v.ballot_id where b.voter_id = $1`, [reg.voter_id]),
      votesBefore,
    )

    const v = (await sql(db, `select status, revoked_at, restored_by, restore_reason from voters where id = $1`, [reg.voter_id]))[0]
    assert.deepEqual([v.status, v.revoked_at, v.restored_by, v.restore_reason], ['active', null, 'leader', 'found phone, checked ID'])
    const audit = (await sql(db, `select detail from admin_audit where action = 'voter_restored'`))[0].detail
    assert.equal(audit.was_revoked_reason, 'lost phone')
    assert.equal(await count(db, `select count(*) n from ypm_private.retired_voter_codes where code_hash = ypm_private.voter_code_hash($1)`, [oldCode]), 1)
  })

  it('refuses: not revoked, no reason, unknown voter, no session', async () => {
    const { db, s } = await devDb()
    const reg = await inPerson(db, s, 'Test Restore Refuse', '08155500611')
    assert.equal((await call(db, 'admin_restore_voter', { p_session: s, p_voter_id: reg.voter_id, p_reason: 'why not' })).status, 'not_revoked')
    await call(db, 'admin_revoke_voter', { p_session: s, p_voter_id: reg.voter_id, p_reason: null })
    assert.equal((await call(db, 'admin_restore_voter', { p_session: s, p_voter_id: reg.voter_id, p_reason: ' ' })).status, 'error')
    assert.equal((await call(db, 'admin_restore_voter', { p_session: s, p_voter_id: NIL, p_reason: 'test reason' })).status, 'not_found')
    assert.equal((await call(db, 'admin_restore_voter', { p_session: 'nope', p_voter_id: reg.voter_id, p_reason: 'test reason' })).status, 'unauthorized')
    assert.equal((await sql(db, `select status from voters where id = $1`, [reg.voter_id]))[0].status, 'revoked')
  })

  it('restoring twice in a row (sequential): the second is refused, one code works', async () => {
    const { db, s } = await devDb()
    const reg = await inPerson(db, s, 'Test Restore Twice', '08155500612')
    await call(db, 'admin_revoke_voter', { p_session: s, p_voter_id: reg.voter_id, p_reason: null })
    const a = await call(db, 'admin_restore_voter', { p_session: s, p_voter_id: reg.voter_id, p_reason: 'first try' })
    const other = await login(db, INVENTOR_KEY)
    const b = await call(db, 'admin_restore_voter', { p_session: other, p_voter_id: reg.voter_id, p_reason: 'second try' })
    assert.equal(a.status, 'ok')
    assert.equal(b.status, 'not_revoked')
    assert.equal((await call(db, 'voter_login', { p_code: a.voter_code })).status, 'ok')
  })

  it('a retired code is never issued or accepted again (reissue and restore)', async () => {
    const { db, s } = await devDb()
    const reg = await inPerson(db, s, 'Test Retired', '08155500613')
    const first = reg.voter_code
    const re = await call(db, 'admin_reissue_voter_code', { p_session: s, p_voter_id: reg.voter_id })
    assert.equal(await count(db, `select count(*) n from ypm_private.retired_voter_codes where code_hash = ypm_private.voter_code_hash($1)`, [first]), 1)

    // Make the generator offer the retired code first: it must be skipped.
    await db.exec(`create table public.t_draws (n int); insert into public.t_draws values (0)`)
    await db.exec(`
      create or replace function ypm_private.new_voter_code() returns text language plpgsql as $$
      declare k int;
      begin
        update public.t_draws set n = n + 1;
        k := (select n from public.t_draws);
        return case when k = 1 then '${first}' else 'YPM-DDDD-EEEE-FFFF' end;
      end $$;`)
    await call(db, 'admin_revoke_voter', { p_session: s, p_voter_id: reg.voter_id, p_reason: null })
    const r = await call(db, 'admin_restore_voter', { p_session: s, p_voter_id: reg.voter_id, p_reason: 'test reason' })
    assert.equal(r.status, 'ok')
    assert.equal(r.voter_code, 'YPM-DDDD-EEEE-FFFF')
    assert.equal(await count(db, `select n from public.t_draws`), 2)
    assert.equal((await call(db, 'voter_login', { p_code: first })).status, 'invalid')
    assert.equal((await call(db, 'voter_login', { p_code: re.voter_code })).status, 'invalid')

    // Not even a direct write can bring one back.
    await assert.rejects(
      sql(db, `update voters set code_hash = ypm_private.voter_code_hash($1) where id = $2`, [first, reg.voter_id]),
      /used before/,
    )
  })
})

describe('004: linking a ballot when approving a review', () => {
  it('asks first, then links with every vote kept and no second ballot', async () => {
    const { db, s } = await devDb()
    const { token, id } = await review(db, s, 'Test Linkreview', '08155500620')
    const ballotId = await anonBallot(db, 'Test Linkreview', '08155500620', 2)
    const votesBefore = await sql(db, `select category_id, nominee_name from votes where ballot_id = $1 order by 1`, [ballotId])
    assert.equal(votesBefore.length, 2)

    const ask = await call(db, 'admin_resolve_review', { p_session: s, p_registration_id: id, p_decision: 'approve', p_link_existing_ballot: false })
    assert.deepEqual(ask, { status: 'phone_has_ballot', ballot: 'in_progress', answered: 2 })
    assert.equal(await count(db, `select count(*) n from voters where phone = '08155500620'`), 0)

    const ok = await call(db, 'admin_resolve_review', { p_session: s, p_registration_id: id, p_decision: 'approve', p_link_existing_ballot: true })
    assert.equal(ok.status, 'ok')
    assert.equal(ok.linked_ballot, true)
    assert.equal((await call(db, 'voter_registration_status', { p_token: token })).status, 'claimed')

    assert.equal(await count(db, `select count(*) n from ballots where voter_phone = '08155500620'`), 1)
    assert.deepEqual(await sql(db, `select category_id, nominee_name from votes where ballot_id = $1 order by 1`, [ballotId]), votesBefore)
    const session = (await call(db, 'voter_login', { p_code: ok.voter_code })).session
    const resumed = await call(db, 'voter_begin_ballot', { p_session: session })
    assert.equal(resumed.status, 'resumed')
    assert.equal(resumed.ballot_id ?? ballotId, ballotId)
    assert.equal(resumed.picks.length, 2)

    // The anonymous route is closed for it now.
    assert.equal((await call(db, 'save_vote', { p_ballot_id: ballotId, ...NOMINEE })).message, 'sign in with your voter code')
    assert.equal((await call(db, 'begin_ballot', { p_name: 'Test Linkreview', p_phone: '08155500620', p_code: null })).status, 'registered_voter')
    // And no second account or ballot can be made for the number.
    assert.equal((await inPerson(db, s, 'Test Linkreview', '08155500620')).status, 'phone_registered')
  })

  it('a submitted ballot stays submitted', async () => {
    const { db, s } = await devDb()
    const { id } = await review(db, s, 'Test Linksubmitted', '08155500621')
    const ballotId = await anonBallot(db, 'Test Linksubmitted', '08155500621', 1)
    await call(db, 'submit_ballot', { p_ballot_id: ballotId })
    const ok = await call(db, 'admin_resolve_review', { p_session: s, p_registration_id: id, p_decision: 'approve', p_link_existing_ballot: true })
    assert.equal(ok.linked_ballot, true)
    const session = (await call(db, 'voter_login', { p_code: ok.voter_code })).session
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: session })).status, 'already_voted')
  })

  it('approving without a ballot, approving twice, and adults only', async () => {
    const { db, s } = await devDb()
    const { id } = await review(db, s, 'Test Noballot', '08155500622')
    const a = await call(db, 'admin_resolve_review', { p_session: s, p_registration_id: id, p_decision: 'approve', p_link_existing_ballot: true })
    assert.equal(a.status, 'ok')
    assert.equal(a.linked_ballot, false)
    const b = await call(db, 'admin_resolve_review', { p_session: s, p_registration_id: id, p_decision: 'approve', p_link_existing_ballot: true })
    assert.equal(b.status, 'error')
    assert.equal(await count(db, `select count(*) n from voters where phone = '08155500622'`), 1)

    const { id: id2 } = await review(db, s, 'Test Notadult', '08155500623')
    await sql(db, `update voter_registrations set adult_confirmed = false where id = $1`, [id2])
    const c = await call(db, 'admin_resolve_review', { p_session: s, p_registration_id: id2, p_decision: 'approve', p_link_existing_ballot: false })
    assert.equal(c.status, 'adult_required')
    assert.equal(await count(db, `select count(*) n from voters where phone = '08155500623'`), 0)
  })

  it('the old three-argument version is gone, so it can’t be used to skip the new checks', async () => {
    const db = await freshDb()
    assert.equal(await count(db, `select count(*) n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('admin_resolve_review', 'admin_register_voter')`), 2)
    assert.equal((await sql(db, `select to_regprocedure('public.admin_resolve_review(text,uuid,text)') r`))[0].r, null)
    assert.equal((await sql(db, `select to_regprocedure('public.admin_register_voter(text,text,text,boolean)') r`))[0].r, null)
  })
})

describe('004: consent records', () => {
  it('online, approved-review and in-person accounts each get one record; no biometrics, no personal details', async () => {
    const { db, s } = await devDb()
    // Online, claimed by the voter.
    const st = await call(db, 'voter_registration_start', { p_name: 'Test Online', p_phone: '08155500630', p_consent_version: CV, p_adult: true })
    await call(db, 'dev_simulate_verification', { p_admin_session: s, p_registration_token: st.registration_token, p_outcome: 'approved' })
    assert.equal((await call(db, 'voter_registration_claim', { p_token: st.registration_token })).status, 'ok')
    // Approved review.
    const { id } = await review(db, s, 'Test Reviewed', '08155500631')
    await call(db, 'admin_resolve_review', { p_session: s, p_registration_id: id, p_decision: 'approve', p_link_existing_ballot: false })
    // In person.
    await inPerson(db, s, 'Test Inperson', '08155500632')

    const rows = await sql(db, `
      select v.phone, c.consent_version, c.method, c.adult_confirmed, c.biometric, c.recorded_by, c.recorded_from
        from voter_consents c join voters v on v.id = c.voter_id order by v.phone`)
    assert.deepEqual(rows.map((r) => [r.phone, r.method, r.recorded_by, r.recorded_from, r.biometric, r.adult_confirmed, r.consent_version]), [
      ['08155500630', 'online', 'self', 'account_created', false, true, CV],
      ['08155500631', 'online', 'leader', 'account_created', false, true, CV],
      ['08155500632', 'in_person', 'leader', 'account_created', false, true, CV],
    ])
    const cols = (await sql(db, `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'voter_consents' order by ordinal_position`)).map((c) => c.column_name)
    assert.deepEqual(cols, ['id', 'voter_id', 'consent_version', 'method', 'adult_confirmed', 'biometric',
      'consented_at', 'recorded_by', 'recorded_from', 'recorded_at'])
    const rls = await sql(db, `select relrowsecurity r from pg_class where oid = 'public.voter_consents'::regclass`)
    assert.equal(rls[0].r, true)
  })

  it('in person needs a current version and an adult; nothing is created otherwise', async () => {
    const { db, s } = await devDb()
    const old = await inPerson(db, s, 'Test Oldnotice', '08155500633', { p_consent_version: 'v0-made-up' })
    assert.equal(old.status, 'consent_outdated')
    assert.equal(old.consent_version, CV)
    assert.equal((await inPerson(db, s, 'Test Minor', '08155500634', { p_adult_confirmed: false })).status, 'adult_required')
    assert.equal((await inPerson(db, s, 'Test Minor', '08155500634', { p_adult_confirmed: null })).status, 'adult_required')
    assert.equal(await count(db, `select count(*) n from voters where phone in ('08155500633', '08155500634')`), 0)

    // Online registration with an unknown or retired version.
    const st = await call(db, 'voter_registration_start', { p_name: 'Test Oldnotice', p_phone: '08155500633', p_consent_version: 'v0-made-up', p_adult: true })
    assert.equal(st.status, 'consent_outdated')
    await sql(db, `update ypm_private.consent_versions set retired_at = now() where version = $1`, [CV])
    assert.equal((await inPerson(db, s, 'Test Retiredv', '08155500635')).status, 'consent_outdated')
  })

  it('draft notices are only accepted on a development database', async () => {
    const db = await freshDb()
    assert.equal((await sql(db, `select ypm_private.consent_version_ok($1) ok`, [CV]))[0].ok, false)
    await sql(db, `update ypm_private.deployment set environment = 'development'`)
    assert.equal((await sql(db, `select ypm_private.consent_version_ok($1) ok`, [CV]))[0].ok, true)
  })

  it('records can’t be changed or deleted (even by the database owner), and biometric must be false', async () => {
    const { db, s } = await devDb()
    await inPerson(db, s, 'Test Immutable', '08155500636')
    await assert.rejects(sql(db, `update voter_consents set adult_confirmed = false`), /cannot be changed/)
    await assert.rejects(sql(db, `delete from voter_consents`), /only be deleted with ypm_private.erase_voter/)
    await assert.rejects(sql(db, `truncate voter_consents`), /only be deleted/)
    await assert.rejects(sql(db, `insert into voter_consents (voter_id, consent_version, method, adult_confirmed, biometric, consented_at, recorded_by, recorded_from)
      select id, 'x', 'online', true, true, now(), 'x', 'account_created' from voters limit 1`), /check constraint/)
    assert.equal(await count(db, `select count(*) n from voter_consents`), 1)
  })

  it('no consent is invented for accounts made before 004', async () => {
    const { db, s } = await devDb('003')
    // An online account (consent recorded at registration) and an in-person one (none recorded).
    const st = await call(db, 'voter_registration_start', { p_name: 'Test Before', p_phone: '08155500637', p_consent_version: CV, p_adult: true })
    await call(db, 'dev_simulate_verification', { p_admin_session: s, p_registration_token: st.registration_token, p_outcome: 'approved' })
    await call(db, 'voter_registration_claim', { p_token: st.registration_token })
    await call(db, 'admin_register_voter', { p_session: s, p_name: 'Test Beforeinperson', p_phone: '08155500638' })
    await db.exec(SAFEGUARDS_SQL)

    const rows = await sql(db, `select v.phone, c.recorded_from from voters v left join voter_consents c on c.voter_id = v.id order by v.phone`)
    assert.deepEqual(rows.map((r) => [r.phone, r.recorded_from]), [
      ['08155500637', 'migration_004_backfill'],
      ['08155500638', null],
    ])
    const stats = await call(db, 'admin_voter_stats', { p_session: s })
    assert.equal(stats.voters_without_consent, 1)
    assert.equal(stats.consent_version, CV)
    assert.equal(stats.adults_only, true)
    // Running 004 again adds nothing.
    await db.exec(SAFEGUARDS_SQL)
    assert.equal(await count(db, `select count(*) n from voter_consents`), 1)
  })
})

describe('004: erasing an account (database owner only)', () => {
  it('removes the account and its consent; keeps the ballot and votes, anonymously', async () => {
    const { db, s } = await devDb()
    const ballotId = await anonBallot(db, 'Test Erase', '08155500640', 2)
    const reg = await inPerson(db, s, 'Test Erase', '08155500640', { p_link_existing_ballot: true })
    assert.equal(reg.linked_ballot, true)
    await call(db, 'voter_login', { p_code: reg.voter_code })

    await assert.rejects(sql(db, `select ypm_private.erase_voter($1, '')`, [reg.voter_id]), /reason is required/)
    const r = (await sql(db, `select ypm_private.erase_voter($1, 'voter asked to be deleted') r`, [reg.voter_id]))[0].r
    assert.equal(r.status, 'ok')
    for (const t of ['voters', 'voter_consents', 'voter_sessions']) {
      assert.equal(await count(db, `select count(*) n from ${t}`), 0, t)
    }
    assert.equal(await count(db, `select count(*) n from voter_registrations where phone = '08155500640'`), 0)
    const b = (await sql(db, `select voter_id, voter_phone from ballots where id = $1`, [ballotId]))[0]
    assert.equal(b.voter_id, null)
    assert.equal(await count(db, `select count(*) n from votes where ballot_id = $1`, [ballotId]), 2)
    const audit = JSON.stringify((await sql(db, `select detail from admin_audit where action = 'voter_erased'`))[0].detail)
    assert.ok(!audit.includes('08155500640') && !audit.includes('Test Erase'), audit)
    // The delete permission doesn't outlive the erase.
    await inPerson(db, s, 'Test Afterwards', '08155500641')
    await assert.rejects(sql(db, `delete from voter_consents`), /only be deleted/)
  })
})

describe('004: undo and re-run', () => {
  const SNAPSHOT = `
    select json_build_object(
      'functions', (select json_agg(json_build_object(
          'sig', p.oid::regprocedure::text,
          'def', pg_get_functiondef(p.oid),
          'acl', (select json_agg(a order by a) from unnest(coalesce(p.proacl::text[], '{}')) a))
          order by p.oid::regprocedure::text)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'ypm_private') and p.prokind = 'f'),
      'triggers', (select json_agg(t.tgname || ' on ' || t.tgrelid::regclass order by 1)
        from pg_trigger t where not t.tgisinternal),
      'columns', (select json_agg(c.table_schema || '.' || c.table_name || '.' || c.column_name
                                  order by c.table_schema, c.table_name, c.ordinal_position)
        from information_schema.columns c where c.table_schema in ('public', 'ypm_private')),
      'data', json_build_object(
        'ballots', (select json_agg(b order by b.id) from ballots b),
        'votes', (select json_agg(v order by v.ballot_id, v.category_id) from votes v),
        'voters', (select json_agg(v order by v.id) from voters v),
        'registrations', (select json_agg(r order by r.id) from voter_registrations r),
        'settings', (select json_agg(s) from settings s))
    ) as snap`

  it('004 then its undo leaves 003 exactly as it was: functions, grants, triggers, columns and data', async () => {
    const { db, s } = await devDb('003')
    await call(db, 'admin_register_voter', { p_session: s, p_name: 'Test Undo', p_phone: '08155500650' })
    await anonBallot(db, 'Test Anon', '08155500651', 2)
    const before = (await sql(db, SNAPSHOT))[0].snap
    await db.exec(SAFEGUARDS_SQL)
    await db.exec(SAFEGUARDS_DOWN_SQL)
    const after = (await sql(db, SNAPSHOT))[0].snap
    assert.deepEqual(after.columns, before.columns)
    assert.deepEqual(after.triggers, before.triggers)
    assert.deepEqual(after.functions.map((f) => f.sig), before.functions.map((f) => f.sig))
    for (let i = 0; i < before.functions.length; i++) {
      assert.equal(after.functions[i].def, before.functions[i].def, before.functions[i].sig)
      assert.deepEqual(after.functions[i].acl, before.functions[i].acl, before.functions[i].sig)
    }
    assert.deepEqual(after.data, before.data)
  })

  it('after real use, the undo keeps accounts, codes and votes working (consent records go)', async () => {
    const { db, s } = await devDb()
    const reg = await inPerson(db, s, 'Test Used', '08155500652')
    await call(db, 'admin_revoke_voter', { p_session: s, p_voter_id: reg.voter_id, p_reason: null })
    const restored = await call(db, 'admin_restore_voter', { p_session: s, p_voter_id: reg.voter_id, p_reason: 'test reason' })
    const ballots = await count(db, `select count(*) n from ballots`)
    await db.exec(SAFEGUARDS_DOWN_SQL)
    assert.equal((await sql(db, `select to_regclass('public.voter_consents') r`))[0].r, null)
    assert.equal((await call(db, 'voter_login', { p_code: restored.voter_code })).status, 'ok')
    assert.equal((await call(db, 'voter_login', { p_code: reg.voter_code })).status, 'invalid')
    assert.equal(await count(db, `select count(*) n from ballots`), ballots)
    // The 003 versions are back, including the old in-person signature.
    assert.equal((await call(db, 'admin_register_voter', { p_session: s, p_name: 'Test Three', p_phone: '08155500653' })).status, 'ok')
    // And 004 goes back on cleanly.
    await db.exec(SAFEGUARDS_SQL)
    assert.equal((await inPerson(db, s, 'Test Four', '08155500654')).status, 'ok')
  })

  it('running 004 twice changes nothing; 003 refuses while 004 is installed; undo 004, 003, 004 works', async () => {
    const db = await freshDb()
    const s = await login(db)
    await db.exec(SAFEGUARDS_SQL)
    assert.equal((await call(db, 'admin_voter_stats', { p_session: s })).status, 'disabled')

    await assert.rejects(db.exec(VOTER_MIGRATION_SQL), /Migration 004 is installed/)
    await db.exec('rollback') // the refusal aborts 003's transaction
    for (const [fn, args] of Object.entries(VOTER_FUNCTIONS(s))) {
      assert.deepEqual(await call(db, fn, args), { status: 'disabled' }, `${fn} still switched off`)
    }

    // The documented way to re-run 003.
    await db.exec(SAFEGUARDS_DOWN_SQL)
    await db.exec(VOTER_MIGRATION_SQL)
    await db.exec(SAFEGUARDS_SQL)
    for (const [fn, args] of Object.entries(VOTER_FUNCTIONS(s))) {
      assert.deepEqual(await call(db, fn, args), { status: 'disabled' }, fn)
    }
    assert.equal((await sql(db, `select to_regprocedure('public.admin_resolve_review(text,uuid,text)') r`))[0].r, null)
  })

  it('003’s undo refuses to run while 004 is installed, and the full undo chain works in order', async () => {
    const { db, s } = await devDb()
    await inPerson(db, s, 'Test Chain', '08155500655')
    await assert.rejects(db.exec(VOTER_DOWN_SQL))
    await db.exec('rollback').catch(() => {})
    assert.ok((await sql(db, `select to_regclass('public.voters') r`))[0].r)

    const votes = await count(db, `select count(*) n from votes`)
    await db.exec(SAFEGUARDS_DOWN_SQL)
    await db.exec(VOTER_DOWN_SQL)
    await db.exec(BALLOT_DOWN_SQL)
    await db.exec(DOWN_SQL)
    assert.equal(await count(db, `select count(*) n from votes`), votes)
    assert.equal(await count(db, `select count(*) n from ballots where voter_phone = $1`, [LEGACY.done.phone]), 1)
  })
})

describe('004: anonymous voting and election data are unchanged', () => {
  it('on a production database with 004: start, resume, save, submit, codes and results work as before', async () => {
    const before = await freshDb({ migrate: '003' })
    const after = await freshDb()
    for (const db of [before, after]) {
      const s = await login(db)
      const fresh = await call(db, 'begin_ballot', { p_name: 'Test Anon', p_phone: '08155500660', p_code: null })
      assert.equal(fresh.status, 'started')
      assert.equal((await call(db, 'save_vote', { p_ballot_id: fresh.ballot_id, ...NOMINEE })).status, 'ok')
      assert.equal((await call(db, 'submit_ballot', { p_ballot_id: fresh.ballot_id })).status, 'ok')
      const again = await call(db, 'begin_ballot', { p_name: 'Test Anon', p_phone: '08155500660', p_code: null })
      assert.equal(again.status, 'already_voted')
      // This device's own unfinished ballot (each test database has its own id).
      const openId = (await sql(db, `select id from ballots where voter_phone = $1`, [LEGACY.open.phone]))[0].id
      const resume = await call(db, 'begin_ballot', { p_name: LEGACY.open.name, p_phone: LEGACY.open.phone, p_ballot_id: openId })
      assert.equal(resume.status, 'resumed')
      await call(db, 'admin_set_code_required', { p_session: s, p_required: true })
      assert.equal((await call(db, 'begin_ballot', { p_name: 'Test Code', p_phone: '08155500661', p_code: null })).status, 'code_required')
      const issued = await call(db, 'admin_issue_codes', { p_session: s, p_count: 1, p_phone: null, p_note: 't', p_expires_hours: null })
      assert.equal((await call(db, 'begin_ballot', { p_name: 'Test Code', p_phone: '08155500661', p_code: issued.codes[0].code })).status, 'started')
      assert.equal((await call(db, 'voting_status')).voting_open, true)
    }
    // Same results either way.
    const dash = async (db) => {
      const d = await call(db, 'admin_dashboard', { p_session: await login(db) })
      return { tally: d.tally, started: d.ballots_started, completed: d.ballots_completed }
    }
    assert.deepEqual(await dash(after), await dash(before))
  })

  it('installing 004 changes no ballot, vote or setting', async () => {
    const db = await freshDb({ migrate: '003' })
    await anonBallot(db, 'Test Keep', '08155500662', 2)
    const snap = `select json_build_object('b', (select json_agg(b order by b.id) from ballots b),
      'v', (select json_agg(v order by v.ballot_id, v.category_id) from votes v),
      's', (select json_agg(s) from settings s)) j`
    const before = (await sql(db, snap))[0].j
    await db.exec(SAFEGUARDS_SQL)
    assert.deepEqual((await sql(db, snap))[0].j, before)
  })
})
