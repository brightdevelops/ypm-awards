import ScreenFrame from '../ScreenFrame.jsx'

// After a returning voter signs in (simulated).
export default function Welcome({ go, voter }) {
  if (!voter) return null

  if (voter.submitted) {
    return (
      <ScreenFrame title={`You’ve already voted, ${voter.firstName}`}>
        <p className="dim">
          Each registered voter can submit one ballot, and yours is in. Thank you for taking part.
        </p>
        <button type="button" className="btn primary" onClick={() => go('login')}>
          Done
        </button>
      </ScreenFrame>
    )
  }

  const { answered, total } = voter.ballot
  return (
    <ScreenFrame title={`Welcome back, ${voter.firstName}`}>
      <p className="dim">
        You have an unfinished ballot: {answered} of {total} categories answered.
      </p>
      <div className="progressBar protoInlineBar" aria-hidden="true">
        <div className="progressFill" style={{ width: `${(answered / total) * 100}%` }} />
      </div>
      <button type="button" className="btn primary" onClick={() => go('login')}>
        Resume my ballot
      </button>
      <p className="fineprint">
        Prototype: the real ballot would open here, where you left off.
      </p>
    </ScreenFrame>
  )
}
