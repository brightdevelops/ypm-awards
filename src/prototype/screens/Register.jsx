import { useState } from 'react'
import ScreenFrame from '../ScreenFrame.jsx'
import { isValidPhone, normalizePhone } from '../../lib/phone.js'

export default function Register({ go, details, onSubmit }) {
  const [name, setName] = useState(details.name)
  const [phone, setPhone] = useState(details.phone)
  const [error, setError] = useState('')

  function submit(e) {
    e.preventDefault()
    setError('')
    if (name.trim().split(/\s+/).length < 2) return setError('Enter your first and last name.')
    if (!isValidPhone(phone)) return setError('Enter a valid phone number, e.g. 08012345678.')
    onSubmit({ name: name.trim(), phone: normalizePhone(phone) })
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
            placeholder="e.g. Chioma Test"
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
            placeholder="08012345678"
          />
        </label>
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
