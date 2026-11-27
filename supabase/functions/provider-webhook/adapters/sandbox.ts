// The "sandbox" vendor: a stand-in with a realistic webhook format, for
// development only. There is no real vendor behind it and no biometric data
// in it; scripts/sandbox-vendor.mjs plays the vendor.
//
// Webhook: POST, JSON body
//   { "id": "evt_…", "type": "verification.completed", "created": <unix s>,
//     "data": { "session_id": "sbx_…", "status": "verified" | "requires_review"
//               | "rejected" | "expired", "reason": "liveness" | "quality"
//               | "duplicate" | "timeout" | null } }
// Header: x-sandbox-signature: t=<unix s>,v1=<hex HMAC-SHA-256 of "<t>.<body>">
//   (several v1 values allowed while a secret is being rotated)
import type { Adapter, Outcome, Parsed, ReasonCode, Verified } from './types.ts'
import { ID_PATTERN } from './types.ts'

export const SIGNATURE_HEADER = 'x-sandbox-signature'
export const TOLERANCE_SECONDS = 300

const STATUS: Record<string, Outcome> = {
  verified: 'approved',
  requires_review: 'review',
  rejected: 'failed',
  expired: 'expired',
}
const REASON: Record<string, ReasonCode> = {
  liveness: 'liveness_failed',
  quality: 'poor_capture',
  duplicate: 'possible_duplicate',
  timeout: 'provider_timeout',
}

const enc = new TextEncoder()

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)))
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// What the sandbox vendor sends (used by scripts/sandbox-vendor.mjs and tests).
export async function signSandbox(secret: string, rawBody: string, unixSeconds: number): Promise<string> {
  return `t=${unixSeconds},v1=${await hmacHex(secret, `${unixSeconds}.${rawBody}`)}`
}

async function verify(headers: Headers, rawBody: string, secret: string, nowMs: number): Promise<Verified> {
  const header = headers.get(SIGNATURE_HEADER)
  if (!header || header.length > 1000) return 'bad_signature'
  let t: number | null = null
  const sigs: string[] = []
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=', 2)
    if (k === 't' && /^\d{1,12}$/.test(v ?? '')) t = Number(v)
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v ?? '')) sigs.push(v)
  }
  if (t === null || sigs.length === 0) return 'bad_signature'
  const expected = await hmacHex(secret, `${t}.${rawBody}`)
  if (!sigs.some((s) => sameHex(s, expected))) return 'bad_signature'
  // Checked after the signature, so an unsigned request learns nothing.
  if (Math.abs(nowMs / 1000 - t) > TOLERANCE_SECONDS) return 'expired'
  return 'ok'
}

function parse(rawBody: string): Parsed {
  let msg: unknown
  try {
    msg = JSON.parse(rawBody)
  } catch {
    return { kind: 'malformed' }
  }
  if (!msg || typeof msg !== 'object') return { kind: 'malformed' }
  const m = msg as Record<string, unknown>
  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id) || typeof m.type !== 'string'
      || typeof m.created !== 'number' || !Number.isInteger(m.created) || m.created <= 0) {
    return { kind: 'malformed' }
  }
  if (m.type !== 'verification.completed') return { kind: 'ignored' }
  const d = m.data as Record<string, unknown> | null
  if (!d || typeof d !== 'object' || typeof d.session_id !== 'string' || !ID_PATTERN.test(d.session_id)
      || typeof d.status !== 'string' || !(d.status in STATUS)) {
    return { kind: 'malformed' }
  }
  // An unknown reason becomes "no reason": never passed on as free text.
  const reason = typeof d.reason === 'string' && d.reason in REASON ? REASON[d.reason] : null
  return {
    kind: 'result',
    result: {
      providerRef: d.session_id,
      deliveryId: m.id,
      outcome: STATUS[d.status],
      reasonCode: reason,
      issuedAt: new Date(m.created * 1000).toISOString(),
    },
  }
}

export const sandbox: Adapter = { name: 'sandbox', secretEnv: 'SANDBOX_WEBHOOK_SECRET', verify, parse }
