import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient.js'
import { BALLOT } from '../data/categories.js'

const KEY_STORE = 'ypm-awards-admin-key'

export default function Admin() {
  const [key, setKey] = useState(() => sessionStorage.getItem(KEY_STORE) || '')
  const [authed, setAuthed] = useState(false)
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showVoters, setShowVoters] = useState(false)

  async function load(k = key) {
    setBusy(true)
    setError('')
    const { data: res, error: err } = await supabase.rpc('get_tally', { p_key: k })
    setBusy(false)

    if (err || !res || res.status === 'unauthorized') {
      setAuthed(false)
      setError('Wrong admin key.')
      return
    }
    sessionStorage.setItem(KEY_STORE, k)
    setAuthed(true)
    setData(res)
  }

  useEffect(() => {
    if (key) load(key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function toggleVoting() {
    const next = !data.voting_open
    const label = next ? 'Open voting again?' : 'Close voting now? Nobody will be able to vote after this.'
    if (!window.confirm(label)) return

    setBusy(true)
    await supabase.rpc('set_voting_open', { p_key: key, p_open: next })
    await load()
  }

  if (!authed) {
    return (
      <div className="shell">
        <div className="inner">
          <div className="card">
            <p className="eyebrow">YPM Youth Awards</p>
            <h1 className="display">Admin</h1>
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault()
                load()
              }}
            >
              <label>
                <span>Admin key</span>
                <input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoComplete="off"
                />
              </label>
              {error && <p className="error">{error}</p>}
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
            <p className="eyebrow">YPM Youth Awards</p>
            <h1 className="display">Results dashboard</h1>
          </div>
          <button className="btn ghost small" onClick={() => load()} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

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
