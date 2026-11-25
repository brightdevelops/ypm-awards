import { LIST_LIMIT } from '../../lib/codes.js'

// Each code is in exactly one state, so the tiles add up to the total.
// When the list is cut off, "used" and "expired" can't be told apart from
// the exact totals, so they're shown as one figure.
export default function CodeStats({ stats }) {
  const tiles = stats.complete
    ? [
        ['available', 'Available', stats.available],
        ['used', 'Used', stats.used],
        ['expired', 'Expired', stats.expired],
        ['revoked', 'Revoked', stats.revoked],
      ]
    : [
        ['available', 'Available', stats.available],
        ['usedExpired', 'Used or expired', stats.usedOrExpired],
        ['revoked', 'Revoked', stats.revoked],
      ]

  return (
    <section aria-label="Code totals">
      <div className="codeStats">
        <div className="codeStat total">
          <span className="statNum">{stats.total}</span>
          <span className="statLabel">Total issued</span>
        </div>
        {tiles.map(([key, label, n]) => (
          <div className={`codeStat ${key}`} key={key}>
            <span className="statNum">{n}</span>
            <span className="statLabel">
              <span className={`dot ${key}`} aria-hidden="true" />
              {label}
            </span>
          </div>
        ))}
      </div>
      {!stats.complete && (
        <p className="dim small statsFoot">
          Among the newest {LIST_LIMIT}: {stats.inList.available} available, {stats.inList.used}{' '}
          used, {stats.inList.expired} expired, {stats.inList.revoked} revoked.
        </p>
      )}
    </section>
  )
}
