// Nominee photos. Drop a file into src/assets/nominees/ named after the
// person and it shows up on every category they're in, with no code change:
//
//   Peace Williams           -> peace-williams.jpg
//   Elizabeth Enikanologbon  -> elizabeth-enikanologbon.jpg
//
// .jpg, .jpeg, .png and .webp all work. Anyone without a photo gets their
// initials. To use a different file for one nominee, set `photo` on them in
// categories.js: { name: 'Bright', photo: 'bright-emeka.jpg' }.
//
// Vite bundles these at build time (with a content hash, so phones cache
// them), which is why they live in src/assets and not public/.
// `npm test` checks every file matches a nominee and isn't too big.
import { PHOTO_EXTENSIONS, initials, photoSlug } from './photoNames.js'

export { initials, photoSlug }

const files = import.meta.glob('../assets/nominees/*.{jpg,jpeg,png,webp,JPG,JPEG,PNG,WEBP}', {
  eager: true,
  query: '?url',
  import: 'default',
})

const BY_FILE = {}
for (const [path, url] of Object.entries(files)) {
  BY_FILE[path.split('/').pop().toLowerCase()] = url
}

// The URL of a nominee's photo, or null when there isn't one.
export function photoFor(nominee) {
  if (!nominee) return null
  if (nominee.photo) return BY_FILE[nominee.photo.toLowerCase()] ?? null
  const slug = photoSlug(nominee.name)
  for (const ext of PHOTO_EXTENSIONS) {
    const url = BY_FILE[`${slug}.${ext}`]
    if (url) return url
  }
  return null
}
