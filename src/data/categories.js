// The ballot. Edit names here, commit, and Vercel redeploys.
// `photo` is optional — add a filename later (put the image in /public/nominees/)
// and the card shows the photo instead of the initial.

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
          { name: 'Queen Solomon' },
        ],
      },
      {
        id: 'most-dedicated-volunteer',
        name: 'Most Dedicated Volunteer',
        nominees: [
          { name: 'Chizoba Uzor' },
          { name: 'Precious John' },
          { name: 'Sarah Bakare' },
        ],
      },
      {
        id: 'behind-the-scene-hero',
        name: 'Behind the Scene Hero',
        nominees: [
          { name: 'Ebenezer Obi' },
          { name: 'Cherish Iwuji' },
          { name: 'Sarah Bakare' },
        ],
      },
      {
        id: 'most-supportive-member',
        name: 'Most Supportive Member',
        nominees: [
          { name: 'Ehis Ighalo' },
          { name: 'PST Solomon' },
          { name: 'Oluwayomi Solomon' },
        ],
      },
      {
        id: 'consistency',
        name: 'Consistency Award',
        nominees: [
          { name: 'Norah Oboh' },
          { name: 'Queen Solomon' },
          { name: 'Oluwayomi Solomon' },
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
          { name: 'Somadinna' },
          { name: 'Daniel Chukwukere' },
        ],
      },
      {
        id: 'best-female-vocalist',
        name: 'Best Female Vocalist',
        nominees: [
          { name: 'Favour Akpan' },
          { name: 'Hephzibah' },
          { name: 'Sarah Bakare' },
        ],
      },
      {
        id: 'best-instrumentalist',
        name: 'Best Instrumentalist of the Year',
        nominees: [
          { name: 'Raphael Tosin' },
          { name: 'Ewomazino' },
        ],
      },
      {
        id: 'creative-talent',
        name: 'Creative Talent of the Year',
        nominees: [
          { name: 'Arthur Adebolagun' },
          { name: 'Blessing Paul' },
          { name: 'Daniel Olamitoye' },
        ],
      },
      {
        id: 'media-personality',
        name: 'Media Personality of the Year',
        nominees: [
          { name: 'Queen Solomon' },
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
          { name: 'Sarah Bakare' },
          { name: 'Queen Solomon' },
        ],
      },
      {
        id: 'humility',
        name: 'Humility Award',
        nominees: [
          { name: 'Ebenezer Obi' },
          { name: 'Queen Solomon' },
          { name: 'Kunle Salami' },
        ],
      },
      {
        id: 'most-disciplined',
        name: 'Most Disciplined Youth',
        nominees: [
          { name: 'Sarah Bakare' },
          { name: 'Queen Solomon' },
          { name: 'Ebenezer Obi' },
        ],
      },
      {
        id: 'positive-influence',
        name: 'Positive Influence Award',
        nominees: [
          { name: 'Peace Williams' },
          { name: 'Queen Solomon' },
          { name: 'Kunle Salami' },
        ],
      },
      {
        id: 'role-model',
        name: 'Role Model of the Year',
        nominees: [
          { name: 'Sarah Bakare' },
          { name: 'PST Solomon' },
          { name: 'Queen Solomon' },
        ],
      },
    ],
  },
  {
    section: 'Special Recognition',
    categories: [
      {
        id: 'youth-personality',
        name: 'Youth Personality of the Year',
        nominees: [
          { name: 'Ehis Ighalo' },
          { name: 'Queen Solomon' },
          { name: 'Ebenezer Obi' },
        ],
      },
      {
        id: 'rising-star',
        name: 'Rising Star Award',
        nominees: [
          { name: 'Precious John' },
          { name: 'Amazing Okechukwu' },
          { name: 'Lillian Williams' },
        ],
      },
      {
        id: 'best-dressed-male',
        name: 'Best Dressed Male',
        nominees: [
          { name: 'Ebenezer Obi' },
          { name: 'Mitchell' },
          { name: 'Raphael Tosin' },
        ],
      },
      {
        id: 'best-dressed-female',
        name: 'Best Dressed Female',
        nominees: [
          { name: 'Sarah Bakare' },
          { name: 'Norah Oboh' },
          { name: 'Hephzibah' },
        ],
      },
      {
        id: 'most-hilarious',
        name: 'Most Hilarious Youth of the Year',
        nominees: [
          { name: 'Ewomazino' },
          { name: 'Ehis Ighalo' },
          { name: 'Precious John' },
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
          { name: 'Arthur Adebolagun' },
          { name: 'Prosper Ossaiku' },
          { name: 'Queen Solomon' },
        ],
      },
      {
        id: 'bible-class-achiever',
        name: 'Bible Class Achiever',
        nominees: [
          { name: 'Prosper Ossaiku' },
          { name: 'Ebube Simeon' },
          { name: 'Amazing Okechukwu' },
        ],
      },
      {
        id: 'teenager-of-the-year',
        name: 'Teenager of the Year',
        nominees: [
          { name: 'Treasure Okafor' },
          { name: 'Precious John' },
          { name: 'Ebube Simeon' },
        ],
      },
      {
        id: 'teen-rising-star',
        name: 'Teen Rising Star Award',
        nominees: [
          { name: 'Prosper Ossaiku' },
          { name: 'Treasure Okafor' },
          { name: 'Precious John' },
        ],
      },
      {
        id: 'youth-leader',
        name: 'Youth Leader Award',
        nominees: [
          { name: 'Queen Solomon' },
          { name: 'Arthur Adebolagun' },
          { name: 'Precious John' },
        ],
      },
    ],
  },
]

// Flat ballot order, with the section label carried on each category.
export const BALLOT = SECTIONS.flatMap((s) =>
  s.categories.map((c) => ({ ...c, section: s.section }))
)

export const CATEGORY_BY_ID = Object.fromEntries(BALLOT.map((c) => [c.id, c]))
