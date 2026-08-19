/**
 * Prompt construction and the deterministic decline path.
 *
 * The model is only ever asked to turn retrieved passages into prose. It is
 * never the thing that decides whether an answer exists — that decision is made
 * here, from retrieval scores, before any generation happens.
 */

import type { Corpus } from './types.ts';
import type { Hit, RetrievalResult } from './retrieve.ts';

/**
 * Kept deliberately short and positively framed.
 *
 * Two things were learned the hard way while tuning this against real 0.5B
 * models. A long numbered rulebook gets echoed back as the answer. And leading
 * with "say so if the evidence is insufficient" primes a small model to answer
 * "No" to questions the evidence clearly supports — so relevance is asserted
 * up front instead (truthfully: retrieval already gated it), and the decline
 * path is handled in code before the model is ever called.
 */
export const SYSTEM_PROMPT = [
  "You are the assistant on Carl Broker's portfolio website. Visitors are often recruiters.",
  "Answer the visitor's question about Carl using only the EVIDENCE below.",
  'The EVIDENCE was already checked for relevance, so it does relate to the question.',
  '',
  'How to answer:',
  '- Write 2 to 3 plain sentences. No lists, no headings, no bold text.',
  '- State only facts that appear in the EVIDENCE. Never explain, define or expand a term.',
  '- Name the specific projects and tools the EVIDENCE mentions.',
  '- The EVIDENCE is written by Carl in the first person. Write about him in the third person.',
  '- Never write URLs or citation markers. Sources are shown separately.',
  '- Do not repeat the SOURCE labels, and never say "the passage", "the evidence"',
  '  or "the information provided". Just state the fact.',
  '- Do not attribute a tool from one project to a different project.',
  '- No preamble, no praise, and no closing sentence about his expertise or strengths.',
].join('\n');

/** Hard ceiling on answer length, enforced in code rather than trusted to the model. */
export const MAX_ANSWER_SENTENCES = 4;

/** How many evidence passages the model sees. Small models degrade past ~4. */
export const MAX_EVIDENCE = 4;

export function buildUserMessage(question: string, hits: Hit[], unknownTerms: string[]): string {
  // Grouped by source, and with no `[1]`-style numbering. Repeating a title once
  // per passage made the model treat four passages from two articles as four
  // articles; numbered evidence invites numbered citations, which are the
  // application's job rather than the model's.
  const grouped = new Map<string, { title: string; passages: string[] }>();
  for (const hit of hits.slice(0, MAX_EVIDENCE)) {
    const entry = grouped.get(hit.doc.id) ?? { title: hit.doc.title, passages: [] };
    entry.passages.push(hit.heading ? `(${hit.heading}) ${hit.text}` : hit.text);
    grouped.set(hit.doc.id, entry);
  }

  const evidence = [...grouped.values()]
    .map((entry) => `SOURCE "${entry.title}":\n${entry.passages.join('\n')}`)
    .join('\n\n');

  const absent = unknownTerms.length
    ? `\nNot mentioned anywhere in the evidence: ${unknownTerms.join(', ')}.\n`
    : '';

  return `EVIDENCE:\n${evidence}\n${absent}\nQUESTION: ${question}`;
}

/** One sentence describing what the corpus actually holds, built from the corpus. */
function coverageSummary(corpus: Corpus): string {
  const count = (type: string) => corpus.docs.filter((doc) => doc.type === type).length;
  const parts: string[] = [];
  const projects = count('project');
  const articles = count('article');
  if (projects) parts.push(`${projects} project write-up${projects === 1 ? '' : 's'}`);
  if (articles) parts.push(`${articles} technical article${articles === 1 ? '' : 's'}`);
  parts.push('his career history and background');
  return `This site covers ${parts.join(', ')}.`;
}

/**
 * The answer given when retrieval cannot support one. Fully deterministic —
 * no model runs, so there is nothing to hallucinate.
 */
export function declineAnswer(result: RetrievalResult, corpus: Corpus): string {
  const coverage = coverageSummary(corpus);

  if (result.missingSubjects.length) {
    const subjects = formatList(result.missingSubjects.slice(0, 3));
    return `Carl's site doesn't mention ${subjects}, so I can't answer that from his public work. ${coverage}`;
  }

  return `I don't have enough information in Carl's public portfolio to answer that confidently. ${coverage}`;
}

function formatList(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}
