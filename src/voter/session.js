// What the voter flow keeps in the browser tab (the development prototype,
// and the production voter page with its own keys).
//
//   voter session:      { session, expiresAt, firstName }
//   registration:       { token, expiresAt, firstName, maskedPhone }
//                       plus { kind: 'in_person', reference } for a request
//                       to be confirmed by a youth leader (migration 006)
//
// Never stored: voter codes, admin keys, the tester's admin session, full
// phone numbers. sessionStorage only (cleared when the tab closes).


function browserStorage() {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

// keys: { voter, registration }, the storage keys to use (the production
// voter page and the development prototype use different ones).
export function createSessionStore(keys, storage = browserStorage(), now = () => Date.now()) {
  function read(key) {
    try {
      const v = JSON.parse(storage?.getItem(key) ?? 'null')
      return v && typeof v === 'object' ? v : null
    } catch {
      return null
    }
  }
  function write(key, value) {
    try {
      if (value) storage?.setItem(key, JSON.stringify(value))
      else storage?.removeItem(key)
    } catch {
      /* private mode: the flow still works, it just won't survive a reload */
    }
  }
  function live(key) {
    const v = read(key)
    if (!v) return null
    const t = Date.parse(v.expiresAt ?? '')
    if (Number.isNaN(t) || t <= now()) {
      write(key, null)
      return null
    }
    return v
  }

  return {
    getVoter: () => live(keys.voter),
    setVoter: ({ session, expiresAt, firstName }) =>
      write(keys.voter, { session, expiresAt, firstName: firstName ?? '' }),
    clearVoter: () => write(keys.voter, null),

    getRegistration: () => live(keys.registration),
    setRegistration: ({ token, expiresAt, firstName, maskedPhone, kind, reference }) =>
      write(keys.registration, {
        token, expiresAt, firstName: firstName ?? '', maskedPhone: maskedPhone ?? '',
        ...(kind === 'in_person' ? { kind, reference: reference ?? '' } : {}),
      }),
    clearRegistration: () => write(keys.registration, null),
  }
}
