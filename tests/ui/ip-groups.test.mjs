// The admin voter list's "Same IP as someone else" filter.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasIpData, sharedIpVoters } from '../../src/lib/ipGroups.js'

const v = (voter_name, voter_ip) => ({ voter_name, voter_phone: '08000000000', voter_ip })

test('lists only voters whose address has more than one ballot, busiest address first', () => {
  const voters = [
    v('Zed', '1.1.1.1'), v('Amy', '2.2.2.2'), v('Bob', '1.1.1.1'),
    v('Cat', '3.3.3.3'), v('Dan', '2.2.2.2'), v('Eve', '2.2.2.2'), v('Old', null),
  ]
  assert.deepEqual(
    sharedIpVoters(voters).map((x) => `${x.voter_ip} ${x.voter_name}`),
    ['2.2.2.2 Amy', '2.2.2.2 Dan', '2.2.2.2 Eve', '1.1.1.1 Bob', '1.1.1.1 Zed'],
  )
})

test('nothing shared, nothing listed; voters without an IP never count', () => {
  assert.deepEqual(sharedIpVoters([v('A', '1.1.1.1'), v('B', null), v('C', null)]), [])
  assert.deepEqual(sharedIpVoters(), [])
})

test('knows whether the dashboard sends IPs at all (009 installed)', () => {
  assert.equal(hasIpData([v('A', null)]), true)
  assert.equal(hasIpData([{ voter_name: 'A', voter_phone: '080' }]), false)
  assert.equal(hasIpData([]), false)
})
