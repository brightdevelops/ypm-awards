// Plays the SANDBOX verification vendor: sends one signed webhook to the
// provider-webhook Edge Function. Development only; sandbox data only (no
// images, no real vendor). The secret comes from the environment, never
// the command line.
//
//   $env:SANDBOX_WEBHOOK_SECRET = '<same value as the function secret>'
//   node scripts/sandbox-vendor.mjs --url <function URL> --ref sbx_… --status verified
//
// --status   verified | requires_review | rejected | expired
// --reason   liveness | quality | duplicate | timeout (optional)
// --event    event id to send (default: a new one; reuse it to test duplicates)
// --age      seconds to backdate the signature (to test the freshness check)
// --wrong-secret  sign with a different secret (to test the signature check)
import { randomBytes } from 'node:crypto'
import { signSandbox, SIGNATURE_HEADER } from '../supabase/functions/provider-webhook/adapters/sandbox.ts'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const url = opt('url')
const ref = opt('ref')
const status = opt('status') ?? 'verified'
const secret = process.env.SANDBOX_WEBHOOK_SECRET
if (!url || !ref || !secret) {
  console.error('Needs --url, --ref and SANDBOX_WEBHOOK_SECRET in the environment.')
  process.exit(2)
}
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url) && !/^https:\/\/vliytvqhjvuhulpvmuat\.supabase\.co\/functions\/v1\//.test(url)) {
  console.error('Refusing: only a local function or the Development project is allowed.')
  process.exit(2)
}

const now = Math.floor(Date.now() / 1000) - Number(opt('age') ?? 0)
const body = JSON.stringify({
  id: opt('event') ?? `evt_${randomBytes(12).toString('hex')}`,
  type: 'verification.completed',
  created: now,
  data: { session_id: ref, status, reason: opt('reason') ?? null },
})
const signature = await signSandbox(args.includes('--wrong-secret') ? 'not-the-secret-not-the-secret-xx' : secret, body, now)
const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature }, body })
console.log(res.status, await res.text())
