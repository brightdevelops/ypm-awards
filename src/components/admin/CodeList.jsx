import { useMemo, useState } from 'react'
import {
  CODE_STATES,
  STATE_LABELS,
  filterCodes,
  formatDateTime,
  maskPhone,
  paginate,
} from '../../lib/codes.js'

const PAGE_SIZE = 25

export default function CodeList({ list, truncated, onRevoke, onGenerate }) {
  const [state, setState] = useState('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)

  const counts = useMemo(() => {
    const c = { all: list.length, available: 0, used: 0, expired: 0, revoked: 0 }
    for (const code of list) if (code.state in c) c[code.state] += 1
    return c
  }, [list])

  const filtered = useMemo(() => filterCodes(list, { state, query }), [list, state, query])
  const view = paginate(filtered, page, PAGE_SIZE)

  if (list.length === 0) {
    return (
      <div className="card center emptyState">
        <p className="historicalHead">No voting codes yet</p>
        <p className="dim small">Generate a batch to hand out, or a code for one phone number.</p>
        <button className="btn primary small inlineBtn" onClick={onGenerate}>
          Generate codes
        </button>
      </div>
    )
  }

  return (
    <div className="card codeListCard">
      <div className="listTools">
        <label className="searchBox">
          <span className="srOnly">Search codes</span>
          <input
            type="search"
            placeholder="Search note, voter, issued by, or last digits of a phone"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(1)
            }}
          />
        </label>
        <div className="chips" role="group" aria-label="Filter by state">
          {['all', ...CODE_STATES].map((s) => (
            <button
              key={s}
              type="button"
              className={`chip ${s}`}
              aria-pressed={state === s}
              onClick={() => {
                setState(s)
                setPage(1)
              }}
            >
              {s === 'all' ? 'All' : STATE_LABELS[s]} <span className="chipCount">{counts[s]}</span>
            </button>
          ))}
        </div>
        <p className="dim small" aria-live="polite">
          {filtered.length === list.length
            ? `${list.length} codes${truncated ? ' (newest only)' : ''}`
            : `${filtered.length} of ${list.length} codes match`}
          . Phone numbers are shortened on screen only.
        </p>
      </div>

      {filtered.length === 0 ? (
        <p className="dim center emptyRow">No codes match this search or filter.</p>
      ) : (
        <table className="codeTable">
          <thead>
            <tr>
              <th scope="col">State</th>
              <th scope="col">Note</th>
              <th scope="col">Restriction</th>
              <th scope="col">Used by</th>
              <th scope="col">Issued</th>
              <th scope="col">Expires</th>
              <th scope="col">
                <span className="srOnly">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {view.items.map((c) => (
              <tr key={c.id}>
                <td data-label="State">
                  <span className={`stateChip ${c.state}`}>{STATE_LABELS[c.state]}</span>
                </td>
                <td data-label="Note" className="noteCell">
                  {c.note || <span className="dim">—</span>}
                </td>
                <td data-label="Restriction">
                  {c.phone ? (
                    <span className="bound">Phone {maskPhone(c.phone)}</span>
                  ) : (
                    <span className="dim">Any phone</span>
                  )}
                </td>
                <td data-label="Used by">
                  {c.voter_name || <span className="dim">—</span>}
                  {c.redeemed_at && <div className="dim tiny">{formatDateTime(c.redeemed_at)}</div>}
                </td>
                <td data-label="Issued">
                  {formatDateTime(c.created_at)}
                  <div className="dim tiny">by {c.created_by}</div>
                </td>
                <td data-label="Expires">
                  {c.revoked_at ? (
                    <span className="dim">Revoked {formatDateTime(c.revoked_at)}</span>
                  ) : c.redeemed_at ? (
                    <span className="dim">—</span>
                  ) : c.expires_at ? (
                    formatDateTime(c.expires_at)
                  ) : (
                    <span className="dim">Never</span>
                  )}
                </td>
                <td className="actionCell">
                  {c.state !== 'revoked' && (
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => onRevoke(c)}
                      aria-label={`Revoke code${c.note ? ` “${c.note}”` : ''}, issued ${formatDateTime(c.created_at)}`}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {view.pages > 1 && (
        <nav className="pager" aria-label="Pages">
          <button
            type="button"
            className="btn ghost small"
            onClick={() => setPage(view.page - 1)}
            disabled={view.page <= 1}
          >
            Previous
          </button>
          <span className="dim small">
            Page {view.page} of {view.pages}
          </span>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => setPage(view.page + 1)}
            disabled={view.page >= view.pages}
          >
            Next
          </button>
        </nav>
      )}
    </div>
  )
}
