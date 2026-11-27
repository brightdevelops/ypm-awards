// Plain helpers for nominee photos, with no build-tool features, so the
// tests can use them directly (photos.js needs Vite).

export const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp']

// "Peace Williams" -> "peace-williams" (the photo file is peace-williams.jpg)
export function photoSlug(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function initials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')
}
