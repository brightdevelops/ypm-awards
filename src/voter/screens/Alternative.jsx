import { useState } from 'react'
import ScreenFrame from '../ScreenFrame.jsx'
import { isValidPhone, normalizePhone } from '../../lib/phone.js'

// The no-face-scan route (Phase 5.1, migration 006): the voter asks to be
// confirmed by a youth leader and gets a reference to show them. The leader
// confirms them in person and hands over the voter code. Same account, same
// ballot as online registration. Works even when no face check is set up.
// onRequest({ name, phone }) returns a message to show here, or null.
//   phoneRule  optional { test(normalized), message, hint }: the development
//              prototype accepts synthetic numbers only
//   consent    { label, notice }: what the voter agrees to (production: the
//              published notice; prototype: the draft)
//   onBack     optional: a "back" link (the prototype's face check option)
const DRAFT_CONSENT = {
  label: 'I agree to YPM keeping my name and phone number to register me to vote (draft notice).',
  notice: null,
}

export default function Alternative({ go, details, onRequest, phoneRule = null, consent = DRAFT_CONSENT, onBack = null }) {
  const [name, setName] = useState(details?.name ?? '')
  const [phone, setPhone] = useState(details?.phone ?? '')
  const [age, setAge] = useState('')
  const [agree, setAgree] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setError('')
    if (name.trim().split(/\s+/).length < 2) return setError('Enter your first and last name.')
    if (!isValidPhone(phone)) return setError(`Enter a valid phone number${phoneRule?.example ? `, e.g. ${phoneRule.example}` : ''}.`)
    const normal = normalizePhone(phone)
    if (phoneRule && !phoneRule.test(normal)) return setError(phoneRule.message)
    if (!age) return setError('Tell us whether you are 18 or older.')
    if (!agree) return setError('Tick the box to agree, so a youth leader can register you.')
    setBusy(true)
    const message = await onRequest({ name: name.trim(), phone: normal })
    setBusy(false)
    if (message) setError(message)
  }

  return (
    <ScreenFrame title="Register without a face scan" lead="You can still vote. It just takes a quick chat in person.">
      <ol className="altSteps">
        <li>
          <strong>Ask here</strong>
          <span>You get a short reference on this phone.</span>
        </li>
        <li>
          <strong>Show it to a youth leader</strong>
          <span>At church or a YPM meeting. They confirm who you are, as for any church event.</span>
        </li>
        <li>
          <strong>You get your voter code</strong>
          <span>The same kind of code as online registration. Use it to sign in and vote.</span>
        </li>
      </ol>
      <p className="dim small">
        Choosing this doesn’t affect your vote in any way, and no face data is collected. You
        don’t need to give a reason.
      </p>

      <form className="form" onSubmit={submit} noValidate>
        <label>
          <span>Full name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" placeholder={phoneRule ? 'e.g. Test Voter One' : ''} />
        </label>
        <label>
          <span>Phone number</span>
          <input
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="off"
            placeholder={phoneRule?.example ?? ''}
            aria-describedby={phoneRule?.hint ? 'alt-phone-help' : undefined}
          />
        </label>
        {phoneRule?.hint && (
          <p id="alt-phone-help" className="fineprint">
            {phoneRule.hint}
          </p>
        )}

        <fieldset className="protoChoice">
          <legend>Are you 18 or older?</legend>
          <label>
            <input type="radio" name="altAge" value="adult" checked={age === 'adult'} onChange={() => setAge('adult')} />
            Yes, I am 18 or older
          </label>
          <label>
            <input type="radio" name="altAge" value="minor" checked={age === 'minor'} onChange={() => setAge('minor')} />
            No, I am under 18
          </label>
        </fieldset>

        {age === 'minor' && (
          <div className="callout warnBox" role="note">
            Registration for under-18s isn’t available yet. Please speak to a youth leader.
          </div>
        )}

        {age === 'adult' && consent.notice}
        {age === 'adult' && (
          <label className="protoCheck">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>{consent.label}</span>
          </label>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {age !== 'minor' && (
          <button className="btn primary" disabled={busy || (age === 'adult' && !agree)}>
            {busy ? 'Sending…' : 'Ask a youth leader to confirm me'}
          </button>
        )}
      </form>

      {onBack && (
        <button type="button" className="linkBtn protoLink" onClick={onBack.onClick}>
          {onBack.label}
        </button>
      )}
      <button type="button" className="linkBtn protoLink" onClick={() => go('login')}>
        I already have a voter code
      </button>
    </ScreenFrame>
  )
}
