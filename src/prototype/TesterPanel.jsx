import { useState } from 'react'
import { OUTCOMES } from './simulator.js'

// DEVELOPMENT ONLY. An authorised tester signs in with a DEV admin key to
// drive the simulated face check and decide reviews. The key is sent once
// and never kept; the admin session lives only in memory (parent state).
// Outcomes here are simulated choices, not biometric results.
export default function TesterPanel({ api, adminSession, setAdminSession, outcome, setOutcome, onRestart }) {
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [reviews, setReviews] = useState(null)
  const [handover, setHandover] = useState(null) // { name, code }: shown until dismissed

  async function signIn(e) {
    e.preventDefault()
    if (busy || !key) return
    setBusy(true)
    setMsg('')
    const r = await api.adminLogin(key)
    setKey('')
    setBusy(false)
    if (r.kind === 'answer' && r.status === 'ok') {
      setAdminSession(r.data.session)
      setLabel(r.data.label)
      return
    }
    setMsg(
      r.kind === 'failed'
        ? 'Couldn’t reach the server.'
        : r.status === 'rate_limited'
          ? 'Too many wrong keys. Paused for 15 minutes.'
          : 'Wrong key.',
    )
  }

  async function signOut() {
    const s = adminSession
    setAdminSession(null)
    setReviews(null)
    setHandover(null)
    setLabel('')
    if (s) await api.adminLogout(s)
  }

  async function loadReviews() {
    setMsg('')
    const r = await api.listReviews(adminSession)
    if (r.kind === 'unauthorized') return expired()
    if (r.kind !== 'answer' || r.status !== 'ok') return setMsg('Couldn’t load reviews.')
    setReviews(r.data.reviews || [])
  }

  function expired() {
    setAdminSession(null)
    setReviews(null)
    setMsg('Tester session ended. Sign in again.')
  }

  async function decide(item, decision) {
    setMsg('')
    const r = await api.resolveReview(adminSession, item.id, decision)
    if (r.kind === 'unauthorized') return expired()
    if (r.kind === 'failed') {
      setMsg('No reply. The decision may have been saved: reload the list before trying again.')
    } else if (r.status === 'ok') {
      if (decision === 'approve') setHandover({ name: item.full_name, code: r.data.voter_code })
      else setMsg(`Rejected ${item.full_name}.`)
    } else {
      setMsg(`Not done: ${r.data?.message || r.status}.`)
    }
    loadReviews()
  }

  return (
    <details className="protoPanel">
      <summary>Tester panel (development only)</summary>

      <p className="small warnText">
        Simulated outcomes only. A “possible duplicate” here is a tester’s choice, not a
        biometric comparison. Use synthetic identities only.
      </p>

      {!adminSession ? (
        <form onSubmit={signIn} className="testerForm">
          <label>
            <span className="small dim">Dev admin key (sent once, never stored)</span>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button className="btn ghost small" disabled={busy || !key}>
            {busy ? 'Checking…' : 'Sign in as tester'}
          </button>
        </form>
      ) : (
        <p className="small">
          Signed in as tester <strong>{label}</strong>.{' '}
          <button type="button" className="linkBtn" onClick={signOut}>
            Sign out
          </button>
        </p>
      )}

      <fieldset>
        <legend>Next face check result</legend>
        {Object.entries(OUTCOMES).map(([id, o]) => (
          <label key={id}>
            <input
              type="radio"
              name="outcome"
              value={id}
              checked={outcome === id}
              onChange={() => setOutcome(id)}
            />
            {o.label}
          </label>
        ))}
      </fieldset>

      {adminSession && (
        <div className="testerReviews">
          <button type="button" className="btn ghost small" onClick={loadReviews}>
            {reviews ? 'Reload review queue' : 'Show review queue'}
          </button>
          {reviews && reviews.length === 0 && <p className="small dim">No registrations awaiting review.</p>}
          {reviews && reviews.length > 0 && (
            <ul>
              {reviews.map((r) => (
                <li key={r.id}>
                  <span>
                    {r.full_name} · {r.phone}
                  </span>
                  <span>
                    <button type="button" className="linkBtn" onClick={() => decide(r, 'approve')}>
                      Approve
                    </button>
                    <button type="button" className="linkBtn" onClick={() => decide(r, 'reject')}>
                      Reject
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {handover && (
        <div className="testerHandover" role="status">
          <p className="small">
            Approved {handover.name}. Hand this code over in person (shown once):
          </p>
          <code>{handover.code}</code>
          <button type="button" className="btn ghost small" onClick={() => setHandover(null)}>
            Done, clear it
          </button>
        </div>
      )}

      {msg && (
        <p className="small warnText" role="status">
          {msg}
        </p>
      )}

      <button type="button" className="btn ghost small" onClick={onRestart}>
        Restart voter flow
      </button>
    </details>
  )
}
