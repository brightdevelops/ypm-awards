// Messages for the voting page when the server refuses a phone number
// because of voter accounts (migration 003). On a database without 003 these
// statuses never appear, so the page behaves exactly as before.

export const START_REFUSALS = {
  registered_voter:
    'This phone number is registered for a voter account, so it can’t start a ballot here. ' +
    'Please see a youth leader.',
  registration_required:
    'Voting now needs a registered voter account. Please see a youth leader to register.',
}

// save_vote and submit_ballot refuse a ballot that a youth leader has linked
// to a voter account. That ballot can't be changed from this page any more,
// so the page stops retrying and says so.
export function isAccountBallot(data) {
  return data?.status === 'error' && data?.message === 'sign in with your voter code'
}
