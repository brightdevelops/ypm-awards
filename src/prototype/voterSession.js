// DEVELOPMENT ONLY. What the connected voter flow keeps in the browser tab.
//
//   voter session:      { session, expiresAt, firstName }
//   registration:       { token, expiresAt, firstName, maskedPhone }
//
// Never stored: voter codes, admin keys, the tester's admin session, full
// phone numbers. sessionStorage only (cleared when the tab closes).

export const VOTER_KEY = 'ypm-dev-voter-session'
export const REGISTRATION_KEY = 'ypm-dev-voter-registration'

function browserStorage() {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function createSessionStore(storage = browserStorage(), now = () => Date.now()) {
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
    getVoter: () => live(VOTER_KEY),
    setVoter: ({ session, expiresAt, firstName }) =>
      write(VOTER_KEY, { session, expiresAt, firstName: firstName ?? '' }),
    clearVoter: () => write(VOTER_KEY, null),

    getRegistration: () => live(REGISTRATION_KEY),
    setRegistration: ({ token, expiresAt, firstName, maskedPhone }) =>
      write(REGISTRATION_KEY, { token, expiresAt, firstName: firstName ?? '', maskedPhone: maskedPhone ?? '' }),
    clearRegistration: () => write(REGISTRATION_KEY, null),
  }
}
