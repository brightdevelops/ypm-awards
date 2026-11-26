// Simulated browser, Phase 3.4/3.5: the "Registered voters" tab flows not
// covered in voters-tab.test.mjs — rejection, reissue from the list,
// revoking an account with a ballot, a consent notice that changes while
// the dialog is open, two admins restoring at once, and every registration
// mode with its effect on the voting and registration functions.
// Synthetic identities only (0815550 09xx). No biometrics.
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

async function devDb(mode = 'optional') {
  const db = await freshDb()
  await sql(db, `update ypm_private.deployment set environment = 'development'`)
  await sql(db, `update settings set verification_provider = 'simulated', registration_mode = '${mode}' where id = 1`)
  await db.exec(DEV_SIM_SQL)
  return { db, session: await login(db) }
}

async function makeReview(db, session, name, phone) {
  const s = await call(db, 'voter_registration_start', { p_name: name, p_phone: phone, p_consent_version: CV, p_adult: true })
  assert.equal(s.status, 'ok', JSON.stringify(s))
  await call(db, 'dev_simulate_verification', { p_admin_session: session, p_registration_token: s.registration_token, p_outcome: 'review' })
  return s.registration_token
}

async function inPerson(db, session, name, phone) {
  const r = await call(db, 'admin_register_voter', {
    p_session: session, p_name: name, p_phone: phone, p_consent_version: CV, p_adult_confirmed: true,
  })
  assert.equal(r.status, 'ok', JSON.stringify(r))
  return r
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

async function handOver() {
  await waitFor(() => CODE.test(dialog()?.textContent || ''), 'a code on screen')
  const code = dialog().textContent.match(CODE)[0]
  await tickAll()
  inDialog('Close and clear code').click()
  await waitFor(() => !dialog(), 'code box closed')
  assert.ok(!text().includes(code), 'code gone from the page')
  return code
}

const count = async (db, q) => (await sql(db, q))[0].n

describe('Registered voters tab: more flows (simulated browser)', () => {
  it('reject: no account, the review leaves the queue, the number can register again', async () => {
    const { db, session } = await devDb()
    const token = await makeReview(db, session, 'Test Rejectme', '08155500901')
    const view = mount(VotersTab, { adminRpc: adminRpcFor(db, session), adminLabel: 'leader' })
    try {
      await waitFor(() => /Reviews waiting \(1\)/.test(text()), 'tab loaded')
      button('Reject').click()
      await waitFor(() => dialog()?.textContent.includes('Reject Test Rejectme'), 'reject dialog')
      assert.match(dialog().textContent, /without creating an account/)
      assert.equal(inDialog('Reject').disabled, false, 'no tick needed to reject')
      inDialog('Reject').click()
      await waitFor(() => !dialog() && text().includes('Registration for Test Rejectme rejected'), 'rejected')
      await waitFor(() => /Reviews waiting \(0\)/.test(text()), 'queue empty')

      assert.equal((await call(db, 'voter_registration_status', { p_token: token })).status, 'rejected')
      assert.equal(await count(db, `select count(*)::int n from voters where phone = '08155500901'`), 0)
      assert.equal(await count(db, `select count(*)::int n from voter_consents`), 0, 'no consent record')
      const audit = await sql(db, `select actor from admin_audit where action = 'registration_rejected'`)
      assert.deepEqual(audit.map((a) => a.actor), ['leader'])
      // Rejection isn't a ban: the same number may try again.
      const again = await call(db, 'voter_registration_start', {
        p_name: 'Test Rejectme', p_phone: '08155500901', p_consent_version: CV, p_adult: true,
      })
      assert.equal(again.status, 'ok')
    } finally {
      view.unmount()
    }
  })

  it('reissue from the list: old code and sessions stop, the ballot is kept', async () => {
    const { db, session } = await devDb()
    const first = await inPerson(db, session, 'Test Reissue', '08155500902')
    const vs = (await call(db, 'voter_login', { p_code: first.voter_code })).session
    assert.equal((await call(db, 'voter_begin_ballot', { p_session: vs })).status, 'started')
    assert.equal((await call(db, 'voter_save_vote', {
      p_session: vs, p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams',
    })).status, 'ok')

    const view = mount(VotersTab, { adminRpc: adminRpcFor(db, session), adminLabel: 'leader' })
    try {
      await waitFor(() => button('Reissue code for Test Reissue'), 'row')
      button('Reissue code for Test Reissue').click()
      await waitFor(() => dialog()?.textContent.includes('Reissue code for Test Reissue'), 'dialog')
      assert.match(dialog().textContent, /In progress/)
      assert.equal(inDialog('Issue new code').disabled, true)
      await tickAll()
      inDialog('Issue new code').click()
      const code = await handOver()
      assert.notEqual(code, first.voter_code)

      assert.equal((await call(db, 'voter_login', { p_code: first.voter_code })).status, 'invalid')
      assert.equal((await call(db, 'voter_begin_ballot', { p_session: vs })).status, 'unauthorized')
      const l = await call(db, 'voter_login', { p_code: code })
      assert.equal(l.status, 'ok')
      const resumed = await call(db, 'voter_begin_ballot', { p_session: l.session })
      assert.equal(resumed.status, 'resumed')
      assert.equal(resumed.picks.length, 1, 'votes kept')
    } finally {
      view.unmount()
    }
  })

  it('revoke needs the name typed; a submitted ballot stays counted; no reissue offered', async () => {
    const { db, session } = await devDb()
    const v = await inPerson(db, session, 'Test Revokeme', '08155500903')
    const vs = (await call(db, 'voter_login', { p_code: v.voter_code })).session
    await call(db, 'voter_begin_ballot', { p_session: vs })
    await call(db, 'voter_save_vote', { p_session: vs, p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams' })
    assert.equal((await call(db, 'voter_submit_ballot', { p_session: vs })).status, 'ok')

    const view = mount(VotersTab, { adminRpc: adminRpcFor(db, session), adminLabel: 'leader' })
    try {
      await waitFor(() => button('Revoke Test Revokeme’s account'), 'row')
      button('Revoke Test Revokeme’s account').click()
      await waitFor(() => dialog()?.textContent.includes('Revoke Test Revokeme'), 'dialog')
      const [reason, confirmName] = dialog().querySelectorAll('input')
      typeInto(reason, 'synthetic test')
      typeInto(confirmName, 'test') // wrong case is fine, wrong name isn't
      await sleep(20)
      assert.equal(inDialog('Revoke account').disabled, false)
      typeInto(confirmName, 'Someone')
      await sleep(20)
      assert.equal(inDialog('Revoke account').disabled, true)
      typeInto(confirmName, 'Test')
      await sleep(20)
      inDialog('Revoke account').click()
      await waitFor(() => text().includes('Account revoked'), 'revoked')
      await waitFor(() => button('Restore Test Revokeme’s account'), 'restore offered')
      assert.equal(button('Reissue code for Test Revokeme'), undefined, 'no reissue on a revoked account')

      assert.equal((await call(db, 'voter_begin_ballot', { p_session: vs })).status, 'unauthorized')
      assert.equal(await count(db, `select count(*)::int n from ballots where completed_at is not null and voter_phone = '08155500903'`), 1)
      assert.equal(await count(db, `select count(*)::int n from votes v join ballots b on b.id = v.ballot_id where b.voter_phone = '08155500903'`), 1, 'vote kept')
    } finally {
      view.unmount()
    }
  })

  it('in person: a consent notice retired while the dialog is open creates nothing; the new one works', async () => {
    const { db, session } = await devDb()
    const view = mount(VotersTab, { adminRpc: adminRpcFor(db, session), adminLabel: 'leader' })
    try {
      await waitFor(() => text().includes(`Consent notice: ${CV}`), 'tab loaded')
      button('Register in person').click()
      await waitFor(() => dialog()?.textContent.includes('No photo or face scan'), 'dialog')
      const inputs = dialog().querySelectorAll('input:not([type=checkbox])')
      typeInto(inputs[0], 'Test Consentchange')
      typeInto(inputs[1], '08155500904')
      await tickAll()

      // Meanwhile the notice is replaced (database owner).
      await sql(db, `update ypm_private.consent_versions set is_current = false, retired_at = now() where version = '${CV}'`)
      await sql(db, `insert into ypm_private.consent_versions (version, description, is_draft, is_current)
                     values ('draft-2026-12-dev', 'Synthetic test notice', true, true)`)

      inDialog('Register and show code').click()
      await waitFor(() => /consent notice has changed \(now draft-2026-12-dev\)/.test(dialog()?.textContent || ''), 'refused')
      assert.match(dialog().textContent, /Nothing was created/)
      assert.ok(!CODE.test(dialog().textContent))
      assert.equal(await count(db, `select count(*)::int n from voters`), 0)
      inDialog('Cancel').click()
      await waitFor(() => !dialog(), 'closed')
    } finally {
      view.unmount()
    }

    // After a refresh the dialog shows and sends the new version.
    const again = mount(VotersTab, { adminRpc: adminRpcFor(db, session), adminLabel: 'leader' })
    try {
      await waitFor(() => text().includes('Consent notice: draft-2026-12-dev'), 'new version shown')
      button('Register in person').click()
      await waitFor(() => dialog()?.textContent.includes('version draft-2026-12-dev'), 'dialog with new version')
      const inputs = dialog().querySelectorAll('input:not([type=checkbox])')
      typeInto(inputs[0], 'Test Consentchange')
      typeInto(inputs[1], '08155500904')
      await tickAll()
      inDialog('Register and show code').click()
      await handOver()
      const c = await sql(db, `select consent_version from voter_consents`)
      assert.deepEqual(c, [{ consent_version: 'draft-2026-12-dev' }])
    } finally {
      again.unmount()
    }

    // Online registration with the retired version is refused too.
    const r = await call(db, 'voter_registration_start', {
      p_name: 'Test Oldnotice', p_phone: '08155500905', p_consent_version: CV, p_adult: true,
    })
    assert.equal(r.status, 'consent_outdated')
  })

  it('two admins restore at once: the second is told, and only the first code works', async () => {
    const { db, session } = await devDb()
    const v = await inPerson(db, session, 'Test Tworestore', '08155500906')
    await call(db, 'admin_revoke_voter', { p_session: session, p_voter_id: v.voter_id, p_reason: 'synthetic test' })

    const view = mount(VotersTab, { adminRpc: adminRpcFor(db, session), adminLabel: 'leader' })
    try {
      await waitFor(() => button('Restore Test Tworestore’s account'), 'row')
      button('Restore Test Tworestore’s account').click()
      await waitFor(() => dialog()?.textContent.includes('Restore Test Tworestore'), 'dialog')
      typeInto(dialog().querySelector('input:not([type=checkbox])'), 'checked ID in person')
      await tickAll()

      const other = await login(db, INVENTOR_KEY)
      const theirs = await call(db, 'admin_restore_voter', { p_session: other, p_voter_id: v.voter_id, p_reason: 'other admin' })
      assert.equal(theirs.status, 'ok')

      inDialog('Restore with a new code').click()
      await waitFor(() => !dialog() && text().includes('already active'), 'told it was already restored')
      assert.ok(!CODE.test(text()))
      assert.equal((await call(db, 'voter_login', { p_code: theirs.voter_code })).status, 'ok')
      assert.equal((await call(db, 'voter_login', { p_code: v.voter_code })).status, 'invalid')
      assert.equal(await count(db, `select count(*)::int n from admin_audit where action = 'voter_restored'`), 1)
    } finally {
      view.unmount()
    }
  })

  it('registration modes: off, optional and required, each with its effect', async () => {
    const { db, session } = await devDb('off')
    // Before any change: an anonymous ballot started, and a registered voter.
    const anon = await call(db, 'begin_ballot', { p_name: 'Test Earlyanon', p_phone: '08155500907', p_code: null })
    assert.equal(anon.status, 'started')
    const reg = await inPerson(db, session, 'Test Registered', '08155500908')

    const start = (phone) => call(db, 'voter_registration_start', {
      p_name: 'Test Moder', p_phone: phone, p_consent_version: CV, p_adult: true,
    })
    const setMode = async (label) => {
      button(label).click()
      await waitFor(() => dialog()?.textContent.includes(`Set registration to ${label}`), `${label} dialog`)
      if (label === 'Required') await tickAll()
      inDialog(`Set to ${label}`).click()
      await waitFor(() => text().includes(`Registration is now ${label.toLowerCase()}`), `${label} set`)
      await waitFor(() => button(label).getAttribute('aria-pressed') === 'true', `${label} pressed`)
    }

    const view = mount(VotersTab, { adminRpc: adminRpcFor(db, session), adminLabel: 'leader' })
    try {
      await waitFor(() => button('Off')?.getAttribute('aria-pressed') === 'true', 'Off shown')
      assert.equal((await start('08155500909')).status, 'registration_off')
      // Off doesn't stop in-person registration or registered voters.
      assert.equal((await call(db, 'voter_login', { p_code: reg.voter_code })).status, 'ok')

      await setMode('Optional')
      assert.equal((await start('08155500909')).status, 'ok')
      assert.equal((await call(db, 'begin_ballot', { p_name: 'Test Newanon', p_phone: '08155500910', p_code: null })).status, 'started')

      await setMode('Required')
      assert.equal((await call(db, 'begin_ballot', { p_name: 'Test Lateanon', p_phone: '08155500911', p_code: null })).status, 'registration_required')
      // Started ballots carry on; registered voters vote; registration stays open.
      assert.equal((await call(db, 'save_vote', { p_ballot_id: anon.ballot_id, p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams' })).status, 'ok')
      const s = (await call(db, 'voter_login', { p_code: reg.voter_code })).session
      assert.equal((await call(db, 'voter_begin_ballot', { p_session: s })).status, 'started')
      assert.equal((await start('08155500912')).status, 'ok')

      // Clicking the current mode opens nothing.
      button('Required').click()
      await sleep(30)
      assert.equal(dialog(), null)

      await setMode('Off')
      assert.equal((await start('08155500913')).status, 'registration_off')
      const modes = await sql(db, `select detail->>'mode' m from admin_audit where action = 'set_registration_mode' order by id`)
      assert.deepEqual(modes.map((m) => m.m), ['optional', 'required', 'off'])
    } finally {
      view.unmount()
    }
  })
})
