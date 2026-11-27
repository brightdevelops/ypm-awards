import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient.js'
import ResultsTab from '../components/admin/ResultsTab.jsx'
import CodesTab from '../components/admin/CodesTab.jsx'
import ActivityTab from '../components/admin/ActivityTab.jsx'
import { adminReply } from '../lib/rpcErrors.js'
import '../admin.css'

// One saved session per door, so signing in at /inventor doesn't sign out /admin.
// Only the session token (and when it expires) is kept, never the key.
// Voting codes are never stored anywhere in the browser.
const DOOR = window.location.pathname.replace(/\/+$/, '') || '/admin'
const SESSION_STORE = `ypm-awards-admin-session${DOOR}`
const EXPIRES_STORE = `${SESSION_STORE}:expires`
const TAB_STORE = `ypm-awards-admin-tab${DOOR}`

// Registered voters needs voter accounts (migrations 003–007), which this
// release doesn't include. import.meta.env.DEV is fixed at build time, so a
// production build contains neither the tab nor its code, and no
// environment variable can switch it on there.
const VotersTab = import.meta.env.DEV ? lazy(() => import('../components/admin/VotersTab.jsx')) : null

const TABS = [
  { id: 'results', label: 'Results' },
  { id: 'codes', label: 'Voting codes' },
  ...(VotersTab ? [{ id: 'voters', label: 'Registered voters' }] : []),
  { id: 'activity', label: 'Activity' },
]

function readSession() {
  try {
    // Versions before sessions kept the raw key here; don't leave it behind.
    sessionStorage.removeItem(`ypm-awards-admin-key${DOOR}`)
    return sessionStorage.getItem(SESSION_STORE) || ''
  } catch {
    return ''
  }
}

function readExpiry() {
  try {
    const t = Date.parse(sessionStorage.getItem(EXPIRES_STORE) || '')
    return Number.isNaN(t) ? null : t
  } catch {
    return null
  }
}

function writeSession(token, expiresAt) {
  try {
    if (token) {
      sessionStorage.setItem(SESSION_STORE, token)
      if (expiresAt) sessionStorage.setItem(EXPIRES_STORE, expiresAt)
    } else {
      sessionStorage.removeItem(SESSION_STORE)
      sessionStorage.removeItem(EXPIRES_STORE)
    }
  } catch {
    /* private mode — you'll just sign in again on reload */
  }
}

function readTab() {
  try {
    const t = sessionStorage.getItem(TAB_STORE)
    return TABS.some((x) => x.id === t) ? t : 'results'
  } catch {
    return 'results'
  }
}

export default function Admin() {
  const [session, setSession] = useState(readSession)
  const [key, setKey] = useState('')
  const [data, setData] = useState(null)
  const [weakKey, setWeakKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState(readTab)
  const tabRefs = useRef({})

  // Signing out unmounts the whole dashboard, which clears anything held in
  // it, including codes on the show-once screen.
  const signedOut = useCallback((message = '') => {
    writeSession('')
    setSession('')
    setData(null)
    setError(message)
  }, [])

  const load = useCallback(
    async (token = session) => {
      setBusy(true)
      setError('')
      const { data: res, error: err } = await supabase.rpc('admin_dashboard', { p_session: token })
      setBusy(false)

      if (err) return setError('Could not load. Check your connection and refresh.')
      if (res?.status !== 'ok') return signedOut('Your session has ended. Please sign in again.')
      setData(res)
      return true
    },
    [session, signedOut],
  )

  // One place that turns an admin RPC into { kind: 'ok' | 'unauthorized' |
  // 'unexpected' | 'network', res }. Never retries. A 'network' result
  // carries missing: true when the database doesn't have that function.
  const adminRpc = useCallback(
    async (fn, args = {}) => {
      try {
        const { data: res, error: err } = await supabase.rpc(fn, { p_session: session, ...args })
        const reply = adminReply(res, err)
        if (reply.kind === 'unauthorized') signedOut('Your session has ended. Please sign in again.')
        return reply
      } catch {
        return { kind: 'network' }
      }
    },
    [session, signedOut],
  )

  async function signIn(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { data: res, error: err } = await supabase.rpc('admin_login', { p_key: key })
    setBusy(false)

    if (err) return setError('Could not sign in. Check your connection and try again.')
    if (res?.status === 'rate_limited')
      return setError('Too many wrong keys. Sign-in is paused for 15 minutes.')
    if (res?.status !== 'ok') return setError('Wrong admin key.')

    setKey('')
    setWeakKey(res.weak_key === true)
    writeSession(res.session, res.expires_at)
    setSession(res.session)
    await load(res.session)
  }

  async function signOut() {
    await supabase.rpc('admin_logout', { p_session: session })
    signedOut()
  }

  useEffect(() => {
    if (session) load(session)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sign out on this device when the session's 12 hours are up, even if the
  // page is just sitting open (e.g. on the show-once code screen).
  useEffect(() => {
    if (!session) return
    const expiresAt = readExpiry()
    if (!expiresAt) return
    const end = () => signedOut('Your session has ended. Please sign in again.')
    const check = () => {
      if (Date.now() >= expiresAt) end()
    }
    const timer = setTimeout(end, Math.min(Math.max(expiresAt - Date.now(), 0), 2 ** 31 - 1))
    document.addEventListener('visibilitychange', check)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [session, signedOut])

  function chooseTab(id) {
    setTab(id)
    try {
      sessionStorage.setItem(TAB_STORE, id)
    } catch {
      /* not important */
    }
  }

  function onTabKey(e) {
    const i = TABS.findIndex((t) => t.id === tab)
    let next = null
    if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length]
    else if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length]
    else if (e.key === 'Home') next = TABS[0]
    else if (e.key === 'End') next = TABS[TABS.length - 1]
    if (!next) return
    e.preventDefault()
    chooseTab(next.id)
    tabRefs.current[next.id]?.focus()
  }

  async function toggleVoting() {
    const next = !data.voting_open
    const label = next ? 'Open voting again?' : 'Close voting now? Nobody will be able to vote after this.'
    if (!window.confirm(label)) return

    setBusy(true)
    const { data: res } = await supabase.rpc('admin_set_voting_open', {
      p_session: session,
      p_open: next,
    })
    if (res?.status === 'unauthorized') {
      setBusy(false)
      return signedOut('Your session has ended. Please sign in again.')
    }
    await load()
  }

  async function toggleCodeRequired() {
    const next = !data.require_voting_code
    let label
    if (next) {
      label =
        'Require a voting code for new ballots? Anyone without a code won’t be able to start ' +
        'voting. Unfinished ballots can still be resumed on the same phone.'
      if ((data.codes?.available ?? 0) === 0) {
        label += '\n\nWarning: there are no unused codes available yet. Issue codes first, ' +
          'or nobody new will be able to vote.'
      }
    } else {
      label =
        'Make voting codes optional? Anyone will be able to start a ballot with just their ' +
        'name and phone number.'
    }
    if (!window.confirm(label)) return

    setBusy(true)
    let failure = ''
    try {
      const { data: res, error: err } = await supabase.rpc('admin_set_code_required', {
        p_session: session,
        p_required: next,
      })
      if (err) {
        failure =
          'Could not change the code setting. Check your connection and try again. ' +
          'The status below is the current setting.'
      } else if (res?.status === 'unauthorized') {
        setBusy(false)
        return signedOut('Your session has ended. Please sign in again.')
      } else if (res?.status !== 'ok') {
        failure = 'Could not change the code setting. The status below is the current setting.'
      }
    } catch {
      failure =
        'Could not change the code setting. Check your connection and try again. ' +
        'The status below is the current setting.'
    }

    // Always show what the server has, never what we hoped to set.
    // If the refresh itself fails, its own message (or the sign-in screen) is shown instead.
    const refreshed = await load()
    if (failure && refreshed) setError(failure)
  }

  if (!session || !data) {
    if (session && !error) {
      return (
        <div className="shell">
          <div className="inner">
            <div className="card center dim">Loading…</div>
          </div>
        </div>
      )
    }

    return (
      <div className="shell">
        <div className="inner">
          <div className="card">
            <p className="eyebrow">YPM Youth Awards</p>
            <h1 className="display">Admin</h1>
            <form className="form" onSubmit={signIn}>
              <label>
                <span>Admin key</span>
                <input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoComplete="off"
                />
              </label>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="btn primary" disabled={busy}>
                {busy ? 'Checking…' : 'Open dashboard'}
              </button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="shell adminShell">
      <div className="inner wide">
        <div className="adminHead">
          <div>
            <p className="eyebrow">
              YPM Youth Awards{data.key_label ? ` · ${data.key_label}` : ''}
            </p>
            <h1 className="display">Admin dashboard</h1>
          </div>
          <div className="adminActions">
            <button className="btn ghost small" onClick={() => load()} disabled={busy}>
              {busy ? 'Refreshing…' : 'Refresh'}
            </button>
            <button className="btn ghost small" onClick={signOut} disabled={busy}>
              Sign out
            </button>
          </div>
        </div>

        {weakKey && (
          <p className="warn" role="status">
            Your admin key is shorter than 16 characters. Ask whoever manages the database to
            set a longer one with <code>ypm_private.set_admin_key</code>.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="statRow">
          <div className="stat">
            <span className="statNum">{data.ballots_completed}</span>
            <span className="statLabel">Ballots submitted</span>
          </div>
          <div className="stat">
            <span className="statNum">{data.ballots_started - data.ballots_completed}</span>
            <span className="statLabel">In progress</span>
          </div>
          <div className="stat">
            <span className={`statPill ${data.voting_open ? 'open' : 'shut'}`}>
              {data.voting_open ? 'Voting open' : 'Voting closed'}
            </span>
            <button className="btn ghost small" onClick={toggleVoting} disabled={busy}>
              {data.voting_open ? 'Close voting' : 'Reopen voting'}
            </button>
          </div>
          <div className="stat">
            <span className={`statPill ${data.require_voting_code ? 'open' : 'neutral'}`}>
              {data.require_voting_code ? 'Codes required' : 'Codes optional'}
            </span>
            <span className="statLabel">
              {data.codes?.available ?? 0} available · {data.codes?.issued ?? 0} issued
            </span>
            <button className="btn ghost small" onClick={toggleCodeRequired} disabled={busy}>
              {data.require_voting_code ? 'Make codes optional' : 'Require codes'}
            </button>
          </div>
        </div>

        <div className="adminTabs" role="tablist" aria-label="Dashboard sections" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el
              }}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={`adminTab${tab === t.id ? ' on' : ''}`}
              onClick={() => chooseTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div
          className="tabPanel"
          role="tabpanel"
          id={`panel-${tab}`}
          aria-labelledby={`tab-${tab}`}
        >
          {tab === 'results' && <ResultsTab data={data} />}
          {tab === 'codes' && (
            <CodesTab data={data} adminRpc={adminRpc} reloadDashboard={load} />
          )}
          {tab === 'voters' && VotersTab && (
            <Suspense fallback={<div className="card center dim">Loading…</div>}>
              <VotersTab adminRpc={adminRpc} adminLabel={data.key_label} />
            </Suspense>
          )}
          {tab === 'activity' && <ActivityTab />}
        </div>
      </div>
    </div>
  )
}
