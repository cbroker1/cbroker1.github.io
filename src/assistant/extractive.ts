/**
 * Retrieval-only answers, for browsers that cannot run the local model.
 *
 * Nothing is generated, so nothing can be invented: this returns real sentences
 * from the single best-matching page, in the order they were written. It is the
 * floor the feature degrades to, not a broken state.
 *
 * Sentences are quoted verbatim, which means they keep the site's first-person
 * voice — the UI frames them as a quotation for exactly that reason.
 */

import { expandQuery, splitSentences, tokenize } from './text.ts';
import type { Hit } from './retrieve.ts';

const MAX_SENTENCES = 3;
const MAX_CHARS = 460;

interface Candidate {
  text: string;
  score: number;
  docIndex: number;
  order: number;
}

export function extractiveAnswer(question: string, hits: Hit[]): string {
  if (!hits.length) return '';

  const weights = new Map(expandQuery(question).map(({ term, weight }) => [term, weight]));

  // Only the two best-ranked documents are quotable. Those are the pages listed
  // as sources, and an excerpt from a page the visitor was not pointed at reads
  // as if the assistant is citing something it isn't.
  const primary = hits[0].docIndex;
  const secondary = hits.find((hit) => hit.docIndex !== primary)?.docIndex;
  const quotable = new Set([primary, secondary].filter((d): d is number => d !== undefined));

  const candidates = collectSentences(hits, weights).filter((c) => quotable.has(c.docIndex));

  // Pick the document by its single best quotable sentence rather than by chunk
  // score: the question is "which page can I quote to answer this?", and chunk
  // ranking also counts title, tag and kind matches that no sentence contains.
  const best = candidates[0];
  if (!best) {
    const fromPrimary = hits.filter((hit) => hit.docIndex === primary);
    const passage = fromPrimary.find((hit) => hit.heading !== 'Summary') ?? fromPrimary[0];
    return leadingSentences(passage?.text ?? '');
  }

  const chosen: Candidate[] = [];
  let length = 0;
  for (const candidate of candidates) {
    if (candidate.docIndex !== best.docIndex) continue;
    if (length + candidate.text.length > MAX_CHARS && chosen.length) break;
    chosen.push(candidate);
    length += candidate.text.length;
    if (chosen.length >= MAX_SENTENCES) break;
  }

  // Restore document order so the excerpt reads the way it was written.
  return chosen.sort((a, b) => a.order - b.order).map((c) => c.text).join(' ');
}

/** Every quotable sentence across the retrieved passages, best match first. */
function collectSentences(hits: Hit[], weights: Map<string, number>): Candidate[] {
  const candidates: Candidate[] = [];
  let order = 0;

  for (const hit of hits) {
    // A summary chunk is the page's own title and blurb — useful as model
    // context, but quoting it back reads like a search result, not an answer.
    if (hit.heading === 'Summary') continue;

    for (const sentence of splitSentences(hit.text)) {
      const text = sentence.trim();
      order += 1;
      if (text.length < 40 || text.length > 300) continue;

      const tokens = tokenize(text);
      if (!tokens.length) continue;

      let overlap = 0;
      const seen = new Set<string>();
      for (const token of tokens) {
        if (seen.has(token)) continue;
        seen.add(token);
        overlap += weights.get(token) ?? 0;
      }
      if (overlap <= 0) continue;

      // Favour dense sentences over long ones that merely contain more words.
      candidates.push({ text, score: overlap / Math.sqrt(tokens.length), docIndex: hit.docIndex, order });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

/** First readable sentences of a passage, used when no sentence matches the query. */
function leadingSentences(text: string): string {
  const chosen: string[] = [];
  let length = 0;
  for (const sentence of splitSentences(text)) {
    const trimmed = sentence.trim();
    if (trimmed.length < 25) continue;
    if (length + trimmed.length > MAX_CHARS && chosen.length) break;
    chosen.push(trimmed);
    length += trimmed.length;
    if (chosen.length >= 2) break;
  }
  return chosen.join(' ');
}
