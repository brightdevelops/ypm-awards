// Helpers for the admin "Voting codes" tab. Pure functions, no browser APIs,
// so they can be tested directly against real RPC responses.
//
// Plaintext codes only ever pass through codesToCsv / codesToText, which the
// show-once screen calls. Nothing here stores or logs them.

// admin_list_codes returns at most this many codes, newest first.
export const LIST_LIMIT = 500

// The server's states (admin_list_codes), in its precedence order: a code is
// in exactly one of them, so they can be added up.
export const CODE_STATES = ['available', 'used', 'expired', 'revoked']

export const STATE_LABELS = {
  available: 'Available',
  used: 'Used',
  expired: 'Expired',
  revoked: 'Revoked',
}

// Display only: the full number is still sent to the browser by the server.
// "08031234567" -> "•••• 4567"
export function maskPhone(phone) {
  const d = String(phone ?? '').replace(/\D/g, '')
  if (!d) return ''
  if (d.length <= 4) return '••••'
  return `•••• ${d.slice(-4)}`
}

// Code counts that never overstate what is known.
//
//   totals: admin_dashboard().codes = { issued, redeemed, revoked, available }
//           exact database totals. "redeemed" overlaps "revoked" (a used code
//           can be revoked later), so it is not used here.
//   list:   admin_list_codes().codes, the newest LIST_LIMIT codes, each with
//           one state.
//
// If the list holds every code, all four states come from it. If it was cut
// off, only the exact totals are given, plus "used or expired" as one figure
// (issued - available - revoked), and the per-state split of the list itself.
export function codeStats(totals, list) {
  const rows = list || []
  const inList = { available: 0, used: 0, expired: 0, revoked: 0 }
  for (const c of rows) {
    if (c.state in inList) inList[c.state] += 1
  }

  const issued = Number(totals?.issued ?? 0)
  const available = Number(totals?.available ?? 0)
  const revoked = Number(totals?.revoked ?? 0)

  const complete = rows.length < LIST_LIMIT || rows.length === issued

  if (complete) {
    return {
      complete: true,
      listed: rows.length,
      total: rows.length,
      ...inList,
      usedOrExpired: inList.used + inList.expired,
      inList,
      // The two RPCs are separate requests; codes issued or revoked between
      // them make the numbers disagree until the next refresh.
      inSync:
        rows.length === issued && inList.available === available && inList.revoked === revoked,
    }
  }

  return {
    complete: false,
    listed: rows.length,
    total: issued,
    available,
    revoked,
    used: null,
    expired: null,
    usedOrExpired: issued - available - revoked,
    inList,
    inSync: true,
  }
}

// Search and filter the list. Phone numbers match only on their ending, the
// same digits the screen shows.
export function filterCodes(list, { state = 'all', query = '' } = {}) {
  const q = query.trim().toLowerCase()
  const digits = q.replace(/\D/g, '')
  const phoneQuery = digits.length > 0 && digits.length === q.replace(/[\s•]/g, '').length

  return (list || []).filter((c) => {
    if (state !== 'all' && c.state !== state) return false
    if (!q) return true
    if (phoneQuery) return String(c.phone ?? '').endsWith(digits)
    return [c.note, c.voter_name, c.created_by].some((v) =>
      String(v ?? '').toLowerCase().includes(q),
    )
  })
}

export function paginate(items, page, size) {
  const pages = Math.max(1, Math.ceil(items.length / size))
  const p = Math.min(Math.max(1, page), pages)
  return { page: p, pages, items: items.slice((p - 1) * size, p * size) }
}

// The server accepts 1 hour to 60 days.
export const MIN_EXPIRY_HOURS = 1
export const MAX_EXPIRY_HOURS = 24 * 60

export const EXPIRY_PRESETS = {
  none: null,
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
}

// -> { hours } (null = never expires) or { error }
export function expiryHours(option, customValue, now = new Date()) {
  if (option in EXPIRY_PRESETS) return { hours: EXPIRY_PRESETS[option] }
  if (option !== 'custom') return { error: 'Choose when the codes expire.' }

  const at = new Date(customValue)
  if (!customValue || Number.isNaN(at.getTime())) return { error: 'Pick an expiry date and time.' }
  const hours = Math.ceil((at.getTime() - now.getTime()) / 3_600_000)
  if (hours < MIN_EXPIRY_HOURS) return { error: 'The expiry must be at least an hour from now.' }
  if (hours > MAX_EXPIRY_HOURS) return { error: 'The expiry can be at most 60 days from now.' }
  return { hours }
}

export function defaultBatchNote(now = new Date()) {
  const day = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return `Batch ${day} ${time}`
}

export function formatDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
}

// A spreadsheet cell that can't run as a formula, quoted for CSV.
function csvCell(value) {
  let s = String(value ?? '')
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

// codes: admin_issue_codes().codes = [{ code, note, phone, expires_at }]
export function codesToCsv(codes) {
  const rows = [['code', 'restriction', 'note', 'expires']]
  for (const c of codes || []) {
    rows.push([
      c.code,
      c.phone ? `Only phone ${maskPhone(c.phone)}` : 'Any phone, one person',
      c.note ?? '',
      c.expires_at ? formatDateTime(c.expires_at) : 'Never',
    ])
  }
  // BOM so Excel reads it as UTF-8 (the mask uses "•").
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

export function codesToText(codes) {
  return (codes || []).map((c) => c.code).join('\n')
}

export function csvFileName(note, now = new Date()) {
  const slug =
    String(note ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'codes'
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `ypm-voting-codes-${slug}-${stamp}.csv`
}
