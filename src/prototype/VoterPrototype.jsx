import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './prototype.css'
import { Progress } from './ScreenFrame.jsx'
import { voterApi, configured } from './connection.js'
import { createSessionStore } from './voterSession.js'
import { CONSENT_VERSION, OUTCOMES, maskPhone } from './simulator.js'
import { BALLOT } from '../data/categories.js'
import TesterPanel from './TesterPanel.jsx'
import Login from './screens/Login.jsx'
import Register from './screens/Register.jsx'
import Consent from './screens/Consent.jsx'
import Camera from './screens/Camera.jsx'
import Verifying from './screens/Verifying.jsx'
import Success from './screens/Success.jsx'
import Duplicate from './screens/Duplicate.jsx'
import Recovery from './screens/Recovery.jsx'
import Alternative from './screens/Alternative.jsx'
import Welcome from './screens/Welcome.jsx'
import Ballot from './screens/Ballot.jsx'
import Notice from './screens/Notice.jsx'

// Phase 3.3 DEVELOPMENT ONLY: the voter registration screens, connected to
// the development database (migration 003 + the dev simulator).
// Opened only from /prototype/voter under `npm run dev` (see App.jsx).
// No camera. Face-check results are chosen by a signed-in tester.

const PROGRESS = { register: 0, consent: 1, camera: 2, verifying: 2, success: 3 }

export default function VoterPrototype({ api = voterApi }) {
  const store = useMemo(() => createSessionStore(), [])
  const [screen, setScreen] = useState('loading')
  const [notice, setNotice] = useState(null)
  const [details, setDetails] = useState({ name: '', phone: '' })
  const [outcome, setOutcome] = useState('approved')
  const [adminSession, setAdminSession] = useState(null) // memory only
  const [voterCode, setVoterCode] = useState(null) // show-once, memory only
  const [voter, setVoter] = useState(null) // { session, expiresAt, firstName }
  const [ballotInfo, setBallotInfo] = useState(null)
  const [picks, setPicks] = useState([])
  const [loginMessage, setLoginMessage] = useState('')
  const [reg, setReg] = useState(null) // { token, expiresAt, firstName, maskedPhone }
  const regRef = useRef(null)
  regRef.current = reg

  const go = useCallback((next) => {
    if (next !== 'success') setVoterCode(null)
    if (next !== 'login') setLoginMessage('')
    setScreen(next)
    window.scrollTo(0, 0)
  }, [])

  const showNotice = useCallback(
    (n) => {
      setNotice(n)
      go('notice')
    },
    [go],
  )

  const dropRegistration = useCallback(() => {
    store.clearRegistration()
    setReg(null)
  }, [store])

  // ---------- Signing in and out ----------

  const signedIn = useCallback(
    ({ session, expiresAt, firstName, ballot }) => {
      const v = { session, expiresAt, firstName }
      store.setVoter(v)
      setVoter(v)
      setBallotInfo(ballot ?? null)
      go('welcome')
    },
    [store, go],
  )

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
    if (s) await api.logout(s) // signed out here even if this doesn't reach the server
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
      default:
        return showNotice({ title: 'Something went wrong', body: 'Please try again.', actions: [{ label: 'Back', onClick: () => go('welcome') }] })
    }
  }

  // ---------- Registration ----------

  async function startRegistration() {
    const r = await api.start(details.name, details.phone, true, CONSENT_VERSION)
    if (r.kind === 'failed') {
      // It may have reached the server. A stray pending registration is
      // harmless (it expires), but each try counts towards the hourly limit.
      return 'We couldn’t confirm whether your registration started. Check your connection and try again. Each try counts towards a limit of 5 an hour for this number.'
    }
    switch (r.status) {
      case 'ok': {
        const next = {
          token: r.data.registration_token,
          expiresAt: r.data.expires_at,
          firstName: details.name.split(/\s+/)[0],
          maskedPhone: maskPhone(details.phone),
        }
        store.setRegistration(next)
        setReg(next)
        go('camera')
        return null
      }
      case 'adult_required':
        go('alternative')
        return null
      case 'needs_assistance':
        showNotice({
          title: 'Please see a youth leader',
          body: 'We can’t register this phone number online. A youth leader can help you in person.',
          actions: [
            { label: 'I have a voter code', onClick: () => go('login') },
            { label: 'Lost my voter code', onClick: () => go('recovery') },
          ],
        })
        return null
      case 'consent_outdated':
        // 004: the notice on this screen isn't the database's current one.
        // Nothing was started.
        showNotice({
          title: 'The privacy notice has changed',
          body: 'The notice you agreed to isn’t the current one, so your registration wasn’t started. Reload the page to read the current notice, then try again.',
          note: 'Development: CONSENT_VERSION in simulator.js doesn’t match the current version in ypm_private.consent_versions.',
          actions: [{ label: 'Register another way', onClick: () => go('alternative') }],
        })
        return null
      case 'disabled': // 004: voter accounts are switched off for this database
      case 'registration_off':
      case 'verification_unavailable':
        showNotice({
          title: 'Online registration isn’t open',
          body: 'You can register in person with a youth leader instead.',
          note: 'Development: set registration_mode and the simulated provider (setup steps).',
          actions: [{ label: 'Register another way', onClick: () => go('alternative') }],
        })
        return null
      case 'rate_limited':
        return 'Too many attempts for this number. Please wait an hour and try again.'
      default:
        return 'Please check your name and phone number.'
    }
  }

  const routeStatus = useCallback(
    async (status, { lostClaim = false } = {}) => {
      const restart = { label: 'Start again', onClick: () => go('register') }
      switch (status) {
        case 'pending':
          return showNotice({
            title: 'The face check didn’t finish',
            body: 'Nothing was decided yet. You can try the face check again.',
            actions: [{ label: 'Try the face check again', onClick: () => go('camera') }],
          })
        case 'approved':
          return claim({ lostClaim }) // eslint-disable-line no-use-before-define
        case 'review':
          return go('duplicate')
        case 'failed':
          dropRegistration()
          return showNotice({
            title: 'We couldn’t complete the face check',
            body: 'This usually means the light was too dim or the face moved out of the oval. Nothing has been saved.',
            actions: [restart, { label: 'Register another way', onClick: () => go('alternative') }],
          })
        case 'expired':
          dropRegistration()
          return showNotice({
            title: 'Your registration timed out',
            body: 'Registrations have to be finished within 30 minutes. Please start again.',
            actions: [restart],
          })
        case 'claimed':
          dropRegistration()
          return showNotice({
            title: 'This registration is complete',
            body: 'If you didn’t receive your voter code, a youth leader can confirm it’s you and issue a new one.',
            actions: [
              { label: 'Sign in', onClick: () => go('login') },
              { label: 'Lost my voter code', onClick: () => go('recovery') },
            ],
          })
        case 'rejected':
          dropRegistration()
          return showNotice({
            title: 'Registration not approved',
            body: 'A youth leader reviewed this registration. Please see them in person.',
            actions: [{ label: 'Back to start', onClick: () => go('login') }],
          })
        default:
          dropRegistration()
          return showNotice({
            title: 'Registration not found',
            body: 'Please start again.',
            actions: [restart],
          })
      }
    },
    // claim is declared below and only reads refs/state setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [go, showNotice, dropRegistration],
  )

  const checkRegistration = useCallback(async () => {
    const r = regRef.current
    if (!r) return go('login')
    const st = await api.status(r.token)
    if (st.kind !== 'answer') {
      return showNotice({
        title: 'Couldn’t check your registration',
        body: 'Check your connection, then try again.',
        actions: [{ label: 'Check again', onClick: checkRegistration }],
      })
    }
    return routeStatus(st.status)
  }, [api, go, showNotice, routeStatus])

  async function claim({ lostClaim }) {
    const r0 = regRef.current
    let r = await api.claim(r0.token)
    // Tester option: the server answered, but act as if the reply was lost.
    if (lostClaim && r.kind === 'answer') r = { kind: 'failed' }

    if (r.kind === 'failed') {
      // The code may have been created. Ask the server instead of guessing,
      // and never claim twice: the second claim can't return the code.
      const st = await api.status(r0.token)
      if (st.kind === 'answer' && st.status === 'claimed') {
        dropRegistration()
        return showNotice({
          title: 'Your code didn’t reach this device',
          body: [
            'Your registration went through, but the connection dropped before your voter code arrived. For your safety it can’t be shown again.',
            'A youth leader can confirm it’s you and give you a new code. Your registration is kept.',
          ],
          actions: [{ label: 'How to get a new code', onClick: () => go('recovery') }],
        })
      }
      if (st.kind === 'answer' && st.status === 'approved') {
        return showNotice({
          title: 'Couldn’t collect your code',
          body: 'Your registration is approved but the code wasn’t handed out yet. Trying again is safe.',
          actions: [{ label: 'Try again', onClick: () => claim({ lostClaim: false }) }],
        })
      }
      return showNotice({
        title: 'We couldn’t confirm your registration',
        body: 'Check your connection, then check again. Don’t start a new registration yet.',
        actions: [{ label: 'Check again', onClick: checkRegistration }],
      })
    }

    if (r.status === 'ok') {
      const v = { session: r.data.session, expiresAt: r.data.expires_at, firstName: r.data.first_name }
      store.setVoter(v)
      setVoter(v)
      setBallotInfo({ state: 'none', answered: 0 })
      dropRegistration()
      setVoterCode(r.data.voter_code)
      return go('success')
    }
    if (r.status === 'not_ready') return routeStatus(r.data.registration)
    if (r.status === 'needs_assistance') {
      dropRegistration()
      return showNotice({
        title: 'Please see a youth leader',
        body: 'This phone number was used to vote or register while you were registering. A youth leader can sort it out in person.',
        actions: [{ label: 'Back to start', onClick: () => go('login') }],
      })
    }
    return checkRegistration() // invalid / expired: let the status explain
  }

  const verifyTask = useCallback(async () => {
    const r = regRef.current
    const o = OUTCOMES[outcome]
    if (!r) return { type: 'missing' }
    if (!adminSession) return { type: 'tester_needed' }
    const sim = await api.simulate(adminSession, r.token, o.server)
    if (sim.kind === 'unauthorized') return { type: 'tester_needed' }
    if (sim.kind === 'answer' && sim.status === 'disabled') return { type: 'disabled' }
    // Whatever the simulator replied, the registration status is the truth.
    const st = await api.status(r.token)
    if (st.kind !== 'answer') return { type: 'unknown' }
    return { type: 'status', status: st.status, lostClaim: Boolean(o.lostClaim) }
  }, [api, adminSession, outcome])

  const verified = useCallback(
    (result) => {
      if (result.type === 'status') return routeStatus(result.status, { lostClaim: result.lostClaim })
      if (result.type === 'tester_needed') {
        return showNotice({
          title: 'Tester sign-in needed',
          body: 'Development only: open the tester panel below and sign in with the development admin key, then run the face check again.',
          actions: [{ label: 'Back to the face check', onClick: () => go('camera') }],
        })
      }
      if (result.type === 'disabled') {
        return showNotice({
          title: 'Simulated verification is off',
          body: 'This database isn’t set up for simulated verification. Follow the development setup steps.',
          actions: [{ label: 'Back to the face check', onClick: () => go('camera') }],
        })
      }
      if (result.type === 'unknown') {
        return showNotice({
          title: 'We couldn’t confirm the result',
          body: 'Check your connection, then check again. The face check may already have been recorded.',
          actions: [{ label: 'Check again', onClick: checkRegistration }],
        })
      }
      return go('register')
    },
    [routeStatus, showNotice, go, checkRegistration],
  )

  async function duplicateCheck() {
    const r = regRef.current
    if (!r) return 'This registration is no longer on this device.'
    const st = await api.status(r.token)
    if (st.kind !== 'answer') return 'Couldn’t check. Try again in a moment.'
    if (st.status === 'review') return 'Still waiting for a youth leader to review it.'
    routeStatus(st.status)
    return null
  }

  // ---------- Restore after a reload ----------

  useEffect(() => {
    if (!configured) return setScreen('unconfigured')
    const v = store.getVoter()
    if (v) {
      setVoter(v)
      return setScreen('welcome')
    }
    const r = store.getRegistration()
    if (r) {
      setReg(r)
      regRef.current = r
      checkRegistration()
      return
    }
    setScreen('login')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function restart() {
    const s = voter?.session
    store.clearVoter()
    dropRegistration()
    setVoter(null)
    setBallotInfo(null)
    setDetails({ name: '', phone: '' })
    go('login')
    if (s) api.logout(s)
  }

  // ---------- Screens ----------

  let body
  switch (screen) {
    case 'loading':
      body = <div className="card center dim">Loading…</div>
      break
    case 'unconfigured':
      body = (
        <Notice
          title="Not connected"
          body="Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY for the development project to .env.local, then restart npm run dev."
        />
      )
      break
    case 'login':
      body = <Login go={go} api={api} onSignedIn={signedIn} message={loginMessage} />
      break
    case 'register':
      body = (
        <Register
          go={go}
          details={details}
          onSubmit={(d) => {
            setDetails(d)
            go('consent')
          }}
        />
      )
      break
    case 'consent':
      body = <Consent go={go} onAgree={startRegistration} />
      break
    case 'camera':
      body = <Camera go={go} outcome={outcome} />
      break
    case 'verifying':
      body = <Verifying task={verifyTask} onResult={verified} />
      break
    case 'success':
      body = <Success firstName={voter?.firstName} code={voterCode} onContinue={() => go('welcome')} />
      break
    case 'duplicate':
      body = <Duplicate go={go} maskedPhone={reg?.maskedPhone} onCheck={duplicateCheck} />
      break
    case 'recovery':
      body = <Recovery go={go} />
      break
    case 'alternative':
      body = <Alternative go={go} />
      break
    case 'welcome':
      body = voter ? (
        <Welcome
          firstName={voter.firstName}
          ballot={ballotInfo}
          total={BALLOT.length}
          onOpenBallot={openBallot}
          onLogout={logout}
        />
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
      <div className="protoBanner" role="note">
        <strong>Development</strong> · Simulated verification · No camera is used · Synthetic
        test identities only ({'0815550 0xxx'}) · Connected to the development database.
      </div>

      <div className="inner">
        {screen in PROGRESS && <Progress current={PROGRESS[screen]} />}
        <div key={screen === 'notice' ? `notice:${notice?.title}` : screen}>{body}</div>
      </div>

      <TesterPanel
        api={api}
        adminSession={adminSession}
        setAdminSession={setAdminSession}
        outcome={outcome}
        setOutcome={setOutcome}
        onRestart={restart}
      />
    </div>
  )
}
