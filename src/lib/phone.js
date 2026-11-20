// Normalise the common Nigerian formats to a single canonical 0XXXXXXXXXX,
// so 0801..., +234801..., 234801... and 801... all count as one voter.
export function normalizePhone(input) {
  let d = String(input || '').replace(/[^\d]/g, '')

  if (d.startsWith('234') && d.length >= 12) d = '0' + d.slice(3)
  else if (d.length === 10 && !d.startsWith('0')) d = '0' + d

  return d
}

export function isValidPhone(input) {
  const d = normalizePhone(input)
  return /^0\d{10}$/.test(d)
}
