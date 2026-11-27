import ScreenFrame from '../ScreenFrame.jsx'

// Voter codes are recovered in person: a youth leader confirms who you are
// and issues a replacement (admin_reissue_voter_code). Nothing is looked up
// here, so this screen can't reveal who has registered.
export default function Recovery({ go }) {
  return (
    <ScreenFrame title="Recover your voter code">
      <p className="dim">
        For your safety, voter codes are never sent by text or shown again on this site.
      </p>
      <ol className="altSteps">
        <li>
          <strong>Find a youth leader</strong>
          <span>At church or a YPM meeting.</span>
        </li>
        <li>
          <strong>They confirm it’s you</strong>
          <span>Using the name and phone number you registered with.</span>
        </li>
        <li>
          <strong>You get a new voter code</strong>
          <span>Your old code stops working straight away. Your ballot is kept.</span>
        </li>
      </ol>
      <button type="button" className="btn primary" onClick={() => go('login')}>
        Back to sign in
      </button>
    </ScreenFrame>
  )
}
