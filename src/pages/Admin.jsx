import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient.js'
import { BALLOT } from '../data/categories.js'
import { buildResults } from '../lib/tally.js'

const votesLabel = (n) => `${n} ${n === 1 ? 'vote' : 'votes'}`

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
    return true
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

  async function toggleCodeRequired() {
    const next = !data.require_voting_code
    let label
    if (next) {
      label =
        'Require a voting code for new ballots? Anyone without a code won’t be able to start ' +
        'voting. Unfinished ballots can still be resumed on the same phone.'
      if ((data.codes?.available ?? 0) === 0) {
        label += '\n\nWarning: there are no unused codes available yet. Issue codes first, ' +
          'or nobody new will be able to vote.'
      }
    } else {
      label =
        'Make voting codes optional? Anyone will be able to start a ballot with just their ' +
        'name and phone number.'
    }
    if (!window.confirm(label)) return

    setBusy(true)
    let failure = ''
    try {
      const { data: res, error: err } = await supabase.rpc('admin_set_code_required', {
        p_session: session,
        p_required: next,
      })
      if (err) {
        failure =
          'Could not change the code setting. Check your connection and try again. ' +
          'The status below is the current setting.'
      } else if (res?.status === 'unauthorized') {
        setBusy(false)
        return signedOut('Your session has ended. Please sign in again.')
      } else if (res?.status !== 'ok') {
        failure = 'Could not change the code setting. The status below is the current setting.'
      }
    } catch {
      failure =
        'Could not change the code setting. Check your connection and try again. ' +
        'The status below is the current setting.'
    }

    // Always show what the server has, never what we hoped to set.
    // If the refresh itself fails, its own message (or the sign-in screen) is shown instead.
    const refreshed = await load()
    if (failure && refreshed) setError(failure)
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

  const results = buildResults(BALLOT, data.tally)
  const { totals } = results

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
            <button className="btn ghost small" onClick={toggleCodeRequired} disabled={busy}>
              {data.require_voting_code ? 'Make codes optional' : 'Require codes'}
            </button>
          </div>
        </div>

        <p className="dim small tallyNote">
          Counts include submitted ballots only. Rankings and percentages use votes for the
          nominees currently on the ballot.
          {totals.all > totals.current && (
            <>
              {' '}
              {votesLabel(totals.all - totals.current)} were cast for names or categories no
              longer on the ballot. They are shown separately, as recorded, and are not
              included in any ranking.
            </>
          )}
        </p>

        {results.categories.map((c) => (
          <div className="card tallyCard" key={c.id}>
            <div className="tallyHead">
              <h2>{c.name}</h2>
              <span className="dim small">
                {votesLabel(c.currentVotes)} for current nominees
                {c.tie ? ' · tie' : ''}
              </span>
            </div>

            {c.nominees.map((n) => (
              <div className="bar" key={n.name}>
                <div className="barTop">
                  <span>
                    {n.name}
                    {n.leading && <span className="barLead">Leading</span>}
                  </span>
                  <span className="barVal">
                    {n.votes} · {n.share.toFixed(0)}%
                  </span>
                </div>
                <div className="barTrack">
                  <div className="barFill" style={{ width: `${n.share}%` }} />
                </div>
              </div>
            ))}

            {c.historical.length > 0 && (
              <div className="historical">
                <p className="historicalHead">
                  Names no longer on this ballot · {votesLabel(c.historicalVotes)}
                </p>
                <p className="dim small">
                  As recorded. Not included in the ranking or percentages above.
                </p>
                <ul className="historicalList">
                  {c.historical.map((h) => (
                    <li key={h.name}>
                      <span>{h.name}</span>
                      <span className="barVal">{votesLabel(h.votes)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}

        {results.removedCategories.length > 0 && (
          <div className="card tallyCard historicalSection">
            <div className="tallyHead">
              <h2>Categories no longer on the ballot</h2>
              <span className="dim small">{votesLabel(totals.inRemovedCategories)}</span>
            </div>
            <p className="dim small">
              These categories were removed after voting started. Their votes are kept and shown
              as recorded, by category ID. They are not ranked and are not part of any current
              category.
            </p>
            {results.removedCategories.map((rc) => (
              <div className="historical" key={rc.id}>
                <p className="historicalHead">
                  <code>{rc.id}</code> · {votesLabel(rc.votes)}
                </p>
                <ul className="historicalList">
                  {rc.nominees.map((n) => (
                    <li key={n.name}>
                      <span>{n.name}</span>
                      <span className="barVal">{votesLabel(n.votes)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

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
