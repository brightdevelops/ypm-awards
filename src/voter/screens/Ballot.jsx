import { useEffect, useRef, useState } from 'react'
import { BALLOT } from '../../data/categories.js'

const initials = (name) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

// The registered voter's ballot (development). Same look as the voting
// page, but every call uses the voter session: the ballot id never reaches
// the browser. Picks are saved one by one; submitting waits until every
// pick is confirmed saved.
export default function Ballot({ api, session, initialPicks, onUnauthorized, onSubmitted }) {
  const [picks, setPicks] = useState(() => {
    const p = {}
    for (const v of initialPicks || []) p[v.category_id] = v.nominee_name
    return p
  })
  const [saving, setSaving] = useState({}) // categoryId -> 'saving' | 'error'
  const [index, setIndex] = useState(() => {
    const first = BALLOT.findIndex((c) => !(initialPicks || []).some((v) => v.category_id === c.id))
    return first === -1 ? BALLOT.length : first
  })
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const latest = useRef({}) // categoryId -> last requested name, so late replies don't win
  const headRef = useRef(null)

  useEffect(() => {
    headRef.current?.focus()
  }, [index])

  async function choose(category, nomineeName) {
    setError('')
    setPicks((p) => ({ ...p, [category.id]: nomineeName }))
    setSaving((s) => ({ ...s, [category.id]: 'saving' }))
    latest.current[category.id] = nomineeName

    const r = await api.save(session, category.id, nomineeName)
    if (latest.current[category.id] !== nomineeName) return // a newer pick is in flight
    if (r.kind === 'unauthorized') return onUnauthorized()
    if (r.kind === 'answer' && r.status === 'ok') {
      setSaving((s) => {
        const n = { ...s }
        delete n[category.id]
        return n
      })
      return
    }
    setSaving((s) => ({ ...s, [category.id]: 'error' }))
    if (r.kind === 'answer' && r.status === 'closed') setError('Voting has closed.')
    else if (r.kind === 'answer' && r.data?.message === 'already submitted') setError('This ballot has already been submitted.')
    else setError('That choice wasn’t saved. Tap it again to retry.')
  }

  async function submit() {
    if (submitting) return
    setError('')
    setSubmitting(true)
    const r = await api.submit(session)
    if (r.kind === 'unauthorized') return onUnauthorized()
    if (r.kind === 'answer' && r.status === 'ok') return onSubmitted()

    if (r.kind === 'failed') {
      // It may have gone through. Ask the server rather than guess.
      const check = await api.begin(session)
      setSubmitting(false)
      if (check.kind === 'answer' && check.status === 'already_voted') return onSubmitted()
      if (check.kind === 'unauthorized') return onUnauthorized()
      return setError('We couldn’t confirm your ballot was submitted. Check your connection and submit again.')
    }
    setSubmitting(false)
    setError(r.status === 'closed' ? 'Voting has closed.' : 'Your ballot wasn’t submitted. Please try again.')
  }

  const unsaved = Object.keys(saving)
  const pending = unsaved.some((id) => saving[id] === 'saving')

  // ---------- Review ----------
  if (index >= BALLOT.length) {
    const skipped = BALLOT.filter((c) => !picks[c.id])
    return (
      <section className="card protoCard" aria-labelledby="ballot-review">
        <p className="eyebrow">Your ballot</p>
        <h1 id="ballot-review" className="display" tabIndex={-1} ref={headRef}>
          Review and submit
        </h1>
        <p className="dim">
          {skipped.length
            ? `${skipped.length} ${skipped.length === 1 ? 'category is' : 'categories are'} not voted. You can still submit.`
            : 'You’ve voted in every category.'}
        </p>
        <ul className="review">
          {BALLOT.map((c, i) => (
            <li key={c.id}>
              <button type="button" className="reviewRow" onClick={() => setIndex(i)}>
                <span className="reviewCat">{c.name}</span>
                <span className={picks[c.id] ? 'reviewPick' : 'reviewPick empty'}>
                  {picks[c.id] || 'Not voted'}
                  {saving[c.id] === 'saving' && ' · saving…'}
                  {saving[c.id] === 'error' && ' · not saved'}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {unsaved.length > 0 && !pending && (
          <p className="warnText small" role="status">
            Some choices aren’t saved. Open them and tap your choice again before submitting.
          </p>
        )}
        <button
          type="button"
          className="btn primary"
          onClick={submit}
          disabled={submitting || unsaved.length > 0}
        >
          {submitting ? 'Submitting…' : pending ? 'Saving your choices…' : 'Submit my ballot'}
        </button>
        <p className="fineprint">Once submitted, your ballot can’t be changed.</p>
      </section>
    )
  }

  // ---------- One category ----------
  const category = BALLOT[index]
  const progress = (index / BALLOT.length) * 100
  return (
    <>
      <div className="progressWrap" aria-hidden="true">
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
      <section className="card" aria-labelledby="ballot-cat">
        <h1 id="ballot-cat" className="categoryName" tabIndex={-1} ref={headRef}>
          {category.name}
        </h1>
        <p className="dim small">
          Category {index + 1} of {BALLOT.length}
          {saving[category.id] === 'saving' && ' · saving…'}
          {saving[category.id] === 'error' && ' · not saved'}
        </p>
        <div className="nominees" role="radiogroup" aria-labelledby="ballot-cat">
          {category.nominees.map((n) => {
            const selected = picks[category.id] === n.name
            return (
              <button
                key={n.name}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`nominee${selected ? ' selected' : ''}`}
                onClick={() => choose(category, n.name)}
              >
                <span className="avatar" aria-hidden="true">
                  {initials(n.name)}
                </span>
                <span className="nomineeName">{n.name}</span>
                <span className="tick" aria-hidden="true">
                  {selected ? '✓' : ''}
                </span>
              </button>
            )
          })}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="navRow">
          <button
            type="button"
            className="btn ghost"
            onClick={() => setIndex(index - 1)}
            disabled={index === 0}
          >
            Back
          </button>
          <button type="button" className="btn primary protoNext" onClick={() => setIndex(index + 1)}>
            {picks[category.id] ? 'Next' : 'Skip'}
          </button>
        </div>
      </section>
      <button type="button" className="linkBtn" onClick={() => setIndex(BALLOT.length)}>
        Go to review
      </button>
    </>
  )
}
