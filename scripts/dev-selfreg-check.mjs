// Self-registration (migration 008) end to end against the DEVELOPMENT
// project, through its public API exactly as the voting page calls it.
// Refuses any project other than Development. Synthetic numbers only
// (08155509xx); prints statuses, never codes.
//
//   node scripts/dev-selfreg-check.mjs [--ip-limit 3]
//
// --ip-limit N: the value you set in settings.self_registration_per_ip_hour
// for this test; the script then expects this computer's address to be
// paused after at most N new registrations in the hour.
import { readFileSync } from 'node:fs'
import { randomInt } from 'node:crypto'

const DEV_REF = 'vliytvqhjvuhulpvmuat'
const env = Object.fromEntries(readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  .split(/\r?\n/).map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]))
const url = env.VITE_SUPABASE_URL
const key = env.VITE_SUPABASE_ANON_KEY
if (url !== `https://${DEV_REF}.supabase.co`) {
  console.error(`Refusing: .env.local points at ${url}, not Development (${DEV_REF}).`)
  process.exit(2)
}
const limitIdx = process.argv.indexOf('--ip-limit')
const ipLimit = limitIdx > 0 ? Number(process.argv[limitIdx + 1]) : null

async function rpc(fn, args = {}) {
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const body = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${JSON.stringify(body)}`)
  return body
}
const begin = (name, phone, code = null, ballotId = null) =>
  rpc('begin_ballot', { p_name: name, p_phone: phone, p_code: code, p_ballot_id: ballotId })

let failures = 0
const check = (cond, msg, detail = '') => {
  if (cond) console.log(`ok    ${msg}`)
  else { failures += 1; console.log(`FAIL  ${msg}${detail ? ` (${detail})` : ''}`) }
}
// A fresh synthetic number each run: 081555 09 + 3 random digits... kept in the 0815550 9xxx range.
const used = new Set()
const phone = () => { let p; do { p = `0815550${9000 + randomInt(1000)}` } while (used.has(p)); used.add(p); return p }

const status = await rpc('voting_status')
console.log(`info  Development voting_status: ${JSON.stringify(status)}`)
check(status.voting_open === true, 'voting is open on Development')
check(status.require_voting_code === false, 'codes are optional (self-registration mode)')

// 1. Register without an administrator; a code is generated automatically.
const p1 = phone()
const r1 = await begin('Test Selfcheck', p1)
check(r1.status === 'started', 'a new voter starts a ballot straight away', r1.status)
check(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(r1.voter_code ?? ''), 'a voter code was generated automatically')
const v = await rpc('save_vote', { p_ballot_id: r1.ballot_id, p_category_id: 'most-reliable-youth', p_nominee_name: 'Peace Williams' })
check(v.status === 'ok', 'a vote saves', JSON.stringify(v))

// 2. Duplicate phone: no second ballot, and no reopening without the code.
check((await begin('Someone Else', p1)).status === 'resume_required', 'the same number from another device is refused without the code')
check((await begin('Thief', phone(), r1.voter_code)).status === 'invalid_code', 'the code is refused with any other number')

// 3. Resume with the code (another device: no ballot id).
const r2 = await begin('Test Selfcheck', p1, r1.voter_code)
check(r2.status === 'resumed' && r2.ballot_id === r1.ballot_id, 'the voter resumes on another device with their code')
check(Array.isArray(r2.picks) && r2.picks.length === 1, 'their saved vote comes back')
check(r2.voter_code === undefined, 'the code is not shown again')
check((await begin('Test Selfcheck', p1, null, r1.ballot_id)).status === 'resumed', 'the original device resumes too')

// 4. One submitted ballot per number and code.
const s = await rpc('submit_ballot', { p_ballot_id: r1.ballot_id })
check(s.status === 'ok', 'the ballot submits', JSON.stringify(s))
check((await begin('Test Selfcheck', p1)).status === 'already_voted', 'the number can’t vote again')
check((await begin('Test Selfcheck', p1, r1.voter_code)).status === 'already_voted', 'the code can’t vote again')
const s2 = await rpc('submit_ballot', { p_ballot_id: r1.ballot_id })
const v2 = await rpc('save_vote', { p_ballot_id: r1.ballot_id, p_category_id: 'most-reliable-youth', p_nominee_name: 'Sarah Bakare' })
check(v2.status !== 'ok', 'a submitted ballot can’t be changed', JSON.stringify(v2))
console.log(`info  submitting again answers ${JSON.stringify(s2)} (the ballot stays submitted once)`)

// 5. IP limit (only with --ip-limit): this computer's address.
if (ipLimit) {
  let started = 1 // registration 1 above counts
  let paused = null
  for (let i = 0; i < ipLimit + 1 && !paused; i++) {
    const r = await begin('Test Iplimit', phone())
    if (r.status === 'started') started += 1
    else if (r.status === 'rate_limited' && r.reason === 'network') paused = started
    else { check(false, 'unexpected answer while testing the IP limit', r.status); break }
  }
  check(paused !== null && paused <= ipLimit, `this address is paused after ${paused ?? 'more than ' + started} new registrations (limit ${ipLimit})`)
  const resumeOk = (await begin('Test Selfcheck', p1)).status === 'already_voted'
  check(resumeOk, 'a paused address can still check an existing ballot')
} else {
  console.log('info  IP limit not tested (run with --ip-limit N after setting the limit to N)')
}

console.log(failures ? `\nSELF-REGISTRATION CHECK FAILED (${failures})` : '\nSELF-REGISTRATION CHECK PASSED')
process.exit(failures ? 1 : 0)
