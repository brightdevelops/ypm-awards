// The provider webhook, independent of the runtime: index.ts runs it on
// Supabase Edge Functions (Deno); the tests run it in Node.
//
// Order of checks: method, configuration, size, signature (with freshness),
// shape. Only then is the database called, with the mapped fields only,
// through public.provider_webhook_result (service role only), which applies
// 005's rules: idempotent, never upgrades, conflicts go to a person.
//
// Replies: 200 received (also for duplicates, so the vendor stops
// retrying) | 400 malformed or refused | 401 signature | 405 | 413 | 502
// database unreachable (the vendor retries; safe, results are idempotent)
// | 503 not configured or verification disabled.
//
// Logs: adapter, delivery id and the database's result. Never the body,
// headers, the provider reference or anything personal.
import type { Adapter } from './adapters/types.ts'

export const MAX_BODY_BYTES = 16 * 1024

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown }>

export interface Deps {
  adapters: Record<string, Adapter>
  env: Record<string, string | undefined>
  rpc: Rpc
  now?: () => number
  log?: (entry: Record<string, unknown>) => void
}

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? Date.now
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' })

  const adapter = deps.adapters[deps.env.PROVIDER_ADAPTER ?? '']
  const secret = adapter ? deps.env[adapter.secretEnv] : undefined
  if (!adapter || !secret || secret.length < 32) return reply(503, { error: 'not_configured' })

  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) return reply(413, { error: 'too_large' })
  const raw = await req.text()
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return reply(413, { error: 'too_large' })

  const verified = await adapter.verify(req.headers, raw, secret, now())
  if (verified !== 'ok') {
    log({ adapter: adapter.name, rejected: verified })
    return reply(401, { error: verified })
  }

  const parsed = adapter.parse(raw)
  if (parsed.kind === 'malformed') {
    log({ adapter: adapter.name, rejected: 'malformed' })
    return reply(400, { error: 'malformed' })
  }
  if (parsed.kind === 'ignored') return reply(200, { received: true, ignored: true })

  const r = parsed.result
  const res = await deps.rpc('provider_webhook_result', {
    p_provider: adapter.name,
    p_provider_ref: r.providerRef,
    p_delivery_id: r.deliveryId,
    p_outcome: r.outcome,
    p_reason_code: r.reasonCode,
    p_issued_at: r.issuedAt,
  }).catch(() => ({ ok: false }))
  if (!res.ok) {
    log({ adapter: adapter.name, delivery: r.deliveryId, error: 'database_unreachable' })
    return reply(502, { error: 'try_again' })
  }
  const data = (res.data ?? {}) as { status?: string; result?: string }
  log({ adapter: adapter.name, delivery: r.deliveryId, status: data.status, result: data.result })
  if (data.status === 'ok') return reply(200, { received: true })
  if (data.status === 'disabled') return reply(503, { error: 'disabled' })
  if (data.status === 'rejected') return reply(400, { error: 'rejected' })
  return reply(502, { error: 'try_again' })
}
