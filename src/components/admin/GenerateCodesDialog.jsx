import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Dialog from './Dialog.jsx'
import { isValidPhone, normalizePhone } from '../../lib/phone.js'
import {
  codesToCsv,
  codesToText,
  csvFileName,
  defaultBatchNote,
  expiryHours,
  formatDateTime,
  maskPhone,
} from '../../lib/codes.js'

// Generate codes, then show them once.
//
// The plaintext codes live only in this component's state. They are never
// written to storage, logged, or put in the URL or title, and they disappear
// when this component unmounts: on Close, on sign-out, when the session ends
// (the whole dashboard unmounts) or when the page is closed.
//
// No automatic retries. If the request's outcome is unknown (network error),
// the server may have created the codes, so the admin is told to check the
// list instead of being offered "try again".
export default function GenerateCodesDialog({ adminRpc, onClose, onIssued }) {
  const [mode, setMode] = useState('batch') // batch | phone
  const [count, setCount] = useState('20')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState(() => defaultBatchNote())
  const [expiry, setExpiry] = useState('7d')
  const [customExpiry, setCustomExpiry] = useState('')
  const [formError, setFormError] = useState('')
  const [step, setStep] = useState('form') // form | sending | result | unknown
  const [result, setResult] = useState(null) // { codes, phoneBound, note, expiresAt }
  const inFlight = useRef(false)

  // Leave nothing behind, whatever closes this.
  useEffect(() => () => setResult(null), [])

  // Warn before the page is closed or reloaded while codes are on screen.
  useEffect(() => {
    if (step !== 'result') return
    const warn = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [step])

  async function submit(e) {
    e.preventDefault()
    if (inFlight.current || step !== 'form') return
    setFormError('')

    const bound = mode === 'phone'
    const n = bound ? 1 : Number(count)
    if (!bound && (!Number.isInteger(n) || n < 1 || n > 200)) {
      return setFormError('Choose between 1 and 200 codes.')
    }
    if (bound && !isValidPhone(phone)) {
      return setFormError('Enter a valid phone number, e.g. 08012345678.')
    }
    const exp = expiryHours(expiry, customExpiry)
    if (exp.error) return setFormError(exp.error)
    const cleanNote = note.trim()
    if (!cleanNote) return setFormError('Add a note, so this batch can be found later.')

    inFlight.current = true
    setStep('sending')
    const r = await adminRpc('admin_issue_codes', {
      p_count: n,
      p_phone: bound ? normalizePhone(phone) : null,
      p_note: cleanNote,
      p_expires_hours: exp.hours,
    })
    inFlight.current = false

    if (r.kind === 'unauthorized') return // the dashboard has signed out and unmounted us
    if (r.kind === 'network') {
      setStep('unknown')
      onIssued() // refresh the list; reading it is harmless
      return
    }
    if (r.kind !== 'ok') {
      // The server answered and refused: nothing was created, so fixing and
      // resubmitting is safe.
      setStep('form')
      return setFormError(
        r.res?.message ? `Not created: ${r.res.message}.` : 'Not created. Please check the form.',
      )
    }

    const codes = r.res.codes || []
    setResult({
      codes,
      phoneBound: bound,
      note: cleanNote,
      expiresAt: codes[0]?.expires_at ?? null,
    })
    setStep('result')
    onIssued()
  }

  if (step === 'unknown') {
    return (
      <Dialog title="Couldn't confirm the codes" onClose={onClose}>
        <div className="callout warn" role="alert">
          <p>
            The connection dropped before the server replied, so the codes{' '}
            <strong>may or may not have been created</strong>. They were not shown and can't be
            recovered.
          </p>
          <p>
            Don't generate again straight away. Close this and look in the list for codes with
            the note <strong>“{note.trim()}”</strong>. If they're there, revoke them, then
            generate a new batch.
          </p>
        </div>
        <div className="dialogActions">
          <button type="button" className="btn primary" data-autofocus onClick={onClose}>
            Close and check the list
          </button>
        </div>
      </Dialog>
    )
  }

  if (step === 'result' && result) {
    return <ShowOnce result={result} onClose={onClose} />
  }

  const sending = step === 'sending'
  return (
    <Dialog
      title="Generate voting codes"
      description="Codes are shown once, right after they're created. Have a safe way to hand them out ready."
      onClose={sending ? () => {} : onClose}
      canDismiss={!sending}
    >
      <form className="form dialogForm" onSubmit={submit} noValidate>
        <fieldset className="segmented" disabled={sending}>
          <legend className="srOnly">Type of code</legend>
          <label className={mode === 'batch' ? 'on' : ''}>
            <input
              type="radio"
              name="mode"
              value="batch"
              checked={mode === 'batch'}
              onChange={() => setMode('batch')}
              data-autofocus
            />
            Batch for any phone
          </label>
          <label className={mode === 'phone' ? 'on' : ''}>
            <input
              type="radio"
              name="mode"
              value="phone"
              checked={mode === 'phone'}
              onChange={() => setMode('phone')}
            />
            For one phone number
          </label>
        </fieldset>

        {mode === 'batch' ? (
          <label>
            <span>How many codes</span>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              max="200"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              disabled={sending}
            />
            <small className="hint">1 to 200. Each code lets one person vote, with any phone number.</small>
          </label>
        ) : (
          <label>
            <span>Phone number</span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="off"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={sending}
            />
            <small className="hint">
              The code works only with this number. It can also reopen this number's unfinished
              ballot on another phone (lost phone, cleared browser).
            </small>
          </label>
        )}

        <label>
          <span>Note</span>
          <input
            type="text"
            maxLength={120}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={sending}
          />
          <small className="hint">
            Used to find or revoke these codes later. Avoid names or other personal details.
          </small>
        </label>

        <label>
          <span>Expires</span>
          <select value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={sending}>
            <option value="24h">In 24 hours</option>
            <option value="7d">In 7 days</option>
            <option value="30d">In 30 days</option>
            <option value="custom">On a date…</option>
            <option value="none">Never</option>
          </select>
          <small className="hint">Expiry only applies to unused codes. Maximum 60 days.</small>
        </label>

        {expiry === 'custom' && (
          <label>
            <span>Expiry date and time</span>
            <input
              type="datetime-local"
              value={customExpiry}
              onChange={(e) => setCustomExpiry(e.target.value)}
              disabled={sending}
            />
          </label>
        )}

        {formError && (
          <p className="error" role="alert">
            {formError}
          </p>
        )}

        <div className="dialogActions">
          <button type="button" className="btn ghost small" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button type="submit" className="btn primary small" disabled={sending}>
            {sending ? 'Generating…' : mode === 'phone' ? 'Generate code' : 'Generate codes'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function ShowOnce({ result, onClose }) {
  const [saved, setSaved] = useState(false)
  const [copyMsg, setCopyMsg] = useState('')
  const { codes, phoneBound, note, expiresAt } = result
  const boundTo = phoneBound ? maskPhone(codes[0]?.phone) : ''

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(codesToText(codes))
      setCopyMsg(
        'Copied. The clipboard keeps them until you copy something else, so paste them somewhere safe now.',
      )
    } catch {
      setCopyMsg('Copying failed. Select the codes on screen and copy them instead.')
    }
  }

  function downloadCsv() {
    const blob = new Blob([codesToCsv(codes)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = csvFileName(note)
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  function print() {
    const done = () => {
      document.body.classList.remove('printingCodes')
      window.removeEventListener('afterprint', done)
    }
    document.body.classList.add('printingCodes')
    window.addEventListener('afterprint', done)
    window.print()
  }

  return (
    <Dialog
      title={phoneBound ? 'Your phone-bound code' : `${codes.length} new voting codes`}
      onClose={onClose}
      canDismiss={false}
      wide
    >
      <div className="callout warn">
        <p>
          <strong>These codes won't be shown again.</strong> Only a scrambled copy is stored, so
          nobody can look them up later. Save, print or hand them out before closing.
        </p>
      </div>

      <div className={`callout ${phoneBound ? 'bound' : 'open'}`}>
        {phoneBound ? (
          <p>
            <strong>Works only with the phone number ending {boundTo.replace('•••• ', '')}.</strong>{' '}
            It also lets that number reopen its unfinished ballot on another phone, so give it
            only to the owner of that number, in person.
          </p>
        ) : (
          <p>
            <strong>Each code works with any phone number, for one person.</strong> Whoever holds
            a code can use it. Treat them like ballot papers: hand them out in person, don't post
            them in group chats, and destroy spare printouts.
          </p>
        )}
      </div>

      <ul className="codeGrid" aria-label="Generated codes">
        {codes.map((c) => (
          <li key={c.id}>
            <span className="codeText">{c.code}</span>
          </li>
        ))}
      </ul>

      <p className="dim small">
        Note: {note} · Expires: {expiresAt ? formatDateTime(expiresAt) : 'never'}
        {phoneBound && <> · Phone: {boundTo}</>}
      </p>

      <div className="dialogTools">
        <button type="button" className="btn ghost small" onClick={copyAll}>
          Copy all
        </button>
        <button type="button" className="btn ghost small" onClick={downloadCsv}>
          Download CSV
        </button>
        <button type="button" className="btn ghost small" onClick={print}>
          Print slips
        </button>
      </div>
      {copyMsg && (
        <p className="dim small" role="status">
          {copyMsg}
        </p>
      )}
      <p className="fineprint">
        A CSV or printout contains working codes. Keep it private and delete or destroy it once
        the codes are handed out. Phone numbers in it are shortened.
      </p>

      <label className="ackRow">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          data-autofocus
        />
        <span>I've saved or handed out these codes</span>
      </label>

      <div className="dialogActions">
        <button type="button" className="btn primary small" onClick={onClose} disabled={!saved}>
          Close and clear codes
        </button>
      </div>

      {createPortal(<PrintSheet result={result} boundTo={boundTo} />, document.body)}
    </Dialog>
  )
}

// Hidden on screen. When printing, it's the only thing on the page.
function PrintSheet({ result, boundTo }) {
  const { codes, phoneBound, expiresAt } = result
  return (
    <div className="printSheet" aria-hidden="true">
      {codes.map((c) => (
        <div className="slip" key={c.id}>
          <div className="slipTitle">YPM Youth Awards · Voting code</div>
          <div className="slipCode">{c.code}</div>
          <div className="slipRule">
            {phoneBound
              ? `Only for the phone number ending ${boundTo.replace('•••• ', '')}.`
              : 'Use once, with your own phone number.'}
            {expiresAt ? ` Valid until ${formatDateTime(expiresAt)}.` : ''}
          </div>
          <div className="slipHow">Enter it on the voting page under “I have a voting code”.</div>
        </div>
      ))}
    </div>
  )
}
