/**
 * Orchestration: question -> retrieve -> ground -> answer -> deterministic sources.
 *
 * This is the whole RAG loop. There is no agent, no tool calling and no second
 * pass; the model is a single, optional step that converts retrieved passages
 * into prose. Sources are always rendered from retrieval metadata, never from
 * anything the model produced.
 */

import { buildIndex, retrieve, sourcesFor, RELEVANCE_FLOOR } from './retrieve.ts';
import type { AnswerSource, RetrievalIndex } from './retrieve.ts';
import {
  buildUserMessage,
  declineAnswer,
  MAX_ANSWER_SENTENCES,
  MAX_EVIDENCE,
  SYSTEM_PROMPT,
} from './prompt.ts';
import { extractiveAnswer } from './extractive.ts';
import { splitSentences } from './text.ts';
import { detectGpu, isMeteredConnection, loadEngine, MODEL } from './engine.ts';
import type { LoadProgress, LocalEngine } from './engine.ts';
import type { Corpus } from './types.ts';
import { createServerEngine } from './server-engine.ts';
import type { ServerEngine } from './server-engine.ts';

export type ModelState =
  | { kind: 'idle' }
  | { kind: 'loading'; percent: number; approxMB: number }
  | { kind: 'ready' }
  | { kind: 'unsupported'; reason: string }
  /** `scope` separates "never loaded" from "died mid-answer" — different bugs. */
  | { kind: 'failed'; scope: 'load' | 'generate'; reason: string };

export type AnswerMode = 'generated' | 'extractive' | 'declined';

export interface AssistantAnswer {
  text: string;
  sources: AnswerSource[];
  mode: AnswerMode;
  /** True when the excerpt was served because the model was still downloading. */
  modelPending?: boolean;
}

/**
 * How long a question waits for a model that is still downloading before the
 * visitor gets the retrieval excerpt instead. The model keeps loading in the
 * background and the next question uses it.
 */
const MODEL_WAIT_MS = 20_000;

export interface AssistantOptions {
  corpusUrl: string;
  onModelState?: (state: ModelState) => void;
  /** Optional server engine config. When provided, uses the funnel API instead of local ONNX. */
  serverConfig?: { funnelUrl: string; model: string };
}

/**
 * Strips anything link-shaped from generated prose.
 *
 * Rule 9 of the system prompt says never write URLs; this is the part that
 * makes it true regardless of what the model does. Applied to the streaming
 * buffer as well, so a half-written URL never even flickers on screen.
 */
/**
 * Clauses where the model narrates its own inputs — "as mentioned in the
 * passage", "as evidenced by ... the evidence". The prompt asks it not to and a
 * 0.6B model does it anyway, so the clause is removed to the end of its
 * sentence. The lookahead keeps ordinary uses of "as described" intact.
 */
const EVIDENCE_HEDGE =
  /,?\s+as\s+(?:mentioned|evidenced|described|stated|shown|noted|detailed|seen|indicated)\b(?=[^.!?]*\b(?:passage|passages|evidence|information provided|context above)\b)[^.!?]*/gi;

/** "Based on the evidence, ..." style openers. */
const PREAMBLE = /^(?:based on|according to|from)\b[^,.]{0,60}[,.]\s*/i;

/** A whole sentence whose only content is that the evidence exists. */
const META_SENTENCE = /\b(?:the|this) (?:evidence|passages?|sources? label|information provided|context above)\b/i;

/**
 * Drops sentences that talk about the retrieved text rather than about Carl.
 * "He described working on RAG systems in the evidence." tells a visitor
 * nothing, and no phrasing of the prompt reliably stops a 0.6B model saying it.
 */
function dropMetaSentences(text: string): string {
  const sentences = splitSentences(text);
  const kept = sentences.filter((sentence) => !META_SENTENCE.test(sentence));
  return kept.length ? kept.join(' ') : text;
}

export function sanitizeAnswer(text: string): string {
  return dropMetaSentences(text)
    .replace(EVIDENCE_HEDGE, '')
    .replace(PREAMBLE, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S*/gi, '')
    .replace(/\bwww\.\S*/gi, '')
    .replace(/\[\s*\d+(\s*,\s*\d+)*\s*\]/g, '')
    .replace(/^\s*(EVIDENCE|ANSWER|QUESTION)\s*:\s*/gim, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Domain-like tokens, restricted to real TLDs so `Node.js` is left alone. */
const DOMAIN = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|ai|co|edu|gov|me|app|xyz)(?:\/[^\s,;)"']*)?/gi;
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/gi;

/**
 * Removes any address the retrieved evidence does not literally contain.
 *
 * The model is told not to write links, but "never invents a URL" should be a
 * property of the system rather than a hope about the model. A bare domain that
 * appears verbatim in the evidence is quoted, not invented, so it stays.
 */
export function dropUnsupportedAddresses(text: string, evidence: string): string {
  const keep = (match: string) => {
    const trimmed = match.replace(/[.,;:)]+$/, '');
    return evidence.includes(trimmed) ? match : '';
  };
  return text.replace(DOMAIN, keep).replace(EMAIL, keep);
}

/**
 * Counts completed sentences, used to stop a model that will not stop itself.
 * Uses the abbreviation-aware splitter: a naive `/[.!?]/` count treats "M.S."
 * and "B.S." as sentence ends and cuts an answer off mid-degree.
 */
function countSentences(text: string): number {
  return splitSentences(text).length;
}

/** Trims to whole sentences. A small model asked for three will sometimes write nine. */
export function limitSentences(text: string, max = MAX_ANSWER_SENTENCES): string {
  const parts = splitSentences(text);
  if (parts.length <= max) return text.trim();
  return parts.slice(0, max).join(' ').trim();
}

export function createAssistant({ corpusUrl, onModelState, serverConfig }: AssistantOptions) {
  let corpusPromise: Promise<{ corpus: Corpus; index: RetrievalIndex }> | null = null;
  let engine: LocalEngine | null = null;
  let enginePending: Promise<LocalEngine | null> | null = null;
  let serverEngine: ServerEngine | null = serverConfig ? createServerEngine(serverConfig) : null;
  let modelState: ModelState = { kind: 'idle' };
  /** One automatic rebuild after a generation failure, then stop trying. */
  let recoveriesLeft = 1;
  /** Conversation turns passed to the model for context. */
  const conversation: ConversationTurn[] = [];

  const setState = (state: ModelState) => {
    modelState = state;
    onModelState?.(state);
  };

  /**
   * Surfaces a short message to the visitor and the real error to the console.
   * Without the console line an on-device failure is undebuggable: it happens on
   * someone else's GPU, and nothing is logged anywhere else by design.
   */
  const reportFailure = (scope: 'load' | 'generate', error: unknown) => {
    console.error(`[assistant] model ${scope} failed`, error);
    setState({
      kind: 'failed',
      scope,
      reason: error instanceof Error ? error.message : `Model ${scope} failed`,
    });
  };

  const loadCorpus = () => {
    corpusPromise ??= fetch(corpusUrl, { credentials: 'omit' })
      .then((response) => {
        if (!response.ok) throw new Error(`Corpus request failed (${response.status})`);
        return response.json() as Promise<Corpus>;
      })
      .then((corpus) => {
        console.log('[assistant] corpus loaded:', corpus.docs.length, 'docs,', corpus.chunks.length, 'chunks, version', corpus.version);
        console.log('[assistant] doc ids:', corpus.docs.map(d => d.id).join(', '));
        console.log('[assistant] corpus URL:', corpusUrl);
        return { corpus, index: buildIndex(corpus) };
      })
      .catch((error) => {
        console.error('[assistant] corpus load failed:', error);
        corpusPromise = null; // Retry on the next question rather than failing forever.
        throw error;
      });
    return corpusPromise;
  };

  const startModel = () => {
    if (enginePending || modelState.kind === 'unsupported') return enginePending;

    enginePending = (async () => {
      if (isMeteredConnection()) {
        setState({
          kind: 'unsupported',
          reason: `Skipped the ${MODEL.approxMB} MB model download on a metered connection.`,
        });
        return null;
      }

      const gpu = await detectGpu();
      if (!gpu.supported) {
        setState({ kind: 'unsupported', reason: gpu.reason ?? 'WebGPU unavailable' });
        return null;
      }

      setState({ kind: 'loading', percent: 0, approxMB: MODEL.approxMB });
      try {
        engine = await loadEngine((progress: LoadProgress) => {
          if (progress.phase === 'ready') setState({ kind: 'ready' });
          else {
            setState({
              kind: 'loading',
              percent: progress.percent ?? 0,
              approxMB: progress.approxMB ?? MODEL.approxMB,
            });
          }
        });
        setState({ kind: 'ready' });
        return engine;
      } catch (error) {
        reportFailure('load', error);
        return null;
      }
    })();

    return enginePending;
  };

  /** Waits for the model, but not indefinitely — a slow download must not hang a question. */
  const waitForModel = async (): Promise<LocalEngine | null> => {
    const pending = startModel();
    if (!pending) return null;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), MODEL_WAIT_MS);
    });

    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    get modelState() {
      return modelState;
    },

    /** Fetch + index the corpus. Cheap, and safe to call on hover. */
    warmCorpus: loadCorpus,

    /** Begin the expensive download. Called when the panel is first opened. */
    warmModel: startModel,

    /** Clear conversation history. Called when the user resets. */
    clearConversation: () => { conversation.length = 0; },

    async ask(
      question: string,
      { onToken, signal }: { onToken?: (text: string) => void; signal?: AbortSignal } = {}
    ): Promise<AssistantAnswer> {
      const { corpus, index } = await loadCorpus();
      const result = retrieve(index, question, { topK: 5, perDoc: 2 });

      if (result.confidence < RELEVANCE_FLOOR || !result.hits.length) {
        return { text: declineAnswer(result, corpus), sources: [], mode: 'declined' };
      }

      // Sources are drawn from the same passages the model was shown, so the
      // links under an answer always correspond to what the answer was built on.
      const evidence = result.hits.slice(0, MAX_EVIDENCE);
      const sources = sourcesFor(evidence);
      // Use server engine if configured, otherwise fall back to local ONNX
      const activeEngine = serverEngine ?? engine ?? (await waitForModel());

      if (!activeEngine) {
        return {
          text: extractiveAnswer(question, evidence),
          sources,
          mode: 'extractive',
          modelPending: modelState.kind === 'loading',
        };
      }

      const userMessage = buildUserMessage(question, evidence, conversation);
      const evidenceText = evidence.map((hit) => hit.text).join('\n');
      const clean = (raw: string) => dropUnsupportedAddresses(sanitizeAnswer(raw), evidenceText);

      try {
        let buffer = '';
        let stopped = false;
        const text = await activeEngine.generate(SYSTEM_PROMPT, userMessage, {
          signal,
          onToken: (delta) => {
            buffer = delta; // Server streams full text, not deltas
            // Stop at the sentence budget rather than truncating afterwards, so
            // the visitor never watches text appear and then get taken away.
            if (!stopped && countSentences(buffer) >= MAX_ANSWER_SENTENCES) {
              stopped = true;
              if (activeEngine.interrupt) activeEngine.interrupt();
            }
            onToken?.(clean(buffer));
          },
        });

        const answer = limitSentences(clean(text || buffer));
        if (answer.length < 15) {
          return { text: extractiveAnswer(question, evidence), sources, mode: 'extractive' };
        }
        // A previous failure was not necessarily permanent; clear it on success
        // so the panel stops apologising for something that now works.
        if (modelState.kind === 'failed') setState({ kind: 'ready' });
        // Record this turn for conversation context
        conversation.push({ question, answer: answer });
        return { text: answer, sources, mode: 'generated' };
      } catch (error) {
        if (signal?.aborted) throw error;
        reportFailure('generate', error);

        // If server engine failed, fall back to local engine
        if (activeEngine === serverEngine && engine) {
          try {
            let buffer = '';
            let stopped = false;
            const text = await engine.generate(SYSTEM_PROMPT, userMessage, {
              signal,
              onToken: (delta) => {
                buffer += delta;
                if (!stopped && countSentences(buffer) >= MAX_ANSWER_SENTENCES) {
                  stopped = true;
                  engine.interrupt();
                }
                onToken?.(clean(buffer));
              },
            });
            const answer = limitSentences(clean(text || buffer));
            if (answer.length >= 15) {
              setState({ kind: 'ready' });
              conversation.push({ question, answer });
              return { text: answer, sources, mode: 'generated' };
            }
          } catch (fallbackError) {
            console.warn('[assistant] server and local engine both failed, using extractive fallback');
          }
        }

        // A GPU session that has failed once tends to keep failing. Drop it so
        // the next question builds a fresh one — the weights are already in the
        // browser cache, so this costs session setup, not a re-download.
        if (recoveriesLeft > 0 && engine) {
          recoveriesLeft -= 1;
          const dead = engine;
          engine = null;
          enginePending = null;
          void dead?.dispose().catch(() => undefined);
        }

        return { text: extractiveAnswer(question, evidence), sources, mode: 'extractive' };
      }
    },
  };
}

export type Assistant = ReturnType<typeof createAssistant>;
