// The privacy notice a voter agrees to when registering with a youth leader
// (no face scan). Production. Review copy for leadership, with every gap:
// docs/privacy-notice-draft.md.
//
// CONSENT_VERSION must match the version migration 007 publishes. Once a
// version has been published in Production, changing the wording needs a
// NEW version (and a migration publishing it): a consent record says which
// wording someone agreed to.
//
// NOT APPROVED. Only the project owner and youth leadership can approve it.
// Until CONSENT_APPROVED is true the voter page takes no registration
// requests (signing in with a code still works). A test refuses
// CONSENT_APPROVED = true while any "[MISSING" marker is left.
export const CONSENT_VERSION = 'ypm-register-2026-12-v1'
export const CONSENT_APPROVED = false

export const CONSENT_NOTICE = [
  {
    heading: 'Who we are',
    body: 'The YPM Youth Awards are run by [MISSING: the organisation’s full name and address], which is responsible for your information.',
  },
  {
    heading: 'What we keep',
    body: 'Your name, your phone number, that you said you are 18 or older, which version of this notice you agreed to and when, and when you last signed in. Your voter code is stored only in a scrambled form that can’t be read back. To stop misuse, your phone number and internet address are kept for up to a day when you register, and your internet address after a wrong sign-in attempt. No photo, face scan, fingerprint or ID document is taken or stored.',
  },
  {
    heading: 'Why',
    body: 'To give you a voter code so that each person votes once, and so a youth leader can help if you lose it. We rely on your consent. It is not used for marketing or anything else.',
  },
  {
    heading: 'Your vote',
    body: 'Your ballot is linked to your account only to stop anyone voting twice. Youth leaders see whether you have voted, not who you voted for. Results are only ever shown as totals.',
  },
  {
    heading: 'Who can see it',
    body: 'The named youth leaders who run the vote see your name and the last four digits of your number. Your information is stored with our hosting providers, Supabase (database) and Vercel (website), [MISSING: where the data is stored, e.g. the Supabase region]. It is never sold or shared with anyone else.',
  },
  {
    heading: 'How long we keep it',
    body: '[MISSING: the retention period, e.g. “Your account is deleted within 30 days after the results are announced.”] Requests that a leader hasn’t confirmed close after 14 days.',
  },
  {
    heading: 'Your choices',
    body: 'Registering is optional: you can still vote on the main voting page with your name and phone number. You can ask to see, correct or delete your details, or withdraw your consent, at any time by contacting [MISSING: the contact for privacy questions, e.g. an email address or named leader]. You can also complain to the Nigeria Data Protection Commission.',
  },
  {
    heading: 'Under 18?',
    body: 'Registration is for people aged 18 or older. If you are under 18 you can still vote on the main voting page, without registering.',
  },
]
