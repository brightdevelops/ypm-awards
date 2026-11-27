// Supabase Edge Function: provider-webhook. DEVELOPMENT ONLY, sandbox vendor.
// NOT DEPLOYED. Deploying needs approval; see
// docs/phase-5-provider-integration-plan.md ("Edge Function").
//
// Environment (function secrets, never in the repo):
//   PROVIDER_ADAPTER        'sandbox'
//   SANDBOX_WEBHOOK_SECRET  at least 32 characters, shared with the sandbox vendor
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  provided by Supabase
// Deploy without JWT verification (vendors don't send a Supabase token); the
// signature check is the authentication.
import { handle } from './handler.ts'
import type { Rpc } from './handler.ts'
import { sandbox } from './adapters/sandbox.ts'

declare const Deno: {
  env: { get(name: string): string | undefined; toObject(): Record<string, string> }
  serve(handler: (req: Request) => Response | Promise<Response>): unknown
}

const url = Deno.env.get('SUPABASE_URL')
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const rpc: Rpc = async (fn, args) => {
  if (!url || !key) return { ok: false }
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!r.ok) return { ok: false }
  return { ok: true, data: await r.json() }
}

Deno.serve((req) =>
  handle(req, {
    adapters: { sandbox },
    env: Deno.env.toObject(),
    rpc,
    log: (entry) => console.log(JSON.stringify(entry)),
  }),
)
