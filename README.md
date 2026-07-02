# Carl Broker — carlbroker.com

> I build AI systems that are meant to be used, not just demoed.

This is the source for my personal site — a working surface for the projects,
writing, and experiments I'm shipping. If you're reading this on GitHub, the
live version is the better way in:

**→ https://cbroker1.github.io**

## About me

I'm an **Agentic AI Engineer at IBM**, based in Duluth, Minnesota. My work sits
at the intersection of agentic AI, retrieval systems, LLM platforms, and
production engineering — designing systems where models, tools, and data work
together to solve real problems.

The path here ran through neuroscience research → healthcare analytics →
applied research at the EPA → enterprise data science → enterprise AI. That
mix gave me a strong bias toward systems that are grounded, testable, and
useful in the real world.

These days I focus on things like:

- multi-agent orchestration
- retrieval-augmented generation
- embeddings and vector databases
- tool-calling architectures
- evaluation and guardrails
- production-ready LLM workflows

## Where to find me

- **Site** — https://cbroker1.github.io
- **GitHub** — [@cbroker1](https://github.com/cbroker1)
- **LinkedIn** — [Carl Broker](https://www.linkedin.com/in/carl-broker-70211646/)

## About this repo

The site is intentionally small and static — Astro, a handful of components,
and Markdown for everything that's actually content. The design is "Hybrid
Studio": a dark, atmospheric hero that hands off to a clean light editorial
context for the writing and project detail pages. The whole thing is meant to
read like opening the door to a working studio rather than a portfolio
template.

### Stack

- [Astro](https://astro.build) — static site generator
- [Framer Motion](https://motion.dev) — interaction and reveal animations
- Markdown content collections for projects and writing
- [GitHub Pages](https://pages.github.com) — hosting

### Local development

```sh
npm install
npm run dev      # dev server at http://localhost:4321
npm run build    # production build to ./dist
npm run preview  # preview the production build locally
```

Requires Node `>=22.12.0`.

### Project layout

```
src/
├── components/   global, section, card, and motion components
├── content/      markdown for projects, writing, about, experience
├── layouts/      BaseLayout
├── pages/        routes (homepage + project/writing detail pages)
└── styles/       design tokens and base styles

public/          static assets (fonts, video, favicon)
```

Project and writing entries live in `src/content/projects/` and
`src/content/writing/` as Markdown. Schemas are defined in
`src/content.config.ts`.

### Deployment

Static build deployed to GitHub Pages from `master` via GitHub Actions.

---

If you're building something that needs an AI engineer who cares about whether
the system actually works — get in touch.
