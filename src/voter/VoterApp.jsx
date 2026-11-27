import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './voter.css'
import { supabase } from '../supabaseClient.js'
import { BALLOT } from '../data/categories.js'
import { createVoterCalls } from './calls.js'
import { maskPhone } from './codes.js'
import { CONSENT_APPROVED, CONSENT_NOTICE, CONSENT_VERSION } from './consentNotice.js'
import { createSessionStore } from './session.js'
import Login from './screens/Login.jsx'
import Alternative from './screens/Alternative.jsx'
import InPerson from './screens/InPerson.jsx'
import Recovery from './screens/Recovery.jsx'
import Welcome from './screens/Welcome.jsx'
import Ballot from './screens/Ballot.jsx'
import Notice from './screens/Notice.jsx'

// The voter page (/voter), production. Registered voters sign in with their
// voter code and vote. New voters ask to be confirmed by a youth leader
// (migration 006): no face scan, no camera. Everything is switched on and
// off by the database (migration 007's switch and the registration mode);
// when it's off, the page says so and points to the main voting page.

const KEYS = { voter: 'ypm-voter-session', registration: 'ypm-voter-request' }
const HELP = 'You received this code from a youth leader. Keep it to yourself.'

function NoticeText() {
  return (
    <div className="protoNotice" tabIndex={0} aria-label="Privacy notice">
      {CONSENT_NOTICE.map((s) => (
        <div key={s.heading}>
          <h2>{s.heading}</h2>
          <p>{s.body}</p>
        </div>
      ))}
    </div>
  )
}

const CONSENT = {
  label: 'I have read this notice and agree to YPM keeping my name and phone number to register me to vote.',
  notice: <NoticeText />,
}

// consentApproved: tests only (the real value is CONSENT_APPROVED).
export default function VoterApp({ api: injected = null, consentApproved = CONSENT_APPROVED }) {
  const api = useMemo(() => injected ?? createVoterCalls((fn, args) => supabase.rpc(fn, args)), [injected])
  const store = useMemo(() => createSessionStore(KEYS), [])
  const [screen, setScreen] = useState('loading')
  const [notice, setNotice] = useState(null)
  const [details, setDetails] = useState({ name: '', phone: '' })
  const [voter, setVoter] = useState(null)
  const [ballotInfo, setBallotInfo] = useState(null)
  const [picks, setPicks] = useState([])
  const [loginMessage, setLoginMessage] = useState('')
  const [reg, setReg] = useState(null)
  const regRef = useRef(null)
  regRef.current = reg

  const go = useCallback((next) => {
    if (next !== 'login') setLoginMessage('')
    setScreen(next === 'register' ? 'alternative' : next)
    window.scrollTo(0, 0)
  }, [])

  const showNotice = useCallback((n) => {
    setNotice(n)
    setScreen('notice')
    window.scrollTo(0, 0)
  }, [])

  const dropRequest = useCallback(() => {
    store.clearRegistration()
    setReg(null)
  }, [store])

  const toVotingPage = { label: 'Go to the voting page', onClick: () => window.location.assign('/') }

  // ---------- Signing in and out ----------

  const signedIn = useCallback(({ session, expiresAt, firstName, ballot }) => {
    const v = { session, expiresAt, firstName }
    store.setVoter(v)
    setVoter(v)
    setBallotInfo(ballot ?? null)
    go('welcome')
  }, [store, go])

  const sessionEnded = useCallback(() => {
    store.clearVoter()
    setVoter(null)
    setBallotInfo(null)
    go('login')
    setLoginMessage('Your session has ended. Please sign in again.')
  }, [store, go])

  async function logout() {
    const s = voter?.session
    store.clearVoter()
    setVoter(null)
    setBallotInfo(null)
    go('login')
    setLoginMessage('You’ve signed out.')
    if (s) await api.logout(s)
  }

  async function openBallot() {
    const r = await api.begin(voter.session)
    if (r.kind === 'unauthorized') return sessionEnded()
    if (r.kind === 'failed') {
      return showNotice({
        title: 'Couldn’t open your ballot',
        body: 'Check your connection. Trying again is safe: it never creates a second ballot.',
        actions: [{ label: 'Try again', onClick: () => go('welcome') }],
      })
    }
    switch (r.status) {
      case 'started':
      case 'resumed':
        setPicks(r.data.picks || [])
        return go('ballot')
      case 'already_voted':
        setBallotInfo({ state: 'submitted', answered: 0 })
        return go('welcome')
      case 'closed':
        return showNotice({ title: 'Voting is closed', body: 'Thank you for your interest.', actions: [{ label: 'Sign out', onClick: logout }] })
      case 'needs_assistance':
        return showNotice({
          title: 'Please see a youth leader',
          body: 'This phone number already has a ballot that was started without signing in. A youth leader can confirm it’s you and connect it to your account.',
          actions: [{ label: 'Sign out', onClick: logout }],
        })
      case 'disabled':
        return showNotice({ title: 'Voter accounts aren’t available', body: 'Please vote on the main voting page.', actions: [toVotingPage] })
      default:
        return showNotice({ title: 'Something went wrong', body: 'Please try again.', actions: [{ label: 'Back', onClick: () => go('welcome') }] })
    }
  }

  // ---------- Asking a youth leader ----------

  async function requestInPerson({ name, phone }) {
    setDetails({ name, phone })
    const r = await api.requestInPerson(name, phone, true, CONSENT_VERSION)
    if (r.kind === 'failed') {
      return 'We couldn’t confirm whether your request was sent. Check your connection and try again. Each try counts towards a limit of 5 an hour for this number.'
    }
    switch (r.status) {
      case 'ok': {
        const next = {
          kind: 'in_person',
          token: r.data.registration_token,
          reference: r.data.reference,
          expiresAt: r.data.expires_at,
          firstName: name.split(/\s+/)[0],
          maskedPhone: maskPhone(phone),
        }
        store.setRegistration(next)
        setReg(next)
        go('inperson')
        return null
      }
      case 'adult_required':
        return 'Registration for under-18s isn’t available yet. Please speak to a youth leader.'
      case 'needs_assistance':
        showNotice({
          title: 'Please see a youth leader',
          body: 'We can’t take a request for this phone number online. A youth leader can help you in person.',
          actions: [
            { label: 'I have a voter code', onClick: () => go('login') },
            { label: 'Lost my voter code', onClick: () => go('recovery') },
          ],
        })
        return null
      case 'consent_outdated':
        return 'The privacy notice has changed. Reload the page and try again.'
      case 'disabled':
      case 'registration_off':
        return 'Registration isn’t open at the moment. You can still vote on the main voting page, or a youth leader can register you in person.'
      case 'rate_limited':
        return 'Too many attempts for this number. Please wait an hour and try again.'
      default:
        return 'Please check your name and phone number.'
    }
  }

  const routeStatus = useCallback((status) => {
    switch (status) {
      case 'review':
        return go('inperson')
      case 'claimed':
        dropRequest()
        return showNotice({
          title: 'You’re registered',
          body: 'A youth leader confirmed you. Sign in with the voter code they gave you.',
          actions: [{ label: 'Sign in', onClick: () => go('login') }, { label: 'Lost my voter code', onClick: () => go('recovery') }],
        })
      case 'rejected':
        dropRequest()
        return showNotice({
          title: 'Registration not approved',
          body: 'A youth leader reviewed this request. Please see them in person.',
          actions: [{ label: 'Back to start', onClick: () => go('login') }],
        })
      case 'expired':
        dropRequest()
        return showNotice({
          title: 'Your request has closed',
          body: 'Requests stay open for 14 days. You can ask again, or a youth leader can register you in person.',
          actions: [{ label: 'Ask again', onClick: () => go('alternative') }],
        })
      case 'disabled':
        return showNotice({ title: 'Voter accounts aren’t available', body: 'Please vote on the main voting page.', actions: [toVotingPage] })
      default:
        dropRequest()
        return showNotice({ title: 'Request not found', body: 'Please ask again.', actions: [{ label: 'Ask again', onClick: () => go('alternative') }] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, showNotice, dropRequest])

  async function inPersonCheck() {
    const r = regRef.current
    if (!r) return 'This request is no longer on this device.'
    const st = await api.status(r.token)
    if (st.kind !== 'answer') return 'Couldn’t check. Try again in a moment.'
    if (st.status === 'review') return 'Not yet. Show your reference to a youth leader.'
    routeStatus(st.status)
    return null
  }

  // ---------- Restore after a reload ----------

  useEffect(() => {
    const v = store.getVoter()
    if (v) {
      setVoter(v)
      return setScreen('welcome')
    }
    const r = store.getRegistration()
    if (r) {
      setReg(r)
      regRef.current = r
      api.status(r.token).then((st) => (st.kind === 'answer' ? routeStatus(st.status) : setScreen('inperson')))
      return
    }
    setScreen('login')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- Screens ----------

  let body
  switch (screen) {
    case 'loading':
      body = <div className="card center dim">Loading…</div>
      break
    case 'login':
      body = <Login go={go} api={api} onSignedIn={signedIn} message={loginMessage} help={HELP} />
      break
    case 'alternative':
      body = consentApproved ? (
        <Alternative go={go} details={details} onRequest={requestInPerson} consent={CONSENT} />
      ) : (
        <Notice
          title="Registration opens soon"
          body="For now, a youth leader can register you in person, or you can vote on the main voting page."
          actions={[{ label: 'Back to sign in', onClick: () => go('login') }, toVotingPage]}
        />
      )
      break
    case 'inperson':
      body = (
        <InPerson go={go} reference={reg?.reference} maskedPhone={reg?.maskedPhone} expiresAt={reg?.expiresAt} onCheck={inPersonCheck} />
      )
      break
    case 'recovery':
      body = <Recovery go={go} />
      break
    case 'welcome':
      body = voter ? (
        <Welcome firstName={voter.firstName} ballot={ballotInfo} total={BALLOT.length} onOpenBallot={openBallot} onLogout={logout} />
      ) : null
      break
    case 'ballot':
      body = (
        <Ballot
          api={api}
          session={voter?.session}
          initialPicks={picks}
          onUnauthorized={sessionEnded}
          onSubmitted={() => {
            setBallotInfo({ state: 'submitted', answered: 0 })
            showNotice({
              title: 'Your ballot is in',
              body: 'Thank you for voting. You can’t change it now, and nobody can vote again with your code.',
              actions: [{ label: 'Sign out', onClick: logout }],
            })
          }}
        />
      )
      break
    case 'notice':
      body = notice ? <Notice {...notice} /> : null
      break
    default:
      body = null
  }

  return (
    <div className="shell protoShell">
      <div className="inner">
        <div key={screen === 'notice' ? `notice:${notice?.title}` : screen}>{body}</div>
      </div>
    </div>
  )
}
