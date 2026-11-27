// The admin "Voting codes" tab: helpers in src/lib/codes.js, checked on
// their own and against real admin_dashboard / admin_list_codes responses.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  LIST_LIMIT,
  codeStats,
  codesToCsv,
  codesToText,
  csvFileName,
  expiryHours,
  filterCodes,
  maskPhone,
  paginate,
} from '../../src/lib/codes.js'
import { freshDb, call, sql, login, issue } from '../db/helpers.mjs'

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
const code = (state, extra = {}) => ({ id: Math.random().toString(36), state, ...extra })

describe('maskPhone', () => {
  it('shows only the last four digits', () => {
    assert.equal(maskPhone('08031234567'), '•••• 4567')
    assert.equal(maskPhone('+234 803 123 4567'), '•••• 4567')
    assert.equal(maskPhone('123'), '••••')
    assert.equal(maskPhone(null), '')
    assert.equal(maskPhone(''), '')
  })
})

describe('codeStats', () => {
  it('uses the list when it holds every code, and the states add up', () => {
    const list = [
      code('available'), code('available'), code('used'), code('expired'), code('revoked'),
    ]
    const s = codeStats({ issued: 5, redeemed: 2, revoked: 1, available: 2 }, list)
    assert.equal(s.complete, true)
    assert.equal(s.inSync, true)
    assert.deepEqual([s.available, s.used, s.expired, s.revoked], [2, 1, 1, 1])
    assert.equal(s.available + s.used + s.expired + s.revoked, s.total)
    assert.equal(s.total, 5)
  })

  it('flags totals and list that disagree (loaded at different moments)', () => {
    const s = codeStats({ issued: 3, redeemed: 0, revoked: 0, available: 3 }, [code('available')])
    assert.equal(s.complete, true)
    assert.equal(s.inSync, false)
  })

  it('gives only exact figures when the list was cut off', () => {
    const list = Array.from({ length: LIST_LIMIT }, (_, i) => code(i < 400 ? 'available' : 'used'))
    const s = codeStats({ issued: 620, redeemed: 150, revoked: 20, available: 430 }, list)
    assert.equal(s.complete, false)
    assert.equal(s.total, 620)
    assert.equal(s.available, 430)
    assert.equal(s.revoked, 20)
    assert.equal(s.used, null)
    assert.equal(s.expired, null)
    assert.equal(s.usedOrExpired, 170)
    assert.equal(s.available + s.usedOrExpired + s.revoked, s.total)
    assert.deepEqual(s.inList, { available: 400, used: 100, expired: 0, revoked: 0 })
  })

  it('treats exactly LIST_LIMIT codes as complete', () => {
    const list = Array.from({ length: LIST_LIMIT }, () => code('available'))
    const s = codeStats({ issued: LIST_LIMIT, revoked: 0, available: LIST_LIMIT }, list)
    assert.equal(s.complete, true)
  })

  it('handles no codes', () => {
    const s = codeStats({ issued: 0, redeemed: 0, revoked: 0, available: 0 }, [])
    assert.equal(s.total, 0)
    assert.equal(s.complete, true)
  })
})

describe('filterCodes and paginate', () => {
  const list = [
    code('available', { note: 'Sunday batch', created_by: 'leader' }),
    code('used', { note: 'Lost phone', phone: '08031234567', voter_name: 'Ada Obi', created_by: 'inventor' }),
    code('revoked', { note: 'Old', phone: '08099994567', created_by: 'leader' }),
  ]

  it('filters by state and searches text', () => {
    assert.equal(filterCodes(list, { state: 'used' }).length, 1)
    assert.equal(filterCodes(list, { query: 'sunday' }).length, 1)
    assert.equal(filterCodes(list, { query: 'ada' }).length, 1)
    assert.equal(filterCodes(list, { query: 'INVENTOR' }).length, 1)
    assert.equal(filterCodes(list, { state: 'available', query: 'lost' }).length, 0)
  })

  it('matches phone numbers on their ending only', () => {
    assert.equal(filterCodes(list, { query: '4567' }).length, 2)
    assert.equal(filterCodes(list, { query: '1234567' }).length, 1)
    assert.equal(filterCodes(list, { query: '0803' }).length, 0)
  })

  it('pages and clamps', () => {
    const items = Array.from({ length: 51 }, (_, i) => i)
    assert.deepEqual(paginate(items, 1, 25).items.length, 25)
    assert.equal(paginate(items, 3, 25).items.length, 1)
    assert.equal(paginate(items, 9, 25).page, 3)
    assert.equal(paginate([], 1, 25).pages, 1)
  })
})

describe('expiryHours', () => {
  const now = new Date('2026-11-25T12:00:00')
  it('maps presets', () => {
    assert.deepEqual(expiryHours('none'), { hours: null })
    assert.deepEqual(expiryHours('24h'), { hours: 24 })
    assert.deepEqual(expiryHours('7d'), { hours: 168 })
    assert.deepEqual(expiryHours('30d'), { hours: 720 })
  })
  it('keeps a picked date within the server limits', () => {
    assert.deepEqual(expiryHours('custom', '2026-11-26T12:00', now), { hours: 24 })
    assert.deepEqual(expiryHours('custom', '2026-11-25T12:30', now), { hours: 1 })
    assert.ok(expiryHours('custom', '2026-11-25T11:00', now).error)
    assert.ok(expiryHours('custom', '2027-02-01T12:00', now).error)
    assert.ok(expiryHours('custom', '', now).error)
    assert.ok(expiryHours('custom', 'nonsense', now).error)
  })
})

describe('CSV export', () => {
  it('quotes, masks phones and defuses spreadsheet formulas', () => {
    const csv = codesToCsv([
      { code: 'ABCDE-FGHJK', note: '=HYPERLINK("x")', phone: null, expires_at: null },
      { code: 'MNPQR-STUVW', note: 'Lost "phone"', phone: '08031234567', expires_at: '2026-12-01T10:00:00Z' },
    ])
    assert.ok(csv.startsWith('﻿"code","restriction","note","expires"\r\n'))
    assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`))
    assert.ok(csv.includes('"Lost ""phone"""'))
    assert.ok(csv.includes('Only phone •••• 4567'))
    assert.ok(!csv.includes('0803123'))
    assert.ok(csv.includes('"Never"'))
    assert.equal(csv.trim().split('\r\n').length, 3)
  })

  it('names the file without personal details', () => {
    assert.equal(
      csvFileName('Sunday Batch #2', new Date('2026-11-25T09:05:00')),
      'ypm-voting-codes-sunday-batch-2-20261125-0905.csv',
    )
    assert.match(csvFileName('', new Date()), /^ypm-voting-codes-codes-/)
  })
})

describe('against real RPC responses', () => {
  it('counts every state exactly once and matches the database', async () => {
    const db = await freshDb()
    const s = await login(db)

    const open = await issue(db, s, { count: 5, note: 'Sunday' })
    const [bound] = await issue(db, s, { phone: '08033334444', note: 'Lost phone', expiresHours: 1 })

    // used
    await call(db, 'begin_ballot', { p_name: 'Voter A', p_phone: '08100000001', p_code: open[0].code })
    // used, then revoked: the server's "redeemed" and "revoked" both count it
    await call(db, 'begin_ballot', { p_name: 'Voter B', p_phone: '08100000002', p_code: open[1].code })
    await call(db, 'admin_revoke_code', { p_session: s, p_code_id: open[1].id })
    // revoked while available
    await call(db, 'admin_revoke_code', { p_session: s, p_code_id: open[2].id })
    // expired
    await sql(db, `update voting_codes set expires_at = now() - interval '1 minute' where id = $1`, [bound.id])

    const dash = await call(db, 'admin_dashboard', { p_session: s })
    const listed = await call(db, 'admin_list_codes', { p_session: s })
    const stats = codeStats(dash.codes, listed.codes)

    assert.equal(stats.complete, true)
    assert.equal(stats.inSync, true)
    assert.deepEqual(
      { total: stats.total, available: stats.available, used: stats.used, expired: stats.expired, revoked: stats.revoked },
      { total: 6, available: 2, used: 1, expired: 1, revoked: 2 },
    )
    assert.equal(stats.available + stats.used + stats.expired + stats.revoked, dash.codes.issued)
    // Why the server's "redeemed" isn't shown: it overlaps "revoked".
    assert.equal(dash.codes.redeemed, 2)

    // Independent check, straight from the table.
    const [truth] = await sql(db, `
      select count(*) filter (where revoked_at is not null)::int as revoked,
             count(*) filter (where revoked_at is null and redeemed_at is not null)::int as used,
             count(*) filter (where revoked_at is null and redeemed_at is null
                              and expires_at is not null and expires_at <= now())::int as expired,
             count(*) filter (where revoked_at is null and redeemed_at is null
                              and (expires_at is null or expires_at > now()))::int as available
        from voting_codes`)
    assert.deepEqual(truth, { revoked: 2, used: 1, expired: 1, available: 2 })

    // The list never carries a code, and phone search uses the ending only.
    for (const c of listed.codes) {
      assert.equal(c.code, undefined)
      assert.equal(c.code_hash, undefined)
    }
    assert.equal(filterCodes(listed.codes, { query: '4444' }).length, 1)
    assert.equal(filterCodes(listed.codes, { query: '0803' }).length, 0)
    assert.equal(filterCodes(listed.codes, { query: 'Voter A' })[0].state, 'used')

    // Exports from a real issue response: codes in, full phone out.
    const csv = codesToCsv([bound, ...open])
    for (const c of open) assert.ok(csv.includes(c.code))
    assert.ok(!csv.includes('08033334444') && !csv.includes('0803333'))
    assert.equal(codesToText(open).split('\n').length, 5)
  })

  it('reports exact totals, not list counts, past the 500-code limit', async () => {
    const db = await freshDb()
    const s = await login(db)
    const all = [
      ...(await issue(db, s, { count: 200, note: 'A' })),
      ...(await issue(db, s, { count: 200, note: 'B' })),
      ...(await issue(db, s, { count: 105, note: 'C' })),
    ]
    await call(db, 'begin_ballot', { p_name: 'V', p_phone: '08100000009', p_code: all[0].code })
    await call(db, 'admin_revoke_code', { p_session: s, p_code_id: all[1].id })
    await call(db, 'admin_revoke_code', { p_session: s, p_code_id: all[2].id })
    await sql(db, `update voting_codes set expires_at = now() - interval '1 minute'
                    where id = any($1::uuid[])`, [[all[3].id, all[4].id, all[5].id]])

    const dash = await call(db, 'admin_dashboard', { p_session: s })
    const listed = await call(db, 'admin_list_codes', { p_session: s })
    assert.equal(listed.codes.length, LIST_LIMIT)

    const stats = codeStats(dash.codes, listed.codes)
    assert.equal(stats.complete, false)
    assert.equal(stats.total, 505)
    assert.equal(stats.available, 499)
    assert.equal(stats.revoked, 2)
    assert.equal(stats.usedOrExpired, 4) // 1 used + 3 expired, exact
    assert.equal(stats.used, null)
    const inList = stats.inList
    assert.equal(inList.available + inList.used + inList.expired + inList.revoked, LIST_LIMIT)
  })
})

describe('plaintext codes stay out of storage and logs', () => {
  const files = [
    'src/pages/Admin.jsx',
    'src/lib/codes.js',
    ...readdirSync(root('src/components/admin')).map((f) => `src/components/admin/${f}`),
  ]

  it('no console logging or localStorage in the admin code', () => {
    for (const f of files) {
      const src = readFileSync(root(f), 'utf8')
      assert.ok(!/console\./.test(src), `${f} logs to the console`)
      assert.ok(!/localStorage/.test(src), `${f} uses localStorage`)
    }
  })

  it('only Admin.jsx touches sessionStorage, for the session and tab only', () => {
    for (const f of files.filter((x) => x !== 'src/pages/Admin.jsx')) {
      assert.ok(!/sessionStorage/.test(readFileSync(root(f), 'utf8')), `${f} uses sessionStorage`)
    }
    const admin = readFileSync(root('src/pages/Admin.jsx'), 'utf8')
    const keys = [...admin.matchAll(/sessionStorage\.(?:set|get)Item\(([^,)]+)/g)].map((m) => m[1].trim())
    for (const k of keys) {
      assert.ok(['SESSION_STORE', 'EXPIRES_STORE', 'TAB_STORE'].includes(k), `unexpected key ${k}`)
    }
  })
})
