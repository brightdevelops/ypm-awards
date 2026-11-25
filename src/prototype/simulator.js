// Phase 3.1 PROTOTYPE ONLY. Everything here is simulated.
//
// No camera, no face data, no network, no storage. "Verification" is a timer
// that returns whatever outcome the reviewer picked in the prototype panel.
// Nothing in this folder may be presented as working face recognition.

// Voter login codes look different from admin-issued voting codes on purpose:
//   voting code (migration 001):     "K7MQP-3XZRA"         10 characters
//   voter login code (migration 003): "YPM-K7MQ-3XZR-A2BC"  prefix + 12 characters
// Normalised (letters and digits only) they are 10 vs 15 characters long and
// a voter code always starts with "YPM", so one can never be mistaken for the
// other. Same rules as ypm_private.normalize_voter_code.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O, 1/I, as in 001
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

// Fictional code for the prototype. The real one comes from the server.
export function demoVoterCode(random = Math.random) {
  let body = ''
  for (let i = 0; i < 12; i++) body += ALPHABET[Math.floor(random() * ALPHABET.length)]
  return format(body)
}

// Fictional returning voter, so the login screen can be tried.
export const DEMO_RETURNING = {
  code: 'YPM-TEST-2345-HJKM', // fictional; "O" isn't in the alphabet, so not "DEMO"
  firstName: 'Ada',
  ballot: { answered: 7, total: 18 },
}

// Fictional voter whose ballot is already submitted: one ballot per voter.
export const DEMO_SUBMITTED = {
  code: 'YPM-VQTE-2345-HJKM',
  firstName: 'Bayo',
  submitted: true,
}

export const OUTCOMES = {
  approved: 'Registration approved',
  duplicate: 'Possible duplicate found',
  liveness_failed: 'Liveness check failed',
  camera_denied: 'Camera permission denied',
  network: 'Connection lost',
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

// Resolves after `ms`, unless cancelled. Returns a cancel function.
export function after(ms, fn) {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

// "07012345678" -> "•••• 5678"
export function maskPhone(phone) {
  const d = String(phone ?? '').replace(/\D/g, '')
  if (!d) return ''
  return d.length <= 4 ? '••••' : `•••• ${d.slice(-4)}`
}
