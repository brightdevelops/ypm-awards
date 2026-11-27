// The privacy notice a voter agrees to when registering with a youth leader
// (no face scan). Production.
//
// CONSENT_VERSION must match the version migration 007 publishes. If the
// wording changes, it needs a NEW version (and a migration publishing it):
// a consent record says which wording someone agreed to.
//
// NOT YET APPROVED. The project owner and youth leadership must approve
// this wording (with the retention period and contact details filled in)
// before release. Until CONSENT_APPROVED is true, the voter page doesn't
// take registration requests; signing in with a code still works.
export const CONSENT_VERSION = 'ypm-register-2026-12-v1'
export const CONSENT_APPROVED = false

export const CONSENT_NOTICE = [
  {
    heading: 'What we keep',
    body: 'Your name and phone number, and when you agreed to this notice. No photo, face scan or ID document is taken or stored.',
  },
  {
    heading: 'Why',
    body: 'To give you a voter code, so that each person votes once. It is not used for anything else, and nobody can see how you voted from it.',
  },
  {
    heading: 'Who can see it',
    body: 'The named youth leaders who run the vote. They see your name and only the last four digits of your number.',
  },
  {
    heading: 'How long we keep it',
    body: '[TO BE CONFIRMED by the project owner: for example, deleted within 30 days after the results are announced.] Your votes are kept separately from your name.',
  },
  {
    heading: 'Your choices',
    body: 'Registering is optional. You can ask a youth leader to see or delete your details at any time. Questions: [contact details to be added].',
  },
]
