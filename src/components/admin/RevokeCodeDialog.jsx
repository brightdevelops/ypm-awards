import { useRef, useState } from 'react'
import Dialog from './Dialog.jsx'
import { STATE_LABELS, formatDateTime, maskPhone } from '../../lib/codes.js'

const EFFECT = {
  available: 'Nobody will be able to use this code. If it has already been handed out, that person will need a new one.',
  used:
    'The voter’s ballot and votes stay exactly as they are. The code can no longer be used to reopen that ballot on another phone. Do this if the code may have been seen by someone else.',
  expired:
    'This code has already expired and can’t start a ballot. Revoking it just marks it as withdrawn.',
}

export default function RevokeCodeDialog({ code, adminRpc, onClose, onRevoked }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)

  async function revoke() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    const r = await adminRpc('admin_revoke_code', { p_code_id: code.id })
    inFlight.current = false
    setBusy(false)

    if (r.kind === 'unauthorized') return
    if (r.kind === 'ok') return onRevoked('Code revoked.')
    if (r.kind === 'unexpected') {
      // The server answered: the code was already revoked or doesn't exist.
      return onRevoked('That code was already revoked or no longer exists. The list has been refreshed.')
    }
    // Revoking twice is harmless, so trying again is safe.
    setError('Could not reach the server. The code may not be revoked yet. Check your connection and try again.')
  }

  return (
    <Dialog
      title="Revoke this code?"
      onClose={busy ? () => {} : onClose}
      canDismiss={!busy}
    >
      <dl className="codeFacts">
        <div>
          <dt>State</dt>
          <dd>{STATE_LABELS[code.state]}</dd>
        </div>
        <div>
          <dt>Note</dt>
          <dd>{code.note || '—'}</dd>
        </div>
        <div>
          <dt>Restriction</dt>
          <dd>{code.phone ? `Only phone ${maskPhone(code.phone)}` : 'Any phone'}</dd>
        </div>
        {code.voter_name && (
          <div>
            <dt>Used by</dt>
            <dd>{code.voter_name}</dd>
          </div>
        )}
        <div>
          <dt>Issued</dt>
          <dd>
            {formatDateTime(code.created_at)} by {code.created_by}
          </dd>
        </div>
      </dl>

      <div className="callout warn">
        <p>{EFFECT[code.state]}</p>
        <p>
          <strong>This can’t be undone.</strong>
        </p>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="dialogActions">
        <button type="button" className="btn ghost small" onClick={onClose} disabled={busy} data-autofocus>
          Keep code
        </button>
        <button type="button" className="btn danger small" onClick={revoke} disabled={busy}>
          {busy ? 'Revoking…' : 'Revoke code'}
        </button>
      </div>
    </Dialog>
  )
}
