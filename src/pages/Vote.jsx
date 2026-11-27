import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient.js'
import { BALLOT } from '../data/categories.js'
import { normalizePhone, isValidPhone } from '../lib/phone.js'
import { START_REFUSALS, SUBMIT_MESSAGES, isAccountBallot, submitOutcome } from '../lib/ballotMessages.js'

const STORE_KEY = 'ypm-awards-ballot-v1'
const ANNOUNCE = '19 December'

function loadLocal() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || null
  } catch {
    return null
  }
}

function saveLocal(state) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state))
  } catch {
    /* private mode — ballot still lives on the server */
  }
}

function clearLocal() {
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    /* ignore */
  }
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')
}

export default function Vote() {
  const [view, setView] = useState('loading') // loading | closed | start | voting | review | done | voted | account
  const [votingOpen, setVotingOpen] = useState(true)
  const [ballotId, setBallotId] = useState(null)
  const [picks, setPicks] = useState({}) // { categoryId: nomineeName }
  const [unsynced, setUnsynced] = useState({})
  const [index, setIndex] = useState(0)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [needsCode, setNeedsCode] = useState(false) // the server requires a code for new ballots
  const [showCode, setShowCode] = useState(false) // voter opened the code field, or the server asked
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [justPicked, setJustPicked] = useState(null)
  const advanceTimer = useRef(null)
  const accountBallot = useRef(false) // a youth leader linked this ballot to a voter account

  // Boot: check whether voting is open, then resume any ballot on this device.
  useEffect(() => {
    let cancelled = false

    async function boot() {
      const { data: status } = await supabase.rpc('voting_status')
      if (cancelled) return

      const open = status?.voting_open !== false
      setVotingOpen(open)
      setNeedsCode(status?.require_voting_code === true)

      const local = loadLocal()
      if (local?.ballotId) {
        setBallotId(local.ballotId)
        setPicks(local.picks || {})
        setUnsynced(local.unsynced || {})
        if (local.completed) {
          setView('done')
          return
        }
        const answered = BALLOT.findIndex((c) => !(local.picks || {})[c.id])
        setIndex(answered === -1 ? 0 : answered)
        setView(answered === -1 ? 'review' : open ? 'voting' : 'closed')
        return
      }

      setView(open ? 'start' : 'closed')
    }

    boot().catch(() => {
      if (!cancelled) setView('start')
    })

    return () => {
      cancelled = true
      if (advanceTimer.current) clearTimeout(advanceTimer.current)
    }
  }, [])

  function persist(next) {
    saveLocal({
      ballotId: next.ballotId ?? ballotId,
      picks: next.picks ?? picks,
      unsynced: next.unsynced ?? unsynced,
      completed: next.completed ?? false,
    })
  }

  async function startBallot(e) {
    e.preventDefault()
    setError('')

    if (name.trim().length < 2) return setError('Please enter your name.')
    if (!isValidPhone(phone))
      return setError('Enter a valid phone number, e.g. 08012345678.')

    if (needsCode && !code.trim())
      return setError('Enter the voting code a youth leader gave you.')

    setBusy(true)
    const { data, error: err } = await supabase.rpc('begin_ballot', {
      p_name: name.trim(),
      p_phone: normalizePhone(phone),
      p_code: code.trim() || null,
      // Proves this device started the ballot, so it can be reopened here.
      p_ballot_id: loadLocal()?.ballotId ?? null,
    })
    setBusy(false)

    if (err) return setError('Could not start. Check your connection and try again.')

    switch (data?.status) {
      case 'started':
      case 'resumed':
        break
      case 'closed':
        setVotingOpen(false)
        return setView('closed')
      case 'already_voted':
        return setView('voted')
      case 'code_required':
        setNeedsCode(true)
        setShowCode(true)
        return setError('Enter the voting code a youth leader gave you.')
      case 'invalid_code':
        setShowCode(true)
        return setError(
          'That code isn’t valid. Check it, or ask a youth leader. Each code works for one person.'
        )
      case 'resume_required':
        setShowCode(true)
        return setError(
          'This number already has an unfinished ballot from another phone or browser. ' +
            'Finish it there, or ask a youth leader for a code for this number and enter it here.'
        )
      case 'rate_limited':
        return setError('Too many attempts. Please wait 15 minutes and try again.')
      case 'registered_voter':
      case 'registration_required':
        return setError(START_REFUSALS[data.status])
      default:
        return setError('Please check your name and phone number.')
    }

    const restored = {}
    for (const v of data?.picks || []) restored[v.category_id] = v.nominee_name

    setBallotId(data.ballot_id)
    setPicks(restored)
    const answered = BALLOT.findIndex((c) => !restored[c.id])
    setIndex(answered === -1 ? 0 : answered)
    persist({ ballotId: data.ballot_id, picks: restored, unsynced: {} })
    setView(answered === -1 ? 'review' : 'voting')
  }

  async function syncVote(categoryId, nomineeName) {
    const { data, error: err } = await supabase.rpc('save_vote', {
      p_ballot_id: ballotId,
      p_category_id: categoryId,
      p_nominee_name: nomineeName,
    })

    if (isAccountBallot(data)) {
      accountBallot.current = true
      setView('account')
      return false
    }

    if (err || data?.status === 'error') {
      setUnsynced((u) => {
        const next = { ...u, [categoryId]: nomineeName }
        persist({ unsynced: next })
        return next
      })
      return false
    }

    if (data?.status === 'closed') {
      setVotingOpen(false)
      setView('closed')
      return false
    }

    setUnsynced((u) => {
      if (!(categoryId in u)) return u
      const next = { ...u }
      delete next[categoryId]
      persist({ unsynced: next })
      return next
    })
    return true
  }

  function choose(category, nomineeName) {
    const nextPicks = { ...picks, [category.id]: nomineeName }
    setPicks(nextPicks)
    persist({ picks: nextPicks })
    setJustPicked(nomineeName)
    syncVote(category.id, nomineeName)

    if (advanceTimer.current) clearTimeout(advanceTimer.current)
    advanceTimer.current = setTimeout(() => {
      setJustPicked(null)
      if (accountBallot.current) return
      if (index + 1 >= BALLOT.length) setView('review')
      else setIndex(index + 1)
    }, 300)
  }

  async function submitBallot() {
    setError('')
    setBusy(true)

    // Flush anything that failed to save earlier before closing the ballot.
    // Never submit with a pick missing: once submitted it can't be fixed.
    let failed = 0
    for (const [categoryId, nomineeName] of Object.entries(unsynced)) {
      if (!(await syncVote(categoryId, nomineeName))) failed++
    }
    if (accountBallot.current) return setBusy(false)
    if (failed > 0) {
      setBusy(false)
      return setError(
        `${failed} of your votes ${failed === 1 ? 'hasn’t' : 'haven’t'} been saved yet. ` +
          'Check your connection and tap Submit again. If it keeps happening, tell a youth leader.'
      )
    }

    const { data, error: err } = await supabase.rpc('submit_ballot', {
      p_ballot_id: ballotId,
    })
    setBusy(false)

    // Never show "Your vote is in" without the server saying so.
    switch (submitOutcome(data, err)) {
      case 'submitted':
        persist({ completed: true })
        return setView('done')
      case 'closed':
        setVotingOpen(false)
        return setView('closed')
      case 'account':
        accountBallot.current = true
        return setView('account')
      case 'unknown_ballot':
        return setError(SUBMIT_MESSAGES.unknown_ballot)
      default:
        return setError(
          err ? 'Could not submit. Check your connection and try again.' : SUBMIT_MESSAGES.unconfirmed,
        )
    }
  }

  /* ---------- screens ---------- */

  if (view === 'loading') {
    return (
      <Shell>
        <div className="card center dim">Loading…</div>
      </Shell>
    )
  }

  if (view === 'closed') {
    return (
      <Shell>
        <div className="card center">
          <Crest />
          <h1 className="display">Voting has closed</h1>
          <p className="dim">
            Thank you. The winners will be announced on {ANNOUNCE}.
          </p>
        </div>
      </Shell>
    )
  }

  if (view === 'voted') {
    return (
      <Shell>
        <div className="card center">
          <Crest />
          <h1 className="display">You have already voted</h1>
          <p className="dim">
            This phone number has a completed ballot. Winners are announced on {ANNOUNCE}.
          </p>
        </div>
      </Shell>
    )
  }

  if (view === 'account') {
    return (
      <Shell>
        <div className="card center">
          <Crest />
          <h1 className="display">Please see a youth leader</h1>
          <p className="dim">
            This phone number now has a registered voter account, and this ballot belongs to it.
            The votes already saved are kept, but this ballot can’t be changed or submitted from
            this page.
          </p>
        </div>
      </Shell>
    )
  }

  if (view === 'done') {
    return (
      <Shell>
        <div className="card center">
          <Crest />
          <h1 className="display">Your vote is in</h1>
          <p className="dim">
            Thank you for voting. Winners will be announced on {ANNOUNCE}.
          </p>
          <p className="fineprint">You can close this page.</p>
        </div>
      </Shell>
    )
  }

  if (view === 'start') {
    return (
      <Shell>
        <div className="card">
          <div className="center">
            <Crest />
            <p className="eyebrow">YPM Youth Awards</p>
            <h1 className="display">Cast your vote</h1>
            <p className="dim">
              {BALLOT.length} categories. Takes about two minutes. One vote per person.
            </p>
          </div>

          <form onSubmit={startBallot} className="form">
            <label>
              <span>Your name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
                autoComplete="name"
              />
            </label>
            <label>
              <span>Phone number</span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="08012345678"
                inputMode="tel"
                autoComplete="tel"
              />
            </label>
            {needsCode || showCode ? (
              <label>
                <span>Voting code</span>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="ABCDE-FGHJK"
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  aria-describedby="code-help"
                />
              </label>
            ) : (
              <button type="button" className="linkBtn left" onClick={() => setShowCode(true)}>
                I have a voting code
              </button>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {(error === START_REFUSALS.registered_voter || error === START_REFUSALS.registration_required) && (
              <p className="small">
                <a href="/voter">Sign in with your voter code, or ask a youth leader to register you</a>
              </p>
            )}
            <button className="btn primary" disabled={busy}>
              {busy ? 'Starting…' : 'Start voting'}
            </button>
            {(needsCode || showCode) && (
              <p className="fineprint" id="code-help">
                {needsCode
                  ? 'Each voter needs a code from a youth leader. It works for one person only.'
                  : 'Codes come from youth leaders. Use yours to continue a ballot from another phone.'}
              </p>
            )}
            <p className="fineprint">
              Your number is only used to make sure each person votes once. It is never
              shown to anyone else.
            </p>
          </form>
        </div>
      </Shell>
    )
  }

  if (view === 'review') {
    const skipped = BALLOT.filter((c) => !picks[c.id])

    return (
      <Shell>
        <div className="card">
          <p className="eyebrow">Last step</p>
          <h1 className="display">Review your votes</h1>
          <p className="dim">Tap any line to change it.</p>

          <ul className="review">
            {BALLOT.map((c, i) => (
              <li key={c.id}>
                <button
                  className="reviewRow"
                  onClick={() => {
                    setIndex(i)
                    setView('voting')
                  }}
                >
                  <span className="reviewCat">{c.name}</span>
                  <span className={picks[c.id] ? 'reviewPick' : 'reviewPick empty'}>
                    {picks[c.id] || 'Not voted'}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {skipped.length > 0 && (
            <p className="warn">
              You skipped {skipped.length}{' '}
              {skipped.length === 1 ? 'category' : 'categories'}. You can submit anyway.
            </p>
          )}
          {error && <p className="error" role="alert">{error}</p>}

          <button className="btn primary" onClick={submitBallot} disabled={busy}>
            {busy ? 'Submitting…' : 'Submit my votes'}
          </button>
          <p className="fineprint">Once submitted, your votes cannot be changed.</p>
        </div>
      </Shell>
    )
  }

  // view === 'voting'
  const category = BALLOT[index]
  const progress = ((index + (picks[category.id] ? 1 : 0)) / BALLOT.length) * 100

  return (
    <Shell>
      <div className="progressWrap">
        <div className="progressBar">
          <div className="progressFill" style={{ width: `${progress}%` }} />
        </div>
        <div className="progressMeta">
          <span>{category.section}</span>
          <span>
            {index + 1} / {BALLOT.length}
          </span>
        </div>
      </div>

      <div className="card">
        <h1 className="categoryName">{category.name}</h1>
        <p className="dim small">Choose one</p>

        <div className="nominees">
          {category.nominees.map((n) => {
            const selected = picks[category.id] === n.name
            return (
              <button
                key={n.name}
                className={`nominee${selected ? ' selected' : ''}${
                  justPicked === n.name ? ' flash' : ''
                }`}
                onClick={() => choose(category, n.name)}
              >
                <span className="avatar">
                  {n.photo ? (
                    <img src={`/nominees/${n.photo}`} alt="" />
                  ) : (
                    initials(n.name)
                  )}
                </span>
                <span className="nomineeName">{n.name}</span>
                <span className="tick" aria-hidden="true">
                  {selected ? '✓' : ''}
                </span>
              </button>
            )
          })}
        </div>

        <div className="navRow">
          <button
            className="btn ghost"
            onClick={() => (index === 0 ? null : setIndex(index - 1))}
            disabled={index === 0}
          >
            Back
          </button>
          <button
            className="btn ghost"
            onClick={() =>
              index + 1 >= BALLOT.length ? setView('review') : setIndex(index + 1)
            }
          >
            {picks[category.id] ? 'Next' : 'Skip'}
          </button>
        </div>

        {Object.keys(unsynced).length > 0 && (
          <p className="fineprint warnText">
            Some votes are waiting for a better connection. They will be sent when you
            submit.
          </p>
        )}
      </div>

      <button className="linkBtn" onClick={() => setView('review')}>
        Review all {BALLOT.length} categories
      </button>
    </Shell>
  )
}

function Shell({ children }) {
  return (
    <div className="shell">
      <div className="inner">{children}</div>
    </div>
  )
}

function Crest() {
  return (
    <svg className="crest" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="18" r="11" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M24 11.5l2.3 4.7 5.2.8-3.8 3.7.9 5.2-4.6-2.4-4.6 2.4.9-5.2-3.8-3.7 5.2-.8z"
        fill="currentColor"
      />
      <path
        d="M17 28l-3 13 10-5 10 5-3-13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}
