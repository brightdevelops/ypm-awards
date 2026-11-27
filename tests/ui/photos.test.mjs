// Nominee photos (src/assets/nominees/). Catches the usual mistakes before
// they reach voters: a file named so it matches nobody, a `photo` setting
// that points at a missing file, and photos too big for mobile data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BALLOT } from '../../src/data/categories.js'
import { PHOTO_EXTENSIONS, initials, photoSlug } from '../../src/lib/photoNames.js'

const DIR = fileURLToPath(new URL('../../src/assets/nominees/', import.meta.url))
const MAX_KB = 300

const photos = readdirSync(DIR).filter((f) => !f.startsWith('.') && f !== 'README.md')
const ext = (f) => f.split('.').pop().toLowerCase()
const base = (f) => f.slice(0, -(ext(f).length + 1)).toLowerCase()

const nominees = BALLOT.flatMap((c) => c.nominees)
const slugs = new Set(nominees.filter((n) => !n.photo).map((n) => photoSlug(n.name)))
const overrides = new Set(nominees.filter((n) => n.photo).map((n) => n.photo.toLowerCase()))

test('photo file names come from the nominee name', () => {
  assert.equal(photoSlug('Peace Williams'), 'peace-williams')
  assert.equal(photoSlug('  Elizabeth   Enikanologbon '), 'elizabeth-enikanologbon')
  assert.equal(photoSlug("Chi-Chi O'Neil"), 'chi-chi-o-neil')
  assert.equal(photoSlug('Bright'), 'bright')
  assert.equal(initials('Peace Williams'), 'PW')
  assert.equal(initials('Bright'), 'B')
})

test('every photo is a supported image type', () => {
  const bad = photos.filter((f) => !PHOTO_EXTENSIONS.includes(ext(f)))
  assert.deepEqual(bad, [], `Use .jpg, .jpeg, .png or .webp for: ${bad.join(', ')}`)
})

test('every photo matches a nominee', () => {
  const unmatched = photos.filter((f) => !slugs.has(base(f)) && !overrides.has(f.toLowerCase()))
  assert.deepEqual(
    unmatched,
    [],
    'These photos match no nominee, so nobody would see them. Rename each to the person\'s ' +
      'name in lower case with dashes (Peace Williams -> peace-williams.jpg): ' +
      unmatched.join(', '),
  )
})

test('every photo set in categories.js exists', () => {
  const have = new Set(photos.map((f) => f.toLowerCase()))
  const missing = [...overrides].filter((f) => !have.has(f))
  assert.deepEqual(missing, [], `Missing from src/assets/nominees/: ${missing.join(', ')}`)
})

test(`every photo is under ${MAX_KB} KB, so the page stays quick on mobile data`, () => {
  const big = photos
    .map((f) => ({ f, kb: Math.round(statSync(DIR + f).size / 1024) }))
    .filter((p) => p.kb > MAX_KB)
  assert.deepEqual(
    big.map((p) => `${p.f} (${p.kb} KB)`),
    [],
    'Shrink these to about 600x750 pixels (see src/assets/nominees/README.md)',
  )
})

test('nominees without a photo are listed (not a failure)', (t) => {
  const have = new Set(photos.map(base))
  const people = [...new Set(nominees.filter((n) => !n.photo).map((n) => n.name))]
  const without = people.filter((name) => !have.has(photoSlug(name)))
  t.diagnostic(`${people.length - without.length} of ${people.length} people have a photo`)
  if (without.length) t.diagnostic(`No photo yet: ${without.join(', ')}`)
})
