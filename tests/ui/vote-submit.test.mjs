// Regression: the voting page used to show "Your vote is in" for any submit
// reply except "closed", including "unknown ballot" errors and replies it
// didn't recognise. Only an explicit "ok" from the server may count as
// submitted. Checked against real submit_ballot replies on every database
// stage: production today, after 001/002, and after 003.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SUBMIT_MESSAGES, submitOutcome } from '../../src/lib/ballotMessages.js'
import { freshDb, call, login } from '../db/helpers.mjs'

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url))

describe('submitOutcome', () => {
  it('counts only an explicit ok as submitted', () => {
    assert.equal(submitOutcome({ status: 'ok' }, null), 'submitted')
    for (const [data, err] of [
      [null, { message: 'TypeError: Failed to fetch' }],
      [{ status: 'ok' }, { message: 'reply arrived with an error' }],
      [null, null],
      [undefined, null],
      ['ok', null],
      [{}, null],
      [{ status: 'OK' }, null],
      [{ status: 'error', message: 'unknown ballot' }, null],
      [{ status: 'error', message: 'something new' }, null],
      [{ status: 'already_voted' }, null],
    ]) {
      assert.notEqual(submitOutcome(data, err), 'submitted', JSON.stringify([data, err]))
    }
  })

  it('names the cases the page handles', () => {
    assert.equal(submitOutcome({ status: 'closed' }, null), 'closed')
    assert.equal(submitOutcome({ status: 'error', message: 'unknown ballot' }, null), 'unknown_ballot')
    assert.equal(submitOutcome({ status: 'error', message: 'sign in with your voter code' }, null), 'account')
    assert.equal(submitOutcome({ status: 'weird' }, null), 'unconfirmed')
    assert.match(SUBMIT_MESSAGES.unknown_ballot, /has not been submitted/)
    assert.match(SUBMIT_MESSAGES.unconfirmed, /couldn’t confirm/)
  })
})

describe('real submit_ballot replies', () => {
  for (const stage of [false, '002', true]) {
    const label = stage === false ? 'production today' : stage === '002' ? 'after 001 and 002' : 'after 003'

    it(`${label}: an unknown ballot is not shown as submitted`, async () => {
      const db = await freshDb({ migrate: stage })
      const r = await call(db, 'submit_ballot', { p_ballot_id: '00000000-0000-0000-0000-000000000000' })
      assert.equal(submitOutcome(r, null), 'unknown_ballot')
    })

    it(`${label}: a real ballot is submitted, and submitting again stays submitted`, async () => {
      const db = await freshDb({ migrate: stage })
      const start = await call(db, stage === false ? 'start_ballot' : 'begin_ballot',
        stage === false
          ? { p_name: 'Test Submit', p_phone: '08155500950' }
          : { p_name: 'Test Submit', p_phone: '08155500950', p_code: null })
      const id = start.ballot_id
      assert.ok(id, JSON.stringify(start))
      assert.equal(submitOutcome(await call(db, 'submit_ballot', { p_ballot_id: id }), null), 'submitted')
      assert.equal(submitOutcome(await call(db, 'submit_ballot', { p_ballot_id: id }), null), 'submitted')
    })

    it(`${label}: voting closed is not shown as submitted`, async () => {
      const db = await freshDb({ migrate: stage })
      const start = await call(db, stage === false ? 'start_ballot' : 'begin_ballot',
        stage === false
          ? { p_name: 'Test Closed', p_phone: '08155500951' }
          : { p_name: 'Test Closed', p_phone: '08155500951', p_code: null })
      if (stage === false) {
        await db.query(`update settings set voting_open = false where id = 1`)
      } else {
        const s = await login(db)
        await call(db, 'admin_set_voting_open', { p_session: s, p_open: false })
      }
      assert.equal(submitOutcome(await call(db, 'submit_ballot', { p_ballot_id: start.ballot_id }), null), 'closed')
    })
  }
})

describe('Vote.jsx', () => {
  const src = readFileSync(root('src/pages/Vote.jsx'), 'utf8')
  const submit = src.slice(src.indexOf('async function submitBallot'), src.indexOf('/* ---------- screens'))

  it('marks a ballot complete only in the "submitted" case', () => {
    assert.equal((src.match(/persist\(\{ completed: true \}\)/g) || []).length, 1)
    assert.match(submit, /switch \(submitOutcome\(data, err\)\) \{\s*case 'submitted':\s*persist\(\{ completed: true \}\)\s*return setView\('done'\)/)
    // The only other route to the "done" screen is a ballot this phone has
    // already recorded as complete.
    assert.equal((submit.match(/setView\('done'\)/g) || []).length, 1)
    assert.equal((src.match(/setView\('done'\)/g) || []).length, 2)
    assert.match(src, /if \(local\.completed\) \{\s*setView\('done'\)/)
  })

  it('shows the submit error to screen readers', () => {
    assert.match(src, /\{error && <p className="error" role="alert">\{error\}<\/p>\}/)
  })
})
