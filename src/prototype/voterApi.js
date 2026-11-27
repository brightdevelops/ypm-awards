// DEVELOPMENT ONLY. The voter and tester calls used by /prototype/voter.
// The voter calls themselves live in src/voter/calls.js.
//
// Every call resolves to one of:
//   { kind: 'answer', status, data }  the server replied (status may be a refusal)
//   { kind: 'unauthorized', data }    the session (voter or tester) isn't valid
//   { kind: 'failed' }                no usable reply. The request MAY still have
//                                     reached the server and taken effect, so
//                                     callers must not assume nothing happened.
//
// Nothing here retries on its own, and nothing is logged. `rpc` is injected
// (the Supabase client in the app, via connection.js; a test database in
// tests).

import { createCaller, createVoterCalls } from '../voter/calls.js'

export function createVoterApi(rpc) {
  const caller = createCaller(rpc)
  const { invoke, once } = caller

  return {
    // Voter (shared with the production voter page)
    ...createVoterCalls(rpc, caller),
    // Online registration with a (simulated) face check: development only.
    start: (name, phone, adult, consentVersion) =>
      once('start', 'voter_registration_start', {
        p_name: name,
        p_phone: phone,
        p_consent_version: consentVersion,
        p_adult: adult,
      }),
    claim: (token) => once('claim', 'voter_registration_claim', { p_token: token }),

    // Tester (development only; needs a dev admin session)
    simulate: (adminSession, token, outcome) =>
      once('simulate', 'dev_simulate_verification', {
        p_admin_session: adminSession,
        p_registration_token: token,
        p_outcome: outcome,
      }),
    // Simulated provider (migration 005). The callback is what a real
    // provider's webhook would call; here this page relays the deliveries.
    providerStart: (adminSession, token, outcome, reasonCode, delaySeconds, scenario) =>
      once('providerStart', 'dev_provider_start', {
        p_admin_session: adminSession,
        p_registration_token: token,
        p_outcome: outcome,
        p_reason_code: reasonCode ?? null,
        p_delay_seconds: delaySeconds ?? 0,
        p_scenario: scenario,
      }),
    // Sandbox vendor (migration 006): opens a session; the result arrives
    // through the provider-webhook function.
    sandboxStart: (adminSession, token) =>
      once('sandboxStart', 'dev_sandbox_start', { p_admin_session: adminSession, p_registration_token: token }),
    providerOutbox: (adminSession) => invoke('dev_provider_outbox', { p_admin_session: adminSession }),
    providerCallback: (body, signature) => invoke('dev_provider_callback', { p_body: body, p_signature: signature }),
    adminLogin: (key) => once('adminLogin', 'admin_login', { p_key: key }),
    adminLogout: (adminSession) => invoke('admin_logout', { p_session: adminSession }),
    listReviews: (adminSession) => invoke('admin_list_reviews', { p_session: adminSession }),
    resolveReview: (adminSession, registrationId, decision) =>
      once(`resolve:${registrationId}`, 'admin_resolve_review', {
        p_session: adminSession,
        p_registration_id: registrationId,
        p_decision: decision,
      }),
  }
}
