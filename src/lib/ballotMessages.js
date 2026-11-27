// Messages for the voting page when the server refuses a phone number
// because of voter accounts (migration 003). On a database without 003 these
// statuses never appear, so the page behaves exactly as before.

export const START_REFUSALS = {
  registered_voter:
    'This phone number is registered for a voter account, so it can’t start a ballot here. ' +
    'Sign in with your voter code instead.',
  registration_required:
    'Voting now needs a registered voter account. Please see a youth leader to register.',
}

// save_vote and submit_ballot refuse a ballot that a youth leader has linked
// to a voter account. That ballot can't be changed from this page any more,
// so the page stops retrying and says so.
export function isAccountBallot(data) {
  return data?.status === 'error' && data?.message === 'sign in with your voter code'
}

// What a submit_ballot reply means. Only an explicit 'ok' from the server
// counts as submitted: anything else (no reply, an error, an unknown ballot,
// a reply this page doesn't recognise) leaves the ballot unsubmitted on this
// phone. Submitting again is safe: the server never submits a ballot twice.
//   submitted | closed | account | unknown_ballot | unconfirmed
export function submitOutcome(data, err) {
  if (err || !data || typeof data !== 'object') return 'unconfirmed'
  if (data.status === 'ok') return 'submitted'
  if (data.status === 'closed') return 'closed'
  if (isAccountBallot(data)) return 'account'
  if (data.status === 'error' && data.message === 'unknown ballot') return 'unknown_ballot'
  return 'unconfirmed'
}

export const SUBMIT_MESSAGES = {
  unconfirmed:
    'We couldn’t confirm that your vote was submitted. Your picks are still saved on this ' +
    'phone. Check your connection and tap Submit again.',
  unknown_ballot:
    'Your vote has not been submitted: this ballot couldn’t be found. Your picks are still ' +
    'on this phone. Please show this message to a youth leader before closing the page.',
}
