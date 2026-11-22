// The results dashboard's tally logic (src/lib/tally.js): historical votes
// are shown as recorded and kept out of current rankings.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildResults } from '../../src/lib/tally.js'
import { BALLOT } from '../../src/data/categories.js'
import {
  freshDb, call, sql, login,
  MIGRATION_SQL, BALLOT_MIGRATION_SQL, BALLOT_SYNC_SQL,
} from '../db/helpers.mjs'

const BALLOT_FIXTURE = [
  { id: 'consistency', name: 'Consistency Award',
    nominees: [{ name: 'Nora Oboh' }, { name: 'Blessing Ukuoha' }, { name: 'Ebenezer Obi' }] },
  { id: 'best-instrumentalist', name: 'Best Instrumentalist',
    nominees: [{ name: 'Raphael Tosin' }, { name: 'Goodnews Ewomazino' }] },
]
const row = (category_id, nominee_name, votes) => ({ category_id, nominee_name, votes })

function deepFreeze(o) {
  Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v))
  return Object.freeze(o)
}

describe('buildResults', () => {
  it('counts current nominees in ballot order, including those with no votes', () => {
    const r = buildResults(BALLOT_FIXTURE, [row('consistency', 'Ebenezer Obi', 3), row('consistency', 'Nora Oboh', 1)])
    const c = r.categories[0]
    assert.deepEqual(c.nominees.map((n) => [n.name, n.votes]),
      [['Nora Oboh', 1], ['Blessing Ukuoha', 0], ['Ebenezer Obi', 3]])
    assert.equal(c.currentVotes, 4)
    assert.equal(c.nominees[2].share, 75)
    assert.equal(c.nominees[2].leading, true)
    assert.deepEqual(r.categories[1].nominees.map((n) => n.votes), [0, 0])
    assert.equal(r.categories[1].nominees.some((n) => n.leading), false)
  })

  it('shows a renamed nominee under the original name, never merged', () => {
    const r = buildResults(BALLOT_FIXTURE, [
      row('consistency', 'Nora Oboh', 2),
      row('consistency', 'Norah Oboh', 5), // original spelling
    ])
    const c = r.categories[0]
    assert.equal(c.nominees.find((n) => n.name === 'Nora Oboh').votes, 2)
    assert.deepEqual(c.historical, [{ name: 'Norah Oboh', votes: 5 }])
    assert.equal(c.historicalVotes, 5)
    assert.equal(c.currentVotes, 2)
  })

  it('keeps historical votes out of rankings, percentages and ties', () => {
    const r = buildResults(BALLOT_FIXTURE, [
      row('best-instrumentalist', 'Raphael Tosin', 4),
      row('best-instrumentalist', 'Goodnews Ewomazino', 2),
      row('best-instrumentalist', 'Ewomazino', 9), // more than anyone current
      row('best-instrumentalist', 'Someone Else', 4), // equals the current leader
    ])
    const c = r.categories[1]
    assert.equal(c.currentVotes, 6)
    assert.equal(c.tie, false)
    const [raphael, goodnews] = c.nominees
    assert.equal(raphael.leading, true)
    assert.equal(goodnews.leading, false)
    assert.equal(Math.round(raphael.share), 67)
    assert.equal(Math.round(raphael.share + goodnews.share), 100)
    assert.deepEqual(c.historical, [{ name: 'Ewomazino', votes: 9 }, { name: 'Someone Else', votes: 4 }])
  })

  it('reports a tie between current nominees only', () => {
    const r = buildResults(BALLOT_FIXTURE, [
      row('consistency', 'Nora Oboh', 3),
      row('consistency', 'Ebenezer Obi', 3),
    ])
    assert.equal(r.categories[0].tie, true)
    assert.equal(r.categories[0].nominees.some((n) => n.leading), false)
  })

  it('lists removed categories separately, as recorded, unranked', () => {
    const r = buildResults(BALLOT_FIXTURE, [
      row('humility', 'Kunle Salami', 2),
      row('humility', 'Ebenezer Obi', 5),
      row('youth-leader', 'Queen Solomon', 1),
    ])
    assert.deepEqual(r.removedCategories, [
      { id: 'humility', votes: 7,
        nominees: [{ name: 'Ebenezer Obi', votes: 5 }, { name: 'Kunle Salami', votes: 2 }] },
      { id: 'youth-leader', votes: 1, nominees: [{ name: 'Queen Solomon', votes: 1 }] },
    ])
    for (const rc of r.removedCategories) {
      for (const n of rc.nominees) assert.deepEqual(Object.keys(n), ['name', 'votes'])
    }
    // a removed category's votes don't leak into a current one with the same nominee
    assert.equal(r.categories[0].nominees.find((n) => n.name === 'Ebenezer Obi').votes, 0)
  })

  it('accounts for every vote exactly once in the totals', () => {
    const rows = [
      row('consistency', 'Nora Oboh', 2), row('consistency', 'Norah Oboh', 3),
      row('best-instrumentalist', 'Raphael Tosin', 4), row('humility', 'Kunle Salami', 6),
    ]
    const { totals } = buildResults(BALLOT_FIXTURE, rows)
    assert.deepEqual(totals, { current: 6, historicalInCurrentCategories: 3, inRemovedCategories: 6, all: 15 })
    assert.equal(totals.all, rows.reduce((s, r) => s + r.votes, 0))
  })

  it('matches names exactly: case and spacing differences stay separate', () => {
    const r = buildResults(BALLOT_FIXTURE, [
      row('consistency', 'nora oboh', 1),
      row('consistency', 'Nora  Oboh', 1),
    ])
    assert.equal(r.categories[0].currentVotes, 0)
    assert.deepEqual(r.categories[0].historical.map((h) => h.name).sort(), ['Nora  Oboh', 'nora oboh'])
  })

  it('handles an empty tally and string counts, and never changes its inputs', () => {
    assert.equal(buildResults(BALLOT_FIXTURE, []).totals.all, 0)
    assert.equal(buildResults(BALLOT_FIXTURE, null).totals.all, 0)
    const ballot = deepFreeze(structuredClone(BALLOT_FIXTURE))
    const rows = deepFreeze([row('consistency', 'Nora Oboh', '2'), row('humility', 'X', '1')])
    const r = buildResults(ballot, rows) // would throw if it wrote to a frozen input
    assert.equal(r.categories[0].currentVotes, 2)
    assert.equal(r.totals.all, 3)
  })
})

describe('dashboard with historical votes in the database', () => {
  it('shows pre-change votes as recorded, without altering any record', async () => {
    // Production before migrating: votes from the original 20 Nov ballot.
    const db = await freshDb({ migrate: false })
    const start = await call(db, 'start_ballot', { p_name: 'Early Voter', p_phone: '08601234567' })
    for (const [cat, name] of [
      ['consistency', 'Norah Oboh'],          // renamed since
      ['consistency', 'Nora Oboh'],           // overwrites the pick above (one per category)
      ['best-instrumentalist', 'Ewomazino'],  // renamed since
      ['humility', 'Kunle Salami'],           // category removed since
    ]) {
      await call(db, 'save_vote', { p_ballot_id: start.ballot_id, p_category_id: cat, p_nominee_name: name })
    }
    const second = await call(db, 'start_ballot', { p_name: 'Second', p_phone: '08601234568' })
    await call(db, 'save_vote', { p_ballot_id: second.ballot_id, p_category_id: 'consistency', p_nominee_name: 'Norah Oboh' })
    for (const b of [start, second]) await call(db, 'submit_ballot', { p_ballot_id: b.ballot_id })

    await db.exec(MIGRATION_SQL)
    await db.exec(BALLOT_MIGRATION_SQL)
    await db.exec(BALLOT_SYNC_SQL)

    const snapshot = () => sql(db, `select * from votes order by id`)
    const votesBefore = await snapshot()
    const catsBefore = await sql(db, `select * from ballot_categories order by id`)

    const dash = await call(db, 'admin_dashboard', { p_session: await login(db) })
    const r = buildResults(BALLOT, dash.tally)

    const consistency = r.categories.find((c) => c.id === 'consistency')
    assert.equal(consistency.nominees.find((n) => n.name === 'Nora Oboh').votes, 1)
    assert.deepEqual(consistency.historical, [{ name: 'Norah Oboh', votes: 1 }])

    const instr = r.categories.find((c) => c.id === 'best-instrumentalist')
    assert.equal(instr.currentVotes, 0)
    assert.equal(instr.nominees.some((n) => n.leading), false)
    assert.deepEqual(instr.historical, [{ name: 'Ewomazino', votes: 1 }])

    assert.deepEqual(r.removedCategories, [
      { id: 'humility', votes: 1, nominees: [{ name: 'Kunle Salami', votes: 1 }] },
    ])
    // The seeded legacy ballot's 'Someone' vote (submitted) is historical too.
    const reliable = r.categories.find((c) => c.id === 'most-reliable-youth')
    assert.deepEqual(reliable.historical, [{ name: 'Someone', votes: 1 }])

    assert.equal(r.totals.all, dash.tally.reduce((s, t) => s + Number(t.votes), 0))

    // Nothing was changed by reading the dashboard.
    assert.deepEqual(await snapshot(), votesBefore)
    assert.deepEqual(await sql(db, `select * from ballot_categories order by id`), catsBefore)
  })
})
