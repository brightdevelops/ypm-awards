// Simulated browser: the real "Registered voters" admin tab, clicked
// through against a test database with migrations 001–004 and the dev
// simulator. Synthetic identities only (0815550 0xxx).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  installDom, startVite, mount, waitFor, button, buttons, dialog, typeInto, tickAll, text, sleep,
} from './dom-setup.mjs'
import { adminReply } from '../../../src/lib/rpcErrors.js'
import { freshDb, call, sql, login, INVENTOR_KEY, DEV_SIM_SQL } from '../../db/helpers.mjs'

const CODE = /YPM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/
const CV = 'draft-2026-11-dev'

let vite
let VotersTab
let win

before(async () => {
  win = installDom('http://localhost:5173/admin')
  vite = await startVite()
  VotersTab = (await vite.ssrLoadModule('/src/components/admin/VotersTab.jsx')).default
})
after(async () => {
  await vite?.close()
  await win?.happyDOM.close()
})

async function devDb() {
  const db = await freshDb()
  await sql(db, `update ypm_private.deployment set environment = 'development'`)
  await sql(db, `update settings set verification_provider = 'simulated', registration_mode = 'optional' where id = 1`)
  await db.exec(DEV_SIM_SQL)
  return { db, session: await login(db) }
}

async function makeReview(db, session, name, phone) {
  const s = await call(db, 'voter_registration_start', { p_name: name, p_phone: phone, p_consent_version: CV, p_adult: true })
  await call(db, 'dev_simulate_verification', { p_admin_session: session, p_registration_token: s.registration_token, p_outcome: 'review' })
}

// The dashboard's adminRpc, against the test database. lose(fn) === true
// drops the reply AFTER the server has acted.
function adminRpcFor(db, session, lose = () => false) {
  return async (fn, args = {}) => {
    let res
    let err = null
    try {
      res = await call(db, fn, { p_session: session, ...args })
    } catch (e) {
      err = e
    }
    if (lose(fn)) return adminReply(null, { message: 'TypeError: Failed to fetch' })
    return adminReply(res, err)
  }
}

const inDialog = (label) => buttons(dialog()).find((b) => b.textContent.includes(label))

async function handOver() {
  await waitFor(() => CODE.test(dialog()?.textContent || ''), 'a code on screen')
  const code = dialog().textContent.match(CODE)[0]
  const close = inDialog('Close and clear code')
  assert.equal(close.disabled, true, 'can’t close before ticking')
  assert.equal(dialog().querySelector('.dialogClose'), null, 'no × on the code box')
  await tickAll()
  inDialog('Close and clear code').click()
  await waitFor(() => !dialog(), 'code box closed')
  assert.ok(!text().includes(code), 'code gone from the page')
  return code
}

describe('Registered voters tab (simulated browser)', () => {
  it('approve, lost-reply approve, link on approval, in person, revoke, restore, mode', async () => {
    const { db, session } = await devDb()
    await makeReview(db, session, 'Test Approveme', '08155500801')
    await makeReview(db, session, 'Test Lostreply', '08155500802')
    await makeReview(db, session, 'Test Hasballot', '08155500803')
    const anon = await call(db, 'begin_ballot', { p_name: 'Test Hasballot', p_phone: '08155500803', p_code: null })
    await call(db, 'save_vote', { p_ballot_id: anon.ballot_id, p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams' })

    let loseNext = null
    const rpc = adminRpcFor(db, session, (fn) => {
      if (fn !== loseNext) return false
      loseNext = null
      return true
    })
    const view = mount(VotersTab, { adminRpc: rpc, adminLabel: 'leader' })
    try {
      await waitFor(() => /Reviews waiting \(3\)/.test(text()), 'tab loaded')
      assert.match(text(), /not a biometric comparison/)
      assert.match(text(), new RegExp(`Consent notice: ${CV}`))
      assert.match(text(), /Adults only/)
      assert.ok(text().includes('•••• 0801') && !text().includes('08155500801'), 'numbers masked')

      // 1. Approve.
      const approveFor = (name) => {
        const li = [...document.querySelectorAll('.reviewList li')].find((l) => l.textContent.includes(name))
        return button('Approve', li)
      }
      approveFor('Test Approveme').click()
      await waitFor(() => dialog()?.textContent.includes('Approve Test Approveme'), 'approve dialog')
      assert.equal(inDialog('Approve and show code').disabled, true)
      await tickAll()
      inDialog('Approve and show code').click()
      const approved = await handOver()
      assert.equal((await call(db, 'voter_login', { p_code: approved })).status, 'ok')

      // 2. Lost reply on my own approval: confirmed from the account, then reissue.
      await waitFor(() => /Reviews waiting \(2\)/.test(text()), 'queue refreshed')
      loseNext = 'admin_resolve_review'
      approveFor('Test Lostreply').click()
      await waitFor(() => dialog()?.textContent.includes('Approve Test Lostreply'), 'second approve dialog')
      await tickAll()
      inDialog('Approve and show code').click()
      await waitFor(() => dialog()?.textContent.includes('was approved'), 'lost approval checked')
      assert.ok(!CODE.test(dialog().textContent))
      inDialog('Reissue code').click()
      await waitFor(() => dialog()?.textContent.includes('Reissue code for Test Lostreply'), 'reissue dialog')
      assert.equal(inDialog('Issue new code').disabled, true)
      await tickAll()
      inDialog('Issue new code').click()
      const reissued = await handOver()
      assert.equal((await call(db, 'voter_login', { p_code: reissued })).status, 'ok')

      // 3. Approval when the number already has a ballot: link it, votes kept.
      await waitFor(() => /Reviews waiting \(1\)/.test(text()), 'one review left')
      approveFor('Test Hasballot').click()
      await waitFor(() => dialog()?.textContent.includes('Approve Test Hasballot'), 'third approve dialog')
      await tickAll()
      inDialog('Approve and show code').click()
      await waitFor(() => dialog()?.textContent.includes('This number already has a ballot'), 'link step')
      assert.match(dialog().textContent, /not finished yet \(1 answered\)/)
      assert.equal(inDialog('Approve and link ballot').disabled, true)
      await tickAll()
      inDialog('Approve and link ballot').click()
      const linkedCode = await handOver()
      const vs = (await call(db, 'voter_login', { p_code: linkedCode })).session
      const resumed = await call(db, 'voter_begin_ballot', { p_session: vs })
      assert.equal(resumed.status, 'resumed')
      assert.equal(resumed.picks.length, 1)

      // 4. In person: identity, consent (current version) and adult boxes.
      button('Register in person').click()
      await waitFor(() => dialog()?.textContent.includes('No photo or face scan'), 'register dialog')
      assert.match(dialog().textContent, new RegExp(`privacy notice \\(version ${CV}\\)`))
      assert.match(dialog().textContent, /Under-18 registration isn’t available yet/)
      const inputs = dialog().querySelectorAll('input:not([type=checkbox])')
      typeInto(inputs[0], 'Test Walkin')
      typeInto(inputs[1], '08155500804')
      await sleep(20)
      inDialog('Register and show code').click()
      await waitFor(() => /Confirm that you’ve checked who they are/.test(dialog()?.textContent || ''), 'needs the boxes')
      await tickAll()
      inDialog('Register and show code').click()
      const walkin = await handOver()
      assert.equal((await call(db, 'voter_login', { p_code: walkin })).status, 'ok')
      const consent = await sql(db, `select c.method, c.consent_version, c.adult_confirmed, c.recorded_by
        from voter_consents c join voters v on v.id = c.voter_id where v.phone = '08155500804'`)
      assert.deepEqual(consent, [{ method: 'in_person', consent_version: CV, adult_confirmed: true, recorded_by: 'leader' }])

      // 5. Revoke, then 6. restore with a new code.
      await waitFor(() => button('Revoke Test Walkin’s account'), 'walkin row')
      button('Revoke Test Walkin’s account').click()
      await waitFor(() => dialog()?.textContent.includes('restoring always issues a new code'), 'revoke dialog')
      assert.equal(inDialog('Revoke account').disabled, true)
      typeInto(dialog().querySelectorAll('input')[1], 'test')
      await sleep(20)
      inDialog('Revoke account').click()
      await waitFor(() => text().includes('Account revoked'), 'revoked')
      assert.equal((await call(db, 'voter_login', { p_code: walkin })).status, 'invalid')

      await waitFor(() => button('Restore Test Walkin’s account'), 'restore button')
      button('Restore Test Walkin’s account').click()
      await waitFor(() => dialog()?.textContent.includes('Restore Test Walkin'), 'restore dialog')
      assert.equal(inDialog('Restore with a new code').disabled, true)
      typeInto(dialog().querySelector('input:not([type=checkbox])'), 'checked ID in person')
      await tickAll()
      inDialog('Restore with a new code').click()
      const restored = await handOver()
      assert.notEqual(restored, walkin)
      assert.equal((await call(db, 'voter_login', { p_code: restored })).status, 'ok')
      assert.equal((await call(db, 'voter_login', { p_code: walkin })).status, 'invalid')

      // 7. Registration mode: Required needs an extra tick.
      button('Required').click()
      await waitFor(() => dialog()?.textContent.includes('Set registration to Required'), 'mode dialog')
      assert.equal(inDialog('Set to Required').disabled, true)
      await tickAll()
      inDialog('Set to Required').click()
      await waitFor(() => text().includes('Registration is now required'), 'mode set')
      assert.equal((await sql(db, `select registration_mode m from settings`))[0].m, 'required')

      // Nothing kept in the browser.
      assert.equal(window.sessionStorage.length, 0)
      assert.equal(window.localStorage.length, 0)
    } finally {
      view.unmount()
    }
  })

  it('another admin’s approval is never offered for reissue', async () => {
    const { db, session } = await devDb()
    await makeReview(db, session, 'Test Twoadmins', '08155500805')
    const view = mount(VotersTab, { adminRpc: adminRpcFor(db, session), adminLabel: 'leader' })
    try {
      await waitFor(() => /Reviews waiting \(1\)/.test(text()), 'tab loaded')
      // The other admin approves while this dialog is open.
      button('Approve').click()
      await waitFor(() => dialog(), 'dialog')
      const other = await login(db, INVENTOR_KEY)
      const id = (await sql(db, `select id from voter_registrations where phone = '08155500805'`))[0].id
      assert.equal((await call(db, 'admin_resolve_review', {
        p_session: other, p_registration_id: id, p_decision: 'approve', p_link_existing_ballot: false,
      })).status, 'ok')
      await tickAll()
      inDialog('Approve and show code').click()
      await waitFor(() => dialog()?.textContent.includes('approved by someone else'), 'checked')
      assert.equal(inDialog('Reissue code'), undefined)
    } finally {
      view.unmount()
    }
  })

  it('a production database: switched off; a database without 003: not installed', async () => {
    const prod = await freshDb() // 004, environment production
    const s = await login(prod)
    const v1 = mount(VotersTab, { adminRpc: adminRpcFor(prod, s), adminLabel: 'leader' })
    try {
      await waitFor(() => v1.host.textContent.includes('switched off for this database'), 'disabled screen')
      assert.ok(!v1.host.textContent.includes('Register in person'))
    } finally {
      v1.unmount()
    }

    const old = await freshDb({ migrate: '002' })
    const s2 = await login(old)
    const v2 = mount(VotersTab, { adminRpc: adminRpcFor(old, s2), adminLabel: 'leader' })
    try {
      await waitFor(() => v2.host.textContent.includes('aren’t installed'), 'not installed screen')
      assert.ok(!v2.host.textContent.includes('Register in person'))
    } finally {
      v2.unmount()
    }
  })
})
