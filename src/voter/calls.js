// The voter's calls (production and the development prototype).
//
// Every call resolves to one of:
//   { kind: 'answer', status, data }  the server replied (status may be a refusal)
//   { kind: 'unauthorized', data }    the session isn't valid
//   { kind: 'failed' }                no usable reply. The request MAY still have
//                                     reached the server and taken effect, so
//                                     callers must not assume nothing happened.
//
// Nothing here retries on its own, and nothing is logged. `rpc` is injected
// (the Supabase client in the app; a test database in tests).

export function createCaller(rpc) {
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

  return { invoke, once }
}

// No online (face-check) registration here: that stays in the development
// prototype's own API.
export function createVoterCalls(rpc, caller = createCaller(rpc)) {
  const { invoke, once } = caller
  return {
    // Migration 006: confirmed by a youth leader instead of a face check.
    requestInPerson: (name, phone, adult, consentVersion) =>
      once('inPerson', 'voter_request_in_person', {
        p_name: name,
        p_phone: phone,
        p_consent_version: consentVersion,
        p_adult: adult,
      }),
    status: (token) => invoke('voter_registration_status', { p_token: token }),
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
  }
}
