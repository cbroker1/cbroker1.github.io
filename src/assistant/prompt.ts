/**
 * Prompt construction and the deterministic decline path.
 *
 * The model is only ever asked to turn retrieved passages into prose. It is
 * never the thing that decides whether an answer exists — that decision is made
 * here, from retrieval scores, before any generation happens.
 */

import type { Corpus } from './types.ts';
import type { Hit, RetrievalResult } from './retrieve.ts';

export interface ConversationTurn {
  question: string;
  answer: string;
}

/**
 * Split into two paths — "if the evidence answers" vs "if it doesn't" — so the
 * model actually evaluates relevance instead of assuming the retrieval already
 * did. Small models especially need the explicit stop instruction; without it
 * they will hallucinate an answer from thin evidence.
 *
 * Removed "Visitors are often recruiters" to avoid pushing the model to be
 * more impressive and less direct. Removed the false relevance guarantee.
 */
export const SYSTEM_PROMPT = [
  "You are the assistant on Carl Broker's portfolio website.",
  "Answer questions about Carl using only the EVIDENCE below.",
  "",
  "If the EVIDENCE answers the question:",
  "- Write 2 to 3 plain sentences. No lists, no headings, no bold text.",
  "- State only facts that appear in the EVIDENCE.",
  "- Name the specific projects and tools the EVIDENCE mentions.",
  "- The EVIDENCE is written by Carl in the first person. Write about him in the third person.",
  "- Never write URLs or citation markers.",
  '- Do not repeat SOURCE labels, and never say "the passage" or "the evidence".',
  '- Do not attribute a tool from one project to a different project.',
  '- No preamble, no praise, no closing sentence about his expertise.',
  "",
  "If the EVIDENCE does not contain enough information to answer the question:",
  "- Do not answer. Stop immediately after reading the evidence.",
].join('\n');

/** Hard ceiling on answer length, enforced in code rather than trusted to the model. */
export const MAX_ANSWER_SENTENCES = 4;

/** How many evidence passages the model sees. Small models degrade past ~4. */
export const MAX_EVIDENCE = 4;

export function buildUserMessage(question: string, hits: Hit[], conversation: ConversationTurn[]): string {
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

  return `EVIDENCE:
${evidence}

QUESTION: ${question}

${conversation.length > 0 ? `CONVERSATION CONTEXT:
${conversation.map((turn) => `Q: ${turn.question}
A: ${turn.answer}`).join('\n\n')}

Consider the conversation above when answering. If the question builds on prior answers, incorporate that context.` : ''}`;
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
  return `I don't have enough information in Carl's public portfolio to answer that confidently. ${coverage}`;
}
