/**
 * Prints the assistant's fully deterministic output — decline text, extractive
 * answers and rendered sources — for a set of recruiter questions.
 *
 * This is everything a visitor sees except the model's prose, so it is where
 * grounding and source correctness get checked.
 *
 *   npm run build && npm run assistant:answers
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const load = (mod) => import(resolve(here, '../src/lib/assistant/', mod));

const { buildIndex, retrieve, sourcesFor, RELEVANCE_FLOOR } = await load('retrieve.ts');
const { extractiveAnswer } = await load('extractive.ts');
const { declineAnswer, buildUserMessage, SYSTEM_PROMPT } = await load('prompt.ts');

const corpus = JSON.parse(readFileSync(resolve(here, '../dist/assistant/corpus.json'), 'utf8'));
const index = buildIndex(corpus);

const QUESTIONS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'What kind of AI systems has Carl built?',
      'Has Carl built RAG systems?',
      'What is Ask Veno?',
      'Does Carl have experience with local LLMs?',
      'What retrieval techniques has he used?',
      'What has Carl written about?',
      "What is Carl's educational background?",
      'Where can I see his code?',
      'What technologies does he use?',
      'What kind of work seems aligned with his background?',
      'Does Carl have deep Kubernetes experience?',
      'Has Carl worked at Google?',
    ];

for (const question of QUESTIONS) {
  const result = retrieve(index, question, { topK: 5, perDoc: 2 });
  console.log(`\n\x1b[1m? ${question}\x1b[0m`);

  if (result.confidence < RELEVANCE_FLOOR || !result.hits.length) {
    console.log(`  [declined]  ${declineAnswer(result, corpus)}`);
    continue;
  }

  console.log(`  [extractive, conf ${result.confidence.toFixed(2)}]`);
  console.log(`  ${extractiveAnswer(question, result.hits).replace(/\n/g, '\n  ')}`);
  console.log('  sources:');
  for (const source of sourcesFor(result.hits)) {
    console.log(`    · ${source.title}`);
    for (const link of source.links) console.log(`        ${link.label} -> ${link.href}`);
  }

  if (process.env.SHOW_PROMPT) {
    console.log('  --- prompt ---');
    console.log(buildUserMessage(question, result.hits, result.unknownTerms).replace(/^/gm, '  | '));
  }
}

console.log(`\nSystem prompt: ${SYSTEM_PROMPT.length} chars\n`);
