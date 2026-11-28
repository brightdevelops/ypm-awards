// Migration 009: each new ballot's IP address, shown to admins.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { freshDb, call, sql, login, SELF_REG_SQL } from './helpers.mjs'

const file = (p) => readFileSync(new URL(`../../migrations/${p}`, import.meta.url), 'utf8')
const IP_SQL = file('009_voter_ip.sql')
const IP_DOWN_SQL = file('009_voter_ip.down.sql')

const begin = (db, name, phone, ip) =>
  call(db, 'begin_ballot', { p_name: name, p_phone: phone }, { ip })
const snapshot = (db) => sql(db, `
  select (select json_agg(b order by b.id) from (select id, voter_name, voter_phone, started_at, completed_at, voting_code_id from ballots) b) ballots,
         (select json_agg(v order by v.id) from votes v) votes`)
const dashboard = async (db) => call(db, 'admin_dashboard', { p_session: await login(db) })
const byName = (voters) => Object.fromEntries(voters.map((v) => [v.voter_name, v]))

describe('009 installs safely', () => {
  it('keeps every ballot and vote, and can be run twice', async () => {
    const db = await freshDb({ migrate: '002' })
    const before = await snapshot(db)
    await db.exec(IP_SQL)
    await db.exec(IP_SQL)
    assert.deepEqual(await snapshot(db), before)
  })

  it('refuses a database without 001, and one with voter accounts (003)', async () => {
    await assert.rejects((await freshDb({ migrate: false })).exec(IP_SQL), /Migration 001 is not installed/)
    await assert.rejects((await freshDb({ migrate: true })).exec(IP_SQL), /Migration 003 is installed/)
  })
})

for (const [label, setup] of [
  ['001 + 002', async () => { const db = await freshDb({ migrate: '002' }); await db.exec(IP_SQL); return db }],
  ['with 008 installed first', async () => { const db = await freshDb({ migrate: '008' }); await db.exec(IP_SQL); return db }],
  ['with 008 installed after', async () => { const db = await freshDb({ migrate: '002' }); await db.exec(IP_SQL); await db.exec(SELF_REG_SQL); return db }],
]) {
  describe(`recording IPs (${label})`, () => {
    it('saves the address each new ballot was started from, and admins see who shares one', async () => {
      const db = await setup()
      const oldBallots = (await sql(db, `select count(*)::int n from ballots`))[0].n

      assert.equal((await begin(db, 'Ada One', '08031110001', '198.51.100.20')).status, 'started')
      assert.equal((await begin(db, 'Ada Two', '08031110002', '198.51.100.20')).status, 'started')
      assert.equal((await begin(db, 'Ben Solo', '08031110003', '203.0.113.99')).status, 'started')
      // No readable address: the ballot is still created, just without an IP.
      assert.equal((await begin(db, 'No Header', '08031110004', null)).status, 'started')

      const rows = await sql(db, `select voter_name, voter_ip from ballots where voter_phone like '0803111000%'`)
      assert.deepEqual(Object.fromEntries(rows.map((r) => [r.voter_name, r.voter_ip])), {
        'Ada One': '198.51.100.20', 'Ada Two': '198.51.100.20', 'Ben Solo': '203.0.113.99', 'No Header': null,
      })

      const d = await dashboard(db)
      assert.equal(d.status, 'ok')
      assert.equal(d.voters.length, oldBallots + 4)
      const v = byName(d.voters)
      assert.equal(v['Ada One'].voter_ip, '198.51.100.20')
      assert.equal(v['Ada One'].ip_count, 2)
      assert.equal(v['Ada Two'].ip_count, 2)
      assert.equal(v['Ben Solo'].ip_count, 1)
      assert.equal(v['No Header'].voter_ip, null)
      assert.equal(v['No Header'].ip_count, null)
      // Ballots from before 009 have no IP.
      const legacy = d.voters.filter((x) => !x.voter_name.startsWith('Ada') && !['Ben Solo', 'No Header'].includes(x.voter_name))
      assert.ok(legacy.length > 0 && legacy.every((x) => x.voter_ip === null))
    })

    it('a forged address cannot overwrite a recorded one, and voters never see IPs', async () => {
      const db = await setup()
      const r = await begin(db, 'Cy Voter', '08031110010', '192.0.2.1')
      assert.deepEqual(Object.keys(r).filter((k) => k.includes('ip')), [])
      // Resuming from another address leaves the original IP alone.
      await call(db, 'begin_ballot', { p_name: 'Cy Voter', p_phone: '08031110010', p_ballot_id: r.ballot_id }, { ip: '192.0.2.2' })
      assert.equal((await sql(db, `select voter_ip from ballots where id = $1`, [r.ballot_id]))[0].voter_ip, '192.0.2.1')
      // No session, no voter list.
      assert.equal((await call(db, 'admin_dashboard', { p_session: 'not-a-session' })).status, 'unauthorized')
      await assert.rejects(call(db, 'dashboard_json', { p_label: 'x' }))
    })
  })
}

describe('undoing 009', () => {
  it('stops recording, erases the IPs, restores the dashboard, keeps ballots and votes', async () => {
    const db = await freshDb({ migrate: '002' })
    await db.exec(IP_SQL)
    await begin(db, 'Dee Before', '08031110020', '198.51.100.30')
    const before = await snapshot(db)
    await db.exec(IP_DOWN_SQL)
    await db.exec(IP_DOWN_SQL)
    assert.deepEqual(await snapshot(db), before)
    assert.equal((await sql(db, `select count(*)::int n from ballots where voter_ip is not null`))[0].n, 0)

    assert.equal((await begin(db, 'Eve After', '08031110021', '198.51.100.31')).status, 'started')
    assert.equal((await sql(db, `select voter_ip from ballots where voter_phone = '08031110021'`))[0].voter_ip, null)
    const d = await dashboard(db)
    assert.ok(d.voters.every((v) => !('voter_ip' in v) && !('ip_count' in v)))
  })
})
