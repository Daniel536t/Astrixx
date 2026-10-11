/**
 * OpenRouter provider (OpenAI-compatible chat completions + usage.cost).
 * Server-side only. Verified 2026-10-10 against the live API, including a
 * `cost: 0` free-tier response. Free shared-pool models may 429 upstream;
 * that surfaces as a retryable ProviderError, never as a capability verdict.
 */
import {
  postJsonWithRetry,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
} from './InferenceProvider';

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
  error?: { message?: string; code?: number };
}

export class OpenRouterProvider implements InferenceProvider {
  readonly name = 'openrouter';

  async completeText(request: InferenceRequest): Promise<InferenceResult> {
    const {
      model,
      apiKey,
      systemPrompt,
      userPrompt,
      maxTokens,
      temperature = 0,
      timeoutMs = 90_000,
      maxRetries = 1,
    } = request;
    const started = Date.now();
    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });
    const { json } = await postJsonWithRetry(
      this.name,
      model,
      'https://openrouter.ai/api/v1/chat/completions',
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-OpenRouter-Title': 'ASTrix',
      },
      { model, messages, max_tokens: maxTokens, temperature, stream: false },
      timeoutMs,
      maxRetries,
    );
    const data = (json ?? {}) as OpenRouterResponse;
    if (data.error) {
      const { ProviderError } = await import('./InferenceProvider');
      throw new ProviderError(
        `openrouter request for ${model} failed: ${(data.error.message ?? 'unknown').slice(0, 200)}`,
        this.name,
        model,
        data.error.code ?? null,
        false,
      );
    }
    const choice = data.choices?.[0];
    if (!choice) {
      const { ProviderError } = await import('./InferenceProvider');
      throw new ProviderError(`openrouter response for ${model} contained no choices.`, this.name, model, null, false);
    }
    const usage = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
          cost: data.usage.cost,
        }
      : null;
    return {
      provider: this.name,
      model,
      text: choice.message?.content ?? '',
      usage,
      latencyMs: Date.now() - started,
    };
  }
}
