// Voter codes and phone display, shared by the voter page (production) and
// the development prototype.
//
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

export function maskPhone(phone) {
  const d = String(phone ?? '').replace(/\D/g, '')
  if (!d) return ''
  return d.length <= 4 ? '••••' : `•••• ${d.slice(-4)}`
}
