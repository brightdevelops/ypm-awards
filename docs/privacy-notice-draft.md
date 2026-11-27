# Voter privacy notice: draft for leadership review

**Status: DRAFT, not approved.** Version `ypm-register-2026-12-v1`. For the
project owner and youth leadership. The wording lives in
`src/voter/consentNotice.js`; the voter page takes no registration requests
until it is approved (`CONSENT_APPROVED = true`), and a test refuses that
while any `[MISSING: …]` is left. This is a checklist for review, not legal
advice; confirm with counsel as planned (the Nigeria Data Protection Act
2023 is assumed to apply).

Who sees it: anyone registering on the voter page (`/voter`, "Register
without a face scan"), and anyone a leader registers in person (the leader
shows it to them first).

## The notice as voters will see it

**Who we are.** The YPM Youth Awards are run by **[MISSING: the
organisation's full name and address]**, which is responsible for your
information.

**What we keep.** Your name, your phone number, that you said you are 18 or
older, which version of this notice you agreed to and when, and when you
last signed in. Your voter code is stored only in a scrambled form that
can't be read back. To stop misuse, your phone number and internet address
are kept for up to a day when you register, and your internet address after
a wrong sign-in attempt. No photo, face scan, fingerprint or ID document is
taken or stored.

**Why.** To give you a voter code so that each person votes once, and so a
youth leader can help if you lose it. We rely on your consent. It is not
used for marketing or anything else.

**Your vote.** Your ballot is linked to your account only to stop anyone
voting twice. Youth leaders see whether you have voted, not who you voted
for. Results are only ever shown as totals.

**Who can see it.** The named youth leaders who run the vote see your name
and the last four digits of your number. Your information is stored with
our hosting providers, Supabase (database) and Vercel (website), **[MISSING:
where the data is stored, e.g. the Supabase region]**. It is never sold or
shared with anyone else.

**How long we keep it.** **[MISSING: the retention period, e.g. "Your
account is deleted within 30 days after the results are announced."]**
Requests that a leader hasn't confirmed close after 14 days.

**Your choices.** Registering is optional: you can still vote on the main
voting page with your name and phone number. You can ask to see, correct or
delete your details, or withdraw your consent, at any time by contacting
**[MISSING: the contact for privacy questions, e.g. an email address or
named leader]**. You can also complain to the Nigeria Data Protection
Commission.

**Under 18?** Registration is for people aged 18 or older. If you are under
18 you can still vote on the main voting page, without registering.

## Missing information (leadership to supply)

| # | What | Why it's needed |
|---|---|---|
| 1 | Organisation's full name and address | Voters must know who is responsible for their data |
| 2 | Where the data is stored (Supabase project region; Vercel is global) | Transfers abroad must be disclosed |
| 3 | Retention period for voter accounts | A notice must say how long data is kept |
| 4 | Privacy contact (email or named leader) | For access, correction, deletion and withdrawal requests |

## Decisions and confirmations (leadership)

1. **Retention in practice.** Nothing deletes accounts automatically. On the
   agreed date the database owner runs `ypm_private.erase_voter` for each
   account (or we agree a one-off clean-up script), and an admin uses
   "Clean up now" for finished registrations. Confirm who does this, and
   when.
2. **Who are "the named youth leaders"?** Everyone holding an admin key
   (`/admin`, `/inventor`) sees registered voters' names and masked numbers.
   Confirm that list.
3. **Database access.** The database owner (Supabase account) could
   technically link a ballot to an account. The notice says leaders "see
   whether you have voted, not who you voted for", which is true of the
   dashboard. Confirm who has Supabase access, and whether to mention it.
4. **The anonymous voting page also collects a name and phone number** (it
   always has). This notice covers registration only. Decide whether the
   voting page needs its own short notice (out of scope for this release
   unless you ask).
5. **Under-18s.** They vote on the main voting page without registering.
   Keep registration on **Optional**: Required would stop new numbers,
   including under-18s, from starting a ballot (tested).
6. **Counsel review** of the final text before approval (owner and youth
   leadership coordinate, as agreed).

## Changing it after approval

Fill in the four gaps, get approval, then set `CONSENT_APPROVED = true` in
one commit. If the wording changes **after** 007 has been run in
Production, it needs a new version and a migration publishing it, so every
consent record keeps pointing at the wording that person agreed to.
