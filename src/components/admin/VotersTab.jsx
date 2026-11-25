// DEVELOPMENT ONLY (Phase 3.4). The admin "Registered voters" tab.
// Admin.jsx loads it only when import.meta.env.DEV is true, so it isn't in a
// production build. It also refuses to work unless the database itself is a
// development one (see voterAccess in lib/voters.js).
//
// Phone numbers arrive from the server already shortened ("•••• 0012").
import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatDateTime } from '../../lib/codes.js'
import {
  BALLOT_LABELS,
  METHOD_LABELS,
  MODES,
  VOTER_PAGE_SIZE,
  createVoterAdmin,
  createdByLabel,
  voterAccess,
} from '../../lib/voters.js'
import {
  ModeDialog,
  RegisterInPersonDialog,
  ReissueDialog,
  ResolveReviewDialog,
  RestoreVoterDialog,
  RevokeVoterDialog,
} from './VoterDialogs.jsx'
import './voters.css'

export default function VotersTab({ adminRpc, adminLabel }) {
  const api = useMemo(() => createVoterAdmin(adminRpc), [adminRpc])
  const [stats, setStats] = useState(null) // the adminRpc result of admin_voter_stats
  const [dialog, setDialog] = useState(null)
  const [notice, setNotice] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  const loadStats = useCallback(async () => {
    const r = await api.stats()
    if (r.kind === 'unauthorized') return
    // A failed refresh keeps the last good figures rather than hiding the tab.
    setStats((prev) => (r.kind === 'ok' || prev?.kind !== 'ok' ? r : prev))
  }, [api])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  function refreshAll() {
    loadStats()
    setReloadKey((k) => k + 1)
  }

  // A dialog finished: show what it reports (never a code) and reload
  // everything from the server.
  function done(message) {
    setDialog(null)
    setNotice(message || '')
    refreshAll()
  }

  const access = voterAccess(import.meta.env.DEV, stats)
  if (access === 'hidden') return null
  if (access === 'loading') return <div className="card center dim">Loading voter accounts…</div>
  if (access === 'not_installed') {
    return (
      <div className="card center emptyState">
        <p className="historicalHead">Voter accounts aren’t installed on this database</p>
        <p className="dim small">
          Registered voters need migration 003. Everything else on this dashboard works as usual.
        </p>
      </div>
    )
  }
  if (access === 'unreachable') {
    return (
      <div className="card center" role="alert">
        <p className="error">Could not load voter accounts. Check your connection and try again.</p>
        <button className="btn ghost small inlineBtn" onClick={() => { setStats(null); loadStats() }}>
          Try again
        </button>
      </div>
    )
  }
  if (access === 'not_development') {
    return (
      <div className="card center emptyState">
        <p className="historicalHead">Voter management is switched off for this database</p>
        <p className="dim small">
          It is available only on a database marked as development, with simulated verification
          switched on. Real voter registration isn’t ready for use yet.
        </p>
      </div>
    )
  }

  const s = stats.res
  return (
    <div className="votersTab">
      <div className="sectionHead">
        <div>
          <h2 className="sectionTitle">Registered voters</h2>
          <p className="dim small">
            Development only. Registered voters sign in with a voter code (YPM-…), not a voting
            code, so the “Codes required” setting doesn’t apply to them.
          </p>
        </div>
        <div className="adminActions">
          <button className="btn ghost small" onClick={() => { setNotice(''); refreshAll() }}>
            Refresh
          </button>
          <button className="btn primary small" onClick={() => { setNotice(''); setDialog({ type: 'register' }) }}>
            Register in person
          </button>
        </div>
      </div>

      <p className="callout warn" role="note">
        Online registrations here use <strong>simulated</strong> verification. A “possible
        duplicate” is a tester’s choice, not a biometric comparison. No camera or face data is
        involved anywhere.
      </p>

      {notice && <p className="okBanner" role="status">{notice}</p>}

      <section aria-label="Voter totals">
        <div className="codeStats">
          {[
            ['Active accounts', s.voters_active],
            ['Revoked', s.voters_revoked],
            ['Registered in person', s.in_person],
            ['Registered online', s.self_registered],
            ['Reviews waiting', s.reviews_pending],
            ['Voter ballots submitted', s.voter_ballots_submitted],
            ...(typeof s.voters_without_consent === 'number'
              ? [['Accounts without a consent record', s.voters_without_consent]]
              : []),
          ].map(([label, n]) => (
            <div className="codeStat" key={label}>
              <span className="statNum">{n}</span>
              <span className="statLabel">{label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card voterCard" aria-labelledby="regModeTitle">
        <h3 id="regModeTitle" className="voterCardTitle">Online registration</h3>
        <div className="modeButtons" role="group" aria-label="Registration mode">
          {Object.entries(MODES).map(([id, m]) => (
            <button
              key={id}
              type="button"
              className="chip"
              aria-pressed={s.registration_mode === id}
              onClick={() => {
                if (s.registration_mode === id) return
                setNotice('')
                setDialog({ type: 'mode', next: id })
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="dim small">{MODES[s.registration_mode]?.effect}</p>
        <p className="dim tiny">
          Verification: {s.verification_provider === 'simulated' ? 'simulated (development)' : s.verification_provider}
          {s.consent_version && ` · Consent notice: ${s.consent_version}`}
          {s.adults_only && ' · Adults only'}
        </p>
      </section>

      <ReviewQueue
        api={api}
        reloadKey={reloadKey}
        onDecide={(review, decision) => { setNotice(''); setDialog({ type: 'resolve', review, decision }) }}
      />

      <VoterList
        api={api}
        reloadKey={reloadKey}
        onReissue={(voter) => { setNotice(''); setDialog({ type: 'reissue', voter }) }}
        onRevoke={(voter) => { setNotice(''); setDialog({ type: 'revoke', voter }) }}
        onRestore={(voter) => { setNotice(''); setDialog({ type: 'restore', voter }) }}
      />

      {dialog?.type === 'mode' && (
        <ModeDialog current={s.registration_mode} next={dialog.next} api={api} onDone={done} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'register' && (
        <RegisterInPersonDialog
          api={api}
          adminLabel={adminLabel}
          consentVersion={s.consent_version}
          onDone={done}
          onClose={() => done(null)}
          onReissue={(voter) => setDialog({ type: 'reissue', voter })}
        />
      )}
      {dialog?.type === 'resolve' && (
        <ResolveReviewDialog
          review={dialog.review}
          decision={dialog.decision}
          api={api}
          adminLabel={adminLabel}
          onDone={done}
          onClose={() => setDialog(null)}
          onReissue={(voter) => setDialog({ type: 'reissue', voter })}
        />
      )}
      {dialog?.type === 'reissue' && (
        <ReissueDialog voter={dialog.voter} api={api} onDone={done} onClose={() => done(null)} />
      )}
      {dialog?.type === 'restore' && (
        <RestoreVoterDialog voter={dialog.voter} api={api} onDone={done} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'revoke' && (
        <RevokeVoterDialog voter={dialog.voter} api={api} onDone={done} onClose={() => setDialog(null)} />
      )}
    </div>
  )
}

function ReviewQueue({ api, reloadKey, onDecide }) {
  const [reviews, setReviews] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    const r = await api.reviews()
    if (r.kind === 'unauthorized') return
    if (r.kind !== 'ok') return setError('Could not load the reviews. Refresh to try again.')
    setReviews(r.res.reviews || [])
  }, [api])

  useEffect(() => {
    load()
  }, [load, reloadKey])

  return (
    <section className="card voterCard" aria-labelledby="reviewsTitle">
      <h3 id="reviewsTitle" className="voterCardTitle">
        Reviews waiting{reviews ? ` (${reviews.length})` : ''}
      </h3>
      {error && <p className="error" role="alert">{error}</p>}
      {!error && reviews === null && <p className="dim small">Loading…</p>}
      {reviews?.length === 0 && <p className="dim small">No registrations are waiting for review.</p>}
      {reviews?.length > 0 && (
        <ul className="reviewList">
          {reviews.map((r) => (
            <li key={r.id}>
              <div>
                <strong>{r.full_name}</strong> <span className="dim">{r.phone}</span>
                <div className="dim tiny">
                  {formatDateTime(r.created_at)} ·{' '}
                  {r.provider === 'simulated' ? 'Simulated “possible duplicate” (not biometric)' : r.provider}
                </div>
              </div>
              <div className="adminActions">
                <button type="button" className="btn ghost small" onClick={() => onDecide(r, 'reject')}>
                  Reject
                </button>
                <button type="button" className="btn primary small" onClick={() => onDecide(r, 'approve')}>
                  Approve
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function VoterList({ api, reloadKey, onReissue, onRevoke, onRestore }) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState(null) // { total, voters }
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const r = await api.list(search, offset)
    setLoading(false)
    if (r.kind === 'unauthorized') return
    if (r.kind !== 'ok') return setError('Could not load the voter list. Refresh to try again.')
    setResult({ total: r.res.total, voters: r.res.voters || [] })
  }, [api, search, offset])

  useEffect(() => {
    load()
  }, [load, reloadKey])

  const pages = result ? Math.max(1, Math.ceil(result.total / VOTER_PAGE_SIZE)) : 1
  const page = Math.floor(offset / VOTER_PAGE_SIZE) + 1

  return (
    <section className="card codeListCard" aria-labelledby="votersTitle">
      <h3 id="votersTitle" className="voterCardTitle">Voter accounts</h3>
      <form
        className="listTools"
        onSubmit={(e) => {
          e.preventDefault()
          setOffset(0)
          setSearch(query)
        }}
      >
        <label className="searchBox">
          <span className="srOnly">Search voters</span>
          <input
            type="search"
            placeholder="Name, or the last digits of a phone number"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button type="submit" className="btn ghost small" disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </button>
        <p className="dim small" aria-live="polite">
          {result
            ? `${result.total} account${result.total === 1 ? '' : 's'}${search ? ' match' : ''}. Phone numbers are shortened by the server.`
            : ''}
        </p>
      </form>

      {error && <p className="error" role="alert">{error}</p>}

      {result && result.voters.length === 0 && (
        <p className="dim center emptyRow">{search ? 'No accounts match this search.' : 'No voter accounts yet.'}</p>
      )}

      {result && result.voters.length > 0 && (
        <table className="codeTable">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Phone</th>
              <th scope="col">Account</th>
              <th scope="col">Registered</th>
              <th scope="col">Ballot</th>
              <th scope="col">Last sign-in</th>
              <th scope="col"><span className="srOnly">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {result.voters.map((v) => (
              <tr key={v.id}>
                <td data-label="Name">{v.full_name}</td>
                <td data-label="Phone">{v.phone}</td>
                <td data-label="Account">
                  <span className={`stateChip ${v.status === 'active' ? 'available' : 'revoked'}`}>
                    {v.status === 'active' ? 'Active' : 'Revoked'}
                  </span>
                  {v.revoked_at && <div className="dim tiny">{formatDateTime(v.revoked_at)}</div>}
                </td>
                <td data-label="Registered">
                  {METHOD_LABELS[v.method] ?? v.method}
                  <div className="dim tiny">
                    {formatDateTime(v.created_at)} by {createdByLabel(v.created_by)}
                  </div>
                </td>
                <td data-label="Ballot">{BALLOT_LABELS[v.ballot] ?? v.ballot}</td>
                <td data-label="Last sign-in">
                  {v.last_login_at ? formatDateTime(v.last_login_at) : <span className="dim">Never</span>}
                </td>
                <td className="actionCell">
                  {v.status === 'revoked' && (
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => onRestore(v)}
                      aria-label={`Restore ${v.full_name}’s account`}
                    >
                      Restore
                    </button>
                  )}
                  {v.status === 'active' && (
                    <div className="adminActions">
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => onReissue(v)}
                        aria-label={`Reissue code for ${v.full_name}`}
                      >
                        Reissue code
                      </button>
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => onRevoke(v)}
                        aria-label={`Revoke ${v.full_name}’s account`}
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pages > 1 && (
        <nav className="pager" aria-label="Pages">
          <button type="button" className="btn ghost small" disabled={page <= 1 || loading}
            onClick={() => setOffset(offset - VOTER_PAGE_SIZE)}>
            Previous
          </button>
          <span className="dim small">Page {page} of {pages}</span>
          <button type="button" className="btn ghost small" disabled={page >= pages || loading}
            onClick={() => setOffset(offset + VOTER_PAGE_SIZE)}>
            Next
          </button>
        </nav>
      )}
    </section>
  )
}
