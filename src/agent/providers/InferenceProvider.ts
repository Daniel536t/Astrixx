/**
 * Replaceable server-side inference provider interface.
 *
 * All providers implement `completeText`: one bounded, non-streaming call
 * returning plain text (ideally JSON per the caller's schema instruction).
 * Keys are supplied by the caller (read from environment) and must never be
 * logged, returned, or bundled for the browser.
 */

export interface InferenceUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Cost in USD/Credits when the provider reports it (OpenRouter does). */
  cost?: number;
}

export interface InferenceResult {
  provider: string;
  model: string;
  text: string;
  usage: InferenceUsage | null;
  latencyMs: number;
}

export interface InferenceRequest {
  model: string;
  apiKey: string;
  systemPrompt?: string;
  userPrompt: string;
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
  /** When true, ask for strict JSON (provider-specific mechanism). */
  jsonMode?: boolean;
  /** Bounded retries on 429/5xx only. Defaults to 1. */
  maxRetries?: number;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly model: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface InferenceProvider {
  readonly name: string;
  completeText(request: InferenceRequest): Promise<InferenceResult>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST helper with timeout + bounded retry on 429/5xx. Never logs the key. */
export async function postJsonWithRetry(
  provider: string,
  model: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  maxRetries: number,
): Promise<{ status: number; json: unknown; latencyMs: number }> {
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text().catch(() => '');
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!response.ok) {
        const retryable = (response.status === 429 || response.status >= 500) && attempt < maxRetries;
        if (retryable) {
          attempt += 1;
          await sleep(1000 * 2 ** (attempt - 1));
          continue;
        }
        const detail = typeof parsed === 'object' && parsed !== null
          ? JSON.stringify(parsed).slice(0, 200)
          : text.slice(0, 200);
        throw new ProviderError(
          `${provider} request failed for ${model}: HTTP ${response.status} ${detail}`,
          provider,
          model,
          response.status,
          false,
        );
      }
      return { status: response.status, json: parsed, latencyMs: Date.now() - started };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new ProviderError(`${provider} request for ${model} timed out after ${timeoutMs}ms.`, provider, model, null, true);
      }
      throw new ProviderError(
        `${provider} request for ${model} failed: ${error instanceof Error ? error.message : String(error)}`,
        provider,
        model,
        null,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
