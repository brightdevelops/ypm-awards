import { useState } from 'react'
import ScreenFrame from '../ScreenFrame.jsx'
import { isValidPhone, normalizePhone } from '../../lib/phone.js'
import { TEST_PHONE_RANGE, isTestPhone } from '../simulator.js'

export default function Register({ go, details, onSubmit }) {
  const [name, setName] = useState(details.name)
  const [phone, setPhone] = useState(details.phone)
  const [error, setError] = useState('')

  function submit(e) {
    e.preventDefault()
    setError('')
    if (name.trim().split(/\s+/).length < 2) return setError('Enter your first and last name.')
    if (!isValidPhone(phone)) return setError('Enter a valid phone number, e.g. 08155500001.')
    const normal = normalizePhone(phone)
    if (!isTestPhone(normal)) {
      return setError(`Development testing uses synthetic numbers only: ${TEST_PHONE_RANGE}.`)
    }
    onSubmit({ name: name.trim(), phone: normal })
  }

  return (
    <ScreenFrame
      title="Register to vote"
      lead="It takes about two minutes. You’ll get a voter code to sign in with next time."
    >
      <form className="form" onSubmit={submit} noValidate>
        <label>
          <span>Full name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            placeholder="e.g. Test Voter One"
          />
        </label>
        <label>
          <span>Phone number</span>
          <input
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="off"
            placeholder="08155500001"
            aria-describedby="reg-phone-help"
          />
        </label>
        <p id="reg-phone-help" className="fineprint">
          Development: synthetic test numbers only ({TEST_PHONE_RANGE}).
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary">Continue</button>
      </form>
      <button type="button" className="linkBtn protoLink" onClick={() => go('login')}>
        I already have a voter code
      </button>
    </ScreenFrame>
  )
}
