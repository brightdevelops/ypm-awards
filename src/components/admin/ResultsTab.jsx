import { useState } from 'react'
import { BALLOT } from '../../data/categories.js'
import { buildResults } from '../../lib/tally.js'
import { maskPhone } from '../../lib/codes.js'

export const votesLabel = (n) => `${n} ${n === 1 ? 'vote' : 'votes'}`

// The results dashboard, as it was before tabs. Only change: voter phone
// numbers are masked (display only; the server still sends them).
export default function ResultsTab({ data }) {
  const [showVoters, setShowVoters] = useState(false)
  const results = buildResults(BALLOT, data.tally)
  const { totals } = results

  return (
    <>
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
        <div className="card tallyCard">
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
          <>
            <p className="dim small maskNote">
              Phone numbers are shortened on screen. This is display only: the full numbers
              still reach this browser.
            </p>
            <ul className="voters">
              {(data.voters || []).map((v, i) => (
                <li key={i}>
                  <span>{v.voter_name}</span>
                  <span className="dim small">
                    {maskPhone(v.voter_phone)} · {v.completed_at ? 'submitted' : 'in progress'}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  )
}
