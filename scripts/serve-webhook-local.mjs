// Runs the provider-webhook Edge Function's handler on THIS computer, for
// the Development sandbox demonstration, without deploying anything.
// Development only; sandbox vendor only; no face data.
//
// It listens on 127.0.0.1 only and calls the Development database's
// service-role-only entry point (public.provider_webhook_result), exactly as
// the deployed function would. Run it in your own PowerShell window:
//
//   $env:SUPABASE_URL = 'https://vliytvqhjvuhulpvmuat.supabase.co'
//   $env:SUPABASE_SERVICE_ROLE_KEY = '<Development service role key>'   # Dashboard → Project Settings → API
//   $env:SANDBOX_WEBHOOK_SECRET = '<32+ random characters>'
//   node scripts/serve-webhook-local.mjs
//
// The service role key stays in that window's environment: it is never
// written to disk, logged or sent anywhere but the Development project.
// Refuses any project but Development. Stop with Ctrl+C, then close the
// window (or Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY).
import { createServer } from 'node:http'
import { handle, MAX_BODY_BYTES } from '../supabase/functions/provider-webhook/handler.ts'
import { sandbox } from '../supabase/functions/provider-webhook/adapters/sandbox.ts'

const DEV = 'https://vliytvqhjvuhulpvmuat.supabase.co'
const PORT = Number(process.env.PORT ?? 8787)
const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '')
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const secret = process.env.SANDBOX_WEBHOOK_SECRET ?? ''

if (url !== DEV) {
  console.error(`Refusing: SUPABASE_URL must be the Development project (${DEV}).`)
  process.exit(2)
}
if (!key || !secret || secret.length < 32) {
  console.error('Set SUPABASE_SERVICE_ROLE_KEY and SANDBOX_WEBHOOK_SECRET (32+ characters) in this window first.')
  process.exit(2)
}

const rpc = async (fn, args) => {
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!r.ok) return { ok: false }
  return { ok: true, data: await r.json() }
}

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith('/functions/v1/provider-webhook')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES * 2) {
      res.writeHead(413).end()
      return
    }
    body += chunk
  }
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
  const out = await handle(
    new Request(`http://127.0.0.1:${PORT}${req.url}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : body }),
    {
      adapters: { sandbox },
      env: { PROVIDER_ADAPTER: 'sandbox', SANDBOX_WEBHOOK_SECRET: secret },
      rpc,
      // Same log as the deployed function: adapter, delivery id, result.
      log: (entry) => console.log(JSON.stringify(entry)),
    },
  )
  res.writeHead(out.status, { 'content-type': 'application/json' })
  res.end(await out.text())
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Sandbox webhook listening on http://127.0.0.1:${PORT}/functions/v1/provider-webhook (Development only).`)
})
