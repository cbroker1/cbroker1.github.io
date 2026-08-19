# Carl Broker — carlbroker.com

> I build AI systems that are meant to be used, not just demoed.

This is the source for my personal site — a working surface for the projects,
writing, and experiments I'm shipping. If you're reading this on GitHub, the
live version is the better way in:

**→ https://cbroker1.github.io**

## About me

I'm an **Advisory AI Engineer at IBM**, based in Duluth, Minnesota. My work sits
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
- Markdown content collections for projects and writing
- [Transformers.js](https://huggingface.co/docs/transformers.js) — browser-local
  inference for the site assistant, loaded on demand and never on page load
- [GitHub Pages](https://pages.github.com) — hosting

### Local development

```sh
npm install
npm run dev              # dev server at http://localhost:4321
npm run build            # production build to ./dist
npm run preview          # preview the production build locally

npm run assistant:eval    # retrieval checks against recruiter-style questions
npm run assistant:test    # controller, grounding gate, and corpus provenance
npm run assistant:answers # print the assistant's deterministic output
```

Those three read `dist/assistant/corpus.json`, so run `npm run build` first.

There is also a browser-level check that drives the real panel — opening it,
asking a question, resetting, and closing — over the Chrome DevTools Protocol:

```sh
npm run preview                                                   # note the port
google-chrome --headless=new --remote-debugging-port=9222 about:blank &
npm run assistant:drive -- 4321                                   # that port
```

Requires Node `>=22.12.0`.

### Ask about Carl — the site assistant

A retrieval-grounded assistant lives in the bottom-right corner of every page.
It answers questions about my work using only this site's own content, and it
runs **entirely in the visitor's browser** — no backend, no API keys, no
inference service, nothing logged.

How it works:

1. At build time, an Astro endpoint (`src/pages/assistant/corpus.json.ts`)
   collects the approved public sources, strips them to prose, chunks them, and
   emits `/assistant/corpus.json`.
2. In the browser, a question is scored against those chunks with a BM25F-style
   lexical retriever plus a curated synonym map. No embedding model is
   downloaded.
3. If the question's subject does not appear in the corpus at all, the
   assistant declines and says what is missing. No model runs.
4. Otherwise the top passages and the question go to a small instruction model
   running locally on WebGPU, which writes the prose — and only the prose.
5. Source links are rendered from retrieval metadata, never from the model, so
   a citation can never be invented.

Without WebGPU the assistant degrades to quoting the closest passage from the
site. The rest of the site never depends on any of it: the assistant's code is
dynamically imported and a failure anywhere in it is contained.

**What it is allowed to know** is defined in exactly one place — the header of
`src/pages/assistant/corpus.json.ts`. To teach it something that has no natural
home on a page, edit `src/knowledge/curated-profile.md`; see
`src/knowledge/README.md` for the editing guide.

### Project layout

```
src/
├── components/   global, section, card, and assistant components
├── content/      markdown for projects, writing, about, experience
├── knowledge/    hand-written public knowledge for the site assistant
├── layouts/      BaseLayout
├── lib/          assistant retrieval, prompting, and inference modules
├── pages/        routes (homepage, detail pages, assistant corpus endpoint)
└── styles/       design tokens and base styles

public/          static assets (fonts, video, favicon)
scripts/         offline checks for the assistant
```

Project and writing entries live in `src/content/projects/` and
`src/content/writing/` as Markdown. Schemas are defined in
`src/content.config.ts`.

### Deployment

Static build deployed to GitHub Pages from `master` via GitHub Actions.

---

If you're building something that needs an AI engineer who cares about whether
the system actually works — get in touch.
