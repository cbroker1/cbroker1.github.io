/**
 * Offline retrieval check for the portfolio assistant.
 *
 * Runs recruiter-style questions through the same retrieval code the browser
 * uses and asserts that the right source documents come back — and, for
 * unsupported questions, that confidence falls below the floor so the
 * assistant declines instead of inventing an answer.
 *
 *   npm run build && npm run assistant:eval
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { buildIndex, retrieve, sourcesFor, RELEVANCE_FLOOR } = await import(
  resolve(here, '../src/lib/assistant/retrieve.ts')
);

const corpusPath = resolve(here, '../dist/assistant/corpus.json');
let corpus;
try {
  corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
} catch {
  console.error(`Corpus not found at ${corpusPath}. Run \`npm run build\` first.`);
  process.exit(1);
}

const index = buildIndex(corpus);

/** `expect`: doc ids that must appear in the top hits. `expectNone`: must decline. */
const CASES = [
  { q: 'What kind of AI systems has Carl built?', expect: ['experience', 'project:ask-veno'] },
  { q: 'Has Carl built RAG systems?', expect: ['project:ask-veno'] },
  { q: 'What is Ask Veno?', expect: ['project:ask-veno'] },
  { q: 'Does Carl have experience with local LLMs?', expect: ['project:ask-veno'] },
  {
    q: "What are Carl's strongest technical projects?",
    expect: ['project:ask-veno', 'project:document-intelligence-pipeline', 'project:optuna-xgboost'],
  },
  { q: 'What retrieval techniques has he used?', expect: ['project:ask-veno'] },
  { q: 'What has Carl written about?', expect: ['article:nvidia-tensorrt-llm-a6000', 'article:tensorrt-llm-under-load'] },
  { q: 'What has he written about GPU inference?', expect: ['article:nvidia-tensorrt-llm-a6000', 'article:tensorrt-llm-under-load'] },
  { q: "What is Carl's educational background?", expect: ['about'] },
  { q: 'What technologies does he use?', expect: ['experience', 'about', 'project:ask-veno'] },
  { q: 'Where can I see his code?', expect: ['links'] },
  { q: 'What kind of work seems aligned with Carl’s background?', expect: ['experience', 'about'] },
  { q: 'What kind of engineer is Carl?', expect: ['about', 'experience'] },
  { q: 'Has Carl done any OCR or document processing work?', expect: ['project:document-intelligence-pipeline'] },
  { q: 'What machine learning model tuning has he done?', expect: ['project:optuna-xgboost'] },
  { q: 'What are his interests outside of work?', expect: ['about'] },
  { q: 'Does Carl have deep Kubernetes experience?', expectNone: true },
  { q: 'Has Carl worked at Google?', expectNone: true },
  { q: 'What is the capital of France?', expectNone: true },
  { q: 'Does Carl speak fluent Japanese?', expectNone: true },
  // Lower-cased phrasing defeats the proper-noun gate, so these lean on the floor.
  { q: 'does carl have deep kubernetes experience', expectNone: true },
  { q: 'has carl worked at google', expectNone: true },
  { q: 'what did carl cook for dinner last night', expectNone: true },
  { q: 'can carl fly a helicopter', expectNone: true },
  { q: 'is carl a licensed attorney', expectNone: true },
];

let failures = 0;
const rows = [];

for (const testCase of CASES) {
  const result = retrieve(index, testCase.q, { topK: 5, perDoc: 2 });
  const docIds = [...new Set(result.hits.map((hit) => hit.doc.id))];
  const grounded = result.confidence >= RELEVANCE_FLOOR;

  let status = 'PASS';
  if (testCase.expectNone) {
    if (grounded) status = 'FAIL';
  } else if (!grounded) {
    status = 'FAIL';
  } else if (!testCase.expect.some((id) => docIds.includes(id))) {
    status = 'FAIL';
  }
  if (status === 'FAIL') failures += 1;

  rows.push({
    status,
    conf: result.confidence.toFixed(3),
    q: testCase.q,
    top: docIds.slice(0, 3).join(', ') || '—',
    unknown: result.missingSubjects.join(', ') || '—',
    sources: sourcesFor(result.hits).map((s) => s.title.slice(0, 28)).join(' | '),
  });
}

const pad = (value, width) => String(value).padEnd(width);
console.log(`\n${pad('', 5)}${pad('conf', 7)}${pad('question', 52)}top documents`);
console.log('-'.repeat(140));
for (const row of rows) {
  console.log(
    `${pad(row.status, 5)}${pad(row.conf, 7)}${pad(row.q.slice(0, 50), 52)}${row.top}` +
      (row.unknown !== '—' ? `   [missing: ${row.unknown}]` : '')
  );
}
console.log('-'.repeat(140));
console.log(
  `${CASES.length - failures}/${CASES.length} passed  ` +
    `(relevance floor ${RELEVANCE_FLOOR}, ${corpus.chunks.length} chunks, ${corpus.docs.length} documents)\n`
);

process.exit(failures ? 1 : 0);
