/**
 * In-browser retrieval over the approved corpus.
 *
 * BM25F-lite: one lexical score per chunk, with the document title, its
 * section heading and its tags treated as boosted fields alongside the body.
 * The corpus is ~5 documents and a few hundred chunks, so the whole index is
 * built in a couple of milliseconds and lives in a single object.
 *
 * The retrieval surface is deliberately narrow — `buildIndex` + `retrieve` —
 * so a dense or hybrid implementation can replace it without touching the UI.
 */

import { contentTerms, expandQuery, normalize, tokenize } from './text.ts';
import type { Corpus, CorpusDoc, SourceType } from './types.ts';

const K1 = 1.2;
const B = 0.75;

const FIELD_WEIGHTS = {
  body: 1,
  heading: 1.6,
  title: 1.4,
  tags: 1.4,
  kind: 0.7,
};

/**
 * Score multiplier applied to each additional passage taken from a document
 * already represented in the results.
 *
 * Document-level fields (title, tags, kind) contribute identically to every
 * chunk of a document, so once a document matches, all of its chunks bunch
 * together near the top — including the weak ones. Discounting repeats lets a
 * strong passage from a second document outrank a mediocre second passage from
 * the first, which is what actually makes the evidence worth reading.
 */
const REDUNDANCY_DISCOUNT = 0.55;

/**
 * Small lift for a document's synthetic summary chunk.
 *
 * The summary is the page's title and blurb — the passage that says what a
 * thing *is*. Without it, "what are his strongest projects?" retrieves
 * implementation details and a small model answers by naming components
 * ("the FastAPI modular dashboard") as if they were projects.
 */
const SUMMARY_BOOST = 1.2;

/**
 * Vocabulary for what a document *is*, indexed alongside its tags.
 *
 * "What has Carl written about?" contains no word that appears in either
 * article, because an article rarely describes itself as an article. Indexing
 * the document kind gives those structural questions something to match.
 */
const TYPE_KEYWORDS: Record<SourceType, string> = {
  project: 'project portfolio',
  article: 'article writing blog post published',
  experience: 'experience career role job employer company',
  about: 'about background bio personal interests education',
  profile: 'profile summary background',
  links: 'contact links profile github linkedin resume email code repository',
};

/** Below this normalised score we treat the corpus as having no answer. */
export const RELEVANCE_FLOOR = 0.1;

/**
 * Imputed IDF for a literal query term the corpus has never seen. Counted
 * against the score ceiling so that asking about something absent lowers
 * confidence instead of being silently ignored.
 */
const ABSENT_TERM_IDF = 2;

/**
 * Documents whose type matches the shape of the question get a small lift.
 * "What has he written about?" should surface articles before project pages.
 */
const TYPE_AFFINITY: { pattern: RegExp; type: SourceType; boost: number }[] = [
  { pattern: /\b(writ|wrote|article|blog|post|essay)/i, type: 'article', boost: 1.3 },
  { pattern: /\b(project|portfolio|built|build|shipped)/i, type: 'project', boost: 1.15 },
  { pattern: /\b(role|job|career|employ|position|company|hire|hiring)/i, type: 'experience', boost: 1.2 },
  { pattern: /\b(contact|reach|email|github|linkedin|resume|repo)/i, type: 'links', boost: 1.25 },
];

interface IndexedChunk {
  chunkIndex: number;
  docIndex: number;
  /** term -> weighted term frequency across all fields */
  tf: Map<string, number>;
  length: number;
  haystack: string;
}

export interface RetrievalIndex {
  corpus: Corpus;
  chunks: IndexedChunk[];
  idf: Map<string, number>;
  avgLength: number;
  /** Every term the corpus contains, for "we have never heard of this" checks. */
  vocabulary: Set<string>;
}

export interface Hit {
  chunkIndex: number;
  docIndex: number;
  doc: CorpusDoc;
  heading: string;
  text: string;
  score: number;
}

export interface RetrievalResult {
  hits: Hit[];
  /** Best hit score normalised to roughly 0..1. Zero means "do not answer". */
  confidence: number;
}

function addTerms(tf: Map<string, number>, terms: string[], weight: number): void {
  for (const term of terms) {
    tf.set(term, (tf.get(term) ?? 0) + weight);
  }
}

export function buildIndex(corpus: Corpus): RetrievalIndex {
  const docTokens = corpus.docs.map((doc) => ({
    title: tokenize(doc.title),
    tags: tokenize(doc.tags.join(' ')),
    kind: tokenize(TYPE_KEYWORDS[doc.type] ?? ''),
  }));

  const chunks: IndexedChunk[] = corpus.chunks.map((chunk, chunkIndex) => {
    const bodyTokens = tokenize(chunk.t);
    const tf = new Map<string, number>();
    addTerms(tf, bodyTokens, FIELD_WEIGHTS.body);
    addTerms(tf, tokenize(chunk.h), FIELD_WEIGHTS.heading);
    addTerms(tf, docTokens[chunk.d].title, FIELD_WEIGHTS.title);
    addTerms(tf, docTokens[chunk.d].tags, FIELD_WEIGHTS.tags);
    addTerms(tf, docTokens[chunk.d].kind, FIELD_WEIGHTS.kind);

    return {
      chunkIndex,
      docIndex: chunk.d,
      tf,
      length: bodyTokens.length,
      haystack: normalize(`${corpus.docs[chunk.d].title} ${chunk.h} ${chunk.t}`),
    };
  });

  const df = new Map<string, number>();
  for (const chunk of chunks) {
    for (const term of chunk.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const total = chunks.length || 1;
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log(1 + (total - count + 0.5) / (count + 0.5)));
  }

  const avgLength = chunks.reduce((sum, c) => sum + c.length, 0) / total;

  return { corpus, chunks, idf, avgLength, vocabulary: new Set(df.keys()) };
}

export interface RetrieveOptions {
  /** Chunks handed to the model. */
  topK?: number;
  /** Cap per source document, so answers cite more than one page. */
  perDoc?: number;
  /**
   * Minimum score relative to the best hit. Short chunks that match only
   * generic framing words score respectably under BM25 and then sit in the
   * model's context as a distraction — a small model will happily justify an
   * answer with whichever passage is nearest, relevant or not. Better to send
   * three good passages than five padded ones.
   */
  minRelativeScore?: number;
}

export function retrieve(
  index: RetrievalIndex,
  query: string,
  { topK = 5, perDoc = 2, minRelativeScore = 0.4 }: RetrieveOptions = {}
): RetrievalResult {
  const terms = expandQuery(query);
  const normalizedQuery = normalize(query);
  const unknownTerms = contentTerms(query).filter((term) => !index.vocabulary.has(term));
  const bigrams = normalizedQuery
    .split(' ')
    .filter((w) => w.length > 2)
    .map((word, i, all) => (i < all.length - 1 ? `${word} ${all[i + 1]}` : ''))
    .filter(Boolean);

  if (!terms.length) return { hits: [], confidence: 0 };

  const affinities = TYPE_AFFINITY.filter((rule) => rule.pattern.test(query));

  // Score ceiling for this query, used to turn raw BM25 into a comparable 0..1.
  const ceiling =
    terms.reduce(
      (sum, { term, weight }) =>
        sum + weight * (index.idf.get(term) ?? (weight === 1 ? ABSENT_TERM_IDF : 0)),
      0
    ) *
    (K1 + 1);

  const scored: Hit[] = [];
  for (const chunk of index.chunks) {
    let score = 0;
    for (const { term, weight } of terms) {
      const tf = chunk.tf.get(term);
      if (!tf) continue;
      const idf = index.idf.get(term) ?? 0;
      const norm = 1 - B + B * (chunk.length / (index.avgLength || 1));
      score += weight * idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
    }
    if (score <= 0) continue;

    // Adjacent query words appearing verbatim is a strong signal on prose this short.
    let phraseHits = 0;
    for (const bigram of bigrams) if (chunk.haystack.includes(bigram)) phraseHits += 1;
    if (phraseHits) score *= 1 + Math.min(phraseHits, 3) * 0.12;

    const doc = index.corpus.docs[chunk.docIndex];
    for (const rule of affinities) if (doc.type === rule.type) score *= rule.boost;

    const corpusChunk = index.corpus.chunks[chunk.chunkIndex];
    if (corpusChunk.h === 'Summary') score *= SUMMARY_BOOST;
    scored.push({
      chunkIndex: chunk.chunkIndex,
      docIndex: chunk.docIndex,
      doc,
      heading: corpusChunk.h,
      text: corpusChunk.t,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  const cutoff = (scored[0]?.score ?? 0) * minRelativeScore;
  const perDocCount = new Map<number, number>();
  const pool = scored.filter((hit) => hit.score >= cutoff);
  const hits: Hit[] = [];

  // Greedy selection with a redundancy discount, rather than a plain top-K.
  while (hits.length < topK) {
    let bestIndex = -1;
    let bestValue = 0;

    for (let i = 0; i < pool.length; i += 1) {
      const seen = perDocCount.get(pool[i].docIndex) ?? 0;
      if (seen >= perDoc) continue;
      const value = pool[i].score * REDUNDANCY_DISCOUNT ** seen;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }

    if (bestIndex < 0) break;
    const [hit] = pool.splice(bestIndex, 1);
    perDocCount.set(hit.docIndex, (perDocCount.get(hit.docIndex) ?? 0) + 1);
    hits.push(hit);
  }

  const rawConfidence = ceiling > 0 ? Math.min(1, (scored[0]?.score ?? 0) / ceiling) : 0;
  // Soft penalty: unknown query terms reduce confidence proportionally.
  // This is better than a hard zero — subjective words like "cool" slip through
  // QUESTION_SHELL and would previously be treated as factual subjects.
  const unknownRatio = terms.length > 0 ? unknownTerms.length / terms.length : 0;
  const confidence = rawConfidence * (1 - unknownRatio * 0.5);

  return { hits, confidence };
}

/** Deterministic source list for an answer: one entry per document, best first. */
export interface AnswerSource {
  title: string;
  links: { label: string; href: string }[];
}

export function sourcesFor(hits: Hit[], limit = 3): AnswerSource[] {
  const seen = new Set<string>();
  const sources: AnswerSource[] = [];

  for (const hit of hits) {
    if (seen.has(hit.doc.id)) continue;
    if (!hit.doc.links.length) continue; // Curated knowledge with no public page.
    seen.add(hit.doc.id);
    sources.push({ title: hit.doc.title, links: hit.doc.links.slice(0, 2) });
    if (sources.length >= limit) break;
  }

  return sources;
}
