// DEVELOPMENT ONLY. The prototype's session store: the shared one
// (src/voter/session.js) with the prototype's own storage keys.
import { createSessionStore as createStore } from '../voter/session.js'

export const VOTER_KEY = 'ypm-dev-voter-session'
export const REGISTRATION_KEY = 'ypm-dev-voter-registration'

export function createSessionStore(storage, now) {
  return createStore({ voter: VOTER_KEY, registration: REGISTRATION_KEY }, storage, now)
}
