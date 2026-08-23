/**
 * Build-time corpus assembly.
 *
 * Pure functions only — no `astro:content` import — so the same code can be
 * exercised by the offline evaluation harness. The Astro endpoint
 * (`src/pages/assistant/corpus.json.ts`) is what actually supplies the source
 * documents, and it is the single place where the approved-source boundary is
 * enforced.
 */

import { chunkMarkdown } from './chunk.ts';
import type { Corpus, CorpusChunk, CorpusDoc, SourceLink, SourceType } from './types.ts';

export const CORPUS_VERSION = 1;

export interface SourceDoc {
  id: string;
  title: string;
  description?: string;
  type: SourceType;
  url: string | null;
  tags: string[];
  date?: string;
  links: SourceLink[];
  markdown: string;
}

/** Types that benefit from a synthetic "what is this" chunk built from metadata. */
const SUMMARISED: SourceType[] = ['project', 'article'];

export function buildCorpus(sources: SourceDoc[]): Corpus {
  const docs: CorpusDoc[] = [];
  const chunks: CorpusChunk[] = [];

  for (const source of sources) {
    const textChunks = chunkMarkdown(source.markdown);
    // Title + description only. Tags are indexed from `CorpusDoc.tags` as their
    // own retrieval field, so repeating them here would double-count them — and
    // a bare list of technologies sitting in a passage invites a small model to
    // attribute one project's stack to another.
    const summary =
      SUMMARISED.includes(source.type) && source.description
        ? `${source.title}. ${source.description}`
        : null;

    if (!textChunks.length && !summary) continue;

    const d = docs.length;
    docs.push({
      id: source.id,
      title: source.title,
      type: source.type,
      url: source.url,
      tags: source.tags,
      ...(source.date ? { date: source.date } : {}),
      links: source.links,
    });

    if (summary) chunks.push({ d, h: 'Summary', t: summary });
    for (const chunk of textChunks) chunks.push({ d, h: chunk.heading, t: chunk.text });
  }

  return { version: CORPUS_VERSION, docs, chunks };
}

/* -------------------------------------------------------------------------- */
/* Curated profile                                                             */
/* -------------------------------------------------------------------------- */

const SOURCE_DIRECTIVE = /<!--\s*source:\s*([\s\S]*?)-->/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const SENTINEL = '@@assistant-source@@';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Splits the curated profile into one source document per `##` section.
 *
 * Editor comments are stripped before anything else is parsed, so guidance
 * text (which may itself contain headings) can never leak into the corpus.
 * A `<!-- source: href | Label -->` line survives that pass as a sentinel and
 * becomes the section's rendered link.
 */
export function parseCuratedProfile(markdown: string): SourceDoc[] {
  const withSentinels = markdown.replace(SOURCE_DIRECTIVE, (_match, body: string) => {
    const [href, label] = body.split('|').map((part) => part.trim());
    return href ? `\n${SENTINEL} ${href} | ${label || 'View source'}\n` : '';
  });
  const cleaned = withSentinels.replace(HTML_COMMENT, '');

  const sections: { heading: string; lines: string[] }[] = [];
  for (const line of cleaned.split('\n')) {
    const match = /^##\s+(.*)$/.exec(line);
    if (match) {
      sections.push({ heading: match[1].trim(), lines: [] });
      continue;
    }
    if (sections.length) sections[sections.length - 1].lines.push(line);
  }

  const docs: SourceDoc[] = [];
  for (const section of sections) {
    const links: SourceLink[] = [];
    const body: string[] = [];
    for (const line of section.lines) {
      if (line.startsWith(SENTINEL)) {
        const [href, label] = line.slice(SENTINEL.length).split('|').map((p) => p.trim());
        if (href) links.push({ label: label || 'View source', href });
        continue;
      }
      body.push(line);
    }

    const markdownBody = body.join('\n').trim();
    if (!markdownBody) continue; // Unfilled placeholder section.

    docs.push({
      id: `profile:${slugify(section.heading)}`,
      title: section.heading,
      type: 'profile',
      url: links[0]?.href ?? null,
      tags: [],
      links,
      markdown: markdownBody,
    });
  }

  return docs;
}

/* -------------------------------------------------------------------------- */
/* Experience                                                                  */
/* -------------------------------------------------------------------------- */

export interface ExperienceEntry {
  years: string;
  role: string;
  company?: string;
  description: string;
  highlights: string[];
  technologies: string[];
}

/** Experience is frontmatter-only, so render it to prose the chunker can read. */
export function experienceMarkdown(entries: ExperienceEntry[]): string {
  return entries
    .map((entry) => {
      const where = entry.company ? ` at ${entry.company}` : '';
      const lines = [
        `## ${entry.role}${where}, ${entry.years}`,
        '',
        `Carl worked as ${entry.role}${where} from ${entry.years}. ${entry.description}`,
        '',
        ...entry.highlights.map((highlight) => `- ${highlight}`),
        '',
        `Technologies: ${entry.technologies.join(', ')}.`,
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}
