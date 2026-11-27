# Vendor inquiries: duplicate-person detection sandbox

**Drafts, not sent** (27 Nov 2026). Send them yourself from the
organisation's email. Fill in the `[brackets]`. Don't attach any images,
voter data or code.

Where to send them:
- **Smile ID:** the "Talk to an expert" form (smile.id/talk-to-an-expert),
  or your Smile ID contact.
- **Entrust (formerly Onfido):** the Entrust Identity Verification "Contact
  sales" form on entrust.com.

---

## Email 1: Smile ID

**Subject:** Sandbox evaluation: Smile Secure duplicate-face detection (selfie only)

Hello,

We run a youth awards vote in Nigeria for [organisation] and are
evaluating face-based duplicate-person detection, so that one person can't
register twice. We're at the sandbox stage only: no production use, and no
real faces until our privacy review is complete.

Could you confirm:

1. **Selfie-only 1:N.** Can Smile Secure's `same-face` duplicate check run
   on a SmartSelfie registration with liveness only, with no ID document and
   no ID number (NIN or BVN)? If not, which product is the minimum?
2. **Sandbox fixtures.** Can the sandbox (`testapi.smileidentity.com`)
   return a `same-face` duplicate result using your test identities or test
   images, so we can test without any real person's face?
3. **Deletion.** Is there an API to delete one person's enrolled face
   template, and all of our partner data at the end of an election? How is
   deletion confirmed? What is the default retention, and can we set it?
4. **Privacy.**
   - Where are images and templates processed and stored?
   - Will you sign a data processing agreement covering NDPA 2023
     compliance, with no training of models on our data, a sub-processor
     list and breach notice?
   - Are templates kept only in our partner account?
5. **Pricing.** What is the cost per registration (liveness plus duplicate
   check) for about [N] people over [period]? Is the sandbox free, with no
   commitment?

Thank you,
[name, role, organisation, email]

---

## Email 2: Entrust Identity Verification

**Subject:** Sandbox evaluation: Known Faces with selfie and liveness only

Hello,

We run a youth awards vote for [organisation] in Nigeria and are
evaluating face-based duplicate-person detection, so that one person can't
register twice. We're at the sandbox stage only: no production use, and no
real faces until our privacy review is complete.

Could you confirm:

1. **Selfie-only 1:N.** Can the Known Faces report run with Facial
   Similarity and motion liveness only, with no identity document check?
2. **Sandbox fixtures.** Can the sandbox return a Known Faces **match** (or
   no match) on demand, for example with test applicants or sample media,
   without any real person's face? We understand sandbox results are
   predetermined.
3. **Deletion.** Does deleting an applicant remove their face data and
   templates permanently, and from future Known Faces matching? Can we
   delete all our applicants at once at the end of an election? How is
   deletion confirmed? What are the default retention and the configurable
   options?
4. **Privacy.**
   - Which hosting region would apply to us (EU, US or Canada)?
   - Is a data processing agreement available covering NDPA 2023
     compliance, with no training of models on our data, a sub-processor
     list and breach notice?
5. **Pricing.** What is the cost per check (Facial Similarity with motion,
   plus Known Faces) for about [N] people over [period]? Is a sandbox
   available without a paid contract?

Thank you,
[name, role, organisation, email]

---

## How to score the replies

A vendor qualifies only if it answers **yes** to 1, 2 and 3, and gives an
acceptable answer on 4. Price (5) decides between two that qualify.

| Question | Smile ID | Entrust |
|---|---|---|
| 1. Duplicate detection on selfie and liveness only | | |
| 2. Sandbox duplicate result without real faces | | |
| 3. Delete per person, and the whole gallery | | |
| 4. Data location, DPA, no model training | | |
| 5. Price per registration; free sandbox | | |

If neither qualifies, the fallback is Amazon Rekognition (published
pricing, full deletion control, no fixture sandbox): see
`docs/biometric-vendor-comparison.md`.
