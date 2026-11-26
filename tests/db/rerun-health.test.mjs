// The read-only health checks in migrations/dev/undo-004-development.md,
// run exactly as written there, against databases where an older migration
// was re-run on top of a newer one. Keeps the documented SQL honest.
//
// The committed files now refuse to run over a newer migration, so the
// re-runs here use copies WITHOUT that guard: what an old saved snippet or a
// copy taken before the guards were added would do.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  freshDb, sql, MIGRATION_SQL, BALLOT_MIGRATION_SQL, BALLOT_DOWN_SQL, VOTER_MIGRATION_SQL, SAFEGUARDS_SQL,
} from './helpers.mjs'

const doc = readFileSync(
  fileURLToPath(new URL('../../migrations/dev/undo-004-development.md', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n')
const blocks = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1])
const UNGUARDED = blocks.find((b) => b.includes('as unguarded'))
const WRAPPERS = blocks.find((b) => b.includes('as begin_ballot_ok'))

async function health(db) {
  const w = (await sql(db, WRAPPERS))[0]
  return {
    unguarded: Number((await sql(db, UNGUARDED))[0].unguarded),
    begin: w.begin_ballot_ok,
    save: w.save_vote_ok,
    submit: w.submit_ballot_ok,
  }
}

const withoutGuard = (file) => {
  const lf = file.replace(/\r\n/g, '\n')
  const out = lf.replace(/-- Refuses to run[\s\S]*?\nend;\n\$\$;\n/, '')
  assert.notEqual(out.length, lf.length, 'guard found and removed')
  return out
}
const HEALTHY = { unguarded: 0, begin: true, save: true, submit: true }

describe('documented health checks for re-run migrations', () => {
  it('both queries are in the document', () => {
    assert.ok(UNGUARDED, 'the "unguarded" query')
    assert.ok(WRAPPERS, 'the voting-wrapper query')
  })

  it('the committed files refuse instead (so these cases need an old copy)', async () => {
    const db = await freshDb()
    for (const [file, re] of [[MIGRATION_SQL, /003 is installed/], [BALLOT_MIGRATION_SQL, /003 is installed/],
      [BALLOT_DOWN_SQL, /003 is installed/], [VOTER_MIGRATION_SQL, /004 is installed/]]) {
      await assert.rejects(db.exec(file), re)
      await db.exec('rollback')
    }
    assert.deepEqual(await health(db), HEALTHY)
  })

  it('a healthy 003 + 004 database passes', async () => {
    assert.deepEqual(await health(await freshDb()), HEALTHY)
  })

  it('re-running an old copy of 002, or of its undo, is caught (save_vote replaced)', async () => {
    for (const rerun of [BALLOT_MIGRATION_SQL, BALLOT_DOWN_SQL].map(withoutGuard)) {
      const db = await freshDb()
      await db.exec(rerun)
      assert.deepEqual(await health(db), { ...HEALTHY, save: false })
    }
  })

  it('re-running an old copy of 001 is caught (begin_ballot replaced)', async () => {
    const db = await freshDb()
    await db.exec(withoutGuard(MIGRATION_SQL))
    assert.equal((await health(db)).begin, false)
  })

  it('re-running an old copy of 003 is caught (16 unguarded), and running 004 again repairs it', async () => {
    const db = await freshDb()
    await db.exec(withoutGuard(BALLOT_MIGRATION_SQL))
    await db.exec(withoutGuard(VOTER_MIGRATION_SQL))
    const h = await health(db)
    assert.equal(h.unguarded, 16)
    assert.equal(h.save, true, '003 puts its save_vote wrapper back')
    await db.exec(SAFEGUARDS_SQL)
    assert.deepEqual(await health(db), HEALTHY)
  })
})
