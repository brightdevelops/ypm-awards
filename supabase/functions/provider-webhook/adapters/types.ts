// The contract every verification-provider adapter implements. One file per
// vendor; the handler and the database don't change when a vendor is added.
//
// An adapter never passes the vendor's payload on: parse() returns only the
// mapped fields below. Images, templates, scores and personal details in a
// payload are dropped here and never reach the database or the logs.

export type Outcome = 'approved' | 'review' | 'failed' | 'expired'
export type ReasonCode = 'liveness_failed' | 'poor_capture' | 'possible_duplicate' | 'provider_timeout'

export interface ProviderResult {
  providerRef: string // the vendor's session id, as stored in provider_sessions
  deliveryId: string // the vendor's event id (duplicates are recognised by it)
  outcome: Outcome
  reasonCode: ReasonCode | null
  issuedAt: string // ISO time the vendor issued the result
}

export type Parsed =
  | { kind: 'result'; result: ProviderResult }
  | { kind: 'ignored' } // a well-formed event we don't act on
  | { kind: 'malformed' }

export type Verified = 'ok' | 'bad_signature' | 'expired'

export interface Adapter {
  name: string // the provider value in the database
  secretEnv: string // environment variable holding the webhook secret
  verify(headers: Headers, rawBody: string, secret: string, nowMs: number): Promise<Verified>
  parse(rawBody: string): Parsed
}

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/
