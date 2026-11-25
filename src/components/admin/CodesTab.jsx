import { useCallback, useEffect, useState } from 'react'
import CodeStats from './CodeStats.jsx'
import CodeList from './CodeList.jsx'
import GenerateCodesDialog from './GenerateCodesDialog.jsx'
import RevokeCodeDialog from './RevokeCodeDialog.jsx'
import { LIST_LIMIT, codeStats } from '../../lib/codes.js'

export default function CodesTab({ data, adminRpc, reloadDashboard }) {
  const [list, setList] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [dialog, setDialog] = useState(null) // { type: 'generate' } | { type: 'revoke', code }

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    // Both requests together, so the totals and the list are as close in
    // time as possible.
    const [r] = await Promise.all([adminRpc('admin_list_codes'), reloadDashboard()])
    if (r.kind === 'unauthorized') return
    setLoading(false)
    if (r.kind !== 'ok') {
      return setLoadError('Could not load the codes. Check your connection and try again.')
    }
    setList(r.res.codes || [])
  }, [adminRpc, reloadDashboard])

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stats = list ? codeStats(data.codes, list) : null
  const truncated = stats && !stats.complete

  return (
    <div className="codesTab">
      <div className="sectionHead">
        <div>
          <h2 className="sectionTitle">Voting codes</h2>
          <p className="dim small">
            Single-use codes for voters. {data.require_voting_code
              ? 'Codes are currently required for new ballots.'
              : 'Codes are currently optional: voters can start without one.'}
          </p>
        </div>
        <div className="adminActions">
          <button
            className="btn ghost small"
            onClick={() => {
              setNotice('')
              refresh()
            }}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button
            className="btn primary small"
            onClick={() => {
              setNotice('')
              setDialog({ type: 'generate' })
            }}
          >
            Generate codes
          </button>
        </div>
      </div>

      {notice && (
        <p className="okBanner" role="status">
          {notice}
        </p>
      )}

      {loadError && (
        <div className="card center" role="alert">
          <p className="error">{loadError}</p>
          <button className="btn ghost small inlineBtn" onClick={refresh}>
            Try again
          </button>
        </div>
      )}

      {!loadError && list === null && <div className="card center dim">Loading codes…</div>}

      {stats && <CodeStats stats={stats} />}

      {truncated && (
        <p className="callout info" role="note">
          The list shows the newest {LIST_LIMIT} of {stats.total} codes. Older codes aren’t shown
          or searchable here yet, and the per-state numbers in the list cover only these{' '}
          {LIST_LIMIT}. The totals above are exact.
        </p>
      )}
      {stats && stats.complete && !stats.inSync && (
        <p className="callout info" role="note">
          Codes changed while this page was loading. Refresh to bring the numbers up to date.
        </p>
      )}

      {list && (
        <CodeList
          list={list}
          truncated={truncated}
          onRevoke={(code) => {
            setNotice('')
            setDialog({ type: 'revoke', code })
          }}
          onGenerate={() => setDialog({ type: 'generate' })}
        />
      )}

      {dialog?.type === 'generate' && (
        <GenerateCodesDialog
          adminRpc={adminRpc}
          onClose={() => setDialog(null)}
          onIssued={refresh}
        />
      )}
      {dialog?.type === 'revoke' && (
        <RevokeCodeDialog
          code={dialog.code}
          adminRpc={adminRpc}
          onClose={() => setDialog(null)}
          onRevoked={(message) => {
            setDialog(null)
            setNotice(message)
            refresh()
          }}
        />
      )}
    </div>
  )
}
