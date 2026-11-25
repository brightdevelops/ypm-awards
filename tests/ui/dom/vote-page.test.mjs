// Simulated browser: the real voting page (src/pages/Vote.jsx) against a
// test database. Regression tests for "never show a submitted vote without
// the server's confirmation", plus the voter-account messages. Synthetic
// identities only (0815550 0xxx).
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  installDom, startVite, mount, setRpc, waitFor, button, typeInto, text, sleep,
} from './dom-setup.mjs'
import { freshDb, call, sql, login, DEV_SIM_SQL } from '../../db/helpers.mjs'
import { BALLOT } from '../../../src/data/categories.js'

const STORE_KEY = 'ypm-awards-ballot-v1'
const CV = 'draft-2026-11-dev'

let vite
let Vote
let win

before(async () => {
  win = installDom('http://localhost:5173/')
  vite = await startVite()
  Vote = (await vite.ssrLoadModule('/src/pages/Vote.jsx')).default
})
after(async () => {
  await vite?.close()
  await win?.happyDOM.close()
})
beforeEach(() => {
  window.localStorage.clear()
})

// A ballot with every category answered, saved on the server, and this
// "phone" remembering it: the page opens on the review screen.
async function answeredBallot(db, phone, { ballotId = null } = {}) {
  const picks = Object.fromEntries(BALLOT.map((c) => [c.id, c.nominees[0].name]))
  let id = ballotId
  if (!id) {
    const b = await call(db, 'begin_ballot', { p_name: 'Test Voter', p_phone: phone, p_code: null })
    id = b.ballot_id
    for (const c of BALLOT) {
      await call(db, 'save_vote', { p_ballot_id: id, p_category_id: c.id, p_nominee_name: c.nominees[0].name })
    }
  }
  window.localStorage.setItem(STORE_KEY, JSON.stringify({ ballotId: id, picks, unsynced: {}, completed: false }))
  return id
}

const stored = () => JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null')
const submitted = async (db, id) => (await sql(db, `select completed_at from ballots where id = $1`, [id]))[0]?.completed_at ?? null

async function openReview() {
  const view = mount(Vote)
  await waitFor(() => text().includes('Review your votes'), 'review screen')
  return view
}

describe('voting page: submitting (simulated browser)', () => {
  it('shows “Your vote is in” only after the server confirms', async () => {
    const db = await freshDb() // production-marked, every migration
    setRpc(db)
    const id = await answeredBallot(db, '08155500901')
    const view = await openReview()
    try {
      button('Submit my votes').click()
      await waitFor(() => text().includes('Your vote is in'), 'done screen')
      assert.equal(stored().completed, true)
      assert.ok(await submitted(db, id))
    } finally {
      view.unmount()
    }
  })

  it('an unknown ballot is NOT shown as submitted', async () => {
    const db = await freshDb()
    setRpc(db)
    await answeredBallot(db, '08155500902', { ballotId: '6f1c2d3e-0000-4000-8000-000000000001' })
    const view = await openReview()
    try {
      button('Submit my votes').click()
      await waitFor(() => /has not been submitted/.test(text()), 'not-submitted message')
      await sleep(100)
      assert.ok(!text().includes('Your vote is in'))
      assert.equal(stored().completed, false)
      assert.ok(document.querySelector('.error[role=alert]'), 'announced to screen readers')
    } finally {
      view.unmount()
    }
  })

  it('no reply: not shown as submitted; tapping Submit again works, once', async () => {
    const db = await freshDb()
    let drop = true
    setRpc(db, (fn) => {
      if (fn === 'submit_ballot' && drop) {
        drop = false
        return { data: null, error: { message: 'TypeError: Failed to fetch' } }
      }
      return undefined
    })
    const id = await answeredBallot(db, '08155500903')
    const view = await openReview()
    try {
      button('Submit my votes').click()
      await waitFor(() => text().includes('Could not submit'), 'connection message')
      assert.ok(!text().includes('Your vote is in'))
      assert.equal(stored().completed, false)
      assert.equal(await submitted(db, id), null)

      button('Submit my votes').click()
      await waitFor(() => text().includes('Your vote is in'), 'done after retry')
      assert.ok(await submitted(db, id))
      assert.equal(Number((await sql(db, `select count(*) n from ballots where voter_phone = '08155500903'`))[0].n), 1)
    } finally {
      view.unmount()
    }
  })

  it('a reply the page doesn’t recognise is not treated as success', async () => {
    const db = await freshDb()
    setRpc(db, (fn) => (fn === 'submit_ballot' ? { data: { status: 'something_new' }, error: null } : undefined))
    await answeredBallot(db, '08155500904')
    const view = await openReview()
    try {
      button('Submit my votes').click()
      await waitFor(() => /couldn’t confirm that your vote was submitted/.test(text()), 'unconfirmed message')
      assert.ok(!text().includes('Your vote is in'))
      assert.equal(stored().completed, false)
    } finally {
      view.unmount()
    }
  })
})

describe('voting page: voter accounts (simulated browser)', () => {
  async function devDb() {
    const db = await freshDb()
    await sql(db, `update ypm_private.deployment set environment = 'development'`)
    await sql(db, `update settings set verification_provider = 'simulated', registration_mode = 'optional' where id = 1`)
    await db.exec(DEV_SIM_SQL)
    return { db, s: await login(db) }
  }

  async function start(name, phone) {
    const view = mount(Vote)
    await waitFor(() => text().includes('Cast your vote'), 'start screen')
    typeInto(document.querySelector('input[placeholder="Full name"]'), name)
    typeInto(document.querySelector('input[placeholder="08012345678"]'), phone)
    await sleep(20)
    button('Start voting').click()
    return view
  }

  it('a new number still starts an anonymous ballot as before', async () => {
    const db = await freshDb()
    setRpc(db)
    const view = await start('Test Anonymous', '08155500910')
    try {
      await waitFor(() => text().includes(BALLOT[0].name), 'first category')
      assert.ok(stored().ballotId)
    } finally {
      view.unmount()
    }
  })

  it('a registered number is told to see a youth leader', async () => {
    const { db, s } = await devDb()
    await call(db, 'admin_register_voter', {
      p_session: s, p_name: 'Test Registered', p_phone: '08155500911', p_consent_version: CV,
      p_adult_confirmed: true, p_link_existing_ballot: false,
    })
    setRpc(db)
    const view = await start('Test Registered', '08155500911')
    try {
      await waitFor(() => text().includes('registered for a voter account'), 'registered message')
      assert.equal(stored(), null)
    } finally {
      view.unmount()
    }
  })

  it('with registration required, a new number is told to register', async () => {
    const { db, s } = await devDb()
    await call(db, 'admin_set_registration_mode', { p_session: s, p_mode: 'required' })
    setRpc(db)
    const view = await start('Test Unregistered', '08155500912')
    try {
      await waitFor(() => text().includes('Voting now needs a registered voter account'), 'required message')
    } finally {
      view.unmount()
    }
  })

  it('a ballot linked to an account by a youth leader stops saving and says why', async () => {
    const { db, s } = await devDb()
    setRpc(db)
    const view = await start('Test Linked', '08155500913')
    try {
      await waitFor(() => text().includes(BALLOT[0].name), 'first category')
      // A youth leader registers this number in person and links the ballot.
      const r = await call(db, 'admin_register_voter', {
        p_session: s, p_name: 'Test Linked', p_phone: '08155500913', p_consent_version: CV,
        p_adult_confirmed: true, p_link_existing_ballot: true,
      })
      assert.equal(r.linked_ballot, true)
      document.querySelector('button.nominee').click()
      await waitFor(() => text().includes('Please see a youth leader'), 'account screen')
      await sleep(400) // past the page's auto-advance
      assert.ok(text().includes('Please see a youth leader'))
    } finally {
      view.unmount()
    }
  })
})
