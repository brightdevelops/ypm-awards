// Simulated browser: the voting page with self-registration (migration 008).
// Synthetic identities only (0815550 0xxx).
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { installDom, startVite, mount, setRpc, waitFor, button, typeInto, text } from './dom-setup.mjs'
import { freshDb, call, sql } from '../../db/helpers.mjs'

const STORE_KEY = 'ypm-awards-ballot-v1'
let vite, Vote, win

before(async () => {
  win = installDom('http://localhost:5173/')
  vite = await startVite()
  Vote = (await vite.ssrLoadModule('/src/pages/Vote.jsx')).default
})
after(async () => {
  await vite?.close()
  await win?.happyDOM.close()
})
beforeEach(() => window.localStorage.clear())

const stored = () => JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null')

async function start(name, phone) {
  const view = mount(Vote)
  await waitFor(() => text().includes('Cast your vote'), 'start screen')
  const [n, p] = document.querySelectorAll('.inner form input')
  typeInto(n, name)
  typeInto(p, phone)
  button('Start voting').click()
  return view
}

describe('voting page: self-registration (simulated browser)', () => {
  it('starts the ballot straight away and shows the voter code once', async () => {
    const db = await freshDb({ migrate: '008' })
    setRpc(db)
    const view = await start('Test Selfreg', '08155500951')
    try {
      await waitFor(() => text().includes('Your voter code'), 'voter code')
      const code = document.querySelector('.voterCode').textContent.trim()
      assert.match(code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/)
      const [row] = await sql(db, `select c.code_hash from voting_codes c join ballots b on b.voting_code_id = c.id
                                    where b.voter_phone = '08155500951'`)
      assert.equal(row.code_hash, createHash('sha256').update(code.replace('-', '')).digest('hex'))
      assert.equal(stored().voterCode, code, 'kept with the ballot on this device')
      // The same voter on another device: the code (with the number) reopens it.
      const r = await call(db, 'begin_ballot', { p_name: 'Test Selfreg', p_phone: '08155500951', p_code: code })
      assert.equal(r.status, 'resumed')
    } finally {
      view.unmount()
    }
  })

  it('on a database without 008 (Production today) it works exactly as before, with no code box', async () => {
    const db = await freshDb({ migrate: '002' })
    setRpc(db)
    const view = await start('Test Before008', '08155500954')
    try {
      await waitFor(() => text().includes('Choose one'), 'ballot')
      assert.ok(!text().includes('Your voter code'))
      assert.equal(stored().voterCode, null)
      assert.equal((await sql(db, `select count(*)::int n from ballots where voter_phone = '08155500954'`))[0].n, 1)
    } finally {
      view.unmount()
    }
  })

  it('explains a busy network and offers a way through', async () => {
    const db = await freshDb({ migrate: '008' })
    setRpc(db, (fn) => (fn === 'begin_ballot' ? { data: { status: 'rate_limited', reason: 'network' }, error: null } : undefined))
    const view = await start('Test Busy', '08155500952')
    try {
      await waitFor(() => /from this network/.test(text()), 'network message')
      assert.match(text(), /ask a youth leader for a voting code/)
      assert.equal(stored(), null, 'nothing started')
    } finally {
      view.unmount()
    }
  })

  it('a leader-issued code shows no voter code (the voter already has one)', async () => {
    const db = await freshDb({ migrate: '008' })
    setRpc(db)
    const view = mount(Vote)
    try {
      await waitFor(() => text().includes('Cast your vote'), 'start screen')
      button('I have a voting code').click()
      await waitFor(() => document.querySelectorAll('.inner form input').length === 3, 'code field')
      const session = (await call(db, 'admin_login', { p_key: 'change-this-leader-key' })).session
      const [c] = (await call(db, 'admin_issue_codes', { p_session: session, p_count: 1, p_phone: '08155500953' })).codes
      const [n, p, k] = document.querySelectorAll('.inner form input')
      typeInto(n, 'Test Leader Code')
      typeInto(p, '08155500953')
      typeInto(k, c.code)
      button('Start voting').click()
      await waitFor(() => text().includes('Choose one'), 'ballot')
      assert.ok(!text().includes('Your voter code'))
    } finally {
      view.unmount()
    }
  })
})
