# Phase 5: real verification provider, integration plan

**Status (27 Nov 2026):** 5.1–5.3 built in migration 006 and
`supabase/functions/provider-webhook`, tested locally, **not applied to any
database and the function is not deployed**. Approved: 5.1, the Edge
Function, sandbox data only.

**Decisions (27 Nov 2026):**
- **Liveness only**, sandbox, with no stored face gallery and no 1:N search
  (option A). The sandbox adapter already works this way: no gallery, no
  scores.
- **The initial release uses the non-biometric youth-leader path** (5.1).
  Face checks stay development-only, behind the privacy gates.
- **The project owner and the youth leadership** coordinate the DPIA and
  the legal review.
- **Feature work is paused** until 005 and 006 are installed on Development
  and integration testing is complete.

Phase 5 prepares the system for a real identity-verification provider. It
does **not** start collecting real biometric data. That only happens after
the privacy gates in section 2 are met and you approve it separately.

## 1. Where Phase 4 leaves us

- The result contract is in place:
  `ypm_private.apply_verification_result(provider_ref, delivery_id, outcome,
  reason_code, issued_at)`. It is idempotent, ignores stale results, never
  upgrades a decision, and sends conflicts to review.
- Results arrive asynchronously, untrusted and signed, and are checked
  inside the database (005).
- Stored per check: outcome, short reason code, provider reference and
  times. Finished records are deleted after 30 days.
- Everything is gated by 004's development switch and
  `verification_provider = 'simulated'`.

A real provider changes three things: who signs the result (the vendor, in
its own format), where the images go (the vendor's systems, never ours),
and the legal footing (biometric data is sensitive personal data).

## 2. Privacy gates (all required before any real face data)

Legal context: the phone formats suggest the organisation operates in
Nigeria. If so, the **Nigeria Data Protection Act 2023** applies, and
biometric data is *sensitive personal data* under it. This list is a
checklist for counsel, not legal advice.

1. **Data protection impact assessment (DPIA)**, completed and signed off
   before the first real check. It covers purpose, necessity (why a face
   check rather than the non-biometric path alone), the risks of a
   duplicate-face gallery, the vendor, transfers abroad, and retention.
2. **Lawful basis: explicit consent**, freely given. It is only free if
   the **non-biometric alternative** (section 4) is equally available and
   carries no disadvantage. Consent must be withdrawable, and withdrawal
   must be as easy as giving it.
3. **Final consent notice** replaces `draft-2026-11-dev`. It names the
   vendor, what is captured, where it is processed, how long the vendor
   keeps it, our 30-day retention, the alternative path and rights. It
   needs a new version in `consent_versions`; 004 already forces re-consent
   when the version changes.
4. **Adults only.** Under-18 registration stays out of scope. Children's
   data needs parental consent and age checks, which this plan doesn't
   cover. The existing `adult_required` check stays.
5. **Vendor data processing agreement (DPA):**
   - The vendor processes data only on our instructions.
   - Images and templates are deleted on completion, or within a stated
     short period.
   - It uses no voter data to train its models.
   - It lists its sub-processors and gives breach notice within 24 to 48
     hours, so we can meet the regulator's 72-hour deadline.
   - It offers audit rights.
6. **Transfers abroad.** If the vendor processes outside Nigeria, record
   the transfer basis (adequacy or contractual safeguards) in the DPIA.
7. **Data minimisation stays enforced by tests.** Our database keeps only
   the outcome, reason code, reference and times. A column whitelist test,
   as in 005, extends to anything Phase 5 adds. No images, templates,
   scores or vendor payloads are stored.
8. **Rights handling.** Access and erasure requests are served by
   `erase_voter` (004) and the 30-day purge. They also need a documented
   request to the vendor to delete its copy.
9. **Breach plan.** Who is told, within 72 hours, and how the provider
   key is rotated.
10. **Registration with the regulator,** if the organisation counts as a
    data controller of major importance. Counsel to confirm.

## 3. Integration design

**Adapter, not a rewrite.** Each vendor gets one adapter that does four
things:

- (a) starts a verification session for a registration token and stores
  only the vendor's session reference;
- (b) verifies the vendor's webhook signature in the vendor's own format;
- (c) maps the vendor's result to `approved | review | failed | expired`
  and a reason code;
- (d) calls `apply_verification_result`.

All of 005's rules (replay, duplicate, stale, conflict, late conflict)
apply unchanged.

**An Edge Function becomes necessary here.** This reverses decision 3 for
Phase 5 only, and needs your approval. Vendors send HTTP webhooks signed
in headers, which a database RPC can't see. A Supabase Edge Function
(`provider-webhook`) would do this:

- verify the vendor's signature with a secret held in the function's
  environment;
- throw away the payload except the mapped fields;
- call a new service-role-only function `ypm_private.provider_result`;
- refuse anything if `verification_provider` isn't the configured vendor.

No vendor payload is logged; function logs record only the reference,
outcome and result.

**Configuration.**
- `settings.verification_provider` gains a vendor value, e.g. `vendor_x`.
  003's check constraint needs widening in migration 006.
- Development uses the vendor's **sandbox** with the vendor's own test
  images only. Never staff or volunteer faces.
- Production stays `none` until the gates are met.

**The duplicate-face question needs your decision.** "One person, one
account" with faces means a **1:N search** against a gallery of every
registered voter's face template, held by the vendor for the whole
election. That is the largest privacy cost in the project. There are two
options:

- **A (recommended):** liveness only, checking a real person is present,
  with no gallery. Duplicates are caught by phone number plus leader
  review, as now.
- **B:** a 1:N duplicate search. It needs a gallery, its retention set
  in the DPIA, and deletion when the election closes.

## 4. Non-biometric alternative (required, equal standing)

The alternative must always be offered, and it must not be slower or
treated as second class. Most of it exists already.

- **Verify with a youth leader.** On the consent screen the voter picks
  "I'd rather not do a face check". They get a pending registration and a
  short reference. A leader confirms them in person, against the person
  and their phone, from the dashboard's review queue. This is close to the
  existing in-person registration (`admin_register_voter`, Phase 3) and the
  review queue. New work: let the voter start it themselves, plus an
  `in_person` reason code.
- **Pre-issued voting codes** (001) remain available, for an election
  where accounts are off.
- **The same account and the same ballot** whichever path is used. Reports
  show only which path, never a ranking or flag.
- **Consent wording** presents both options side by side before any
  camera prompt. Choosing the alternative needs no reason.
- **Tests:** the alternative works with `verification_provider = 'none'`
  and with the vendor configured, and reaches the same final state as the
  face path.

This can be built and tested in Development now, with no biometric data.
I'd do it first (5.1).

## 5. Steps (in batches, each with migration, undo, tests, suite + build)

- **5.1 Non-biometric path, voter-initiated** (migration 006, dev only).
  Pending registration with `in_person` reason, leader confirmation from
  the queue, equal-outcome tests.
- **5.2 Provider abstraction:**
  - widen `verification_provider`;
  - add a provider-neutral `ypm_private.provider_result` (service role
    only) that wraps `apply_verification_result`;
  - make the 005 simulator one adapter among others;
  - prove existing tests are unchanged.
- **5.3 Webhook Edge Function** (after approval), tested locally with
  Supabase's function runtime and the simulator's signing, plus signature,
  replay and oversize tests.
- **5.4 Vendor sandbox adapter**, after vendor selection and a signed DPA.
  It uses sandbox credentials and vendor test images only, on Development.
- **5.5 Retention and deletion with the vendor:**
  - a deletion call to the vendor when our record is purged or the voter
    is erased;
  - a check that the vendor confirms deletion;
  - an election-close purge.
- **5.6 Readiness review:**
  - DPIA sign-off;
  - final consent notice;
  - security review of the function and adapter;
  - a rehearsal on a Production-like copy;
  - then your separate go/no-go for Production.

## 6. Decisions needed (yours)

1. Approve **5.1 (non-biometric path)** to start now in Development.
2. **Liveness only (A)** or **1:N duplicate search (B)**.
3. Allow an **Edge Function** for webhooks from 5.3.
4. Who owns the **DPIA** and the **counsel review**, and the vendor
   shortlist criteria: data location, retention, no training on our data,
   a sandbox, deletion API, price.

## Implementation notes (5.1–5.3)

- **5.1 is migration 006** (`voter_request_in_person`,
  `admin_in_person_requests`, `admin_confirm_in_person`). Requests use
  provider `in_person` and status `review`, so they appear in the
  existing queue; they close after 14 days; 005's 30-day clean-up removes
  them later. No 003/004 function changed.
- **The dashboard works without a face check configured.** It used to
  require `verification_provider = 'simulated'`; it now also opens when
  006's function answers (only on a development database), so in-person
  requests can always be confirmed.
- **Same consent version for both paths.** The draft notice
  (`draft-2026-11-dev`) still describes a face scan. The final notice
  must describe both paths (gate 3).
- **5.2 entry point:** `public.provider_webhook_result`, service role only
  (checked in tests, including after re-running 004 and 005). The sandbox
  adapter maps vendor statuses and reasons to our codes; unknown reasons
  become none, extra payload fields (images, scores, names) are dropped
  and never logged.
- **5.3 Edge Function** (`supabase/functions/provider-webhook`): POST only,
  16 KB limit, HMAC-SHA-256 signature over `<timestamp>.<body>`, 5-minute
  freshness, rotation (several signatures), then the database's own
  checks (shape, 10-minute freshness, provider match). Replies 200 for
  duplicates so the vendor stops retrying; 502 when the database can't be
  reached so it retries (safe: results are idempotent).
- **Deploying it (needs your approval; not done):** set the function
  secrets `PROVIDER_ADAPTER=sandbox` and `SANDBOX_WEBHOOK_SECRET` (32+
  random characters), deploy `provider-webhook` with JWT verification
  off, on Development only. Then
  `node scripts/sandbox-vendor.mjs --url https://vliytvqhjvuhulpvmuat.supabase.co/functions/v1/provider-webhook --ref <sbx_…> --status verified`
  (the script refuses any other project).

## Out of scope until separately approved

Real faces of anyone (including staff) on any environment, vendor
production credentials, under-18 registration, Production use.
