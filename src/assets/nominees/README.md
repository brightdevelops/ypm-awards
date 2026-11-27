# Nominee photos

Put one photo per person in this folder, named after them in lower case with
dashes instead of spaces:

| Nominee | File |
|---|---|
| Peace Williams | `peace-williams.jpg` |
| Elizabeth Enikanologbon | `elizabeth-enikanologbon.jpg` |
| Bright | `bright.jpg` |

- The photo shows in every category that person is nominated in.
- `.jpg`, `.jpeg`, `.png` and `.webp` all work.
- Anyone without a photo shows their initials.
- Cards are portrait (4:5), with faces kept near the top. A head-and-shoulders
  photo about **600×750 pixels** works best. Each file must be under 300 KB.
  Phone photos are usually 2–5 MB: shrink them first, e.g. in Windows Photos
  (… → Resize image) or at squoosh.app.

Then run `npm test`. It tells you if a file name matches nobody (a typo), if a
file is too big, and which people still have no photo.

To use a different file name for someone, set `photo` in
`src/data/categories.js`: `{ name: 'Bright', photo: 'bright-emeka.jpg' }`.

Photos don't change the ballot, so no SQL needs to run when you add them.
