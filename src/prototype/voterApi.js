// DEVELOPMENT ONLY. The voter and tester calls used by /prototype/voter.
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

export function createVoterApi(rpc) {
  const inFlight = new Map()

  async function invoke(fn, args) {
    try {
      const { data, error } = await rpc(fn, args)
      if (error || !data || typeof data !== 'object') return { kind: 'failed' }
      if (data.status === 'unauthorized') return { kind: 'unauthorized', data }
      return { kind: 'answer', status: data.status, data }
    } catch {
      return { kind: 'failed' }
    }
  }

  // One request at a time per key: a double tap gets the same promise
  // instead of a second request.
  function once(key, fn, args) {
    if (inFlight.has(key)) return inFlight.get(key)
    const p = invoke(fn, args).finally(() => inFlight.delete(key))
    inFlight.set(key, p)
    return p
  }

  return {
    // Voter
    start: (name, phone, adult, consentVersion) =>
      once('start', 'voter_registration_start', {
        p_name: name,
        p_phone: phone,
        p_consent_version: consentVersion,
        p_adult: adult,
      }),
    status: (token) => invoke('voter_registration_status', { p_token: token }),
    claim: (token) => once('claim', 'voter_registration_claim', { p_token: token }),
    login: (code) => once('login', 'voter_login', { p_code: code }),
    logout: (session) => invoke('voter_logout', { p_session: session }),
    begin: (session) => once('begin', 'voter_begin_ballot', { p_session: session }),
    save: (session, categoryId, nomineeName) =>
      invoke('voter_save_vote', {
        p_session: session,
        p_category_id: categoryId,
        p_nominee_name: nomineeName,
      }),
    submit: (session) => once('submit', 'voter_submit_ballot', { p_session: session }),

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
