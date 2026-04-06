# CLAUDE.md — Personal Website Project

## Project Overview

A personal website for showcasing projects, AI work, experiments, and writing. Built as a clean, maintainable, static site using Astro, deployable on GitHub Pages.

This is not a generic portfolio template. It is a designed system — an engineering lab, project gallery, writing platform, and personal site rolled into one.

**Positioning:** The public surface of a working builder. The site should feel like opening the door to a well-organized workshop — you immediately see what's being made, how it's made, and the thinking behind it. The site itself demonstrates the same craft it showcases.

**Content priority:** Projects first, writing second, resume third.

---

## Audience & Goals

| Audience | Looking for | Should feel after visiting |
|---|---|---|
| Recruiters / hiring managers | Technical depth, taste, initiative | "This person builds real things and thinks clearly" |
| Potential clients | Capability, scope, professionalism | "This person can execute at the level I need" |
| Engineers / peers | Interesting projects, sharp writing, substance | "Someone I'd want to work with or follow" |
| General visitors | Clear picture of who this person is | "I understand what they do and I'm impressed" |

**Universal takeaway:** Competence, clarity, and taste — conveyed through the work itself and the way it's presented, not through self-description.

---

## Design Philosophy

**"Hybrid Studio"** — dark and atmospheric at the top, transitioning to clean and readable for content. Like walking from a moody studio entrance into a well-lit workspace.

Core principles:

* **Dark = identity.** The hero, header, and project showcases live in a dark context that signals "technical builder."
* **Light = content.** Writing, detailed descriptions, and the about page use a light editorial context for readability.
* **The transition is the signature.** The intentional shift from dark to light as the user scrolls is the defining design move. Most personal sites pick one or the other.
* **Systems over pages.** Think in components and design tokens, not individual page layouts.
* **Restraint over spectacle.** Every animation, color choice, and element must earn its place.
* **The work speaks.** Minimal self-description. Let projects and writing carry the weight.

---

## Visual Direction

### Layout

* Full-bleed dark hero zone on the homepage
* Contained content sections below, transitioning to light backgrounds
* Generous whitespace throughout
* Disciplined grid system
* Content sections separated by spacing, not heavy borders or decorative elements
* Project cards displayed in a dark gallery context
* Writing displayed in a light editorial context

### Internal Pages

* Dark sticky header on all pages
* Project detail pages: dark hero, light content body
* Writing pages: dark header, light body immediately
* About page: light throughout with dark header
* Contact: simple, light

### Typography

* **Primary font:** Inter (geometric sans-serif)
* **Mono font:** Geist Mono — used for labels, tags, dates, metadata, and code references
* **Display headings:** Large, light weight on dark backgrounds; bold weight on light backgrounds
* **Body text:** Small-to-medium size, generous line-height for readability
* **Tracking:** Tight on display headings, normal on body text
* **Scale:** Consistent typographic scale used across all pages

### Color Palette

**Dark zone:**
* Background: near-black (`#0a0a0a`)
* Surface/cards: `#141414`
* Borders: `#252525`
* Text: off-white (`#e5e5e5`)
* Muted text: `#888888`

**Light zone:**
* Background: warm off-white (`#f8f8f6`)
* Surface/cards: `#ffffff`
* Borders: `#e0e0dc`
* Text: near-black (`#1a1a1a`)
* Muted text: `#6b6b6b`

**Accent (Olive):**
* Primary: `#a3b86c`
* Hover: `#b5ca7e`
* Subtle (10% opacity): `#a3b86c1a`

**General rules:**
* Minimal palette — mostly black, white, and olive accent
* Accent used for interactive elements and emphasis only, never decoratively
* Muted tones for secondary text and metadata
* The olive accent is the single most recognizable brand element
* On light backgrounds, use accent for large text or underlines only — darken to `#7a8f4a` for small text links

### Motion & Animation

**Philosophy:** Motion serves comprehension and atmosphere. No decorative animation.

* **Hero:** Text reveal (character or word stagger via Framer Motion), subtle ambient motion
* **Scroll reveals:** Fade + subtle upward translate on content sections as they enter viewport
* **Page transitions:** Opacity crossfade (0.3-0.5s)
* **Dark-to-light transition:** Animated background color shift as user scrolls (the signature moment)
* **Card interactions:** Subtle scale or shadow lift on hover
* **Writing section:** No animation — just good typography
* **Easing:** Consistent curve throughout, inspired by ease-out-expo (`cubic-bezier(.19, 1, .22, 1)`)
* **Duration:** 0.3-0.6s for interactions, up to 1.2s for scroll reveals

**Use Framer Motion only where animation actually improves the experience.** Use `.astro` components for everything static.

---

## Site Structure

```
/                       Homepage
/projects               Projects index (filterable card grid)
/projects/[slug]        Project detail page
/writing                Writing index (blog posts and essays)
/writing/[slug]         Individual post (article layout)
/about                  About page
/contact                Contact page
```

### Homepage Sections (scroll order)

1. **Hero** — name, one-line positioning statement, subtle ambient animation. Full viewport, dark.
2. **Featured projects** — 2-3 highlighted project cards. Dark context.
3. **Statement block** — short statement about what I build and why. Large centered text. Transition zone.
4. **Recent writing** — 2-3 latest posts, minimal list format. Light context.
5. **Brief about** — one paragraph + link to full about page. Light context.
6. **Contact CTA** — simple closing prompt with links. Light or dark.
7. **Footer** — links, social, copyright.

### Page Structures

**Projects index:** Dark header, card grid on light or dark background (TBD), filterable by tag/category.

**Project detail:** Dark hero (project title, description, tags, link), light content body (problem, approach, outcome, media, technical details).

**Writing index:** Dark header, list or card layout on light background, sorted by date.

**Blog post:** Dark header, light article body with typographic hierarchy, related posts at bottom.

**About:** Dark header, light body. Who I am, what I do, experience/background, links.

**Contact:** Dark header, light body. Direct and simple — email, GitHub, LinkedIn, or a minimal form.

---

## Component System

### Global Components

| Component | Description |
|---|---|
| `SiteHeader` | Sticky dark header. Logo/name, nav links (Projects, Writing, About, Contact), minimal. |
| `SiteFooter` | Footer with nav links, social icons, copyright. |
| `BaseLayout` | Astro layout wrapping head, header, slot, footer. |
| `SectionWrapper` | Universal content section container with consistent padding and max-width. |

### Content Components

| Component | Description |
|---|---|
| `Hero` | Full-viewport hero with name, tagline, ambient animation. Dark background. |
| `StatementBlock` | Large centered headline text. Used for positioning statements. |
| `ProjectCard` | Card with image, title, description, tags. Used in grids. |
| `ProjectGrid` | Responsive grid of `ProjectCard` components, with optional filtering. |
| `WritingList` | Minimal list of posts — title + date, no cards. |
| `WritingCard` | Card variant for writing index page if needed. |
| `SplitSection` | Two-column layout — text + image or text + text. |
| `CTABanner` | Full-width call-to-action with headline and links. |
| `AboutBlock` | Short about section with paragraph and link. |

### Motion Components (React + Framer Motion)

| Component | Description |
|---|---|
| `ScrollReveal` | Wrapper that fades/translates children into view on scroll. |
| `TextReveal` | Character or word stagger animation for headings. |
| `PageTransition` | Opacity crossfade between page navigations. |

### Rules

* Use `.astro` components by default.
* Use `.tsx` (React) only when Framer Motion interactivity is required.
* Keep styles colocated in components unless a global stylesheet is defined.
* Build reusable components, not page-specific one-offs.
* No placeholder or lorem ipsum content.

---

## Tech Stack

* **Astro** — static site framework
* **Framer Motion** — animations and transitions (via React islands in Astro)
* **Astro Content Collections** — Markdown/MDX for writing and project entries
* **GitHub Pages** — hosting and deployment

Avoid unnecessary dependencies. Prefer static-friendly solutions. Prefer Astro built-in features before reaching for extras.

---

## Folder Structure

```
website/
├── CLAUDE.md                       # This file — project spec
├── references/                     # Design references (not part of build)
│   ├── screenshots/
│   ├── notes/
│   ├── pdfs/
│   └── terminal-industries.com/
├── src/
│   ├── components/                 # All components
│   │   ├── global/                 # SiteHeader, SiteFooter, BaseLayout
│   │   ├── sections/               # Hero, StatementBlock, CTABanner, SplitSection
│   │   ├── cards/                  # ProjectCard, WritingCard
│   │   └── motion/                 # ScrollReveal, TextReveal, PageTransition (.tsx)
│   ├── layouts/                    # Astro layouts
│   │   └── BaseLayout.astro
│   ├── pages/                      # Routes
│   │   ├── index.astro
│   │   ├── projects/
│   │   ├── writing/
│   │   ├── about.astro
│   │   └── contact.astro
│   ├── content/                    # Content collections
│   │   ├── projects/               # Markdown/MDX project entries
│   │   └── writing/                # Markdown/MDX blog posts
│   └── styles/                     # Global styles and design tokens
│       └── global.css
├── public/                         # Static assets (images, fonts, favicon)
├── astro.config.mjs
├── package.json
└── tsconfig.json
```

---

## Development Workflow

### Rules

* All work is scoped to `/home/cbroker/Documents/2026/website`
* Do not scaffold or install packages without explicit approval
* Write clean, minimal code — no speculative abstractions
* No code is written until structure and design are understood
* Summarize findings before building
* Propose a small implementation plan before coding
* Break large problems into phases
* Favor readability and maintainability over cleverness
* Keep the final site completely separate from reference files
* Commit only when asked

### How to Use References

Mirrored websites in `references/` are **reference blueprints**, not source code.

Use them to:
* Identify layout patterns and component structures
* Study spacing, typography, and color from CSS
* Study animations and interactions
* Understand content hierarchy

Do NOT:
* Dump the entire mirrored site into context
* Treat compiled JS bundles as source code
* Directly modify mirrored files into the final site
* Copy text or content verbatim

When working from a mirrored site, use **small curated slices** — one HTML file, key CSS, or screenshots.

---

## Build Order

Build in this order. Do not skip ahead.

1. **Scaffold** — Astro project, folder structure, config, global CSS with design tokens
2. **Global shell** — BaseLayout, SiteHeader, SiteFooter
3. **Homepage** — Hero, featured projects section, statement block, writing preview, CTA
4. **Content collections** — Schema for projects and writing
5. **Projects** — ProjectCard, ProjectGrid, projects index page, project detail page
6. **Writing** — WritingList/WritingCard, writing index page, blog post layout
7. **About & Contact** — Static pages
8. **Motion** — ScrollReveal, TextReveal, dark-to-light transition, page transitions
9. **Polish** — Spacing, typography, responsiveness, accessibility
10. **Deploy** — GitHub Pages configuration and deployment

---

## Deployment

* Target: GitHub Pages
* Build output: static HTML/CSS/JS
* Repository: `cbroker1/website`
* Branch strategy: TBD (likely `main` with GitHub Actions)

---

## Reference Material

* Mirrored site: `references/terminal-industries.com/`
* Screenshots: `references/screenshots/` (6 images showing homepage scroll sequence)
* Notes: `references/notes/site_intent.txt`
* Design direction chosen: **Hybrid Studio** (dark-to-light transition)
* Key patterns borrowed: section rhythm, dark-to-light scroll transition, scroll-triggered reveals, component-based section architecture, accent color as brand thread
* Architecture document: `references/notes/architecture.md` — sitemap, wireframes, design tokens, content schemas
