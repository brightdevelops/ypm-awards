import { useState } from 'react'
import ScreenFrame from '../ScreenFrame.jsx'
import { isValidPhone } from '../../lib/phone.js'
import { after } from '../simulator.js'

// The reply is the same whether or not the number is registered, so this
// screen can't be used to find out who has registered.
export default function Recovery({ go, details }) {
  const [phone, setPhone] = useState(details.phone)
  const [error, setError] = useState('')
  const [state, setState] = useState('form') // form | sending | sent

  function submit(e) {
    e.preventDefault()
    if (state !== 'form') return
    setError('')
    if (!isValidPhone(phone)) return setError('Enter the phone number you registered with.')
    setState('sending')
    after(900, () => setState('sent'))
  }

  if (state === 'sent') {
    return (
      <ScreenFrame title="Next step: see a youth leader">
        <p className="dim">
          If that number is registered, a youth leader can confirm it’s you in person and give
          you a new voter code. Your old code will stop working.
        </p>
        <p className="dim">
          For your safety, voter codes are never shown on this screen or sent to anyone else.
        </p>
        <p className="fineprint">Prototype: nothing was looked up or sent.</p>
        <button type="button" className="btn primary" onClick={() => go('login')}>
          Back to sign in
        </button>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame title="Recover your voter code" lead="Enter the phone number you registered with.">
      <form className="form" onSubmit={submit} noValidate>
        <label>
          <span>Phone number</span>
          <input
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="off"
            placeholder="08012345678"
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" disabled={state === 'sending'}>
          {state === 'sending' ? 'Please wait…' : 'Continue'}
        </button>
      </form>
      <button type="button" className="linkBtn protoLink" onClick={() => go('login')}>
        Back to sign in
      </button>
    </ScreenFrame>
  )
}
