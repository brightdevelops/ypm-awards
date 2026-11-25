// DEVELOPMENT ONLY (Phase 3.4). Dialogs for the Registered voters tab.
//
// Voter codes are shown once, in CodeHandover, and live only in that
// component's state: never stored, logged, exported, copied automatically or
// put into a notice. They disappear when the dialog closes, the tab changes,
// or the admin signs out (the whole dashboard unmounts).
//
// Lost replies: a request that got no reply may still have worked. Nothing
// here retries by itself. Instead the dialog looks up what the server now
// holds and explains it; any further action needs a fresh, deliberate click.
import { useEffect, useRef, useState } from 'react'
import Dialog from './Dialog.jsx'
import { formatDateTime } from '../../lib/codes.js'
import { isValidPhone, normalizePhone } from '../../lib/phone.js'
import {
  BALLOT_LABELS,
  MODES,
  VERIFY_LIMIT,
  createdByLabel,
  inPersonOutcome,
  lastDigits,
  maskLikeServer,
  reviewOutcome,
  voterStatusNow,
} from '../../lib/voters.js'

const RESTORE_NOTE =
  'The number stays registered, so they can’t vote on the voting page or register again. ' +
  'You can restore the account later from this list; restoring always issues a new code, and ' +
  'the current code never works again.'

// Guards against a second click while a request is out, on top of the
// single-flight in lib/voters.js.
function useOneAtATime() {
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  async function run(fn) {
    if (busyRef.current) return undefined
    busyRef.current = true
    setBusy(true)
    try {
      return await fn()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  return [busy, run]
}

// ---------- show once ----------

export function CodeHandover({ title, name, code, children, onClose }) {
  const [handed, setHanded] = useState(false)

  useEffect(() => {
    const warn = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  return (
    <Dialog title={title} onClose={() => {}} canDismiss={false}>
      <div className="callout warn">
        <p>
          <strong>This voter code won’t be shown again.</strong> Only a scrambled copy is stored.
          Give it to {name || 'the voter'} in person. Don’t send it by message or photograph it.
        </p>
      </div>
      <div className="voterHandover" aria-label="Voter code">
        <span className="codeText">{code}</span>
      </div>
      {children}
      <label className="ackRow">
        <input
          type="checkbox"
          checked={handed}
          onChange={(e) => setHanded(e.target.checked)}
          data-autofocus
        />
        <span>I’ve handed this code to the voter</span>
      </label>
      <div className="dialogActions">
        <button type="button" className="btn primary small" onClick={onClose} disabled={!handed}>
          Close and clear code
        </button>
      </div>
    </Dialog>
  )
}

// ---------- registration mode ----------

export function ModeDialog({ current, next, api, onDone, onClose }) {
  const [busy, run] = useOneAtATime()
  const [understood, setUnderstood] = useState(next !== 'required')
  const [error, setError] = useState('')

  async function confirm() {
    await run(async () => {
      setError('')
      const r = await api.setMode(next)
      if (r.kind === 'unauthorized') return
      if (r.kind === 'ok') return onDone(`Registration is now ${MODES[next].label.toLowerCase()}.`)
      if (r.kind === 'unexpected') return setError('The server refused the change. Nothing was changed.')
      // No reply: reload and show what the server has, never what we hoped for.
      onDone(
        'Couldn’t confirm the change. The setting shown has been reloaded from the server: ' +
          'check it before trying again.',
      )
    })
  }

  return (
    <Dialog title={`Set registration to ${MODES[next].label}?`} onClose={busy ? () => {} : onClose} canDismiss={!busy}>
      <p className="dim small">
        Now: <strong>{MODES[current]?.label ?? current}</strong>. {MODES[current]?.effect}
      </p>
      <div className={`callout ${next === 'required' ? 'warn' : 'info'}`}>
        <p>{MODES[next].effect}</p>
      </div>
      {next === 'required' && (
        <label className="ackRow">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          <span>I understand that new phone numbers won’t be able to vote without a voter account</span>
        </label>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialogActions">
        <button type="button" className="btn ghost small" onClick={onClose} disabled={busy} data-autofocus>
          Cancel
        </button>
        <button type="button" className="btn primary small" onClick={confirm} disabled={busy || !understood}>
          {busy ? 'Saving…' : `Set to ${MODES[next].label}`}
        </button>
      </div>
    </Dialog>
  )
}

// ---------- reissue ----------

export function ReissueDialog({ voter, api, onDone, onClose }) {
  const [busy, run] = useOneAtATime()
  const [step, setStep] = useState('confirm') // confirm | code | unknown
  const [checked, setChecked] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')

  useEffect(() => () => setCode(''), [])

  async function reissue() {
    await run(async () => {
      setError('')
      const r = await api.reissue(voter.id)
      if (r.kind === 'unauthorized') return
      if (r.kind === 'ok') {
        setCode(r.res.voter_code)
        return setStep('code')
      }
      if (r.kind === 'unexpected') {
        return setError(
          r.res?.status === 'revoked'
            ? 'This account has been revoked, so no code can be issued.'
            : 'This account wasn’t found. Refresh the list.',
        )
      }
      setChecked(false)
      setStep('unknown')
    })
  }

  if (step === 'code') {
    return (
      <CodeHandover
        title="New voter code"
        name={voter.full_name}
        code={code}
        onClose={() => {
          setCode('')
          onDone('New code issued. The old code and any signed-in devices have stopped working.')
        }}
      >
        <p className="dim small">
          For {voter.full_name} ({voter.phone}). Their old code and any signed-in devices have
          stopped working.
        </p>
      </CodeHandover>
    )
  }

  return (
    <Dialog title={`Reissue code for ${voter.full_name}?`} onClose={busy ? () => {} : onClose} canDismiss={!busy}>
      {step === 'unknown' && (
        <div className="callout warn" role="alert">
          <p>
            <strong>Couldn’t confirm.</strong> The connection dropped before the server replied.
            A new code may have been issued; if so, the old code has stopped working and the new
            one can’t be shown again.
          </p>
          <p>
            Nothing else changed. If the person still needs a code, you can issue another one
            below. Only the newest code ever works.
          </p>
        </div>
      )}
      <dl className="codeFacts">
        <div><dt>Name</dt><dd>{voter.full_name}</dd></div>
        <div><dt>Phone</dt><dd>{voter.phone}</dd></div>
        <div><dt>Ballot</dt><dd>{BALLOT_LABELS[voter.ballot] ?? voter.ballot}</dd></div>
      </dl>
      <div className="callout info">
        <p>
          The current code and any devices signed in with it stop working straight away. Their
          ballot and votes are kept.
        </p>
      </div>
      <label className="ackRow">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} data-autofocus />
        <span>I’ve checked this person’s identity in person</span>
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialogActions">
        <button type="button" className="btn ghost small" onClick={onClose} disabled={busy}>
          {step === 'unknown' ? 'Close' : 'Cancel'}
        </button>
        <button type="button" className="btn primary small" onClick={reissue} disabled={busy || !checked}>
          {busy ? 'Issuing…' : step === 'unknown' ? 'Issue another code' : 'Issue new code'}
        </button>
      </div>
    </Dialog>
  )
}

// ---------- revoke ----------

export function RevokeVoterDialog({ voter, api, onDone, onClose }) {
  const [busy, run] = useOneAtATime()
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  const firstName = String(voter.full_name || '').trim().split(/\s+/)[0]
  const matches = typed.trim().toLowerCase() === firstName.toLowerCase()

  async function revoke() {
    await run(async () => {
      setError('')
      const r = await api.revoke(voter.id, reason)
      if (r.kind === 'unauthorized') return
      if (r.kind === 'ok') return onDone('Account revoked. Its ballot and votes are kept.')
      // Refused (already revoked) or no reply: look it up instead of guessing.
      const now = voterStatusNow(voter.id, await api.list(lastDigits(voter.phone), 0, VERIFY_LIMIT))
      if (now.outcome === 'revoked') return onDone('The account is revoked (checked with the server).')
      if (now.outcome === 'active') {
        return setError('The account is still active: nothing was changed. You can try again.')
      }
      setError(
        'Couldn’t confirm whether the account was revoked. Close this, refresh the list and check ' +
          'its status before trying again.',
      )
    })
  }

  return (
    <Dialog title={`Revoke ${voter.full_name}’s account?`} onClose={busy ? () => {} : onClose} canDismiss={!busy}>
      <dl className="codeFacts">
        <div><dt>Phone</dt><dd>{voter.phone}</dd></div>
        <div><dt>Ballot</dt><dd>{BALLOT_LABELS[voter.ballot] ?? voter.ballot}</dd></div>
      </dl>
      <div className="callout warn">
        <p>Their code and signed-in devices stop working at once. Their ballot and votes are kept.</p>
        <p><strong>{RESTORE_NOTE}</strong></p>
      </div>
      <form className="form dialogForm" onSubmit={(e) => { e.preventDefault(); if (matches) revoke() }}>
        <label>
          <span>Reason (optional, kept in the audit log)</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </label>
        <label>
          <span>Type “{firstName}” to confirm</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-autofocus />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialogActions">
          <button type="button" className="btn ghost small" onClick={onClose} disabled={busy}>
            Keep account
          </button>
          <button type="submit" className="btn danger small" disabled={busy || !matches}>
            {busy ? 'Revoking…' : 'Revoke account'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

// ---------- register in person ----------

export function RegisterInPersonDialog({ api, adminLabel, consentVersion, onDone, onClose, onReissue }) {
  const [busy, run] = useOneAtATime()
  const [step, setStep] = useState('form') // form | link | code | created | other | unknown
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [checked, setChecked] = useState(false)
  const [consented, setConsented] = useState(false)
  const [adult, setAdult] = useState(false)
  const [linkChecked, setLinkChecked] = useState(false)
  const [ballot, setBallot] = useState(null) // { state, answered }
  const [result, setResult] = useState(null) // { code, linked }
  const [found, setFound] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => () => setResult(null), [])

  const canonical = normalizePhone(phone)
  const masked = maskLikeServer(canonical)

  async function submit(link) {
    await run(async () => {
      setError('')
      const r = await api.registerInPerson(name, canonical, consentVersion, adult, link)
      if (r.kind === 'unauthorized') return
      if (r.kind === 'ok') {
        setResult({ code: r.res.voter_code, linked: r.res.linked_ballot === true })
        return setStep('code')
      }
      if (r.kind === 'unexpected') {
        const s = r.res?.status
        if (s === 'phone_has_ballot') {
          setBallot({ state: r.res.ballot, answered: r.res.answered })
          setLinkChecked(false)
          return setStep('link')
        }
        if (s === 'consent_outdated') {
          setStep('form')
          return setError(
            `The consent notice has changed${r.res.consent_version ? ` (now ${r.res.consent_version})` : ''}. ` +
              'Close this, refresh, and go through the current notice with them. Nothing was created.',
          )
        }
        if (s === 'adult_required') {
          setStep('form')
          return setError('Only adults can be registered for now. Nothing was created.')
        }
        if (s === 'phone_registered') {
          setStep('form')
          return setError(
            'This number already has a voter account. If they’ve lost their code, find them in ' +
              'the list and reissue it.',
          )
        }
        setStep('form')
        return setError('The server refused this. Check the name and number. Nothing was created.')
      }
      // No reply: find out whether the account exists before anything else.
      const out = inPersonOutcome(name, masked, await api.list(lastDigits(masked), 0, VERIFY_LIMIT), adminLabel)
      if (out.outcome === 'not_created') {
        setStep('form')
        return setError('The connection dropped, and no account was created. You can try again.')
      }
      setFound(out.voter ?? null)
      setStep(out.outcome) // created | other | unknown
    })
  }

  function onSubmit(e) {
    e.preventDefault()
    if (name.trim().length < 2) return setError('Enter their full name.')
    if (!isValidPhone(phone)) return setError('Enter a valid phone number, e.g. 08012345678.')
    if (!checked) return setError('Confirm that you’ve checked who they are.')
    if (!consentVersion) return setError('No consent notice is available. Refresh and try again.')
    if (!consented) return setError('Confirm that they’ve read the privacy notice and agree.')
    if (!adult) return setError('Only adults (18 or over) can be registered for now.')
    submit(false)
  }

  if (step === 'code' && result) {
    return (
      <CodeHandover
        title="Registered in person"
        name={name.trim()}
        code={result.code}
        onClose={() => {
          setResult(null)
          onDone(`${name.trim()} is registered${result.linked ? ', and their existing ballot is linked' : ''}.`)
        }}
      >
        <p className="dim small">
          {name.trim()} ({masked}).{' '}
          {result.linked
            ? 'Their existing ballot is now linked: they continue it by signing in with this code.'
            : 'They sign in with this code to vote.'}
        </p>
      </CodeHandover>
    )
  }

  if (step === 'created' || step === 'other' || step === 'unknown') {
    return (
      <Dialog title="Couldn’t confirm the registration" onClose={onClose}>
        <div className="callout warn" role="alert">
          {step === 'created' && (
            <p>
              The connection dropped, but the server shows that the account for {found.full_name}{' '}
              ({found.phone}) <strong>was created</strong>, at {formatDateTime(found.created_at)}.
              Its code didn’t reach you and can’t be shown again. Issue a new one: their identity
              is checked again first.
            </p>
          )}
          {step === 'other' && (
            <p>
              The number {masked} already has a voter account in the name of {found.full_name},
              created by {createdByLabel(found.created_by)}. Nothing more was done. Check the list
              before doing anything else.
            </p>
          )}
          {step === 'unknown' && (
            <p>
              The connection dropped and the result couldn’t be checked. Don’t register again yet:
              close this, refresh, and search the list for the number ending{' '}
              {lastDigits(masked)}.
            </p>
          )}
        </div>
        <div className="dialogActions">
          <button type="button" className="btn ghost small" onClick={onClose} data-autofocus>
            Close
          </button>
          {step === 'created' && (
            <button type="button" className="btn primary small" onClick={() => onReissue(found)}>
              Reissue code
            </button>
          )}
        </div>
      </Dialog>
    )
  }

  if (step === 'link') {
    return (
      <Dialog title="This number already has a ballot" onClose={busy ? () => {} : onClose} canDismiss={!busy}>
        <div className="callout warn">
          <p>
            {masked} started a ballot on the voting page. It is{' '}
            <strong>{ballot?.state === 'submitted' ? 'already submitted' : 'not finished yet'}</strong>
            {typeof ballot?.answered === 'number' && ` (${ballot.answered} answered)`}.
          </p>
          <p>
            Linking attaches that ballot to the new account. From then on it can only be continued
            by signing in with the voter code, and the voting page on their phone stops saving
            changes to it. Every vote already on it is kept.
            {ballot?.state === 'submitted' && ' Their submitted votes stay exactly as they are.'}
          </p>
        </div>
        <label className="ackRow">
          <input type="checkbox" checked={linkChecked} onChange={(e) => setLinkChecked(e.target.checked)} data-autofocus />
          <span>I’ve confirmed with this person that they started that ballot</span>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialogActions">
          <button type="button" className="btn ghost small" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary small" onClick={() => submit(true)} disabled={busy || !linkChecked}>
            {busy ? 'Registering…' : 'Register and link ballot'}
          </button>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      title="Register in person"
      description="For anyone who can’t or doesn’t want to register online. No photo or face scan is taken."
      onClose={busy ? () => {} : onClose}
      canDismiss={!busy}
    >
      <form className="form dialogForm" onSubmit={onSubmit}>
        <label>
          <span>Full name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" data-autofocus />
        </label>
        <label>
          <span>Phone number</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" />
        </label>
        <label className="ackRow">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>I’ve checked who they are, in person, and that this is their own number</span>
        </label>
        <label className="ackRow">
          <input type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)} />
          <span>
            They’ve read the privacy notice{consentVersion ? ` (version ${consentVersion})` : ''} and
            agree to an account being kept for voting
          </span>
        </label>
        <label className="ackRow">
          <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
          <span>They are 18 or over</span>
        </label>
        <p className="dim small">
          Under-18 registration isn’t available yet. Development database: use synthetic test
          identities only.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialogActions">
          <button type="button" className="btn ghost small" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary small" disabled={busy}>
            {busy ? 'Registering…' : 'Register and show code'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

// ---------- review decision ----------

export function ResolveReviewDialog({ review, decision, api, adminLabel, onDone, onClose, onReissue }) {
  const [busy, run] = useOneAtATime()
  const [step, setStep] = useState('confirm') // confirm | link | code | approved | rejected | unknown
  const [checked, setChecked] = useState(decision === 'reject')
  const [linkChecked, setLinkChecked] = useState(false)
  const [ballot, setBallot] = useState(null) // { state, answered }
  const [linked, setLinked] = useState(false)
  const [code, setCode] = useState('')
  const [found, setFound] = useState(null)
  // Reissue is offered only if the lost reply was ours AND the account was
  // made under our key: otherwise another admin has the code.
  const [mine, setMine] = useState(false)
  const [error, setError] = useState('')
  const approve = decision === 'approve'

  useEffect(() => () => setCode(''), [])

  // Never assume: a review missing from the queue may have been approved
  // or rejected. Look for the account the approval would have created.
  async function check() {
    const [reviews, voters] = await Promise.all([
      api.reviews(),
      api.list(lastDigits(review.phone), 0, VERIFY_LIMIT),
    ])
    if (reviews.kind === 'unauthorized' || voters.kind === 'unauthorized') return null
    return reviewOutcome(review, reviews, voters, adminLabel)
  }

  async function resolve(link = false) {
    await run(async () => {
      setError('')
      const r = await api.resolveReview(review.id, decision, link)
      if (r.kind === 'unauthorized') return
      if (r.kind === 'ok') {
        if (!approve) return onDone(`Registration for ${review.full_name} rejected.`)
        setCode(r.res.voter_code)
        setLinked(r.res.linked_ballot === true)
        return setStep('code')
      }
      if (r.kind === 'unexpected' && r.res?.status === 'adult_required') {
        return setError('Only adults can be registered for now, so this can’t be approved. Reject it instead.')
      }
      if (r.kind === 'unexpected' && r.res?.status === 'phone_registered') {
        return setError('This number already has a voter account, so it can’t be approved. Reject this review instead.')
      }
      if (r.kind === 'unexpected' && r.res?.status === 'phone_has_ballot') {
        setBallot({ state: r.res.ballot, answered: r.res.answered })
        setLinkChecked(false)
        return setStep('link')
      }
      const out = await check()
      if (!out) return
      if (out.outcome === 'still_waiting') {
        return setError(
          r.kind === 'unexpected'
            ? 'The server refused this, and the review is still waiting. Refresh and try again.'
            : 'The connection dropped, but the review is still waiting: nothing was decided. You can try again.',
        )
      }
      setFound(out.voter ?? null)
      setMine(approve && r.kind === 'network' && out.byMe === true)
      setStep(out.outcome === 'approved' ? 'approved' : out.outcome === 'not_approved' ? 'rejected' : 'unknown')
    })
  }

  if (step === 'code') {
    return (
      <CodeHandover
        title="Registration approved"
        name={review.full_name}
        code={code}
        onClose={() => {
          setCode('')
          onDone(`${review.full_name} is registered.`)
        }}
      >
        <p className="dim small">
          For {review.full_name} ({review.phone}). Their phone will say the registration is
          complete; they sign in with this code.
          {linked && ' Their existing ballot is linked: they continue it after signing in.'}
        </p>
      </CodeHandover>
    )
  }

  if (step === 'link') {
    return (
      <Dialog title="This number already has a ballot" onClose={busy ? () => {} : onClose} canDismiss={!busy}>
        <div className="callout warn">
          <p>
            {review.phone} started a ballot on the voting page. It is{' '}
            <strong>{ballot?.state === 'submitted' ? 'already submitted' : 'not finished yet'}</strong>
            {typeof ballot?.answered === 'number' && ` (${ballot.answered} answered)`}.
          </p>
          <p>
            Approving can link that ballot to the new account. Every vote on it is kept, and from
            then on it can only be continued by signing in with the voter code. Only link it if
            you’ve confirmed this person started it; otherwise reject this review.
          </p>
        </div>
        <label className="ackRow">
          <input type="checkbox" checked={linkChecked} onChange={(e) => setLinkChecked(e.target.checked)} data-autofocus />
          <span>I’ve confirmed with this person that they started that ballot</span>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialogActions">
          <button type="button" className="btn ghost small" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary small" onClick={() => resolve(true)} disabled={busy || !linkChecked}>
            {busy ? 'Saving…' : 'Approve and link ballot'}
          </button>
        </div>
      </Dialog>
    )
  }

  if (step !== 'confirm') {
    return (
      <Dialog title="Checked with the server" onClose={() => onDone(null)}>
        <div className={`callout ${step === 'unknown' ? 'warn' : 'info'}`} role="alert">
          {step === 'approved' && (
            <p>
              This registration <strong>was approved</strong>: an account for {found.full_name}{' '}
              ({found.phone}) was created by {createdByLabel(found.created_by)} at{' '}
              {formatDateTime(found.created_at)}.{' '}
              {mine
                ? 'The code didn’t reach you and can’t be shown again. Issue a new one: their identity is checked again first.'
                : 'It was approved by someone else, who was shown the code. Don’t reissue it unless the voter confirms in person that they never received it.'}
            </p>
          )}
          {step === 'rejected' && (
            <p>
              This review is closed and <strong>no account was created</strong>, so it was rejected
              {approve ? ' (by another admin)' : ''}. There’s no code to reissue.
            </p>
          )}
          {step === 'unknown' && (
            <p>
              The result couldn’t be checked. <strong>Don’t reissue anything yet.</strong> Close
              this, refresh, and look for the review in the queue and the number ending{' '}
              {lastDigits(review.phone)} in the voter list.
            </p>
          )}
        </div>
        <div className="dialogActions">
          <button type="button" className="btn ghost small" onClick={() => onDone(null)} data-autofocus>
            Close
          </button>
          {step === 'approved' && mine && (
            <button type="button" className="btn primary small" onClick={() => onReissue(found)}>
              Reissue code
            </button>
          )}
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      title={approve ? `Approve ${review.full_name}?` : `Reject ${review.full_name}?`}
      onClose={busy ? () => {} : onClose}
      canDismiss={!busy}
    >
      <dl className="codeFacts">
        <div><dt>Phone</dt><dd>{review.phone}</dd></div>
        <div><dt>Submitted</dt><dd>{formatDateTime(review.created_at)}</dd></div>
        <div><dt>Flagged by</dt><dd>{review.provider === 'simulated' ? 'Simulated check (not biometric)' : review.provider}</dd></div>
      </dl>
      <div className="callout info">
        {approve ? (
          <p>
            Approving creates their voter account and shows the code once, for you to hand over.
            Check in person that they are who they say, and that they don’t already have an
            account under another number.
          </p>
        ) : (
          <p>
            Rejecting closes this registration without creating an account. They can still vote
            in another way, for example by registering in person.
          </p>
        )}
      </div>
      {approve && (
        <label className="ackRow">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} data-autofocus />
          <span>I’ve checked this person in person</span>
        </label>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialogActions">
        <button type="button" className="btn ghost small" onClick={onClose} disabled={busy} data-autofocus={!approve || undefined}>
          Cancel
        </button>
        <button
          type="button"
          className={`btn ${approve ? 'primary' : 'danger'} small`}
          onClick={() => resolve(false)}
          disabled={busy || !checked}
        >
          {busy ? 'Saving…' : approve ? 'Approve and show code' : 'Reject'}
        </button>
      </div>
    </Dialog>
  )
}

// ---------- restore ----------

export function RestoreVoterDialog({ voter, api, onDone, onClose }) {
  const [busy, run] = useOneAtATime()
  const [step, setStep] = useState('confirm') // confirm | code | restored_unseen
  const [reason, setReason] = useState('')
  const [checked, setChecked] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')

  useEffect(() => () => setCode(''), [])

  async function restore() {
    await run(async () => {
      setError('')
      const r = await api.restore(voter.id, reason)
      if (r.kind === 'unauthorized') return
      if (r.kind === 'ok') {
        setCode(r.res.voter_code)
        return setStep('code')
      }
      if (r.kind === 'unexpected') {
        const s = r.res?.status
        if (s === 'not_revoked') {
          return onDone('This account is already active (someone may have just restored it). Nothing was changed.')
        }
        if (s === 'not_found') return setError('This account no longer exists. Refresh the list.')
        return setError('The server refused this. Check the reason (at least 3 characters). Nothing was changed.')
      }
      // No reply: look it up before anything else.
      const now = voterStatusNow(voter.id, await api.list(lastDigits(voter.phone), 0, VERIFY_LIMIT))
      if (now.outcome === 'revoked') {
        return setError('The connection dropped and the account is still revoked: nothing was changed. You can try again.')
      }
      if (now.outcome === 'active') return setStep('restored_unseen')
      setError('Couldn’t confirm whether the account was restored. Close this, refresh the list and check its status.')
    })
  }

  if (step === 'code') {
    return (
      <CodeHandover
        title="Account restored"
        name={voter.full_name}
        code={code}
        onClose={() => {
          setCode('')
          onDone(`${voter.full_name}’s account is active again with a new code.`)
        }}
      >
        <p className="dim small">
          For {voter.full_name} ({voter.phone}). Their old code still doesn’t work; only this one does.
        </p>
      </CodeHandover>
    )
  }

  if (step === 'restored_unseen') {
    return (
      <Dialog title="Restored, but the code didn’t arrive" onClose={() => onDone(null)}>
        <div className="callout warn" role="alert">
          <p>
            The connection dropped, but the account is <strong>active again</strong>. Its new code
            didn’t reach you and can’t be shown again. Their old code still doesn’t work.
          </p>
          <p>
            If you restored it yourself just now, use “Reissue code” on their row (their identity
            is checked again). If another admin may have restored it, ask them first: reissuing
            cancels the code they handed over.
          </p>
        </div>
        <div className="dialogActions">
          <button type="button" className="btn primary small" onClick={() => onDone(null)} data-autofocus>
            Close
          </button>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog title={`Restore ${voter.full_name}’s account?`} onClose={busy ? () => {} : onClose} canDismiss={!busy}>
      <dl className="codeFacts">
        <div><dt>Phone</dt><dd>{voter.phone}</dd></div>
        <div><dt>Ballot</dt><dd>{BALLOT_LABELS[voter.ballot] ?? voter.ballot}</dd></div>
      </dl>
      <div className="callout info">
        <p>
          The account becomes active with a <strong>new code</strong>, shown once. The old code never
          works again. Their ballot and votes are unchanged.
        </p>
      </div>
      <form
        className="form dialogForm"
        onSubmit={(e) => {
          e.preventDefault()
          if (checked && reason.trim().length >= 3) restore()
        }}
      >
        <label>
          <span>Reason (kept in the audit log)</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} data-autofocus />
        </label>
        <label className="ackRow">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>I’ve checked this person’s identity in person</span>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialogActions">
          <button type="button" className="btn ghost small" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary small" disabled={busy || !checked || reason.trim().length < 3}>
            {busy ? 'Restoring…' : 'Restore with a new code'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
