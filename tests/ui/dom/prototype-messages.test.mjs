// Simulated browser: the development voter flow (/prototype/voter) shows the
// right message for each refusal from migration 004, instead of falling
// through to "check your name and phone number" or "code not found".
// Regression tests. Synthetic identities only (0815550 09xx). No camera.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  installDom, startVite, mount, setRpc, waitFor, button, typeInto, text, sleep,
} from './dom-setup.mjs'
import { freshDb, call, sql, DEV_SIM_SQL } from '../../db/helpers.mjs'

let vite
let VoterPrototype
let win

before(async () => {
  win = installDom('http://localhost:5173/prototype/voter')
  vite = await startVite()
  VoterPrototype = (await vite.ssrLoadModule('/src/prototype/VoterPrototype.jsx')).default
})
after(async () => {
  await vite?.close()
  await win?.happyDOM.close()
})
beforeEach(() => {
  window.sessionStorage.clear()
})

async function devDb() {
  const db = await freshDb()
  await sql(db, `update ypm_private.deployment set environment = 'development'`)
  await sql(db, `update settings set verification_provider = 'simulated', registration_mode = 'optional' where id = 1`)
  await db.exec(DEV_SIM_SQL)
  return db
}

// Login screen → register → consent → "I agree, continue".
async function registerUntilAgree(name, phone) {
  await waitFor(() => button('First time? Register to vote'), 'login screen')
  button('First time? Register to vote').click()
  await waitFor(() => text().includes('Register to vote'), 'register screen')
  const [n, p] = document.querySelectorAll('form input')
  typeInto(n, name)
  typeInto(p, phone)
  await sleep(20)
  button('Continue').click()
  await waitFor(() => document.querySelector('input[value=adult]'), 'consent screen')
  document.querySelector('input[value=adult]').click()
  await sleep(20)
  document.querySelector('.protoCheck input').click()
  await sleep(20)
  button('I agree, continue').click()
}

describe('development voter flow: messages for 004 refusals (simulated browser)', () => {
  it('a changed consent notice says so, and nothing is started', async () => {
    const db = await devDb()
    await sql(db, `update ypm_private.consent_versions set is_current = false, retired_at = now()`)
    await sql(db, `insert into ypm_private.consent_versions (version, description, is_draft, is_current)
                   values ('draft-2026-12-dev', 'Synthetic test notice', true, true)`)
    setRpc(db)
    const view = mount(VoterPrototype)
    try {
      await registerUntilAgree('Test Oldnotice', '08155500951')
      await waitFor(() => text().includes('The privacy notice has changed'), 'consent notice message')
      assert.ok(!text().includes('Please check your name and phone number'))
      assert.equal((await sql(db, `select count(*)::int n from voter_registrations`))[0].n, 0)
    } finally {
      view.unmount()
    }
  })

  it('online registration switched off says so', async () => {
    const db = await devDb()
    await sql(db, `update settings set registration_mode = 'off' where id = 1`)
    setRpc(db)
    const view = mount(VoterPrototype)
    try {
      await registerUntilAgree('Test Modeoff', '08155500952')
      await waitFor(() => text().includes('Online registration isn’t open'), 'off message')
    } finally {
      view.unmount()
    }
  })

  it('a database with voter accounts switched off (004 "disabled") says so, on register and sign-in', async () => {
    const db = await freshDb() // production: 004 answers "disabled"
    assert.equal((await call(db, 'voter_login', { p_code: 'YPM-AAAA-BBBB-CCCC' })).status, 'disabled')
    setRpc(db)
    const view = mount(VoterPrototype)
    try {
      await registerUntilAgree('Test Disabled', '08155500953')
      await waitFor(() => text().includes('Online registration isn’t open'), 'disabled on register')
      assert.ok(!text().includes('Please check your name and phone number'))
    } finally {
      view.unmount()
    }

    const again = mount(VoterPrototype)
    try {
      await waitFor(() => document.querySelector('.codeInput'), 'login screen')
      typeInto(document.querySelector('.codeInput'), 'YPM-AAAA-BBBB-CCCC')
      await sleep(20)
      button('Continue').click()
      await waitFor(() => text().includes('Voter accounts aren’t available here'), 'disabled on sign-in')
      assert.ok(!text().includes('We couldn’t find that voter code'))
    } finally {
      again.unmount()
    }
  })

})
