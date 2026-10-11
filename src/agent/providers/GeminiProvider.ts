/**
 * Google Gemini provider (REST generateContent, `X-goog-api-key` header).
 * Server-side only. Verified 2026-10-10 against the live v1beta endpoint.
 */
import {
  postJsonWithRetry,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
} from './InferenceProvider';

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

export class GeminiProvider implements InferenceProvider {
  readonly name = 'gemini';

  async completeText(request: InferenceRequest): Promise<InferenceResult> {
    const {
      model,
      apiKey,
      systemPrompt,
      userPrompt,
      maxTokens,
      temperature = 0,
      timeoutMs = 60_000,
      jsonMode = false,
      maxRetries = 1,
    } = request;
    const started = Date.now();
    const contents: Array<{ role?: string; parts: Array<{ text: string }> }> = [];
    if (systemPrompt) contents.push({ role: 'user', parts: [{ text: `System instructions: ${systemPrompt}` }] });
    contents.push({ role: 'user', parts: [{ text: userPrompt }] });
    const { json } = await postJsonWithRetry(
      this.name,
      model,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
      {
        contents,
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature,
          ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
        },
      },
      timeoutMs,
      maxRetries,
    );
    const data = (json ?? {}) as GeminiResponse;
    if (data.promptFeedback?.blockReason) {
      const { ProviderError } = await import('./InferenceProvider');
      throw new ProviderError(
        `gemini request for ${model} blocked: ${data.promptFeedback.blockReason}`,
        this.name,
        model,
        null,
        false,
      );
    }
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    const usage = data.usageMetadata
      ? {
          promptTokens: data.usageMetadata.promptTokenCount ?? 0,
          completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: data.usageMetadata.totalTokenCount ?? 0,
        }
      : null;
    return { provider: this.name, model, text, usage, latencyMs: Date.now() - started };
  }
}
