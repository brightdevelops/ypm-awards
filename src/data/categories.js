// The ballot. Edit names here, commit, and Vercel redeploys.
// Photos: put peace-williams.jpg (the name in lower case, dashes for spaces)
// in src/assets/nominees/ and it shows on every card for that person; no
// edit here needed. `photo` only overrides the file name for one nominee.
// See src/assets/nominees/README.md.
//
// Source: leader's "YPM NOMINATIONS 2026" list, 21 Nov 2026.
// Youth Personality of the Year and Teenager of the Year are NOT here —
// the list had no nominees for them. Paste them in when they arrive.

export const SECTIONS = [
  {
    section: 'Service & Commitment',
    categories: [
      {
        id: 'most-reliable-youth',
        name: 'Most Reliable Youth',
        nominees: [
          { name: 'Peace Williams' },
          { name: 'Sarah Bakare' },
          { name: 'Chizoba Uzor' },
        ],
      },
      {
        id: 'most-dedicated-volunteer',
        name: 'Most Dedicated Volunteer',
        nominees: [
          { name: 'Chizoba Uzor' },
          { name: 'Blessing Paul' },
          { name: 'Kunle Salami' },
        ],
      },
      {
        id: 'behind-the-scene-hero',
        name: 'Behind-the-Scenes Hero',
        nominees: [
          { name: 'Ebenezer Obi' },
          { name: 'Sylvester Okosodo' },
          { name: 'Kunle Salami' },
        ],
      },
      {
        id: 'most-supportive-member',
        name: 'Most Supportive Member',
        nominees: [
          { name: 'Goodness Emeka' },
          { name: 'Elizabeth Enikanologbon' },
          { name: 'Favour Ejiogu' },
        ],
      },
      {
        id: 'consistency',
        name: 'Consistency Award',
        nominees: [
          { name: 'Nora Oboh' },
          { name: 'Blessing Ukuoha' },
          { name: 'Ebenezer Obi' },
        ],
      },
    ],
  },
  {
    section: 'Talent & Creativity',
    categories: [
      {
        id: 'best-male-vocalist',
        name: 'Best Male Vocalist',
        nominees: [
          { name: 'Monday Praise' },
          { name: 'Kelvin Ekwemuka' },
          { name: 'Daniel Chukwukere' },
        ],
      },
      {
        id: 'best-female-vocalist',
        name: 'Best Female Vocalist',
        nominees: [
          { name: 'Favour Akpan' },
          { name: 'Rotimi Damilola Hephzibah' },
          { name: 'Blessing Paul' },
        ],
      },
      {
        id: 'best-instrumentalist',
        name: 'Best Instrumentalist of the Year',
        nominees: [
          { name: 'Raphael Tosin' },
          { name: 'Goodnews Ewomazino' },
        ],
      },
      {
        id: 'creative-talent',
        name: 'Creative Talent of the Year',
        nominees: [
          { name: 'Adebolagun Arthur' },
          { name: 'Blessing Paul' },
          { name: 'Daniel Olamitoye' },
        ],
      },
      {
        id: 'media-personality',
        name: 'Media Personality of the Year',
        nominees: [
          { name: 'Mitchel Nwanchukwu' },
          { name: 'Lillian Williams' },
          { name: 'Ebenezer Obi' },
        ],
      },
    ],
  },
  {
    section: 'Character & Personal Development',
    categories: [
      {
        id: 'excellent-character',
        name: 'Excellent Character Award',
        nominees: [
          { name: 'Lillian Williams' },
          { name: 'Ebenezer Obi' },
          { name: 'Peace Williams' },
        ],
      },
      {
        id: 'most-disciplined',
        name: 'Most Disciplined Youth',
        nominees: [
          { name: 'Sarah Bakare' },
          { name: 'Chizoba Uzor' },
          { name: 'Ebenezer Obi' },
        ],
      },
    ],
  },
  {
    section: 'Special Recognition',
    categories: [
      {
        id: 'best-dressed-male',
        name: 'Best Dressed Male',
        nominees: [
          { name: 'Ebenezer Obi' },
          { name: 'Ikenna Ndubuisi' },
          { name: 'Raphael Tosin' },
        ],
      },
      {
        id: 'best-dressed-female',
        name: 'Best Dressed Female',
        nominees: [
          { name: 'Sarah Bakare' },
          { name: 'Nora Oboh' },
          { name: 'Blessing Jakiri' },
        ],
      },
      {
        id: 'most-hilarious',
        name: 'Most Hilarious Youth of the Year',
        nominees: [
          { name: 'Goodnews Ewomazino' },
          { name: 'Ehis Ighalo' },
        ],
      },
    ],
  },
  {
    section: 'Teenage Award of Excellence',
    categories: [
      {
        id: 'heart-of-a-servant',
        name: 'Heart of a Servant Award',
        nominees: [
          { name: 'Amazing Okechukwu' },
          { name: 'Prosper Ossaiku' },
          { name: 'Queen Solomon' },
        ],
      },
      {
        id: 'bible-class-achiever',
        name: 'Bible Class Achiever',
        nominees: [
          { name: 'Ifeanyi Ojianwuna' },
          { name: 'Ebube Simeon' },
          { name: 'Bright' },
        ],
      },
      {
        id: 'teen-rising-star',
        name: 'Rising Star Award',
        nominees: [
          { name: 'Prosper Ossaiku' },
          { name: 'Treasure Okafor' },
          { name: 'Amazing Okechukwu' },
        ],
      },
    ],
  },
]

/* ---------------------------------------------------------------
   Waiting on nominees. When your leader sends them, drop the block
   into the right section above and delete these notes.

   Special Recognition:
      { id: 'youth-personality', name: 'Youth Personality of the Year',
        nominees: [{ name: '' }, { name: '' }, { name: '' }] },

   Teenage Award of Excellence:
      { id: 'teenager-of-the-year', name: 'Teenager of the Year',
        nominees: [{ name: '' }, { name: '' }, { name: '' }] },
--------------------------------------------------------------- */

// Flat ballot order, with the section label carried on each category.
export const BALLOT = SECTIONS.flatMap((s) =>
  s.categories.map((c) => ({ ...c, section: s.section }))
)

export const CATEGORY_BY_ID = Object.fromEntries(BALLOT.map((c) => [c.id, c]))
