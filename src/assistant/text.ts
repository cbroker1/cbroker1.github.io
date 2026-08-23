/**
 * Shared text primitives for the portfolio assistant.
 *
 * Used both at build time (indexing the approved corpus) and in the browser
 * (processing a visitor's question), so this module must stay dependency-free
 * and must not touch the DOM or Node APIs.
 */

/** Words that carry no retrieval signal on a single-person portfolio corpus. */
const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are',
  'as', 'at', 'be', 'been', 'being', 'both', 'but', 'by', 'can', 'could', 'did',
  'does', 'doing', 'done', 'each', 'few', 'for', 'from', 'further', 'get', 'gets', 'had',
  'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if',
  'in', 'into', 'is', 'it', 'its', 'just', 'kind', 'kinds', 'may', 'me', 'might',
  'more', 'most', 'much', 'must', 'my', 'no', 'nor', 'not', 'of', 'off', 'on', 'once',
  'one', 'only', 'or', 'other', 'our', 'out', 'over', 'own', 'same', 'she', 'should',
  'so', 'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'us', 'use',
  'used', 'uses', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while',
  'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your',
  // The subject of every question on this site — present in queries, absent from prose.
  'broker', 'carls',
]);

/** Irregular forms worth normalising for recruiter-style phrasing. */
const IRREGULAR: Record<string, string> = {
  built: 'build',
  building: 'build',
  builds: 'build',
  wrote: 'write',
  written: 'write',
  writes: 'write',
  writing: 'write',
  taught: 'teach',
  ran: 'run',
  led: 'lead',
  strongest: 'strong',
  best: 'strong',
  studied: 'study',
  studies: 'study',
};

export function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    // Expand common contractions so "what's" → "what is" (both are stopwords)
    .replace(/\b(\w+)('s)\b/g, '$1 is')
    .replace(/\b(\w+)('re)\b/g, '$1 are')
    .replace(/\b(\w+)('ve)\b/g, '$1 have')
    .replace(/\b(\w+)('ll)\b/g, '$1 will')
    .replace(/\b(\w+)('d)\b/g, '$1 would')
    .replace(/\b(\w+)('m)\b/g, '$1 am')
    .replace(/\b(\w+)('t)\b/g, '$1 not')
    .replace(/\b(\w+)('cause)\b/g, '$1 because')
    .replace(/[^a-z0-9+#.\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Deliberately light stemmer — enough to bridge plural/gerund forms, no more. */
export function stem(word: string): string {
  const irregular = IRREGULAR[word];
  if (irregular) return irregular;
  if (word.length <= 3) return word;

  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('al') && word.length > 6) return word.slice(0, -2);
  if (word.endsWith('sses')) return word.slice(0, -2);
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('ly') && word.length > 4) return word.slice(0, -2);
  if (
    word.endsWith('s') &&
    !word.endsWith('ss') &&
    !word.endsWith('us') &&
    !word.endsWith('is')
  ) {
    return word.slice(0, -1);
  }
  return word;
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  for (const raw of normalize(input).split(' ')) {
    const word = raw.replace(/^[.\-+#?]+|[.\-+#?]+$/g, '');
    if (!word || word.length < 2) continue;
    if (STOPWORDS.has(word)) continue;
    tokens.push(stem(word));
  }
  return tokens;
}

/**
 * Curated vocabulary bridges.
 *
 * Every term in a group expands to the other terms in that group at reduced
 * weight. This is what stands in for a dense retriever: on a corpus this small
 * it closes the paraphrase gap ("education" -> "degree"/"university") for a
 * few hundred bytes instead of a 20 MB embedding model download.
 *
 * Groups may contain multi-word phrases; those are matched against the whole
 * normalised query before single-word expansion runs.
 */
export const ALIAS_GROUPS: string[][] = [
  ['rag', 'retrieval augmented generation', 'retrieval', 'grounded', 'context'],
  ['llm', 'language model', 'model', 'inference'],
  ['local llm', 'ollama', 'offline', 'on device', 'local', 'self hosted'],
  ['vector database', 'vector db', 'embedding', 'chromadb', 'milvus', 'similarity', 'cosine'],
  ['chunking', 'chunk', 'passage', 'corpus', 'index'],
  ['hybrid retrieval', 'bm25', 'reciprocal rank fusion', 'rrf', 'dense', 'lexical', 'rerank'],
  ['education', 'degree', 'university', 'college', 'school', 'masters', 'm.s.', 'b.s.', 'graduate', 'academic'],
  ['background', 'career', 'history', 'experience', 'role', 'job', 'position', 'work'],
  ['code', 'repository', 'repo', 'github', 'source', 'open source'],
  ['resume', 'cv', 'linkedin', 'profile', 'contact', 'email', 'reach'],
  ['gpu', 'nvidia', 'cuda', 'tensorrt', 'a6000', 'serving', 'throughput', 'latency', 'ttft'],
  ['benchmark', 'measure', 'evaluation', 'eval', 'metric', 'test'],
  ['agent', 'multi agent', 'orchestration', 'tool calling', 'watsonx', 'orchestrate'],
  ['machine learning', 'ml', 'classifier', 'classification', 'xgboost', 'scikit learn', 'training'],
  ['ocr', 'tesseract', 'document', 'scanned', 'extraction'],
  ['nlp', 'transformer', 'roberta', 'hugging face', 'bert'],
  ['python', 'pytorch', 'fastapi', 'pandas', 'sqlite'],
  ['hiring', 'recruiter', 'roles', 'opportunity', 'looking for', 'interested in', 'aligned', 'fit'],
  ['interests', 'hobbies', 'outside of work', 'personal', 'paramotor', 'mountain biking', 'scuba'],
  ['technologies', 'tech stack', 'stack', 'tools', 'toolkit', 'skills'],
  ['project', 'projects', 'work', 'portfolio'],
  ['article', 'articles', 'blog', 'post', 'write'],
  ['ask veno', 'veno', 'venoxium', 'gamma', 'whisper', 'livestream'],
];

/**
 * Question scaffolding: generic nouns, evaluative adjectives and framing verbs
 * that shape a question without being its subject.
 *
 * Used by the grounding gate. A question whose *subject* is missing from the
 * corpus ("...deep Kubernetes experience?") cannot be answered; a question that
 * merely contains an unindexed framing word ("...retrieval techniques?") can.
 * Anything listed here is treated as framing, never as a subject.
 */
const QUESTION_SHELL = new Set([
  'able', 'actual', 'align', 'aligned', 'amount', 'appear', 'approach', 'area',
  'background', 'believe', 'best', 'big', 'capabilities', 'capability', 'capable',
  'career', 'comfortable', 'company', 'competent', 'consider', 'current', 'deep',
  'deeper', 'describe', 'discuss', 'domain', 'employer', 'example', 'experience',
  'expertise', 'explain', 'familiar', 'familiarity', 'favorite', 'favourite',
  'field', 'find', 'fit', 'general', 'give', 'good', 'great', 'hand', 'high',
  'involve', 'job', 'key', 'knowledge', 'level', 'list', 'long', 'look', 'lot',
  'low', 'main', 'make', 'many', 'match', 'mention', 'method', 'methodology',
  'detail', 'highlight', 'insight', 'practice',
  'need', 'notable', 'opportunity', 'overall', 'particular', 'past', 'position',
  'previous', 'professional', 'provide', 'qualification', 'qualified', 'real',
  'recent', 'relate', 'related', 'relevant', 'role', 'sample', 'say', 'seem',
  'several', 'share', 'show', 'skill', 'small', 'solid', 'sort', 'specific',
  'strength', 'strong', 'suit', 'suited', 'summarise', 'summarize', 'talk',
  'technic', 'technique', 'tell', 'thing', 'think', 'time', 'top', 'topic',
  'various', 'want', 'way', 'year',
  // Filler nouns that shape a question but carry no retrieval signal.
  'fella', 'fellow', 'guy', 'individual', 'person', 'type',
]);

/** The topic-bearing words in a question, paired with how the visitor typed
 * them so a decline can quote the question back accurately.
 *
 * Kept for future use if we add a soft-confidence gate based on unknown terms.
 */
export function subjectTerms(query: string): { term: string; word: string }[] {
  const subjects: { term: string; word: string }[] = [];
  const seen = new Set<string>();

  for (const raw of query.trim().split(/\s+/)) {
    const word = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#]+$/g, '');
    if (!word) continue;
    const [term] = tokenize(word);
    if (!term || QUESTION_SHELL.has(term) || seen.has(term)) continue;
    seen.add(term);
    subjects.push({ term, word });
  }

  return subjects;
}

export interface WeightedTerm {
  term: string;
  weight: number;
}

const PHRASE_GROUPS = ALIAS_GROUPS.map((group) => group.filter((t) => t.includes(' ')));

/**
 * Turns a raw question into weighted search terms.
 *
 * Terms the visitor actually typed keep weight 1. Alias expansions come in at
 * a fraction of that, so they can rescue a paraphrased question without ever
 * outvoting a literal match.
 */
/** Framing words still match, but must not outrank the question's real subject. */
const SHELL_WEIGHT = 0.5;

export function expandQuery(query: string, expansionWeight = 0.4): WeightedTerm[] {
  const normalized = normalize(query);
  const literal = tokenize(query);
  const weights = new Map<string, number>();

  for (const term of literal) {
    const weight = QUESTION_SHELL.has(term) ? SHELL_WEIGHT : 1;
    weights.set(term, Math.max(weights.get(term) ?? 0, weight));
  }

  const addExpansion = (phrase: string) => {
    for (const term of tokenize(phrase)) {
      if (weights.has(term) && weights.get(term)! >= expansionWeight) continue;
      weights.set(term, expansionWeight);
    }
  };

  const literalSet = new Set(literal);
  ALIAS_GROUPS.forEach((group, groupIndex) => {
    const phraseHit = PHRASE_GROUPS[groupIndex].some((phrase) => normalized.includes(phrase));
    const wordHit = group.some(
      (entry) => !entry.includes(' ') && tokenize(entry).every((t) => literalSet.has(t))
    );
    if (!phraseHit && !wordHit) return;
    for (const entry of group) addExpansion(entry);
  });

  return [...weights.entries()].map(([term, weight]) => ({ term, weight }));
}

/** Literal, non-expanded content terms — used to detect what the corpus never mentions. */
export function contentTerms(query: string): string[] {
  return [...new Set(tokenize(query))];
}

/** Abbreviations that end in a period but not a sentence. */
const NOT_SENTENCE_END = '(?<!\\b(?:St|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|Inc|Ltd|vs|etc|approx|Fig|No|[A-Z])\\.)';

export function splitSentences(text: string): string[] {
  return text
    .split(new RegExp(`(?<=[.!?])${NOT_SENTENCE_END}\\s+(?=[A-Z0-9"'(])`))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
