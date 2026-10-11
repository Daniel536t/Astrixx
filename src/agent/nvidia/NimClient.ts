/**
 * Minimal OpenAI-compatible chat-completions client for NVIDIA NIM.
 *
 * Server-side only: the API key is passed in by the caller (read from
 * environment) and is never logged, never returned, and never bundled for
 * the browser. Non-streaming only — turn-loop decisions do not need SSE.
 */
import { NVIDIA_NIM_BASE_URL } from './ModelRegistry';

export interface NimUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface NimCompletion {
  model: string;
  /** Final answer text. May be empty when the model only emitted reasoning. */
  content: string;
  /** Private reasoning trace. NEVER surfaced to public logs or the Observatory. */
  reasoning: string | null;
  finishReason: string | null;
  usage: NimUsage | null;
  latencyMs: number;
}

export interface NimRequestOptions {
  model: string;
  apiKey: string;
  systemPrompt?: string;
  userPrompt: string;
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
  baseUrl?: string;
  /** Bounded retries on 429/503 only. Defaults to 2. */
  maxRetries?: number;
}

export class NimError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly model: string,
  ) {
    super(message);
    this.name = 'NimError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function nimChatCompletion(options: NimRequestOptions): Promise<NimCompletion> {
  const {
    model,
    apiKey,
    systemPrompt,
    userPrompt,
    maxTokens,
    temperature = 0,
    timeoutMs = 120_000,
    baseUrl = NVIDIA_NIM_BASE_URL,
    maxRetries = 2,
  } = options;
  const started = Date.now();
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });

  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const retryable = (response.status === 429 || response.status >= 500) && attempt < maxRetries;
        if (retryable) {
          attempt += 1;
          await sleep(1000 * 2 ** (attempt - 1));
          continue;
        }
        throw new NimError(
          `NIM request failed for ${model}: HTTP ${response.status} ${body.slice(0, 200)}`,
          response.status,
          model,
        );
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number | null } };
      };
      const choice = data.choices?.[0];
      if (!choice) throw new NimError(`NIM response for ${model} contained no choices.`, null, model);
      const usage = data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
            reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens ?? undefined,
          }
        : null;
      return {
        model,
        content: choice.message?.content ?? '',
        reasoning: choice.message?.reasoning_content ?? null,
        finishReason: choice.finish_reason ?? null,
        usage,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof NimError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new NimError(`NIM request for ${model} timed out after ${timeoutMs}ms.`, null, model);
      }
      throw new NimError(
        `NIM request for ${model} failed: ${error instanceof Error ? error.message : String(error)}`,
        null,
        model,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
