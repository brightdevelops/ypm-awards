# Phase 4 plan: simulated biometric integration (development only)

**Status: proposal, nothing built.** Synthetic data only. No camera, no face
images, no templates, no real vendor. Each step below is development-only
and enforced by the database (004's switch), like Phase 3.

## Where Phase 3 leaves us

- `voter_registrations.provider` / `provider_ref` and
  `settings.verification_provider` (`none` | `simulated`) already exist (003).
- The only "verification" is a signed-in tester choosing an outcome
  (`dev_simulate_verification`: approved | review | failed). The camera
  screen is a drawing on a timer.
- Results arrive **synchronously** from a trusted admin session. A real
  provider would answer **asynchronously**, from outside, possibly twice, late
  or out of order. That gap is what Phase 4 closes, still without biometrics.

## Goal

Shape the server so that a real provider could later be plugged in by
changing configuration and one adapter, while everything stays simulated:

1. A **provider result** contract instead of a tester's click.
2. **Asynchronous, untrusted delivery** handled safely (signatures, replays,
   duplicates, timeouts).
3. **Data minimisation built in**: the database only ever stores an outcome,
   a provider reference and timestamps. Never images, templates or scores
   beyond a coarse band.

## Steps (in batches)

**4.1 Result contract (migration 005, dev only).**
`ypm_private.apply_verification_result(provider, provider_ref, outcome,
reason_code, received_at)`. Outcomes stay `approved | review | failed`, plus
`expired` (provider gave up). `reason_code` is a short enum (for example
`liveness_failed`, `possible_duplicate`, `poor_capture`), never free text.
Idempotent on `(provider, provider_ref)`: the same result twice changes
nothing; a conflicting second result goes to review, never overwrites.
`dev_simulate_verification` becomes a thin caller of it, so existing tests
keep passing.

**4.2 Simulated provider with delayed, signed callbacks.**
A `simulated_async` provider: starting a registration creates a
`provider_ref`; the tester panel schedules the result (delay, duplicate
delivery, out-of-order, wrong signature, never arrives). Delivery is an HMAC
over the body with a key in Vault, checked inside the database function. No
Edge Function at first: the "callback" is an RPC the tester panel sends, so
no new infrastructure.

**4.3 Failure handling in the voter flow.**
Status polling with back-off; "still checking" after N seconds; expiry after
the registration window; a clear "see a youth leader" path. Reuses the
uncertain-reply patterns from Phase 3 (never assume, always re-check).

**4.4 Retention and erasure.**
Scheduled clean-up of `provider_ref` and finished registrations after a
fixed period (proposed 30 days, needs a decision), using `erase_voter` for
accounts. Tests prove nothing biometric-shaped can be stored (column
whitelist test, like the existing "collects nothing it shouldn't" tests).

**4.5 Admin visibility.**
The review queue shows `reason_code` and delivery history (received,
duplicate, rejected signature) so a leader can see why a case is waiting.
No scores, no images.

Each batch: migration with an undo file, tests (database + simulated
browser), development-only enforcement tests, and the full suite + build.

## Decisions needed before 4.1 (yours)

1. **Approve the migration re-run guards** (001, 002, 003) first, so 005
   lands on a protected chain. Patch and test results are in the Phase 3.5
   report.
2. **Retention period** for registrations and provider references (proposed
   30 days after the election closes).
3. **Callbacks without an Edge Function in Phase 4** (proposed), deferring
   any new hosted infrastructure.
4. Confirm the **consent notice stays a draft** (`draft-2026-11-dev`) for all
   of Phase 4; the wording mentions a face scan that still doesn't happen.

## Out of scope until separately approved

Any real camera access, real face data, a real vendor or vendor account,
under-18 registration, production use, and any legal or privacy sign-off
(a data protection impact assessment is required before a real provider).
