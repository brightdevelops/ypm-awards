// Phase 5.3: the provider-webhook Edge Function's logic (handler.ts and the
// sandbox adapter), run in Node. First on its own, then end to end against a
// test database with migrations 001–006, calling the database the way the
// deployed function does: as the service role. Sandbox data only
// (0815550 05xx); no images, no real vendor.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { handle, MAX_BODY_BYTES } from '../../supabase/functions/provider-webhook/handler.ts'
import { sandbox, signSandbox, SIGNATURE_HEADER, TOLERANCE_SECONDS } from '../../supabase/functions/provider-webhook/adapters/sandbox.ts'
import { freshDb, call, sql, login, DEV_SIM_SQL, PROVIDER_SQL } from '../db/helpers.mjs'

const SECRET = 'sandbox-test-secret-0123456789abcdef'
const ENV = { PROVIDER_ADAPTER: 'sandbox', SANDBOX_WEBHOOK_SECRET: SECRET }
const NOW = 1_800_000_000_000

function event(over = {}, data = {}) {
  return {
    id: 'evt_test_1', type: 'verification.completed', created: Math.floor(NOW / 1000),
    data: { session_id: 'sbx_abc', status: 'verified', reason: null, ...data }, ...over,
  }
}

async function request(body, { secret = SECRET, t = Math.floor(NOW / 1000), method = 'POST', header } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const headers = { 'content-type': 'application/json' }
  if (header !== null) headers[SIGNATURE_HEADER] = header ?? (await signSandbox(secret, raw, t))
  return new Request('http://localhost/functions/v1/provider-webhook', method === 'GET' ? { method, headers } : { method, headers, body: raw })
}

function recorder(reply = { ok: true, data: { status: 'ok', result: 'applied' } }) {
  const calls = []
  const logs = []
  return {
    calls, logs,
    deps: (env = ENV) => ({
      adapters: { sandbox }, env, now: () => NOW,
      rpc: async (fn, args) => { calls.push({ fn, args }); return reply },
      log: (e) => logs.push(e),
    }),
  }
}

const status = async (res) => [res.status, await res.json()]

describe('provider webhook: checks before anything reaches the database', () => {
  it('a correctly signed result is passed on with the mapped fields only', async () => {
    const rec = recorder()
    const body = event({}, {
      status: 'requires_review', reason: 'duplicate',
      // A real vendor might add these; none may be passed on or logged.
      selfie_url: 'https://vendor.example/selfie.jpg', face_template: 'AAAA', match_score: 0.93,
      full_name: 'Test Person', phone: '08155500501',
    })
    assert.deepEqual(await status(await handle(await request(body), rec.deps())), [200, { received: true }])
    assert.deepEqual(rec.calls, [{
      fn: 'provider_webhook_result',
      args: {
        p_provider: 'sandbox', p_provider_ref: 'sbx_abc', p_delivery_id: 'evt_test_1',
        p_outcome: 'review', p_reason_code: 'possible_duplicate', p_issued_at: new Date(NOW).toISOString(),
      },
    }])
    const logged = JSON.stringify(rec.logs)
    for (const s of ['selfie', 'AAAA', '0.93', 'Test Person', '08155500501', 'sbx_abc']) {
      assert.ok(!logged.includes(s), `log must not contain ${s}`)
    }
  })

  it('maps every sandbox status and reason; unknown reasons become none', async () => {
    const cases = [
      ['verified', null, 'approved', null], ['requires_review', 'duplicate', 'review', 'possible_duplicate'],
      ['rejected', 'liveness', 'failed', 'liveness_failed'], ['rejected', 'quality', 'failed', 'poor_capture'],
      ['expired', 'timeout', 'expired', 'provider_timeout'], ['rejected', 'face_score_low', 'failed', null],
    ]
    for (const [st, reason, outcome, code] of cases) {
      const rec = recorder()
      await handle(await request(event({}, { status: st, reason })), rec.deps())
      assert.deepEqual([rec.calls[0].args.p_outcome, rec.calls[0].args.p_reason_code], [outcome, code], st)
    }
  })

  it('refuses bad, missing and tampered signatures (401), and accepts a rotated secret', async () => {
    const rec = recorder()
    const body = event()
    assert.equal((await handle(await request(body, { secret: 'wrong-secret-wrong-secret-wrong-xx' }), rec.deps())).status, 401)
    assert.equal((await handle(await request(body, { header: null }), rec.deps())).status, 401)
    assert.equal((await handle(await request(body, { header: 't=abc,v1=zz' }), rec.deps())).status, 401)
    const good = await signSandbox(SECRET, JSON.stringify(body), Math.floor(NOW / 1000))
    const tampered = new Request('http://localhost/x', {
      method: 'POST', headers: { [SIGNATURE_HEADER]: good },
      body: JSON.stringify(event({}, { status: 'verified', session_id: 'sbx_someone_else' })),
    })
    assert.equal((await handle(tampered, rec.deps())).status, 401)
    assert.equal(rec.calls.length, 0)

    const t = Math.floor(NOW / 1000)
    const oldSig = (await signSandbox('previous-secret-previous-secret-xx', JSON.stringify(body), t)).split(',')[1]
    const both = `${good},${oldSig}`
    assert.equal((await handle(await request(body, { header: both }), rec.deps())).status, 200)
  })

  it('refuses replays older than 5 minutes, even with a valid signature', async () => {
    const rec = recorder()
    const t = Math.floor(NOW / 1000) - TOLERANCE_SECONDS - 1
    assert.deepEqual(await status(await handle(await request(event({ created: t }), { t }), rec.deps())), [401, { error: 'expired' }])
    assert.equal(rec.calls.length, 0)
  })

  it('method, size, configuration and shape', async () => {
    const rec = recorder()
    assert.equal((await handle(await request(event(), { method: 'GET' }), rec.deps())).status, 405)
    assert.equal((await handle(await request(event()), rec.deps({}))).status, 503)
    assert.equal((await handle(await request(event()), rec.deps({ PROVIDER_ADAPTER: 'vendor_x', SANDBOX_WEBHOOK_SECRET: SECRET }))).status, 503)
    assert.equal((await handle(await request(event()), rec.deps({ PROVIDER_ADAPTER: 'sandbox', SANDBOX_WEBHOOK_SECRET: 'short' }))).status, 503)
    const big = JSON.stringify(event({ pad: 'x'.repeat(MAX_BODY_BYTES) }))
    assert.equal((await handle(await request(big), rec.deps())).status, 413)
    assert.equal((await handle(await request('not json'), rec.deps())).status, 400)
    assert.equal((await handle(await request(event({ id: "x'; drop table votes; --" })), rec.deps())).status, 400)
    assert.equal((await handle(await request(event({}, { status: 'approved_by_me' })), rec.deps())).status, 400)
    assert.equal((await handle(await request(event({}, { session_id: 'a'.repeat(100) })), rec.deps())).status, 400)
    assert.deepEqual(await status(await handle(await request(event({ type: 'verification.started' })), rec.deps())), [200, { received: true, ignored: true }])
    assert.equal(rec.calls.length, 0)
  })

  it('database replies: unreachable 502 (vendor retries), disabled 503, refused 400', async () => {
    assert.equal((await handle(await request(event()), recorder({ ok: false }).deps())).status, 502)
    assert.equal((await handle(await request(event()), recorder({ ok: true, data: { status: 'disabled' } }).deps())).status, 503)
    assert.equal((await handle(await request(event()), recorder({ ok: true, data: { status: 'rejected' } }).deps())).status, 400)
    const throws = { adapters: { sandbox }, env: ENV, now: () => NOW, rpc: async () => { throw new Error('network') } }
    assert.equal((await handle(await request(event()), throws)).status, 502)
  })
})

describe('provider webhook end to end, against a test database (sandbox data)', () => {
  const CV = 'draft-2026-11-dev'

  async function setup({ production = false } = {}) {
    const db = await freshDb({ migrate: '006' })
    if (!production) {
      await sql(db, `update ypm_private.deployment set environment = 'development'`)
      await sql(db, `update settings set verification_provider = 'simulated', registration_mode = 'optional' where id = 1`)
      await db.exec(DEV_SIM_SQL)
      await db.exec(PROVIDER_SQL)
    }
    return db
  }
  // As the deployed function calls the database: the service role.
  const serviceRpc = (db, role = 'service_role') => async (fn, args) => {
    try {
      return { ok: true, data: await call(db, fn, args, { role }) }
    } catch {
      return { ok: false }
    }
  }
  const deps = (db, role) => ({ adapters: { sandbox }, env: ENV, rpc: serviceRpc(db, role) })
  const nowEvent = (ref, id, st = 'verified', reason = null) =>
    event({ id, created: Math.floor(Date.now() / 1000) }, { session_id: ref, status: st, reason })
  const send = async (db, body, role) =>
    handle(await request(body, { t: body.created }), deps(db, role))

  async function begin(db, phone) {
    const s = await login(db)
    const st = await call(db, 'voter_registration_start', { p_name: 'Test Webhook', p_phone: phone, p_consent_version: CV, p_adult: true })
    const sb = await call(db, 'dev_sandbox_start', { p_admin_session: s, p_registration_token: st.registration_token })
    assert.equal(sb.status, 'ok')
    return { token: st.registration_token, ref: sb.provider_ref }
  }

  it('verified: the voter is approved and collects their code once; the duplicate delivery changes nothing', async () => {
    const db = await setup()
    const { token, ref } = await begin(db, '08155500501')
    const body = nowEvent(ref, 'evt_e2e_1')
    assert.equal((await send(db, body)).status, 200)
    assert.equal((await send(db, body)).status, 200, 'duplicates are acknowledged')
    assert.equal((await call(db, 'voter_registration_status', { p_token: token })).status, 'approved')
    assert.equal((await call(db, 'voter_registration_claim', { p_token: token })).status, 'ok')
    assert.deepEqual((await sql(db, `select result from ypm_private.verification_events order by id`)).map((e) => e.result), ['applied', 'duplicate'])
  })

  it('a contradicting second result sends it to a person; an unknown reference changes nothing', async () => {
    const db = await setup()
    const { token, ref } = await begin(db, '08155500502')
    await send(db, nowEvent(ref, 'evt_e2e_2'))
    await send(db, nowEvent(ref, 'evt_e2e_3', 'requires_review', 'duplicate'))
    assert.equal((await call(db, 'voter_registration_status', { p_token: token })).status, 'review')
    assert.equal((await send(db, nowEvent('sbx_nobody', 'evt_e2e_4'))).status, 200)
    assert.equal((await sql(db, `select count(*)::int n from ypm_private.verification_events where result = 'unknown_ref'`))[0].n, 1)
  })

  it('stores nothing from the payload beyond outcome, reason and ids', async () => {
    const db = await setup()
    const { ref } = await begin(db, '08155500503')
    const body = nowEvent(ref, 'evt_e2e_5', 'rejected', 'liveness')
    body.data.selfie_url = 'https://vendor.example/selfie.jpg'
    body.data.match_score = 0.12
    assert.equal((await send(db, body)).status, 200)
    const dump = JSON.stringify(await sql(db, `select * from ypm_private.verification_events`)) +
      JSON.stringify(await sql(db, `select * from ypm_private.provider_sessions`)) +
      JSON.stringify(await sql(db, `select * from admin_audit`))
    assert.ok(!dump.includes('selfie') && !dump.includes('0.12'))
  })

  it('a browser role can’t use the entry point (the function would get 502 and the vendor retries)', async () => {
    const db = await setup()
    const { token, ref } = await begin(db, '08155500504')
    assert.equal((await send(db, nowEvent(ref, 'evt_e2e_6'), 'anon')).status, 502)
    assert.equal((await call(db, 'voter_registration_status', { p_token: token })).status, 'pending')
  })

  it('on a production database it answers 503 and changes nothing', async () => {
    const db = await setup({ production: true })
    assert.equal((await send(db, nowEvent('sbx_abc', 'evt_e2e_7'))).status, 503)
    assert.equal((await sql(db, `select count(*)::int n from ypm_private.verification_events`))[0].n, 0)
  })
})
