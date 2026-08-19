/**
 * Browser-local answer generation.
 *
 * Everything model-specific lives behind `loadEngine()`. Swapping models means
 * editing `MODEL` below; swapping runtimes means reimplementing this one file.
 * Nothing else in the assistant knows what an ONNX graph is.
 *
 * Weights and the runtime are fetched from public CDNs on first use only, and
 * the browser's Cache Storage keeps them for repeat visits. Nothing is sent
 * anywhere: the question, the evidence and the answer never leave the tab.
 */

/**
 * Qwen3-0.6B, 4-bit weights with fp16 activations, thinking mode off.
 *
 * Two smaller candidates were measured against the real corpus and prompts
 * before settling here:
 *
 *   SmolLM2-360M-Instruct (273 MB) — answered "No, Carl has not built RAG
 *     systems" against evidence that plainly said otherwise, and echoed the
 *     system prompt back as the answer. Not usable.
 *   Qwen2.5-0.5B-Instruct (483 MB) — fluent, but invented a project ("Volo"),
 *     invented definitions ("TTFT (Total Time Forward)") and named a framework
 *     that appears nowhere on the site. Fabrication is worse than clumsiness on
 *     a page a recruiter is reading.
 *
 * Qwen3-0.6B was the smallest model that stopped inventing things. The extra
 * ~90 MB over Qwen2.5 buys correctness, which the brief ranks first.
 */
export const MODEL = {
  id: 'onnx-community/Qwen3-0.6B-ONNX',
  /**
   * 4-bit weights with fp16 activations. The plain `q4` build is 920 MB, which
   * is not a download to hand someone silently, so a GPU without `shader-f16`
   * is treated as unsupported and gets the retrieval-only experience instead.
   */
  dtype: 'q4f16' as const,
  approxMB: 580,
  /**
   * Qwen3 emits a <think> block by default. For "turn these passages into three
   * sentences" it adds latency and nothing else, so the chat template is applied
   * manually with thinking disabled.
   */
  disableThinking: true,
};

const RUNTIME_URL =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.web.min.js';

const GENERATION = {
  max_new_tokens: 200,
  do_sample: false,
  repetition_penalty: 1.08,
};

export type LoadPhase = 'unsupported' | 'runtime' | 'downloading' | 'warming' | 'ready' | 'error';

export interface LoadProgress {
  phase: LoadPhase;
  /** 0-100 across all model files, when known. */
  percent?: number;
  approxMB?: number;
}

export interface GenerateOptions {
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface LocalEngine {
  generate(system: string, user: string, options?: GenerateOptions): Promise<string>;
  interrupt(): void;
  dispose(): Promise<void>;
}

export interface GpuSupport {
  supported: boolean;
  fp16: boolean;
  reason?: string;
}

/** Feature-detects WebGPU without loading a single byte of the runtime. */
export async function detectGpu(): Promise<GpuSupport> {
  const gpu = (navigator as Navigator & { gpu?: unknown }).gpu as
    | { requestAdapter(): Promise<{ features: Set<string> } | null> }
    | undefined;

  if (!gpu) return { supported: false, fp16: false, reason: "This browser doesn't support WebGPU." };

  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return { supported: false, fp16: false, reason: 'No WebGPU adapter is available here.' };
    }
    if (!adapter.features.has('shader-f16')) {
      return {
        supported: false,
        fp16: false,
        reason: "This GPU doesn't support the 16-bit shaders the model needs.",
      };
    }
    return { supported: true, fp16: true };
  } catch {
    return { supported: false, fp16: false, reason: "WebGPU couldn't be initialised." };
  }
}

/**
 * Whether it would be rude to start the download.
 *
 * Android Chrome supports WebGPU, so without this check a recruiter opening the
 * assistant on mobile data would silently pull 580 MB. Save-Data is an explicit
 * request not to; a 2G/3G connection makes the download pointless anyway.
 */
export function isMeteredConnection(): boolean {
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;

  if (!connection) return false;
  if (connection.saveData) return true;
  return ['slow-2g', '2g', '3g'].includes(connection.effectiveType ?? '');
}

let enginePromise: Promise<LocalEngine> | null = null;

/** Loads the model once per page. Repeat calls share the first promise. */
export function loadEngine(onProgress: (progress: LoadProgress) => void): Promise<LocalEngine> {
  enginePromise ??= createEngine(onProgress).catch((error) => {
    enginePromise = null; // Allow a retry on the next open.
    throw error;
  });
  return enginePromise;
}

async function createEngine(onProgress: (progress: LoadProgress) => void): Promise<LocalEngine> {
  const gpu = await detectGpu();
  if (!gpu.supported) {
    const error = new Error(gpu.reason ?? 'WebGPU unavailable');
    error.name = 'UnsupportedBrowserError';
    throw error;
  }

  const dtype = MODEL.dtype;
  const approxMB = MODEL.approxMB;

  onProgress({ phase: 'runtime', approxMB });
  const transformers = await import(/* @vite-ignore */ RUNTIME_URL);
  const { pipeline, env, TextStreamer, InterruptableStoppingCriteria } = transformers;

  // Never probe this origin for model files — the site hosts none.
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  if (typeof SharedArrayBuffer === 'undefined' && env.backends?.onnx?.wasm) {
    // GitHub Pages cannot send the COOP/COEP headers threading requires.
    env.backends.onnx.wasm.numThreads = 1;
  }

  const bytes = new Map<string, { loaded: number; total: number }>();
  const report = (item: { file?: string; loaded?: number; total?: number }) => {
    if (!item.file || !item.total) return;
    bytes.set(item.file, { loaded: item.loaded ?? 0, total: item.total });
    let loaded = 0;
    let total = 0;
    for (const entry of bytes.values()) {
      loaded += entry.loaded;
      total += entry.total;
    }
    if (total > 0) {
      onProgress({ phase: 'downloading', percent: Math.min(99, (loaded / total) * 100), approxMB });
    }
  };

  const generator = await pipeline('text-generation', MODEL.id, {
    device: 'webgpu',
    dtype,
    progress_callback: (item: { status?: string; file?: string; loaded?: number; total?: number }) => {
      if (item.status === 'progress') report(item);
      else if (item.status === 'ready') onProgress({ phase: 'warming', percent: 100, approxMB });
    },
  });

  onProgress({ phase: 'ready', percent: 100, approxMB });

  let stopper: { interrupt(): void; reset(): void } | null = null;

  return {
    async generate(system, user, options = {}) {
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];

      // Applied by hand so `enable_thinking` can be passed through; the pipeline
      // does not forward template options.
      const prompt = generator.tokenizer.apply_chat_template(messages, {
        tokenize: false,
        add_generation_prompt: true,
        ...(MODEL.disableThinking ? { enable_thinking: false } : {}),
      });

      stopper = new InterruptableStoppingCriteria();
      const onAbort = () => stopper?.interrupt();
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const streamer = options.onToken
        ? new TextStreamer(generator.tokenizer, {
            skip_prompt: true,
            skip_special_tokens: true,
            callback_function: options.onToken,
          })
        : undefined;

      try {
        const output = await generator(prompt, {
          ...GENERATION,
          return_full_text: false,
          streamer,
          stopping_criteria: stopper,
        });
        return extractAssistantText(output);
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
        stopper = null;
      }
    },

    interrupt() {
      // Never let stopping an answer become the thing that breaks it.
      try {
        stopper?.interrupt();
      } catch (error) {
        console.warn('[assistant] could not interrupt generation', error);
      }
    },

    async dispose() {
      try {
        await generator.dispose?.();
      } catch (error) {
        console.warn('[assistant] could not dispose model session', error);
      }
    },
  };
}

/** Normalises the pipeline's output, which differs between string and chat inputs. */
function extractAssistantText(output: unknown): string {
  const first = Array.isArray(output) ? output[0] : output;
  const generated = (first as { generated_text?: unknown })?.generated_text;

  if (Array.isArray(generated)) {
    const last = generated[generated.length - 1] as { content?: string } | undefined;
    return stripThinking(last?.content ?? '');
  }
  return stripThinking(typeof generated === 'string' ? generated : '');
}

/** Belt and braces: drop a reasoning block if the template ever emits one. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim();
}
