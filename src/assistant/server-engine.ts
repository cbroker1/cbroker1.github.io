/**
 * Server-side answer generation via the llama.cpp funnel API.
 *
 * Swaps the local ONNX model for a remote Qwen3.6-35B-A3B-MTP served by
 * llama.cpp and exposed through a Tailscale Funnel. The RAG pipeline
 * (retrieval, evidence, prompt) is unchanged — only the model call differs.
 *
 * The funnel URL is read from an environment variable so it can differ
 * between dev and prod. Falls back to a hardcoded dev value.
 */

/**
 * OpenAI-compatible chat completion response shape — we only touch the
 * fields we need, so the type stays narrow.
 */
interface ChatChoice {
  finish_reason: string;
  message: {
    role: string;
    content: string;
    reasoning_content?: string;
  };
}

interface ChatResponse {
  choices: ChatChoice[];
}

/** Streaming delta from the OpenAI-compatible SSE endpoint. */
interface StreamChunk {
  choices: { delta: { content?: string }; finish_reason: string | null }[];
}

export interface ServerEngineOptions {
  /** Funnel URL, e.g. `https://gpurig.tail12bb91.ts.net` */
  funnelUrl: string;
  /** Model alias registered with the llama.cpp server. */
  model: string;
}

export interface ServerEngine {
  generate(
    system: string,
    user: string,
    options?: { onToken?: (delta: string) => void; signal?: AbortSignal }
  ): Promise<string>;
  interrupt(): void;
  dispose(): Promise<void>;
}

/**
 * Creates a server-side engine that streams completions via the funnel API.
 *
 * The llama.cpp server speaks the OpenAI-compatible streaming protocol
 * (SSE with `data: {...}` lines). We parse the SSE stream to feed tokens
 * to the UI typewriter.
 */
export function createServerEngine({ funnelUrl, model }: ServerEngineOptions): ServerEngine {
  let aborted = false;

  return {
    async generate(system, user, options = {}) {
      if (aborted) return '';

      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];

      const body = JSON.stringify({
        model,
        messages,
        max_tokens: 500,
        stream: true,
      });

      const url = `${funnelUrl}/v1/chat/completions`;

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Origin': 'https://cbroker1.github.io',
          },
          body,
          signal: options.signal,
        });

        if (!response.ok) {
          throw new Error(`Server response ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          // Non-streaming fallback — shouldn't happen with `stream: true`
          // but handle it gracefully.
          const json: ChatResponse = await response.json();
          return json.choices[0]?.message.content ?? '';
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        let done = false;

        while (!done) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) {
            done = true;
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE lines
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (aborted) break;

            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;

            const data = trimmed.slice(6).trim();
            if (data === '[DONE]') {
              done = true;
              break;
            }

            try {
              const chunk: StreamChunk = JSON.parse(data);
              const content = chunk.choices?.[0]?.delta?.content;
              if (content) {
                fullText += content;
                options.onToken?.(fullText);
              }
            } catch {
              // Malformed SSE data — skip it
            }
          }
        }

        return fullText;
      } catch (error) {
        if (aborted) return '';
        throw error;
      }
    },

    interrupt() {
      aborted = true;
    },

    async dispose() {
      aborted = true;
    },
  };
}
