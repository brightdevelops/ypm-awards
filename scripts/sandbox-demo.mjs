// Automated sandbox demonstration: duplicate-person detection (1:N) and
// liveness, end to end, on THIS computer. No credentials, no network, no
// Supabase project, no camera and no face data.
//
//   npm run demo:sandbox
//
// What runs:
//   * a throwaway in-memory database with migrations 001–006, marked
//     development (PGlite);
//   * the provider-webhook function's real handler, served over HTTP on
//     127.0.0.1 and calling the database as the service role;
//   * a sandbox VENDOR EMULATOR that behaves like a vendor's sandbox with
//     test fixtures. Each capture is a synthetic fixture label (for example
//     "person-A/live"), never an image. The emulator does what a 1:N vendor
//     does: a liveness check, then a search of its gallery, then it enrols
//     the person if no match is found. Its "gallery" holds fixture labels
//     only, in memory, and is deleted at the end ("election close").
//
// Synthetic identities only (0815550 06 9x). Prints a step-by-step report;
// exit code 0 only if every step behaved as expected.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { handle } from '../supabase/functions/provider-webhook/handler.ts'
import { sandbox, signSandbox, SIGNATURE_HEADER } from '../supabase/functions/provider-webhook/adapters/sandbox.ts'
import { freshDb, call, sql, LEADER_KEY, DEV_SIM_SQL, PROVIDER_SQL } from '../tests/db/helpers.mjs'

const CV = 'draft-2026-11-dev'
const SECRET = randomBytes(24).toString('hex')
const quiet = process.argv.includes('--quiet')
const steps = []
const say = (s) => { if (!quiet) console.log(s) }
function expect(name, ok, detail = '') {
  steps.push({ name, ok })
  say(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`)
}

// ---------- the database (development, simulated setting) ----------
const db = await freshDb({ migrate: '006' })
await sql(db, `update ypm_private.deployment set environment = 'development'`)
await sql(db, `update settings set verification_provider = 'simulated', registration_mode = 'optional' where id = 1`)
await db.exec(DEV_SIM_SQL)
await db.exec(PROVIDER_SQL)
const tester = (await call(db, 'admin_login', { p_key: LEADER_KEY })).session

// ---------- the webhook function, on 127.0.0.1 ----------
const deps = {
  adapters: { sandbox },
  env: { PROVIDER_ADAPTER: 'sandbox', SANDBOX_WEBHOOK_SECRET: SECRET },
  rpc: async (fn, args) => {
    try {
      return { ok: true, data: await call(db, fn, args, { role: 'service_role' }) }
    } catch {
      return { ok: false }
    }
  },
}
const server = createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
  const out = await handle(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body }), deps)
  res.writeHead(out.status, { 'content-type': 'application/json' })
  res.end(await out.text())
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const WEBHOOK = `http://127.0.0.1:${server.address().port}/functions/v1/provider-webhook`

// ---------- the sandbox vendor emulator (fixture labels, never images) ----------
const vendor = {
  gallery: new Map(), // fixture person -> the session that enrolled them
  async send(event, { secret = SECRET, ageSeconds = 0 } = {}) {
    const t = Math.floor(Date.now() / 1000) - ageSeconds
    const body = JSON.stringify({ ...event, created: t })
    const r = await fetch(WEBHOOK, { method: 'POST', headers: { [SIGNATURE_HEADER]: await signSandbox(secret, body, t) }, body })
    return r.status
  },
  // What a 1:N vendor does with one capture: liveness first, then search
  // the gallery, then enrol if there's no match.
  async verify(sessionRef, fixture) {
    const [person, kind] = fixture.split('/')
    const event = { id: `evt_${randomBytes(8).toString('hex')}`, type: 'verification.completed' }
    if (kind !== 'live') {
      return { status: await this.send({ ...event, data: { session_id: sessionRef, status: 'rejected', reason: 'liveness' } }), event }
    }
    if (this.gallery.has(person)) {
      return { status: await this.send({ ...event, data: { session_id: sessionRef, status: 'requires_review', reason: 'duplicate' } }), event, match: this.gallery.get(person) }
    }
    this.gallery.set(person, sessionRef)
    return { status: await this.send({ ...event, data: { session_id: sessionRef, status: 'verified', reason: null } }), event }
  },
  deleteGallery() {
    const n = this.gallery.size
    this.gallery.clear()
    return n
  },
}

// ---------- helpers on our side ----------
async function register(name, phone) {
  const st = await call(db, 'voter_registration_start', { p_name: name, p_phone: phone, p_consent_version: CV, p_adult: true })
  const sb = await call(db, 'dev_sandbox_start', { p_admin_session: tester, p_registration_token: st.registration_token })
  return { token: st.registration_token, ref: sb.provider_ref }
}
const status = async (token) => (await call(db, 'voter_registration_status', { p_token: token })).status
const reason = async (ref) => (await sql(db, `select reason_code from ypm_private.provider_sessions where provider_ref = $1`, [ref]))[0]?.reason_code

try {
  say('\nSandbox demonstration: duplicate-person detection (1:N) and liveness')
  say('Synthetic fixtures only. No camera, no images, no face data.\n')

  say('1. A new person registers (fixture person-A, live)')
  const a = await register('Test Amina One', '08155500691')
  const ra = await vendor.verify(a.ref, 'person-A/live')
  expect('vendor: liveness passed, no match in the gallery, person-A enrolled', ra.status === 200 && vendor.gallery.has('person-A'))
  expect('our side: approved', (await status(a.token)) === 'approved')
  const claim = await call(db, 'voter_registration_claim', { p_token: a.token })
  expect('the voter collects their code once', claim.status === 'ok' && /^YPM-/.test(claim.voter_code))

  say('\n2. The SAME person tries again with another name and number (person-A, live)')
  const a2 = await register('Test Different Name', '08155500692')
  const ra2 = await vendor.verify(a2.ref, 'person-A/live')
  expect('vendor: liveness passed, 1:N search MATCHED person-A', ra2.status === 200 && ra2.match === a.ref)
  expect('our side: sent to a person for review, not rejected automatically', (await status(a2.token)) === 'review')
  expect('review reason recorded: possible_duplicate', (await reason(a2.ref)) === 'possible_duplicate')
  const queue = await call(db, 'admin_review_details', { p_session: tester })
  expect('the dashboard shows why it waits', queue.reviews.some((r) => r.reason_code === 'possible_duplicate'))
  const reviewId = (await sql(db, `select registration_id from ypm_private.provider_sessions where provider_ref = $1`, [a2.ref]))[0].registration_id
  const rej = await call(db, 'admin_resolve_review', { p_session: tester, p_registration_id: reviewId, p_decision: 'reject' })
  expect('a leader checks in person and rejects the second registration', rej.status === 'ok' && (await status(a2.token)) === 'rejected')
  expect('still one account for person-A', (await sql(db, `select count(*)::int n from voters`))[0].n === 1)

  say('\n3. Liveness: a photo of someone held up to the camera (fixture person-B, photo attack)')
  const b = await register('Test Bola Spoof', '08155500693')
  await vendor.verify(b.ref, 'person-B/photo')
  expect('vendor: liveness FAILED, nothing searched or enrolled', !vendor.gallery.has('person-B'))
  expect('our side: failed (liveness_failed); no account', (await status(b.token)) === 'failed' && (await reason(b.ref)) === 'liveness_failed')

  say('\n4. A different, new person (fixture person-B, live)')
  const b2 = await register('Test Bola Two', '08155500694')
  await vendor.verify(b2.ref, 'person-B/live')
  expect('vendor: no match, person-B enrolled; our side approved', vendor.gallery.has('person-B') && (await status(b2.token)) === 'approved')

  say('\n5. The webhook refuses what a real vendor would never send')
  const c = await register('Test Cleo Checks', '08155500695')
  const forged = await vendor.send({ id: 'evt_forged', type: 'verification.completed', data: { session_id: c.ref, status: 'verified' } }, { secret: 'not-the-secret-not-the-secret-000' })
  expect('forged signature: 401, nothing changes', forged === 401 && (await status(c.token)) === 'pending')
  const replay = await vendor.send({ id: 'evt_old', type: 'verification.completed', data: { session_id: c.ref, status: 'verified' } }, { ageSeconds: 400 })
  expect('replayed 6+ minutes late: 401, nothing changes', replay === 401 && (await status(c.token)) === 'pending')
  const once = { id: 'evt_twice', type: 'verification.completed', data: { session_id: c.ref, status: 'verified' } }
  const s1 = await vendor.send(once)
  const s2 = await vendor.send(once)
  const results = (await sql(db, `select result from ypm_private.verification_events e join ypm_private.provider_sessions s using (registration_id) where s.provider_ref = $1 order by e.id`, [c.ref])).map((x) => x.result)
  expect('delivered twice: applied once', s1 === 200 && s2 === 200 && results.join(',') === 'applied,duplicate')

  say('\n6. A duplicate found AFTER the account exists (late result)')
  const claimB = await call(db, 'voter_registration_claim', { p_token: b2.token })
  expect('person-B collects their code', claimB.status === 'ok')
  const late = await vendor.send({ id: 'evt_late', type: 'verification.completed', data: { session_id: b2.ref, status: 'requires_review', reason: 'duplicate' } })
  const details = await call(db, 'admin_review_details', { p_session: tester })
  expect('the account keeps working (never undone automatically)', late === 200 && (await status(b2.token)) === 'claimed')
  expect('leaders are told to check that account in person', details.late_conflicts.some((x) => x.reason_code === 'possible_duplicate' && x.phone === '•••• 0694'))

  say('\n7. What our database keeps')
  const cols = await sql(db, `select table_name, column_name from information_schema.columns
                               where table_schema = 'ypm_private' and table_name in ('provider_sessions', 'verification_events')
                               order by table_name, ordinal_position`)
  const names = cols.map((x) => x.column_name)
  expect('no image, template, embedding or score columns', !names.some((n) => /image|photo|template|embedding|vector|score|face/i.test(n)), names.join(' '))

  say('\n8. Election close: delete the gallery and our verification records')
  const deleted = vendor.deleteGallery()
  expect(`vendor gallery deleted (${deleted} fixture people)`, vendor.gallery.size === 0 && deleted === 2)
  await db.exec(`
    update voter_registrations set created_at = created_at - interval '31 days', expires_at = expires_at - interval '31 days';
    update ypm_private.verification_events set received_at = received_at - interval '31 days';`)
  const ballotsBefore = (await sql(db, `select count(*)::int n from ballots`))[0].n
  const purge = await call(db, 'admin_purge_verification_records', { p_session: tester })
  expect('our 30-day clean-up deletes finished verification records', purge.status === 'ok' && purge.registrations > 0, `${purge.registrations} registrations, ${purge.events} events`)
  expect('ballots and accounts are kept', (await sql(db, `select count(*)::int n from ballots`))[0].n === ballotsBefore && (await sql(db, `select count(*)::int n from voters`))[0].n === 2)
} catch (e) {
  expect(`unexpected error: ${e.message}`, false)
} finally {
  server.close()
}

const failed = steps.filter((s) => !s.ok).length
console.log(`\n${steps.length - failed} of ${steps.length} steps behaved as expected${failed ? `, ${failed} did not` : ''}.`)
console.log(failed ? 'SANDBOX DEMO FAILED' : 'SANDBOX DEMO PASSED')
process.exit(failed ? 1 : 0)
