// Simulated browser, production release: the voter page (/voter) and the
// dashboard's Registered voters tab against a PRODUCTION-marked database
// with migrations 001–007. Synthetic identities only (0815550 02xx). No
// camera, no face data.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  installDom, startVite, mount, setRpc, waitFor, button, buttons, dialog, typeInto, tickAll, text, sleep,
} from './dom-setup.mjs'
import { adminReply } from '../../../src/lib/rpcErrors.js'
import { freshDb, call, sql, login } from '../../db/helpers.mjs'

const CODE = /YPM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/

let vite
let VoterApp
let VotersTab
let win

before(async () => {
  win = installDom('http://localhost:5173/voter')
  vite = await startVite()
  VoterApp = (await vite.ssrLoadModule('/src/voter/VoterApp.jsx')).default
  VotersTab = (await vite.ssrLoadModule('/src/components/admin/VotersTab.jsx')).default
})
after(async () => {
  await vite?.close()
  await win?.happyDOM.close()
})
beforeEach(() => window.sessionStorage.clear())

async function prodDb({ live = true } = {}) {
  const db = await freshDb({ migrate: '007' }) // production-marked
  if (live) {
    await sql(db, `update ypm_private.deployment set voter_accounts_live = true`)
    await sql(db, `update settings set registration_mode = 'optional' where id = 1`)
  }
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

async function ask(name, phone) {
  await waitFor(() => button('First time? Register to vote'), 'sign-in screen')
  assert.ok(!text().includes('scan your face'), 'no face-scan wording')
  button('First time? Register to vote').click()
  await waitFor(() => text().includes('Register without a face scan'), 'request screen')
  assert.ok(!text().includes('Development'), 'no development wording')
  const inputs = document.querySelectorAll('.inner form input:not([type=radio]):not([type=checkbox])')
  typeInto(inputs[0], name)
  typeInto(inputs[1], phone)
  await sleep(20)
  document.querySelector('input[name=altAge][value=adult]').click()
  await waitFor(() => text().includes('What we keep'), 'notice shown')
  document.querySelector('.protoCheck input').click()
  await sleep(20)
  button('Ask a youth leader to confirm me').click()
}

describe('voter page in Production (simulated browser)', () => {
  it('a real-format number, the published notice, a leader confirms, the voter signs in and votes', async () => {
    const db = await prodDb()
    setRpc(db)
    let view = mount(VoterApp, { consentApproved: true })
    let code
    try {
      await ask('Test Production Voter', '0815 550 0201')
      await waitFor(() => text().includes('Show this to a youth leader'), 'reference screen')
      const ref = document.querySelector('.voterCode').textContent
      const [q] = await sql(db, `select q.reference, r.consent_version from ypm_private.in_person_requests q join voter_registrations r on r.id = q.registration_id`)
      assert.deepEqual(q, { reference: ref, consent_version: 'ypm-register-2026-12-v1' })
    } finally {
      view.unmount()
    }

    const s = await login(db)
    const admin = mount(VotersTab, { adminRpc: adminRpcFor(db, s), adminLabel: 'leader' })
    try {
      await waitFor(() => /Asked to be confirmed in person · reference/.test(text()), 'request in the queue')
      button('Confirm').click()
      await waitFor(() => dialog() && /Confirm Test Production Voter\?/.test(dialog().textContent), 'dialog')
      dialog().querySelector('.ackRow input').click()
      await sleep(20)
      inDialog('Confirm and show code').click()
      await waitFor(() => CODE.test(dialog()?.textContent || ''), 'code shown once')
      code = dialog().textContent.match(CODE)[0]
      await tickAll()
      inDialog('Close and clear code').click()
      await waitFor(() => !dialog(), 'closed')
      // Production wording: no development or simulator text.
      assert.match(text(), /No face checks. People register in person with a youth leader/)
      assert.ok(!/Development|simulated|tester/i.test(text()), 'no development wording')
    } finally {
      admin.unmount()
    }

    view = mount(VoterApp, { consentApproved: true })
    try {
      await waitFor(() => text().includes('You’re registered'), 'confirmed on reload')
      button('Sign in').click()
      await waitFor(() => document.querySelector('.codeInput'), 'sign-in form')
      typeInto(document.querySelector('.codeInput'), code)
      await sleep(20)
      document.querySelector('.inner form button').click()
      await waitFor(() => text().includes('Welcome, Test'), 'signed in')
      assert.equal((await sql(db, `select count(*)::int n from voter_sessions`))[0].n, 1)
    } finally {
      view.unmount()
    }
    // Stored in session storage under the production keys only.
    assert.equal(window.sessionStorage.getItem('ypm-dev-voter-session'), null)
  })

  it('until the notice is approved, the page takes no requests', async () => {
    const db = await prodDb()
    setRpc(db)
    const view = mount(VoterApp)
    try {
      await waitFor(() => button('First time? Register to vote'), 'sign-in')
      button('First time? Register to vote').click()
      await waitFor(() => text().includes('Registration opens soon'), 'not open yet')
      assert.equal((await sql(db, `select count(*)::int n from voter_registrations`))[0].n, 0)
    } finally {
      view.unmount()
    }
  })

  it('switched off in the database: requests and sign-in say so; the dashboard tab says it’s off', async () => {
    const db = await prodDb({ live: false })
    setRpc(db)
    const view = mount(VoterApp, { consentApproved: true })
    try {
      await ask('Test Off Voter', '08155500202')
      await waitFor(() => text().includes('Registration isn’t open at the moment'), 'off message')
      button('I already have a voter code').click()
      await waitFor(() => document.querySelector('.codeInput'), 'sign-in form')
      typeInto(document.querySelector('.codeInput'), 'YPM-AAAA-BBBB-CCCC')
      await sleep(20)
      document.querySelector('.inner form button').click()
      await waitFor(() => text().includes('Voter accounts aren’t available here'), 'disabled sign-in')
    } finally {
      view.unmount()
    }
    const s = await login(db)
    const admin = mount(VotersTab, { adminRpc: adminRpcFor(db, s), adminLabel: 'leader' })
    try {
      await waitFor(() => text().includes('Voter management is switched off'), 'tab off')
    } finally {
      admin.unmount()
    }
  })
})
