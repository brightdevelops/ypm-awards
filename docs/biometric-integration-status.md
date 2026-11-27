# Biometric provider integration: status (Development only)

**27 Nov 2026.** Development only, sandbox only, synthetic identities only.
No real face data has been collected anywhere, and biometrics can't be
enabled in Production (the database refuses `verification_provider =
'simulated'` and every provider function outside Development).

## Liveness is not duplicate detection

| | Liveness check | Duplicate-person detection (1:N) |
|---|---|---|
| Question it answers | Is a real, live person in front of the camera now (not a photo, screen or mask)? | Has this person already registered, under any name or number? |
| Compares against | Nothing stored | **Every registered voter's face template** |
| Needs a stored face gallery | No | **Yes**, kept for the whole election (at the vendor) |
| Stops one person voting twice | **No**. The same person passes liveness again with a second phone number | Yes, within the vendor's accuracy |
| Privacy cost | Lower (the vendor processes one capture and deletes it) | Highest in the project (a biometric database of all voters) |
| Decision so far | Chosen on 27 Nov: liveness only, no stored gallery | Ruled out on 27 Nov; **needed for the original objective** |

So **liveness alone does not meet the original objective** of preventing
duplicate voting. Duplicate-person detection needs a 1:N search with a
stored gallery, which reverses the 27 Nov decision. That is yours to make,
with the DPIA owner.

Duplicate controls that work today, without biometrics:
- one account per phone number, enforced by a unique index and locks;
- a registered number can't start an anonymous ballot;
- one ballot per voter;
- the voter code is shown once;
- in-person confirmation by a leader;
- a vendor's "possible duplicate" goes to a person for review, never to an
  automatic rejection.

## Already built (reused, not rebuilt)

| Piece | Where | State |
|---|---|---|
| Result contract: idempotent, no upgrades, conflicts to review, late conflicts flagged | `005` `apply_verification_result` | Installed on Development |
| Signed, asynchronous, untrusted delivery (simulator) | `005` | Installed on Development |
| 30-day retention of verification records | `005` | Installed on Development |
| Review reasons (`liveness_failed`, `poor_capture`, `possible_duplicate`, …) | `005`, dashboard | Installed on Development |
| Sandbox provider sessions; service-role-only result entry point | `006` `dev_sandbox_start`, `provider_webhook_result` | Installed on Development |
| Webhook function: signature, 5-minute freshness, key rotation, size limit, mapping | `supabase/functions/provider-webhook` | Tested; **not deployed** |
| Sandbox vendor adapter: `verified` / `rejected` + `liveness` / `requires_review` + `duplicate` | `adapters/sandbox.ts` | Tested |
| Vendor emulator (plays the sandbox vendor, signs webhooks) | `scripts/sandbox-vendor.mjs` | Tested |
| Non-biometric alternative path | `006`, `/voter` | Installed on Development |

**Added in this batch** (finishing the demo, no new feature):
- **Prototype:** a "Sandbox vendor through the webhook" delivery. It opens
  a sandbox session and shows its reference and the exact vendor command
  in the tester panel, then waits for the webhook's result (up to 5
  minutes).
- **`scripts/serve-webhook-local.mjs`:** runs the webhook function's
  handler on your computer against Development, so nothing is deployed. It
  refuses any project but Development and listens on 127.0.0.1 only.
- **Tests, through the real screens and handler:** liveness passed (code
  shown), liveness failed (nothing created), and possible duplicate (sent
  to review).

## Shortest path to a working sandbox demonstration (no vendor needed)

About 10 minutes, Development only. Three PowerShell windows:

1. **Webhook** (your window; the service role key stays in it):
   ```powershell
   cd C:\Users\Bright\Downloads\ypm-awards
   $env:SUPABASE_URL = 'https://vliytvqhjvuhulpvmuat.supabase.co'
   $env:SUPABASE_SERVICE_ROLE_KEY = '<Development service role key>'
   $env:SANDBOX_WEBHOOK_SECRET = '<32+ random characters>'
   node scripts\serve-webhook-local.mjs
   ```
2. **App:** `npm run dev`, then open `http://localhost:5173/prototype/voter`:
   1. Sign in to the tester panel.
   2. Choose **Sandbox vendor through the webhook**.
   3. Register a fresh `081555009xx` number, agree, and click **Start face
      check**. No camera is used.
3. **Vendor:** set the same `SANDBOX_WEBHOOK_SECRET`, then paste the command
   the tester panel shows. Change `--status` for each case:

   | Vendor says | Command ending | Expected |
   |---|---|---|
   | Liveness passed | `--status verified` | Voter code shown |
   | Liveness failed | `--status rejected --reason liveness` | "We couldn't complete the face check"; nothing created |
   | Possible duplicate person | `--status requires_review --reason duplicate` | Review screen; the dashboard review queue shows "possible duplicate" |
   | Forged | add `--wrong-secret` | 401; nothing changes |
   | Replayed late | add `--age 400` | 401; nothing changes |
   | Sent twice | the same `--event` twice | Applied once |

**What the demo proves:** the whole path a real vendor would use, from
session to signed webhook to server checks to the result rules, the voter
screens and the admin review. **What it doesn't:** any face analysis. The
vendor script decides each outcome; no face is captured or compared.

## What's missing for a real vendor sandbox ("vendor-approved fixtures")

1. **A vendor, its sandbox account and a DPA** (approval). Selection
   criteria are in the Phase 5 plan: data location, deletion API, no
   training on our data, a sandbox with **test fixtures instead of a live
   camera**, and, if duplicate detection is wanted, a 1:N search with a
   deletable gallery.
2. **Session creation on the server.** Today `dev_sandbox_start` creates
   our own `sbx_` reference. A real vendor issues the session id from its
   API, called server-side with a vendor API key held as a function
   secret, never in the browser. This is one small function, plus storing
   the vendor's id in `provider_sessions`.
3. **Capture.** The vendor's web SDK or hosted page replaces the drawing on
   the Camera screen, fed only with the vendor's sandbox fixtures. If a
   vendor's sandbox can't run without a live camera, it isn't usable under
   the current rules (no real facial data).
4. **The vendor's adapter:** one file next to `adapters/sandbox.ts`, for
   its signature scheme and result mapping.
5. **A migration** widening `provider_sessions.provider` to the vendor's
   name. Development only, like 006.
6. **Deletion at the vendor:** a call to the vendor's deletion API when our
   30-day clean-up removes a record or an account is erased.
7. **For duplicate detection only:**
   - enrol each approved person in the vendor's gallery;
   - search the gallery on every new registration;
   - map the vendor's match to `possible_duplicate`, which is already
     handled and goes to review;
   - delete the gallery when the election closes.

   Templates live only at the vendor; our database keeps outcomes and
   reason codes, as now (enforced by tests).

## Approvals needed (yours and leadership's)

**Technical**
- Run the local demo with the Development service role key (step 1), or
  approve deploying `provider-webhook` to **Development** instead.
- Choose a vendor and create a sandbox account, which means accepting its
  terms.

**Privacy and policy**
- **Liveness only, or duplicate-person detection with a stored gallery.**
  This reverses the 27 Nov decision; only the second meets the original
  objective.
- A DPIA covering what's chosen. For 1:N that means the gallery, its
  retention, accuracy and false matches, and transfers abroad. The project
  owner and youth leadership coordinate it, as agreed.
- A biometric consent notice: a new version separate from the
  youth-leader notice, which says "no face scan". It needs explicit
  consent, withdrawal, and the alternative path offered side by side.
- The vendor's data processing agreement: deletion, no training on our
  data, sub-processors, and breach notice.
- Adults only, unchanged. Under-18s use the voting page.
- A separate approval before any real face, staff included, on any
  environment, and before anything biometric in Production.
