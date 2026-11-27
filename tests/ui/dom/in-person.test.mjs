// Simulated browser, Phase 5.1 (migration 006): "verify with a youth
// leader". The voter asks on the real screens, with NO verification
// provider configured; a leader confirms them in the dashboard and hands
// over the code; the voter signs in and votes. Synthetic identities only
// (0815550 04xx). No camera, no face data.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  installDom, startVite, mount, setRpc, waitFor, button, buttons, dialog, typeInto, tickAll, text, sleep,
} from './dom-setup.mjs'
import { adminReply } from '../../../src/lib/rpcErrors.js'
import { freshDb, call, sql, login } from '../../db/helpers.mjs'

const CODE = /YPM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/
const REF = /\b[A-HJ-NP-Z2-9]{6}\b/

let vite
let VoterPrototype
let VotersTab
let win

before(async () => {
  win = installDom('http://localhost:5173/prototype/voter')
  vite = await startVite()
  VoterPrototype = (await vite.ssrLoadModule('/src/prototype/VoterPrototype.jsx')).default
  VotersTab = (await vite.ssrLoadModule('/src/components/admin/VotersTab.jsx')).default
})
after(async () => {
  await vite?.close()
  await win?.happyDOM.close()
})
beforeEach(() => window.sessionStorage.clear())

// Development, registration open, and no face check configured at all.
async function devDb(migrate = '006') {
  const db = await freshDb({ migrate })
  await sql(db, `update ypm_private.deployment set environment = 'development'`)
  await sql(db, `update settings set verification_provider = 'none', registration_mode = 'optional' where id = 1`)
  return db
}

const adminRpcFor = (db, session) => async (fn, args = {}) => {
  let res
  let err = null
  try {
    res = await call(db, fn, { p_session: session, ...args })
  } catch (e) {
    err = e
  }
  return adminReply(res, err)
}
const inDialog = (label) => buttons(dialog()).find((b) => b.textContent.includes(label))

async function askInPerson(name, phone) {
  await waitFor(() => button('First time? Register to vote'), 'login screen')
  button('First time? Register to vote').click()
  await waitFor(() => text().includes('Register to vote'), 'register screen')
  const [n, p] = document.querySelectorAll('.inner form input')
  typeInto(n, name)
  typeInto(p, phone)
  await sleep(20)
  button('Continue').click()
  await waitFor(() => button('Register another way, without a face scan'), 'consent screen')
  button('Register another way, without a face scan').click()
  await waitFor(() => text().includes('Register without a face scan'), 'alternative screen')
  // Name and number carried over from the previous screen.
  const [n2, p2] = document.querySelectorAll('.inner form input[type=text], .inner form input:not([type]), .inner form input[type=tel]')
  assert.equal(n2.value, name)
  assert.equal(p2.value, phone)
  document.querySelector('input[name=altAge][value=adult]').click()
  await sleep(20)
  document.querySelector('.protoCheck input').click()
  await sleep(20)
  button('Ask a youth leader to confirm me').click()
  await waitFor(() => text().includes('Show this to a youth leader'), 'reference screen')
  return document.querySelector('.voterCode').textContent
}

describe('verify with a youth leader (simulated browser)', () => {
  it('voter asks without any face check set up; a leader confirms; the voter signs in and votes', async () => {
    const db = await devDb()
    setRpc(db)
    const voterView = mount(VoterPrototype)
    let code
    try {
      const ref = await askInPerson('Test Inperson Voter', '08155500401')
      assert.match(ref, REF)
      const [q] = await sql(db, `select q.reference, r.status, r.provider from ypm_private.in_person_requests q
                                  join voter_registrations r on r.id = q.registration_id`)
      assert.deepEqual(q, { reference: ref, status: 'review', provider: 'in_person' })

      button('Has a leader confirmed me?').click()
      await waitFor(() => text().includes('Not yet. Show your reference'), 'not yet')

      // A reload keeps the request and its reference.
      voterView.unmount()
      const again = mount(VoterPrototype)
      await waitFor(() => text().includes('Show this to a youth leader'), 'back on the reference screen')
      assert.equal(document.querySelector('.voterCode').textContent, ref)
      again.unmount()
    } finally {
      try { voterView.unmount() } catch { /* already */ }
    }

    // The leader, in the dashboard.
    const s = await login(db)
    const adminView = mount(VotersTab, { adminRpc: adminRpcFor(db, s), adminLabel: 'leader' })
    try {
      await waitFor(() => /Reviews waiting \(1\)/.test(text()), 'queue loaded')
      await waitFor(() => /Asked to be confirmed in person · reference [A-HJ-NP-Z2-9]{6}/.test(text()), 'reference shown')
      assert.ok(!text().includes('08155500401'), 'number masked')
      button('Confirm').click()
      await waitFor(() => dialog() && /Confirm Test Inperson Voter\?/.test(dialog().textContent), 'confirm dialog')
      assert.match(dialog().textContent, /Confirm in person \(no face check\)/)
      assert.match(dialog().textContent, /Reference[A-HJ-NP-Z2-9]{6}/)
      dialog().querySelector('.ackRow input').click()
      await sleep(20)
      inDialog('Confirm and show code').click()
      await waitFor(() => CODE.test(dialog()?.textContent || ''), 'code shown once')
      code = dialog().textContent.match(CODE)[0]
      await tickAll()
      inDialog('Close and clear code').click()
      await waitFor(() => !dialog(), 'closed')
    } finally {
      adminView.unmount()
    }
    const [v] = await sql(db, `select method, created_by from voters where phone = '08155500401'`)
    assert.deepEqual(v, { method: 'in_person', created_by: 'leader' })

    // Back on the voter's phone: registered; sign in with the code and vote.
    const view = mount(VoterPrototype)
    try {
      // Opening the page checks the request straight away.
      await waitFor(() => text().includes('You’re registered'), 'registered notice')
      button('Sign in').click()
      await waitFor(() => document.querySelector('.inner form input'), 'login form')
      typeInto(document.querySelector('.inner form input'), code)
      await sleep(20)
      document.querySelector('.inner form button').click()
      await waitFor(() => text().includes('Welcome, Test'), 'signed in')
      assert.equal((await sql(db, `select count(*)::int n from voter_sessions`))[0].n, 1)
    } finally {
      view.unmount()
    }
  })

  it('without 005 simulated verification on, a pre-006 database still hides the tab', async () => {
    const db = await devDb('005')
    const s = await login(db)
    const view = mount(VotersTab, { adminRpc: adminRpcFor(db, s), adminLabel: 'leader' })
    try {
      await waitFor(() => text().includes('Voter management is switched off'), 'hidden')
    } finally {
      view.unmount()
    }
  })

  it('under-18s and registration switched off get a clear answer; nothing is stored', async () => {
    const db = await devDb()
    setRpc(db)
    const view = mount(VoterPrototype)
    try {
      await waitFor(() => button('First time? Register to vote'), 'login')
      button('First time? Register to vote').click()
      await waitFor(() => text().includes('Register to vote'), 'register')
      const [n, p] = document.querySelectorAll('.inner form input')
      typeInto(n, 'Test Young Person')
      typeInto(p, '08155500402')
      await sleep(20)
      button('Continue').click()
      await waitFor(() => button('Register another way, without a face scan'), 'consent')
      button('Register another way, without a face scan').click()
      await waitFor(() => document.querySelector('input[name=altAge][value=minor]'), 'alternative')
      document.querySelector('input[name=altAge][value=minor]').click()
      await waitFor(() => text().includes('Registration for under-18s isn’t available yet'), 'minor message')
      assert.ok(!button('Ask a youth leader to confirm me'), 'no request button for under-18s')

      await sql(db, `update settings set registration_mode = 'off' where id = 1`)
      document.querySelector('input[name=altAge][value=adult]').click()
      await sleep(20)
      document.querySelector('.protoCheck input').click()
      await sleep(20)
      button('Ask a youth leader to confirm me').click()
      await waitFor(() => text().includes('Registration isn’t open at the moment'), 'off message')
      assert.equal((await sql(db, `select count(*)::int n from voter_registrations`))[0].n, 0)
    } finally {
      view.unmount()
    }
  })

  it('a leader can reject a request; the voter is told to see them', async () => {
    const db = await devDb()
    setRpc(db)
    const view = mount(VoterPrototype)
    try {
      await askInPerson('Test Rejected Request', '08155500403')
      const s = await login(db)
      const [r] = await sql(db, `select id from voter_registrations where phone = '08155500403'`)
      assert.equal((await call(db, 'admin_confirm_in_person', { p_session: s, p_registration_id: r.id, p_decision: 'reject' })).status, 'ok')
      button('Has a leader confirmed me?').click()
      await waitFor(() => text().includes('Registration not approved'), 'rejected notice')
    } finally {
      view.unmount()
    }
  })

  it('without migration 006 the dashboard queue looks as before', async () => {
    const db = await devDb('005')
    await sql(db, `update settings set verification_provider = 'simulated' where id = 1`)
    const s = await login(db)
    const view = mount(VotersTab, { adminRpc: adminRpcFor(db, s), adminLabel: 'leader' })
    try {
      await waitFor(() => /Reviews waiting \(0\)/.test(text()), 'loaded')
      assert.ok(!text().includes('Could not load the reviews'))
    } finally {
      view.unmount()
    }
  })
})
