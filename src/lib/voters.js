// DEVELOPMENT ONLY (Phase 3.4). The admin "Registered voters" tab: calls to
// the migration 003 admin functions, and the rules for working out what
// really happened when a reply is lost.
//
// Every call goes through the dashboard's adminRpc, which resolves to
//   { kind: 'ok', res }          the server did it
//   { kind: 'unexpected', res }  the server answered and refused
//   { kind: 'unauthorized' }     the admin session has ended (already signed out)
//   { kind: 'network', missing } no usable reply; `missing` means the database
//                                doesn't have the function (003 not installed)
// A 'network' result never means "nothing happened": the request may have
// reached the server. Nothing here retries, and nothing is logged.

export const VOTER_PAGE_SIZE = 50
export const VERIFY_LIMIT = 200

export { isMissingFunction } from './rpcErrors.js'

// Whether the tab may be used at all.
//   isDev:  import.meta.env.DEV (decided at build time; a production build
//           doesn't contain this tab, whatever environment variables say)
//   stats:  the adminRpc result of admin_voter_stats
// The server-side half: with migration 004 every voter function answers
// "disabled" unless the database is marked as development; and
// verification_provider can only be 'simulated' on a development database
// (003), so a production database never shows 'simulated' either.
export function voterAccess(isDev, stats) {
  if (!isDev) return 'hidden'
  if (!stats) return 'loading'
  if (stats.kind === 'network') return stats.missing ? 'not_installed' : 'unreachable'
  if (stats.kind === 'unexpected' && stats.res?.status === 'disabled') return 'not_development'
  if (stats.kind !== 'ok') return 'unreachable'
  if (stats.res.verification_provider !== 'simulated') return 'not_development'
  return 'ready'
}

export function createVoterAdmin(adminRpc) {
  const inFlight = new Map()

  // One request at a time per action: a double click gets the same answer
  // instead of a second request.
  function once(key, fn, args) {
    if (inFlight.has(key)) return inFlight.get(key)
    const p = Promise.resolve(adminRpc(fn, args)).finally(() => inFlight.delete(key))
    inFlight.set(key, p)
    return p
  }

  return {
    stats: () => adminRpc('admin_voter_stats'),
    list: (search = '', offset = 0, limit = VOTER_PAGE_SIZE) =>
      adminRpc('admin_list_voters', {
        p_search: search.trim() || null,
        p_limit: limit,
        p_offset: offset,
      }),
    reviews: () => adminRpc('admin_list_reviews'),

    // p_link_existing_ballot is sent only when linking (004 defaults it to
    // false), so plain approvals also work on a database still at 003.
    resolveReview: (registrationId, decision, linkExistingBallot = false) =>
      once(`review:${registrationId}`, 'admin_resolve_review', {
        p_registration_id: registrationId,
        p_decision: decision,
        ...(linkExistingBallot === true ? { p_link_existing_ballot: true } : {}),
      }),
    reissue: (voterId) => once(`reissue:${voterId}`, 'admin_reissue_voter_code', { p_voter_id: voterId }),
    revoke: (voterId, reason) =>
      once(`revoke:${voterId}`, 'admin_revoke_voter', {
        p_voter_id: voterId,
        p_reason: reason?.trim() || null,
      }),
    registerInPerson: (name, phone, consentVersion, adultConfirmed, linkExistingBallot = false) =>
      once(`register:${phone}`, 'admin_register_voter', {
        p_name: name.trim(),
        p_phone: phone,
        p_consent_version: consentVersion,
        p_adult_confirmed: adultConfirmed === true,
        p_link_existing_ballot: linkExistingBallot === true,
      }),
    restore: (voterId, reason) =>
      once(`restore:${voterId}`, 'admin_restore_voter', {
        p_voter_id: voterId,
        p_reason: reason.trim(),
      }),
    setMode: (mode) => once('mode', 'admin_set_registration_mode', { p_mode: mode }),
  }
}

// ---------- labels ----------

export const MODES = {
  off: {
    label: 'Off',
    effect: 'Nobody can register online. Voting works exactly as before.',
  },
  optional: {
    label: 'Optional',
    effect:
      'People can register for a voter account, or vote as before with their name and phone number.',
  },
  required: {
    label: 'Required',
    effect:
      'New phone numbers can no longer start a ballot without a voter account. Ballots already ' +
      'started on the voting page can still be finished.',
  },
}

export const BALLOT_LABELS = {
  none: 'Not started',
  in_progress: 'In progress',
  submitted: 'Submitted',
}

export const METHOD_LABELS = {
  in_person: 'In person',
  face_simulated: 'Online (simulated check)',
}

export function createdByLabel(createdBy) {
  return createdBy === 'self' ? 'the voter' : createdBy || 'unknown'
}

// "•••• 0012" -> "0012"
export function lastDigits(masked) {
  return String(masked || '').replace(/[^0-9]/g, '')
}

// ---------- working out what happened after a lost reply ----------

const sameName = (a, b) =>
  String(a || '').trim().replace(/\s+/g, ' ').toLowerCase() ===
  String(b || '').trim().replace(/\s+/g, ' ').toLowerCase()

function votersFrom(result) {
  return result?.kind === 'ok' && Array.isArray(result.res?.voters) ? result.res.voters : null
}

// After approving or rejecting a review without a reply.
//
// A review that has left the queue was approved OR rejected (by this admin
// or another one), so its absence proves nothing on its own. Approving
// creates a voter account in the same transaction, and a phone number can
// only ever have one account, so the account is the evidence:
//   still_waiting  the review is still in the queue: nothing was decided
//   approved       an account made from this review exists (method
//                  face_simulated, not self-made, same name and number).
//                  byMe: it was created under this admin's key. Only then
//                  can the lost code be this admin's; otherwise another
//                  admin approved it and has already handed the code over.
//   not_approved   the review is gone and no such account exists: it was
//                  rejected (by you or someone else)
//   unknown        the check itself couldn't be completed
export function reviewOutcome(review, reviewsResult, votersResult, myLabel) {
  if (reviewsResult?.kind !== 'ok') return { outcome: 'unknown' }
  const waiting = (reviewsResult.res?.reviews || []).some((r) => r.id === review.id)
  if (waiting) return { outcome: 'still_waiting' }
  const voters = votersFrom(votersResult)
  if (!voters) return { outcome: 'unknown' }
  const voter = voters.find(
    (v) =>
      v.phone === review.phone &&
      sameName(v.full_name, review.full_name) &&
      v.method === 'face_simulated' &&
      v.created_by !== 'self',
  )
  return voter
    ? { outcome: 'approved', voter, byMe: Boolean(myLabel) && voter.created_by === myLabel }
    : { outcome: 'not_approved' }
}

// After an in-person registration without a reply.
//   created      an in-person account with this name and number exists,
//                created under this admin's key
//   not_created  no account for this number exists: trying again is safe
//   other        the number has an account that isn't this registration
//                (including one another admin registered at the same time)
//   unknown      the check couldn't be completed
export function inPersonOutcome(name, maskedPhone, votersResult, myLabel) {
  const voters = votersFrom(votersResult)
  if (!voters) return { outcome: 'unknown' }
  const forNumber = voters.filter((v) => v.phone === maskedPhone)
  const voter = forNumber.find(
    (v) => v.method === 'in_person' && sameName(v.full_name, name) && Boolean(myLabel) && v.created_by === myLabel,
  )
  if (voter) return { outcome: 'created', voter }
  return forNumber.length ? { outcome: 'other', voter: forNumber[0] } : { outcome: 'not_created' }
}

// After revoking without a reply: look the voter up again.
//   revoked | active | unknown
export function voterStatusNow(voterId, votersResult) {
  const voters = votersFrom(votersResult)
  if (!voters) return { outcome: 'unknown' }
  const voter = voters.find((v) => v.id === voterId)
  if (!voter) return { outcome: 'unknown' }
  return { outcome: voter.status === 'revoked' ? 'revoked' : 'active', voter }
}

// The masked number the server will show for a phone typed in the form.
export function maskLikeServer(phone) {
  const d = String(phone || '')
  return d.length <= 4 ? '••••' : `•••• ${d.slice(-4)}`
}
