// Phase 3.3 DEVELOPMENT ONLY: shared constants for the connected voter flow.
//
// There is no camera and no face data. The "face check" result is chosen by
// an authorised tester and recorded by dev_simulate_verification on the
// development database. A simulated "possible duplicate" is the tester's
// choice, NOT a biometric comparison.

// Voter login codes look different from admin-issued voting codes on purpose:
//   voting code (migration 001):      "K7MQP-3XZRA"         10 characters
//   voter login code (migration 003): "YPM-K7MQ-3XZR-A2BC"  prefix + 12 characters
// Same rules as ypm_private.normalize_voter_code.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const GROUP = '[A-HJ-NP-Z2-9]{4}'
export const VOTER_CODE_PATTERN = new RegExp(`^YPM-${GROUP}-${GROUP}-${GROUP}$`)

const format = (body) => `YPM-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`

export function normalizeVoterCode(input) {
  const s = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (s.length !== 15 || !s.startsWith('YPM')) return null
  const body = s.slice(3)
  if ([...body].some((ch) => !ALPHABET.includes(ch))) return null
  return format(body)
}

// An admin-issued voting code: 10 characters, no "YPM" prefix.
export function looksLikeVotingCode(input) {
  const s = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return s.length === 10 && !s.startsWith('YPM')
}

// Synthetic identities only. The development flow accepts phone numbers in
// this fictional range and nothing else, so no real number is ever entered.
export const TEST_PHONE_RANGE = '08155500000 – 08155500999'
export function isTestPhone(normalized) {
  return /^08155500\d{3}$/.test(String(normalized ?? ''))
}

export const CONSENT_VERSION = 'draft-2026-11-dev'

// What the tester can make the next face check do.
//   server: the outcome dev_simulate_verification records
//   lostClaim: the server hands out the code, but the browser acts as if the
//              reply never arrived (tests the uncertain-response screens)
export const OUTCOMES = {
  approved: { label: 'Approved', server: 'approved' },
  review: { label: 'Possible duplicate (simulated, not biometric)', server: 'review' },
  failed: { label: 'Face check failed', server: 'failed' },
  camera_denied: { label: 'Camera permission denied (no server call)', server: null },
  lost_claim: { label: 'Approved, but the code reply is “lost”', server: 'approved', lostClaim: true },
}

export const LIVENESS_PROMPTS = [
  'Look straight at the camera',
  'Turn your head slightly to the left',
  'Turn your head slightly to the right',
  'Blink twice',
]

export const VERIFY_STEPS = [
  { id: 'quality', label: 'Checking photo quality' },
  { id: 'liveness', label: 'Confirming a live person' },
  { id: 'duplicate', label: 'Checking for an existing registration' },
]

// Runs fn after ms; returns a cancel function.
export function after(ms, fn) {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

// "08155500012" -> "•••• 0012"
export function maskPhone(phone) {
  const d = String(phone ?? '').replace(/\D/g, '')
  if (!d) return ''
  return d.length <= 4 ? '••••' : `•••• ${d.slice(-4)}`
}
