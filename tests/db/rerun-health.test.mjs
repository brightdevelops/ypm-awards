// The read-only health checks in migrations/dev/undo-004-development.md,
// run exactly as written there, against databases where an older migration
// was re-run on top of a newer one. Keeps the documented SQL honest.
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
const HEALTHY = { unguarded: 0, begin: true, save: true, submit: true }

describe('documented health checks for re-run migrations', () => {
  it('both queries are in the document', () => {
    assert.ok(UNGUARDED, 'the "unguarded" query')
    assert.ok(WRAPPERS, 'the voting-wrapper query')
  })

  it('a healthy 003 + 004 database passes', async () => {
    assert.deepEqual(await health(await freshDb()), HEALTHY)
  })

  it('re-running 002, or its undo, is caught (save_vote replaced)', async () => {
    for (const rerun of [BALLOT_MIGRATION_SQL, BALLOT_DOWN_SQL]) {
      const db = await freshDb()
      await db.exec(rerun)
      assert.deepEqual(await health(db), { ...HEALTHY, save: false })
    }
  })

  it('re-running 001 is caught (begin_ballot replaced)', async () => {
    const db = await freshDb()
    await db.exec(MIGRATION_SQL)
    assert.equal((await health(db)).begin, false)
  })

  it('re-running 003 is caught (16 unguarded), and 003 then 004 repairs everything', async () => {
    const db = await freshDb()
    await db.exec(BALLOT_MIGRATION_SQL)
    await db.exec(VOTER_MIGRATION_SQL)
    const h = await health(db)
    assert.equal(h.unguarded, 16)
    assert.equal(h.save, true, '003 puts its save_vote wrapper back')
    await db.exec(SAFEGUARDS_SQL)
    assert.deepEqual(await health(db), HEALTHY)
  })
})
