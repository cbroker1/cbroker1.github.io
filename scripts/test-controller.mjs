/**
 * End-to-end check of the assistant controller with no browser and no model.
 *
 * Covers the paths that must never regress: the corpus contract, the decline
 * gate, deterministic source rendering, and the URL scrubber that enforces
 * "the model never emits links" regardless of what the model emits.
 *
 *   npm run build && npm run assistant:test
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(here, '../dist/assistant/corpus.json');
const corpusText = readFileSync(corpusPath, 'utf8');

// The controller fetches its corpus; serve the built artifact from memory.
globalThis.fetch = async (url) => {
  if (String(url).includes('corpus.json')) {
    return { ok: true, status: 200, json: async () => JSON.parse(corpusText) };
  }
  throw new Error(`Unexpected fetch: ${url}`);
};

const { createAssistant, sanitizeAnswer, dropUnsupportedAddresses, limitSentences } = await import(
  resolve(here, '../src/lib/assistant/controller.ts')
);

let failed = 0;
const check = (name, condition, detail = '') => {
  console.log(`${condition ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failed += 1;
};

console.log('\nsanitizeAnswer — the model must never surface a link or citation');
const dirty =
  'Carl built Ask Veno [1], see https://example.com/fake and [the repo](https://evil.test) or www.nope.io .';
const clean = sanitizeAnswer(dirty);
check('strips bare URLs', !/https?:\/\//.test(clean), clean);
check('strips www hosts', !/www\./.test(clean), clean);
check('unwraps markdown links to their label', clean.includes('the repo'), clean);
check('strips numeric citations', !/\[\d+\]/.test(clean), clean);
check('leaves the prose intact', clean.startsWith('Carl built Ask Veno'), clean);

const hedged = 'Yes, Carl has built RAG systems as mentioned in the "Ask Veno" passage. He used ChromaDB.';
check(
  'removes a clause that narrates the evidence',
  sanitizeAnswer(hedged) === 'Yes, Carl has built RAG systems. He used ChromaDB.',
  sanitizeAnswer(hedged)
);
const hedged2 = 'Carl has experience with local LLMs, as evidenced by his mention in the passage where he ran Ollama.';
check(
  'removes the clause through to the end of its sentence',
  sanitizeAnswer(hedged2) === 'Carl has experience with local LLMs.',
  sanitizeAnswer(hedged2)
);
check(
  'leaves an ordinary "as described" alone',
  sanitizeAnswer('He built it as described in his article.').includes('as described'),
  sanitizeAnswer('He built it as described in his article.')
);
const meta = 'Yes, Carl has built RAG systems. He described working on RAG systems in the evidence.';
check(
  'drops a sentence that only refers to the evidence',
  sanitizeAnswer(meta) === 'Yes, Carl has built RAG systems.',
  sanitizeAnswer(meta)
);
check(
  'never returns empty when every sentence is meta',
  sanitizeAnswer('This is described in the evidence.').length > 0
);
check(
  'strips a "Based on ..." preamble',
  sanitizeAnswer('Based on the evidence, Carl built Ask Veno.') === 'Carl built Ask Veno.',
  sanitizeAnswer('Based on the evidence, Carl built Ask Veno.')
);

console.log('\ndropUnsupportedAddresses — an address must exist in the evidence to survive');
const evidence = 'Public code lives at github.com/cbroker1 and email is carlbroker@gmail.com.';
check(
  'keeps an address quoted from the evidence',
  dropUnsupportedAddresses('See github.com/cbroker1 for code.', evidence).includes('github.com/cbroker1')
);
check(
  'removes an address the evidence never mentions',
  !dropUnsupportedAddresses('See github.com/someone-else for code.', evidence).includes('someone-else')
);
check(
  'removes an invented email',
  !dropUnsupportedAddresses('Mail carl@fake.test today.', evidence).includes('@fake.test')
);
check(
  'leaves non-address dotted tokens alone',
  dropUnsupportedAddresses('He used Node.js and scikit-learn.', evidence).includes('Node.js')
);

console.log('\nlimitSentences — the model is not trusted to be concise');
const long = 'One. Two. Three. Four. Five. Six.';
check('trims to whole sentences', limitSentences(long, 3) === 'One. Two. Three.', limitSentences(long, 3));
check('leaves short answers untouched', limitSentences('Only one.', 3) === 'Only one.');

const assistant = createAssistant({ corpusUrl: 'http://test/assistant/corpus.json' });

console.log('\ncorpus + retrieval through the controller (no WebGPU here, so extractive)');
const grounded = await assistant.ask('What is Ask Veno?');
check('answers a covered question', grounded.mode === 'extractive' && grounded.text.length > 40);
check('renders at least one source', grounded.sources.length >= 1);
check(
  'every source link is a real URL from the corpus',
  grounded.sources.every((s) => s.links.every((l) => /^(https?:|\/|mailto:)/.test(l.href)))
);
check(
  'answer text contains no links',
  !/https?:\/\//.test(grounded.text),
  grounded.text.slice(0, 60)
);

console.log('\ngrounding gate');
const declinedEntity = await assistant.ask('Has Carl worked at Google?');
check('declines an unsupported employer', declinedEntity.mode === 'declined');
check('names what is missing', /Google/i.test(declinedEntity.text), declinedEntity.text);
check('shows no sources when declining', declinedEntity.sources.length === 0);

const declinedTech = await assistant.ask('does carl have deep kubernetes experience');
check('declines lower-cased unsupported tech', declinedTech.mode === 'declined', declinedTech.text);

const nonsense = await assistant.ask('what is the capital of France');
check('declines an off-topic question', nonsense.mode === 'declined');

console.log('\ncorpus privacy boundary — provenance, not keyword filtering');
const corpus = JSON.parse(corpusText);

/**
 * Every word in the corpus must appear in an approved source file.
 *
 * This is stronger than blacklisting sensitive words: it proves no text from
 * anywhere else on the machine can reach the corpus. The three source modules are
 * included because the generated experience and contact prose is assembled from
 * string literals that live in them.
 */
const APPROVED_SOURCES = [
  ...readdirSync(resolve(here, '../src/content/projects')).map((f) => `../src/content/projects/${f}`),
  ...readdirSync(resolve(here, '../src/content/writing')).map((f) => `../src/content/writing/${f}`),
  '../src/content/about.md',
  '../src/content/experience.md',
  '../src/knowledge/curated-profile.md',
  '../src/lib/assistant/corpus.ts',
  '../src/lib/site-links.ts',
  '../src/pages/assistant/corpus.json.ts',
];

const words = (text) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);

const approvedVocabulary = new Set(
  APPROVED_SOURCES.flatMap((file) => words(readFileSync(resolve(here, file), 'utf8')))
);

const foreign = new Set();
for (const chunk of corpus.chunks) {
  for (const word of words(chunk.t)) if (!approvedVocabulary.has(word)) foreign.add(word);
}
for (const doc of corpus.docs) {
  for (const word of words(doc.title)) if (!approvedVocabulary.has(word)) foreign.add(word);
}

check(
  'every word traces back to an approved source file',
  foreign.size === 0,
  foreign.size ? `unaccounted: ${[...foreign].slice(0, 12).join(', ')}` : ''
);

const EXPECTED_DOC_IDS = [
  'project:ask-veno',
  'project:document-intelligence-pipeline',
  'project:optuna-xgboost',
  'article:nvidia-tensorrt-llm-a6000',
  'article:tensorrt-llm-under-load',
  'about',
  'experience',
  'links',
];
const actualIds = corpus.docs.map((d) => d.id).filter((id) => !id.startsWith('profile:'));
check(
  'corpus holds exactly the expected documents (plus curated profile sections)',
  actualIds.length === EXPECTED_DOC_IDS.length && actualIds.every((id) => EXPECTED_DOC_IDS.includes(id)),
  actualIds.join(', ')
);

check(
  'every document has a title and a type',
  corpus.docs.every((d) => d.title && d.type)
);
check(
  'every chunk points at a real document',
  corpus.chunks.every((c) => corpus.docs[c.d] !== undefined)
);
check(
  'no document links to an unexpected host',
  corpus.docs.every((d) =>
    d.links.every((l) => /^(\/|mailto:)/.test(l.href) || /^https:\/\/(github|www\.linkedin)\.com\//.test(l.href))
  )
);

console.log(failed ? `\n${failed} check(s) failed\n` : '\nAll checks passed\n');
process.exit(failed ? 1 : 0);
