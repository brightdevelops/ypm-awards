// Re-run guards: 001, 002 and their undo files refuse to run over 003, and
// 003 refuses to run over 004, because each would silently replace newer
// protected functions. Every legitimate install, re-run and rollback order
// must still work exactly as before. Synthetic identities only.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  freshDb, call, sql, login, LEGACY,
  MIGRATION_SQL, DOWN_SQL, BALLOT_MIGRATION_SQL, BALLOT_DOWN_SQL, BALLOT_SYNC_SQL,
  VOTER_MIGRATION_SQL, VOTER_DOWN_SQL, SAFEGUARDS_SQL, SAFEGUARDS_DOWN_SQL,
} from './helpers.mjs'

const CV = 'draft-2026-11-dev'

// Every function in our schemas with a hash of its body: "nothing changed".
const functions = async (db) =>
  JSON.stringify(await sql(db, `
    select p.oid::regprocedure::text n, md5(p.prosrc) h, coalesce(p.proacl::text, '') a
      from pg_proc p
     where p.pronamespace in ('public'::regnamespace, 'ypm_private'::regnamespace)
     order by 1`))

async function refuses(db, file, re) {
  await assert.rejects(db.exec(file), re)
  await db.exec('rollback') // the refusal aborts the file's transaction
}

async function devWithVoter() {
  const db = await freshDb()
  await sql(db, `update ypm_private.deployment set environment = 'development'`)
  const s = await login(db)
  const v = await call(db, 'admin_register_voter', {
    p_session: s, p_name: 'Test Guard', p_phone: '08155500991', p_consent_version: CV, p_adult_confirmed: true,
  })
  const vs = (await call(db, 'voter_login', { p_code: v.voter_code })).session
  await call(db, 'voter_begin_ballot', { p_session: vs })
  const ballot = (await sql(db, `select id from ballots where voter_phone = '08155500991'`))[0].id
  return { db, ballot }
}

describe('migration re-run guards', () => {
  it('with 003 + 004 installed, every older file refuses and changes nothing', async () => {
    const { db, ballot } = await devWithVoter()
    const before = await functions(db)
    for (const [file, re] of [
      [MIGRATION_SQL, /Migration 003 is installed/],
      [DOWN_SQL, /Migration 003 is installed/],
      [BALLOT_MIGRATION_SQL, /Migration 003 is installed/],
      [BALLOT_DOWN_SQL, /Migration 003 is installed/],
      [VOTER_MIGRATION_SQL, /Migration 004 is installed/],
    ]) {
      await refuses(db, file, re)
      assert.equal(await functions(db), before)
    }
    // The registered voter's ballot is still protected from anonymous saves.
    const r = await call(db, 'save_vote', { p_ballot_id: ballot, p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams' })
    assert.equal(r.status, 'error')
  })

  it('with 003 only, 001 and 002 refuse; 003 itself can still be re-run', async () => {
    const db = await freshDb({ migrate: '003' })
    for (const file of [MIGRATION_SQL, DOWN_SQL, BALLOT_MIGRATION_SQL, BALLOT_DOWN_SQL]) {
      await refuses(db, file, /Migration 003 is installed/)
    }
    await db.exec(VOTER_MIGRATION_SQL)
    await db.exec(VOTER_MIGRATION_SQL)
  })

  it('a fresh install in order, with every file run twice while it is the newest', async () => {
    const db = await freshDb({ migrate: false }) // production as it is today
    await db.exec(MIGRATION_SQL)
    await db.exec(MIGRATION_SQL)
    await db.exec(BALLOT_MIGRATION_SQL)
    await db.exec(BALLOT_MIGRATION_SQL)
    await db.exec(MIGRATION_SQL) // 001 again after 002 (no 003): allowed, as before
    await db.exec(BALLOT_MIGRATION_SQL)
    await db.exec(BALLOT_SYNC_SQL)
    await db.exec(VOTER_MIGRATION_SQL)
    await db.exec(VOTER_MIGRATION_SQL)
    await db.exec(SAFEGUARDS_SQL)
    await db.exec(SAFEGUARDS_SQL)
    assert.equal((await call(db, 'begin_ballot', { p_name: 'Test Fresh', p_phone: '08155500993', p_code: null })).status, 'started')
  })

  it('the full rollback chain in order, then a full reinstall, keeps every ballot and vote', async () => {
    const db = await freshDb()
    const votes = (await sql(db, `select count(*)::int n from votes`))[0].n
    await db.exec(SAFEGUARDS_DOWN_SQL)
    await db.exec(VOTER_DOWN_SQL)
    await db.exec(BALLOT_DOWN_SQL)
    await db.exec(DOWN_SQL)
    assert.equal((await sql(db, `select count(*)::int n from votes`))[0].n, votes)
    assert.equal((await sql(db, `select to_regprocedure('ypm_private.save_vote_002(uuid,text,text)') r`))[0].r, null)

    await db.exec(MIGRATION_SQL)
    await db.exec(BALLOT_MIGRATION_SQL)
    await db.exec(BALLOT_SYNC_SQL)
    await db.exec(VOTER_MIGRATION_SQL)
    await db.exec(SAFEGUARDS_SQL)
    assert.equal((await sql(db, `select count(*)::int n from votes`))[0].n, votes)
    assert.equal((await sql(db, `select count(*)::int n from ballots where voter_phone = $1`, [LEGACY.done.phone]))[0].n, 1)
  })

  it('partial rollbacks: undo 004 then 003, after which 002 and 001 work again', async () => {
    const db = await freshDb()
    await db.exec(SAFEGUARDS_DOWN_SQL)
    await refuses(db, BALLOT_MIGRATION_SQL, /Migration 003 is installed/) // 003 still there
    await db.exec(VOTER_DOWN_SQL)
    await db.exec(BALLOT_MIGRATION_SQL)
    await db.exec(MIGRATION_SQL)
    await db.exec(BALLOT_DOWN_SQL)
    await db.exec(BALLOT_MIGRATION_SQL)
  })

  it('on a production-like database the guarded 001 behaves as before (old ballots resume)', async () => {
    const db = await freshDb({ migrate: false })
    await db.exec(MIGRATION_SQL)
    await db.exec(BALLOT_MIGRATION_SQL)
    const r = await call(db, 'begin_ballot', { p_name: LEGACY.open.name, p_phone: LEGACY.open.phone, p_code: null })
    assert.notEqual(r.status, 'started', 'an existing unfinished ballot is not replaced')
  })

  it('each guard sits inside its file’s transaction, so a refusal can’t be skipped past', () => {
    for (const [name, file] of Object.entries({ MIGRATION_SQL, DOWN_SQL, BALLOT_MIGRATION_SQL, BALLOT_DOWN_SQL, VOTER_MIGRATION_SQL })) {
      const lf = file.replace(/\r\n/g, '\n')
      const begin = lf.indexOf('\nbegin;\n')
      const guard = lf.indexOf('-- Refuses to run')
      assert.ok(begin > 0 && guard > begin, `${name}: guard after begin;`)
      assert.ok(guard < lf.indexOf('create ', guard), `${name}: guard before the first change`)
    }
  })
})
