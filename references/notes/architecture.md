# Site Architecture

## 1. Sitemap

```
/                           Homepage
├── /projects               Projects index (filterable grid)
│   └── /projects/[slug]    Project detail page (dynamic, from content collection)
├── /writing                Writing index (list/grid of posts)
│   └── /writing/[slug]     Blog post / essay (dynamic, from content collection)
├── /about                  About page
└── /contact                Contact page
```

**Total routes:** 4 static pages + 2 dynamic collection routes

**No 404 page initially** — Astro generates a default. Can be customized later in polish phase.

---

## 2. Navigation Structure

### Header Nav

```
[Name/Logo]                      [Projects]  [Writing]  [About]  [Contact]
```

- Name/logo links to `/`
- Four nav items, no dropdowns, no mega-menus
- Sticky, dark background on all pages
- On mobile: hamburger menu with slide-out or overlay

### Footer Nav

```
┌────────────────────────────────────────────────────┐
│  [Name/Logo]         Projects    About     GitHub   │
│                      Writing     Contact   LinkedIn  │
│                                            Email     │
│  © 2026                                              │
└────────────────────────────────────────────────────┘
```

- Three columns: brand, site links, external links
- Minimal — no descriptions, no decorative elements
- Dark background (matches header)

---

## 3. Homepage Wireframe

### Section 1: Hero (dark, full viewport)

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│                                                     │
│                                                     │
│                   [Name]                            │
│          [One-line positioning]                     │
│                                                     │
│                                                     │
│                                                     │
│                              [scroll indicator ↓]   │
└─────────────────────────────────────────────────────┘
  bg: --color-bg-dark (#0a0a0a)
  text: --color-text-on-dark (#e5e5e5)
  animation: TextReveal on name, fade-in on tagline
  height: 100vh
  content: centered vertically and horizontally
```

### Section 2: Featured Projects (dark)

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│  Featured Projects                    View all →    │
│                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐│
│  │              │  │              │  │            ││
│  │   [image]    │  │   [image]    │  │  [image]   ││
│  │              │  │              │  │            ││
│  │  Title       │  │  Title       │  │  Title     ││
│  │  Description │  │  Description │  │  Desc...   ││
│  │  [tag] [tag] │  │  [tag] [tag] │  │  [tag]     ││
│  └──────────────┘  └──────────────┘  └────────────┘│
│                                                     │
└─────────────────────────────────────────────────────┘
  bg: --color-bg-dark
  cards: subtle border or slight bg lift (--color-surface-dark)
  tags: monospace, accent color
  grid: 3 columns desktop, 2 tablet, 1 mobile
  animation: ScrollReveal stagger on cards
```

### Section 3: Statement Block (transition zone)

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│                                                     │
│       "I build software, AI systems, and            │
│        tools — then write about what                │
│        I learn along the way."                      │
│                                                     │
│                                                     │
└─────────────────────────────────────────────────────┘
  bg: gradient transition from --color-bg-dark to --color-bg-light
  text: large display size, light weight
  text color transitions from light to dark as bg shifts
  animation: ScrollReveal fade-in
  padding: generous vertical spacing (--space-section-lg or larger)
  THIS IS THE SIGNATURE TRANSITION MOMENT
```

### Section 4: Recent Writing (light)

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│  Recent Writing                       View all →    │
│                                                     │
│  ── Title of post one                    Mar 2026 ──│
│  ── Title of post two                    Feb 2026 ──│
│  ── Title of post three                  Jan 2026 ──│
│                                                     │
└─────────────────────────────────────────────────────┘
  bg: --color-bg-light (#f8f8f6)
  text: --color-text-on-light (#1a1a1a)
  dates: monospace, muted color
  layout: simple rows, not cards — title left, date right
  dividers: subtle 1px lines between items
  animation: none — just good typography
```

### Section 5: About Preview (light)

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│  A short paragraph about who I am, what I care      │
│  about, and what I'm working on. Two or three       │
│  sentences max.                                     │
│                                                     │
│  More about me →                                    │
│                                                     │
└─────────────────────────────────────────────────────┘
  bg: --color-bg-light
  text: body size, readable
  link: accent color
  animation: none
```

### Section 6: Contact CTA (dark)

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│            Let's connect.                           │
│                                                     │
│      [email]    [GitHub]    [LinkedIn]               │
│                                                     │
└─────────────────────────────────────────────────────┘
  bg: --color-bg-dark (bookends the page — dark at top, dark at bottom)
  text: --color-text-on-dark
  links: accent color on hover
  padding: generous
```

### Section 7: Footer (dark)

```
  Matches footer nav structure above. Seamless with CTA bg.
```

---

## 4. Component Hierarchy

### Which components are used where:

```
BaseLayout
├── SiteHeader
├── <slot> (page content)
└── SiteFooter

Homepage (index.astro)
├── Hero
│   └── TextReveal (.tsx)
├── SectionWrapper (dark)
│   ├── section heading + "View all" link
│   └── ProjectGrid
│       └── ProjectCard (x3, featured only)
│           └── ScrollReveal (.tsx)
├── StatementBlock (transition zone)
│   └── ScrollReveal (.tsx)
├── SectionWrapper (light)
│   ├── section heading + "View all" link
│   └── WritingList (x3, recent only)
├── SectionWrapper (light)
│   └── AboutBlock
├── CTABanner (dark)
└── (footer via layout)

Projects Index (/projects)
├── SectionWrapper (dark)
│   └── page heading
├── SectionWrapper (light or dark — TBD)
│   └── ProjectGrid (all projects)
│       └── ProjectCard (xN)

Project Detail (/projects/[slug])
├── Hero (dark, project-specific: title, description, tags, links)
├── SectionWrapper (light)
│   └── article content (rendered markdown)
│   └── optional: SplitSection for media + text

Writing Index (/writing)
├── SectionWrapper (light)
│   └── page heading
│   └── WritingList (all posts) or WritingCard grid

Blog Post (/writing/[slug])
├── SectionWrapper (light)
│   └── post header (title, date, tags)
│   └── article content (rendered markdown)
│   └── optional: related posts

About (/about)
├── SectionWrapper (light)
│   └── heading, bio, experience, links

Contact (/contact)
├── SectionWrapper (light)
│   └── heading, contact info/links
```

---

## 5. Design Tokens

### Spacing Scale

Based on a 4px base unit, with named semantic sizes:

```css
:root {
  /* Base unit */
  --space-unit: 4px;

  /* Raw scale */
  --space-1:  4px;     /* 1 unit  — tight gaps */
  --space-2:  8px;     /* 2 units — inline spacing */
  --space-3:  12px;    /* 3 units — small gaps */
  --space-4:  16px;    /* 4 units — base spacing */
  --space-6:  24px;    /* 6 units — component internal padding */
  --space-8:  32px;    /* 8 units — section internal spacing */
  --space-12: 48px;    /* 12 units — between components */
  --space-16: 64px;    /* 16 units — between sections (mobile) */
  --space-24: 96px;    /* 24 units — between sections (tablet) */
  --space-32: 128px;   /* 32 units — between sections (desktop) */
  --space-40: 160px;   /* 40 units — hero vertical padding */

  /* Semantic aliases */
  --space-section: var(--space-24);       /* vertical padding inside sections */
  --space-section-lg: var(--space-32);    /* hero and transition zones */
  --space-component: var(--space-12);     /* gap between components */
  --space-card-padding: var(--space-6);   /* internal card padding */
  --space-grid-gap: var(--space-6);       /* grid gap between cards */
}
```

### Typography Scale

Using a modular scale (ratio ~1.25, minor third):

```css
:root {
  /* Font families */
  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
  --font-mono: 'Geist Mono', 'JetBrains Mono', monospace;

  /* Font sizes */
  --text-xs:    0.75rem;    /* 12px — fine print, metadata */
  --text-sm:    0.875rem;   /* 14px — captions, tags, dates */
  --text-base:  1rem;       /* 16px — body text */
  --text-lg:    1.125rem;   /* 18px — lead paragraphs */
  --text-xl:    1.25rem;    /* 20px — small headings */
  --text-2xl:   1.5rem;     /* 24px — section subheadings */
  --text-3xl:   1.875rem;   /* 30px — section headings */
  --text-4xl:   2.25rem;    /* 36px — page titles */
  --text-5xl:   3rem;       /* 48px — hero heading (mobile) */
  --text-6xl:   3.75rem;    /* 60px — hero heading (desktop) */
  --text-7xl:   4.5rem;     /* 72px — hero heading (large screens) */

  /* Font weights */
  --weight-normal:  400;
  --weight-medium:  500;
  --weight-semibold: 600;
  --weight-bold:    700;

  /* Line heights */
  --leading-none:   1;
  --leading-tight:  1.15;    /* display headings */
  --leading-snug:   1.3;     /* subheadings */
  --leading-normal: 1.6;     /* body text */
  --leading-relaxed: 1.75;   /* long-form reading */

  /* Letter spacing */
  --tracking-tight:  -0.02em;  /* display headings */
  --tracking-normal:  0;       /* body text */
  --tracking-wide:    0.05em;  /* mono labels, uppercase tags */
}
```

**Usage rules:**
- Hero name: `--text-6xl` / `--weight-normal` / `--leading-tight` / `--tracking-tight` on dark
- Section headings: `--text-3xl` / `--weight-semibold` / `--leading-snug`
- Card titles: `--text-xl` / `--weight-medium`
- Body text: `--text-base` / `--weight-normal` / `--leading-normal`
- Tags / dates / labels: `--text-sm` / `--font-mono` / `--tracking-wide`
- Statement block: `--text-4xl` to `--text-5xl` / `--weight-normal` / `--leading-tight`

### Color Palette

```css
:root {
  /* === Dark Zone === */
  --color-bg-dark:          #0a0a0a;
  --color-surface-dark:     #141414;   /* cards, raised elements on dark bg */
  --color-border-dark:      #252525;   /* subtle borders on dark bg */
  --color-text-on-dark:     #e5e5e5;   /* primary text on dark */
  --color-text-muted-dark:  #888888;   /* secondary/meta text on dark */

  /* === Light Zone === */
  --color-bg-light:         #f8f8f6;
  --color-surface-light:    #ffffff;   /* cards, raised elements on light bg */
  --color-border-light:     #e0e0dc;   /* subtle borders on light bg */
  --color-text-on-light:    #1a1a1a;   /* primary text on light */
  --color-text-muted-light: #6b6b6b;   /* secondary/meta text on light */

  /* === Accent (Olive) === */
  --color-accent:           #a3b86c;   /* olive — primary accent */
  --color-accent-hover:     #b5ca7e;   /* lighter olive for hover states */
  --color-accent-subtle:    #a3b86c1a; /* 10% opacity — tag backgrounds, subtle highlights */

  /* === Semantic === */
  --color-link:             var(--color-accent);
  --color-link-hover:       var(--color-accent-hover);
  --color-divider-dark:     var(--color-border-dark);
  --color-divider-light:    var(--color-border-light);
}
```

**Olive accent rationale:** Distinctive without being aggressive. Reads as natural, intentional, technical-but-warm. Works on both dark and light backgrounds. Avoids the cliches of neon green, electric blue, or orange that dominate dev portfolios.

**Contrast notes:**
- `#a3b86c` on `#0a0a0a` = ~7.5:1 ratio (passes AAA)
- `#a3b86c` on `#f8f8f6` = ~2.8:1 ratio (decorative/non-text use only on light, or use for large text)
- For small text links on light: use `#1a1a1a` with olive underline, or darken accent to `#7a8f4a` for body links on light

### Container Widths

```css
:root {
  --width-content:    720px;    /* prose, blog posts, about text */
  --width-container:  1080px;   /* standard page container */
  --width-wide:       1280px;   /* project grids, wide layouts */
  --width-full:       100%;     /* full-bleed sections (hero, CTA) */

  --padding-container: var(--space-6);  /* horizontal padding on containers */
}
```

**Usage:**
- Hero: `--width-full` (full bleed, content centered within)
- Project grid: `--width-wide`
- Blog post body: `--width-content`
- Standard sections: `--width-container`
- All containers get `--padding-container` on left/right for mobile safety

### Animation Tokens

```css
:root {
  --ease-out:       cubic-bezier(0, 0, 0.58, 1);
  --ease-out-expo:  cubic-bezier(0.19, 1, 0.22, 1);

  --duration-fast:    150ms;   /* hover states, micro-interactions */
  --duration-normal:  300ms;   /* transitions, page changes */
  --duration-slow:    600ms;   /* scroll reveals */
  --duration-slower:  1200ms;  /* hero text reveal */
}
```

---

## 6. Content Collection Schemas

### Projects Collection

```
src/content/projects/[slug].md
```

**Frontmatter schema:**

```yaml
---
title: "Project Name"                              # required
description: "One or two sentence summary."        # required
date: 2026-03-15                                   # required, used for sort order
tags: ["AI", "Python", "Computer Vision"]           # required, string array
featured: true                                      # optional, default false — shown on homepage
image: "/images/projects/project-name.png"          # optional, card thumbnail
url: "https://github.com/user/project"              # optional, external link (live site or repo)
repo: "https://github.com/user/project"             # optional, source code link
status: "complete"                                  # optional: "complete" | "in-progress" | "archived"
---

Markdown body content here.

## Problem
What problem this project solves.

## Approach
How it was built, key technical decisions.

## Outcome
Results, learnings, impact.
```

**Notes:**
- `featured: true` projects appear on the homepage (limit to 2-3)
- `tags` are used for filtering on the projects index page
- `status` is optional metadata, can be displayed as a badge
- Body content is free-form markdown, but the Problem/Approach/Outcome structure is a suggested convention, not enforced

### Writing Collection

```
src/content/writing/[slug].md
```

**Frontmatter schema:**

```yaml
---
title: "Post Title"                                 # required
description: "Short summary for cards and SEO."     # required
date: 2026-03-15                                    # required, used for sort and display
tags: ["AI", "Systems", "Process"]                  # optional, string array
featured: true                                      # optional, default false — shown on homepage
draft: false                                        # optional, default false — drafts excluded from build
---

Markdown body content here.
```

**Notes:**
- `draft: true` posts are excluded from production builds but visible in dev
- `featured: true` posts appear in the homepage "Recent Writing" section
- If fewer than 3 posts are featured, fall back to most recent by date
- No category system — tags are sufficient for a personal site
- No estimated reading time in schema — can be computed at build time from word count if desired later
