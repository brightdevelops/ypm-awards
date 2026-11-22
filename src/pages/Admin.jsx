import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient.js'
import { BALLOT } from '../data/categories.js'

// One saved session per door, so signing in at /inventor doesn't sign out /admin.
// Only the session token is kept (it expires after 12 hours), never the key.
const DOOR = window.location.pathname.replace(/\/+$/, '') || '/admin'
const SESSION_STORE = `ypm-awards-admin-session${DOOR}`

function readSession() {
  try {
    // Versions before sessions kept the raw key here; don't leave it behind.
    sessionStorage.removeItem(`ypm-awards-admin-key${DOOR}`)
    return sessionStorage.getItem(SESSION_STORE) || ''
  } catch {
    return ''
  }
}

function writeSession(token) {
  try {
    if (token) sessionStorage.setItem(SESSION_STORE, token)
    else sessionStorage.removeItem(SESSION_STORE)
  } catch {
    /* private mode — you'll just sign in again on reload */
  }
}

export default function Admin() {
  const [session, setSession] = useState(readSession)
  const [key, setKey] = useState('')
  const [data, setData] = useState(null)
  const [weakKey, setWeakKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showVoters, setShowVoters] = useState(false)

  function signedOut(message = '') {
    writeSession('')
    setSession('')
    setData(null)
    setError(message)
  }

  async function load(token = session) {
    setBusy(true)
    setError('')
    const { data: res, error: err } = await supabase.rpc('admin_dashboard', { p_session: token })
    setBusy(false)

    if (err) return setError('Could not load. Check your connection and refresh.')
    if (res?.status !== 'ok') return signedOut('Your session has ended. Please sign in again.')
    setData(res)
  }

  async function signIn(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { data: res, error: err } = await supabase.rpc('admin_login', { p_key: key })
    setBusy(false)

    if (err) return setError('Could not sign in. Check your connection and try again.')
    if (res?.status === 'rate_limited')
      return setError('Too many wrong keys. Sign-in is paused for 15 minutes.')
    if (res?.status !== 'ok') return setError('Wrong admin key.')

    setKey('')
    setWeakKey(res.weak_key === true)
    writeSession(res.session)
    setSession(res.session)
    await load(res.session)
  }

  async function signOut() {
    await supabase.rpc('admin_logout', { p_session: session })
    signedOut()
  }

  useEffect(() => {
    if (session) load(session)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function toggleVoting() {
    const next = !data.voting_open
    const label = next ? 'Open voting again?' : 'Close voting now? Nobody will be able to vote after this.'
    if (!window.confirm(label)) return

    setBusy(true)
    const { data: res } = await supabase.rpc('admin_set_voting_open', {
      p_session: session,
      p_open: next,
    })
    if (res?.status === 'unauthorized') {
      setBusy(false)
      return signedOut('Your session has ended. Please sign in again.')
    }
    await load()
  }

  if (!session || !data) {
    if (session && !error) {
      return (
        <div className="shell">
          <div className="inner">
            <div className="card center dim">Loading…</div>
          </div>
        </div>
      )
    }

    return (
      <div className="shell">
        <div className="inner">
          <div className="card">
            <p className="eyebrow">YPM Youth Awards</p>
            <h1 className="display">Admin</h1>
            <form className="form" onSubmit={signIn}>
              <label>
                <span>Admin key</span>
                <input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoComplete="off"
                />
              </label>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="btn primary" disabled={busy}>
                {busy ? 'Checking…' : 'Open dashboard'}
              </button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  const byCategory = {}
  for (const row of data.tally || []) {
    byCategory[row.category_id] = byCategory[row.category_id] || []
    byCategory[row.category_id].push(row)
  }

  return (
    <div className="shell">
      <div className="inner wide">
        <div className="adminHead">
          <div>
            <p className="eyebrow">
              YPM Youth Awards{data.key_label ? ` · ${data.key_label}` : ''}
            </p>
            <h1 className="display">Results dashboard</h1>
          </div>
          <div className="adminActions">
            <button className="btn ghost small" onClick={() => load()} disabled={busy}>
              {busy ? 'Refreshing…' : 'Refresh'}
            </button>
            <button className="btn ghost small" onClick={signOut} disabled={busy}>
              Sign out
            </button>
          </div>
        </div>

        {weakKey && (
          <p className="warn" role="status">
            Your admin key is shorter than 16 characters. Ask whoever manages the database to
            set a longer one with <code>ypm_private.set_admin_key</code>.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="statRow">
          <div className="stat">
            <span className="statNum">{data.ballots_completed}</span>
            <span className="statLabel">Ballots submitted</span>
          </div>
          <div className="stat">
            <span className="statNum">{data.ballots_started - data.ballots_completed}</span>
            <span className="statLabel">In progress</span>
          </div>
          <div className="stat">
            <span className={`statPill ${data.voting_open ? 'open' : 'shut'}`}>
              {data.voting_open ? 'Voting open' : 'Voting closed'}
            </span>
            <button className="btn ghost small" onClick={toggleVoting} disabled={busy}>
              {data.voting_open ? 'Close voting' : 'Reopen voting'}
            </button>
          </div>
          <div className="stat">
            <span className={`statPill ${data.require_voting_code ? 'open' : 'neutral'}`}>
              {data.require_voting_code ? 'Codes required' : 'Codes optional'}
            </span>
            <span className="statLabel">
              {data.codes?.redeemed ?? 0} used · {data.codes?.available ?? 0} available
            </span>
          </div>
        </div>

        {BALLOT.map((c) => {
          const rows = (byCategory[c.id] || []).slice().sort((a, b) => b.votes - a.votes)
          const total = rows.reduce((s, r) => s + Number(r.votes), 0)
          const top = rows[0]
          const tie = rows.length > 1 && Number(rows[1].votes) === Number(top?.votes)

          return (
            <div className="card tallyCard" key={c.id}>
              <div className="tallyHead">
                <h2>{c.name}</h2>
                <span className="dim small">
                  {total} {total === 1 ? 'vote' : 'votes'}
                  {tie ? ' · tie' : ''}
                </span>
              </div>

              {c.nominees.map((n) => {
                const row = rows.find((r) => r.nominee_name === n.name)
                const votes = row ? Number(row.votes) : 0
                const pct = total ? (votes / total) * 100 : 0
                const leading = !tie && top?.nominee_name === n.name && votes > 0

                return (
                  <div className="bar" key={n.name}>
                    <div className="barTop">
                      <span>
                        {n.name}
                        {leading && <span className="barLead">Leading</span>}
                      </span>
                      <span className="barVal">
                        {votes} · {pct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="barTrack">
                      <div className="barFill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}

        <div className="card">
          <button className="linkBtn left" onClick={() => setShowVoters((s) => !s)}>
            {showVoters ? 'Hide' : 'Show'} voter list ({(data.voters || []).length})
          </button>
          {showVoters && (
            <ul className="voters">
              {(data.voters || []).map((v, i) => (
                <li key={i}>
                  <span>{v.voter_name}</span>
                  <span className="dim small">
                    {v.voter_phone} · {v.completed_at ? 'submitted' : 'in progress'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
