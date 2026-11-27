# Biometric vendors for duplicate-person detection (1:N): comparison

**27 Nov 2026. Desk research only:** no accounts created, no terms
accepted, nothing sent to any vendor. Prices and behaviour are as
published or reported at the time. Items marked *unconfirmed* must be
asked of the vendor before choosing.

What we need:
- **1:N duplicate-person detection**, which means a face gallery held at
  the vendor;
- **liveness**;
- **a sandbox with vendor test fixtures**, so no real faces are used;
- **template and gallery deletion**;
- **signed result webhooks**;
- **privacy terms** that fit the Nigeria Data Protection Act.

## Shortlist

### 1. Smile ID (Africa-focused identity verification)
- **1:N:** "Smile Secure", the vendor's duplicate-detection and
  fraud-screening system, runs automatically on its V3 verifications
  (Biometric KYC, Document Verification, SmartSelfie). Results come in the
  webhook's `antifraud.smile_secure`: `status` (`clear` / `attention` /
  `error`) and `suspect_users` with reasons `same-face` or
  `same-id-number`. *Unconfirmed:* whether `same-face` applies to
  SmartSelfie-only registration (without an ID number), and the match
  threshold.
- **Liveness:** SmartSelfie, with ISO 30107-3 listed among its
  certifications.
- **Sandbox:** `testapi.smileidentity.com`, free. It returns
  **predetermined results for test identities** (matched on name and
  email), and test identities are refused in production. *Unconfirmed:*
  whether duplicate (`same-face`) results can be triggered in the sandbox;
  none of the documented test identities is described as a duplicate. No
  test images are supplied.
- **Deletion:** *not found in the API reference.* The nearest endpoint,
  `report_fraud`, flags rather than deletes. No default retention is
  stated. This is a **blocker to clear first**.
- **Webhooks:** HMAC-SHA-256 over timestamp + partner ID + `sid_request`,
  base64, keyed with the API key. Delivered at least once, up to 3 retries,
  no order guarantee. 005's rules already handle all of that.
- **Pricing:** not published; pay as you go by quote. The sandbox is free.
- **Fit:** strong regional fit (Nigeria). The privacy risk: Biometric KYC
  may require collecting a national ID number (NIN or BVN), which this
  project doesn't collect today.

### 2. Amazon Rekognition (cloud API, self-serve)
- **1:N:** face collections. `IndexFaces` enrols, `SearchFacesByImage`
  searches, `DeleteFaces` / `DeleteCollection` delete. **We control the
  gallery** and its deletion directly, in our own AWS account (it is still
  stored by AWS, not in our database).
- **Liveness:** Face Liveness (an Amplify UI capture component plus a
  server-side session).
- **Sandbox:** **no vendor sandbox with fixtures.** Testing uses your own
  account with your own images. Without real faces, that means synthetic
  (AI-generated) face images, which needs your explicit approval. Liveness
  needs a live camera stream, so it can't be exercised without a camera.
- **Deletion:** documented APIs, synchronous and under our control.
- **Webhooks:** none. Our function calls AWS directly and applies the
  result through the same `provider_webhook_result` entry point.
- **Pricing:** the lowest, and published. Reported figures (confirm on
  AWS's page for the chosen region):
  - liveness about $0.015 a check;
  - search and enrol about $0.001 an image;
  - storage $0.00001 a face a month.

  For 1,000 registrations that's roughly **$20**.
- **Privacy:**
  - Face Liveness is offered only in the US, Ireland, Tokyo and Mumbai
    regions (no African region), so data is stored abroad.
  - AWS may use liveness video to improve the service **unless you opt out**
    (AWS Organizations policy), so the opt-out is required.

### 3. Entrust Identity Verification (formerly Onfido): "Known Faces"
- **1:N:** the Known Faces report compares an applicant's latest capture
  with earlier applicants in our account and returns matching applicant
  IDs. It needs a Facial Similarity check.
- **Liveness:** motion or video capture in its SDKs.
- **Sandbox:** **predetermined results whatever is uploaded**, isolated
  from live data. *Unconfirmed:* whether Known Faces matches can be
  triggered in the sandbox.
- **Deletion:** deleting an applicant permanently removes them from future
  matches.
- **Webhooks:** signed HMAC over the body. The closest to our sandbox
  adapter.
- **Pricing:** not published; enterprise quote.
- **Privacy:** an established DPA, hosted in the EU, US or Canada, so data
  is stored abroad. Built for KYC (it also expects a document check);
  confirm Known Faces can be bought with selfie and liveness only.

### Considered and set aside
- **Microsoft Azure Face:** identification and liveness are Limited
  Access. They need registration and approval at Microsoft's discretion,
  for managed customers, and Microsoft has said it isn't accepting new
  managed-customer requests.
- **FaceTec 1:N:** self-hosted, so the face gallery would live on our own
  servers. That contradicts our rule that we never hold templates.
- **Didit, deepidv:** low published 1:N prices, but younger services; a
  privacy and terms review would take longer.

## Comparison

| | Smile ID | Amazon Rekognition | Entrust (Onfido) |
|---|---|---|---|
| 1:N duplicate detection | Smile Secure `same-face` (on V3 verifications) | Collections and search (we run it) | Known Faces report |
| Sandbox with vendor fixtures | Yes, predetermined test identities; duplicate case *unconfirmed* | **No**; own account, own images | Yes, predetermined; Known Faces *unconfirmed* |
| Template or gallery deletion | **Not documented** (blocker) | Yes (`DeleteFaces`, `DeleteCollection`) | Yes (delete applicant) |
| Result delivery | Signed webhook (HMAC, base64) | None (synchronous calls) | Signed webhook (HMAC) |
| Integration effort with our architecture | Medium: adapter, session, SDK; may need ID numbers | Highest: session, capture, search/enrol logic, deletion, no webhook | Medium: adapter, applicant/check calls, SDK |
| Price | Quote; sandbox free | About $20 per 1,000 registrations (published) | Quote |
| Where data is stored | *Ask* (Africa likely) | US, Ireland, Tokyo or Mumbai (liveness) | EU, US or Canada |
| Main privacy concern | National ID numbers; deletion | Data abroad; service-improvement opt-out | Data abroad; bundled document checks |

## Recommendation

Send the same five questions to **Smile ID** and **Entrust** (approval
needed: contacting vendors). Choose the first that answers yes to all
five:
1. Can 1:N duplicate detection run on **selfie and liveness only**, with no
   ID document or ID number?
2. Can the **sandbox return a duplicate match** using your test identities
   or fixtures, with no real faces?
3. Is there an API to **delete one person's face template**, and to delete
   the whole gallery when the election ends? With what confirmation?
4. Where are faces processed and stored? Do you sign a DPA with no model
   training on our data, a sub-processor list and breach notice?
5. What's the price for about [N] registrations?

**Amazon Rekognition** is the fallback if neither answers well: cheapest,
with full deletion control, but no fixture sandbox (testing would need
approved synthetic face images, and a camera for liveness).

## The shortest remaining integration path, whichever vendor

Everything else is built and runs today: `npm run demo:sandbox`, 22 of 22
steps.
1. **Vendor sandbox account** (approval).
2. **Adapter file** for the vendor's signature and result mapping, next to
   `adapters/sandbox.ts`. Map "suspect user" to `possible_duplicate`.
3. **Session creation** server-side (the vendor's API key held as a
   function secret).
4. **Capture:** the vendor's SDK on the Camera screen, sandbox fixtures
   only.
5. **A Development migration** allowing the vendor's name as a provider.
6. **Deletion hooks:** our 30-day clean-up and `erase_voter` call the
   vendor's deletion, and "election close" deletes the gallery.
7. **Re-run the demo scenarios** against the vendor's sandbox in place of
   the emulator.

Sources: docs.usesmileid.com (Smile Secure, sandbox testing, environments,
webhooks, users API), aws.amazon.com/rekognition (pricing, Face Liveness,
collections), documentation.identity.entrust.com (Known Faces, sandbox),
learn.microsoft.com (Face Limited Access).
