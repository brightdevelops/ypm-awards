// Voters who share an IP address (migration 009), for the admin voter list.
// Returns only voters whose address has more than one ballot, grouped by
// address (busiest first), names in order within each group.
export function sharedIpVoters(voters = []) {
  const groups = new Map()
  for (const v of voters) {
    if (!v.voter_ip) continue
    if (!groups.has(v.voter_ip)) groups.set(v.voter_ip, [])
    groups.get(v.voter_ip).push(v)
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .sort((a, b) => b.length - a.length || a[0].voter_ip.localeCompare(b[0].voter_ip))
    .flatMap((g) => [...g].sort((a, b) => String(a.voter_name).localeCompare(String(b.voter_name))))
}

// Whether the dashboard's data includes IP addresses at all (009 installed).
export function hasIpData(voters = []) {
  return voters.some((v) => 'voter_ip' in v)
}
