// Turns the dashboard's raw tally into what the results page shows.
//
// The ballot changed after voting started, so the database holds votes for
// names (and whole categories) that are no longer on it. Those votes are
// shown as recorded, under the name they were cast for. They are never
// merged into a current nominee, never counted in a current category's
// ranking or percentages, and never hidden. Matching is exact: "Norah Oboh"
// and "Nora Oboh" are different names here. Deciding whether they are the
// same person is for the leaders, not this code.
//
//   ballot:    [{ id, name, nominees: [{ name }] }]   (categories.js BALLOT)
//   tallyRows: [{ category_id, nominee_name, votes }] (submitted ballots only)

const byVotesThenName = (a, b) => b.votes - a.votes || a.name.localeCompare(b.name)

function sumRows(rows) {
  const out = new Map()
  for (const r of rows) {
    out.set(r.nominee_name, (out.get(r.nominee_name) || 0) + Number(r.votes || 0))
  }
  return out
}

export function buildResults(ballot, tallyRows) {
  const rowsByCategory = new Map()
  for (const r of tallyRows || []) {
    if (!rowsByCategory.has(r.category_id)) rowsByCategory.set(r.category_id, [])
    rowsByCategory.get(r.category_id).push(r)
  }

  const categories = ballot.map((c) => {
    const counts = sumRows(rowsByCategory.get(c.id) || [])
    const listed = new Set(c.nominees.map((n) => n.name))

    // Current nominees, in ballot order. Only these are ranked.
    const nominees = c.nominees.map((n) => ({ name: n.name, votes: counts.get(n.name) || 0 }))
    const currentVotes = nominees.reduce((s, n) => s + n.votes, 0)
    const top = Math.max(0, ...nominees.map((n) => n.votes))
    const atTop = nominees.filter((n) => n.votes === top).length
    const tie = top > 0 && atTop > 1
    for (const n of nominees) {
      n.share = currentVotes ? (n.votes / currentVotes) * 100 : 0
      n.leading = top > 0 && !tie && n.votes === top
    }

    // Names with votes in this category that aren't on it any more.
    const historical = [...counts]
      .filter(([name]) => !listed.has(name))
      .map(([name, votes]) => ({ name, votes }))
      .sort(byVotesThenName)
    const historicalVotes = historical.reduce((s, h) => s + h.votes, 0)

    return { id: c.id, name: c.name, nominees, currentVotes, tie, historical, historicalVotes }
  })

  // Whole categories that are no longer on the ballot. Not ranked.
  const onBallot = new Set(ballot.map((c) => c.id))
  const removedCategories = [...rowsByCategory]
    .filter(([id]) => !onBallot.has(id))
    .map(([id, rows]) => {
      const nominees = [...sumRows(rows)]
        .map(([name, votes]) => ({ name, votes }))
        .sort(byVotesThenName)
      return { id, votes: nominees.reduce((s, n) => s + n.votes, 0), nominees }
    })
    .sort((a, b) => a.id.localeCompare(b.id))

  const totals = {
    current: categories.reduce((s, c) => s + c.currentVotes, 0),
    historicalInCurrentCategories: categories.reduce((s, c) => s + c.historicalVotes, 0),
    inRemovedCategories: removedCategories.reduce((s, c) => s + c.votes, 0),
  }
  totals.all = totals.current + totals.historicalInCurrentCategories + totals.inRemovedCategories

  return { categories, removedCategories, totals }
}
