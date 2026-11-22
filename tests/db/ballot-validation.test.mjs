import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import {
  freshDb, call, sql, login, issue, LEGACY,
  BALLOT_MIGRATION_SQL, BALLOT_DOWN_SQL, BALLOT_SYNC_SQL,
} from './helpers.mjs'
import { BALLOT } from '../../src/data/categories.js'
import { ballotSql } from '../../scripts/ballot-sql.mjs'

const vote = (db, ballotId, categoryId, nomineeName) =>
  call(db, 'save_vote', {
    p_ballot_id: ballotId, p_category_id: categoryId, p_nominee_name: nomineeName,
  })

const INVALID = { status: 'error', reason: 'invalid_choice', message: 'not a nominee in this category' }

describe('the database ballot matches categories.js', () => {
  let db
  before(async () => {
    db = await freshDb()
  })

  it('ballot-sync.sql is up to date (run `npm run ballot:sql` if this fails)', () => {
    assert.equal(BALLOT_SYNC_SQL.replace(/\r\n/g, '\n'), ballotSql(BALLOT))
  })

  it('has exactly the categories and nominees on the voting page', async () => {
    const cats = await sql(db, `select id, name, section from ballot_categories where active order by position`)
    assert.deepEqual(cats, BALLOT.map((c) => ({ id: c.id, name: c.name, section: c.section })))
    const noms = await sql(db, `select category_id, name from ballot_nominees where active
                                order by category_id, position`)
    const expected = BALLOT.flatMap((c) => c.nominees.map((n) => ({ category_id: c.id, name: n.name })))
      .sort((a, b) => a.category_id.localeCompare(b.category_id))
    assert.deepEqual(noms, expected)
  })

  it('accepts every real nominee in its own category', async () => {
    const s = await call(db, 'begin_ballot', { p_name: 'Full', p_phone: '08400000001' })
    for (const c of BALLOT) {
      for (const n of c.nominees) {
        assert.deepEqual(await vote(db, s.ballot_id, c.id, n.name), { status: 'ok' }, `${c.id} / ${n.name}`)
      }
    }
    assert.equal((await sql(db, `select count(*)::int n from votes where ballot_id = $1`, [s.ballot_id]))[0].n,
      BALLOT.length)
  })
})

describe('save_vote rejects manipulated requests', () => {
  let db, ballotId
  before(async () => {
    db = await freshDb()
    ballotId = (await call(db, 'begin_ballot', { p_name: 'Tester', p_phone: '08400000002' })).ballot_id
  })

  const votesFor = async (id) =>
    (await sql(db, `select category_id, nominee_name from votes where ballot_id = $1 order by category_id`, [id]))

  it('rejects a category that does not exist', async () => {
    assert.deepEqual(await vote(db, ballotId, 'best-hacker', 'Peace Williams'), INVALID)
    assert.deepEqual(await vote(db, ballotId, 'youth-personality', 'Peace Williams'), INVALID) // not yet on the ballot
  })

  it('rejects a nominee that does not exist', async () => {
    assert.deepEqual(await vote(db, ballotId, 'most-reliable-youth', 'Made Up Person'), INVALID)
  })

  it('rejects a real nominee in a category they are not nominated in', async () => {
    // Peace Williams is a nominee, but not for Best Male Vocalist.
    assert.deepEqual(await vote(db, ballotId, 'best-male-vocalist', 'Peace Williams'), INVALID)
  })

  it('rejects near-misses: case, spacing, lookalikes', async () => {
    for (const name of ['peace williams', 'PEACE WILLIAMS', ' Peace Williams', 'Peace Williams ',
                        'Peace  Williams', 'Peace Wiliams', 'Peace Williams']) {
      assert.deepEqual(await vote(db, ballotId, 'most-reliable-youth', name), INVALID, JSON.stringify(name))
    }
    assert.deepEqual(await vote(db, ballotId, 'Most-Reliable-Youth', 'Peace Williams'), INVALID)
  })

  it('rejects empty, null and oversized values', async () => {
    assert.deepEqual(await vote(db, ballotId, 'most-reliable-youth', ''), INVALID)
    assert.deepEqual(await vote(db, ballotId, 'most-reliable-youth', null), INVALID)
    assert.deepEqual(await vote(db, ballotId, null, 'Peace Williams'), INVALID)
    assert.deepEqual(await vote(db, ballotId, 'most-reliable-youth', 'x'.repeat(100000)), INVALID)
  })

  it('treats SQL in the values as plain text', async () => {
    for (const name of ["'; delete from votes; --", "Peace Williams' or '1'='1", 'Peace Williams"); drop table votes; --']) {
      assert.deepEqual(await vote(db, ballotId, 'most-reliable-youth', name), INVALID)
    }
    assert.ok((await sql(db, `select count(*)::int n from votes`))[0].n > 0)
  })

  it('stored none of the rejected votes', async () => {
    assert.deepEqual(await votesFor(ballotId), [])
  })

  it('keeps a valid pick when a later change of mind is invalid', async () => {
    assert.deepEqual(await vote(db, ballotId, 'most-reliable-youth', 'Sarah Bakare'), { status: 'ok' })
    assert.deepEqual(await vote(db, ballotId, 'most-reliable-youth', 'Made Up Person'), INVALID)
    assert.deepEqual(await votesFor(ballotId), [{ category_id: 'most-reliable-youth', nominee_name: 'Sarah Bakare' }])
  })

  it('rejects votes on an unknown ballot id', async () => {
    const r = await vote(db, '00000000-0000-4000-8000-000000000000', 'most-reliable-youth', 'Peace Williams')
    assert.equal(r.message, 'unknown ballot')
  })

  it('rejects changes to a submitted ballot, valid or not', async () => {
    assert.equal((await vote(db, LEGACY.done.ballotId, 'consistency', 'Nora Oboh')).message, 'already submitted')
    assert.equal((await vote(db, LEGACY.done.ballotId, 'consistency', 'Made Up')).message, 'already submitted')
  })

  it('rejects everything while voting is closed', async () => {
    await sql(db, `update settings set voting_open = false`)
    assert.deepEqual(await vote(db, ballotId, 'consistency', 'Nora Oboh'), { status: 'closed' })
    await sql(db, `update settings set voting_open = true`)
  })

  it('does not let the browser write votes or edit the ballot directly', async () => {
    await db.exec('set role anon')
    try {
      // votes: Supabase grants it, RLS blocks it
      await assert.rejects(
        db.query(`insert into votes (ballot_id, category_id, nominee_name) values ($1, 'consistency', 'Nora Oboh')`,
          [ballotId]),
        /row-level security/
      )
      for (const t of ['ballot_categories', 'ballot_nominees']) {
        await assert.rejects(db.query(`select * from ${t}`), /permission denied/)
        await assert.rejects(db.query(`update ${t} set active = true`), /permission denied/)
      }
    } finally {
      await db.exec('reset role')
    }
  })

  it('blocks invalid votes at the table too, whatever the path', async () => {
    await assert.rejects(
      sql(db, `insert into votes (ballot_id, category_id, nominee_name)
               values ($1, 'best-male-vocalist', 'Peace Williams')`, [ballotId]),
      /votes_nominee_fk/
    )
  })

  it('counts only what was stored in the tally', async () => {
    await call(db, 'submit_ballot', { p_ballot_id: ballotId })
    const t = await call(db, 'admin_dashboard', { p_session: await login(db) })
    const names = new Set(t.tally.map((r) => r.nominee_name))
    for (const bad of ['Made Up Person', "'; delete from votes; --"]) assert.ok(!names.has(bad))
  })
})

describe('ballot edits', () => {
  let db, ballotId
  before(async () => {
    db = await freshDb()
    ballotId = (await call(db, 'begin_ballot', { p_name: 'Editor', p_phone: '08400000003' })).ballot_id
    await vote(db, ballotId, 'most-hilarious', 'Ehis Ighalo')
  })

  it('stops accepting a nominee once removed, and keeps votes already cast', async () => {
    const edited = BALLOT.map((c) =>
      c.id === 'most-hilarious'
        ? { ...c, nominees: c.nominees.filter((n) => n.name !== 'Ehis Ighalo') }
        : c
    )
    await db.exec(ballotSql(edited))
    const other = (await call(db, 'begin_ballot', { p_name: 'Late', p_phone: '08400000004' })).ballot_id
    assert.deepEqual(await vote(db, other, 'most-hilarious', 'Ehis Ighalo'), INVALID)
    assert.deepEqual(
      await sql(db, `select nominee_name from votes where ballot_id = $1`, [ballotId]),
      [{ nominee_name: 'Ehis Ighalo' }]
    )
  })

  it('accepts a newly added category once synced', async () => {
    const added = [
      ...BALLOT,
      {
        id: 'youth-personality', name: 'Youth Personality of the Year', section: 'Special Recognition',
        nominees: [{ name: "Ngozi O'Neil" }, { name: 'Tunde Bello' }],
      },
    ]
    assert.deepEqual(await vote(db, ballotId, 'youth-personality', 'Tunde Bello'), INVALID)
    await db.exec(ballotSql(added))
    assert.deepEqual(await vote(db, ballotId, 'youth-personality', "Ngozi O'Neil"), { status: 'ok' })
  })

  it('refuses to generate a malformed ballot', () => {
    assert.throws(() => ballotSql([{ id: 'Bad Id', name: 'x', section: 's', nominees: [] }]), /bad category id/)
    assert.throws(() => ballotSql([{ id: 'a', name: 'x', section: 's', nominees: [{ name: ' Pad' }] }]), /bad nominee/)
    assert.throws(() => ballotSql([{ id: 'a', name: 'x', section: 's', nominees: [{ name: 'A' }, { name: 'A' }] }]), /duplicate nominee/)
    assert.throws(() => ballotSql([
      { id: 'a', name: 'x', section: 's', nominees: [] },
      { id: 'a', name: 'y', section: 's', nominees: [] },
    ]), /duplicate category/)
  })
})

describe('migration 002 on a live database', () => {
  let db
  before(async () => {
    db = await freshDb({ migrate: '001' })
  })

  it('leaves existing votes alone, including ones not on the current ballot', async () => {
    const before = await sql(db, `select * from votes order by id`)
    await db.exec(BALLOT_MIGRATION_SQL)
    assert.deepEqual(await sql(db, `select * from votes order by id`), before)
    // the seeded legacy votes are for 'Someone', who isn't a nominee
    const orphans = await sql(db, `
      select v.category_id, v.nominee_name, count(*)::int as votes
        from votes v
       where not exists (select 1 from ballot_nominees n
                          where n.category_id = v.category_id and n.name = v.nominee_name)
       group by 1, 2`)
    assert.deepEqual(orphans, [{ category_id: 'most-reliable-youth', nominee_name: 'Someone', votes: 2 }])
  })

  it('lets a pre-002 unfinished ballot carry on with valid picks', async () => {
    const r = await call(db, 'begin_ballot', {
      p_name: LEGACY.open.name, p_phone: LEGACY.open.phone, p_ballot_id: LEGACY.open.ballotId,
    })
    assert.equal(r.status, 'resumed')
    // replacing the orphaned pick with a real one works
    assert.deepEqual(await vote(db, LEGACY.open.ballotId, 'most-reliable-youth', 'Peace Williams'), { status: 'ok' })
    assert.deepEqual(await vote(db, LEGACY.open.ballotId, 'consistency', 'Nora Oboh'), { status: 'ok' })
  })

  it('can be run twice, and never undoes a later ballot sync', async () => {
    await db.exec(BALLOT_SYNC_SQL)
    await sql(db, `update ballot_nominees set active = false where name = 'Bright'`)
    await db.exec(BALLOT_MIGRATION_SQL)
    const [r] = await sql(db, `select active from ballot_nominees where name = 'Bright'`)
    assert.equal(r.active, false)
    assert.equal((await sql(db, `select count(*)::int n from ballot_categories`))[0].n, BALLOT.length)
  })

  it('rolls back cleanly, keeping votes, and can be re-applied', async () => {
    const before = (await sql(db, `select count(*)::int n from votes`))[0].n
    await db.exec(BALLOT_DOWN_SQL)
    assert.equal((await sql(db, `select count(*)::int n from votes`))[0].n, before)
    assert.equal((await sql(db, `select to_regclass('public.ballot_nominees') r`))[0].r, null)
    await db.exec(BALLOT_MIGRATION_SQL)
    const s = (await call(db, 'begin_ballot', { p_name: 'After', p_phone: '08400000005' })).ballot_id
    assert.deepEqual(await vote(db, s, 'consistency', 'Made Up'), INVALID)
    assert.deepEqual(await vote(db, s, 'consistency', 'Nora Oboh'), { status: 'ok' })
  })

  it('does not change the code path for 001 voting codes', async () => {
    const [c] = await issue(db, await login(db))
    const r = await call(db, 'begin_ballot', { p_name: 'Coded', p_phone: '08400000006', p_code: c.code })
    assert.equal(r.status, 'started')
    assert.deepEqual(await vote(db, r.ballot_id, 'consistency', 'Nora Oboh'), { status: 'ok' })
  })
})
