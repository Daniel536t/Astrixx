import { describe, expect, it, vi, afterEach } from 'vitest';
import { GeminiProvider } from './GeminiProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import { ProviderError } from './InferenceProvider';
import { selectProvider, lookupProviderModel, keyEnvVarFor } from './ProviderRegistry';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('GeminiProvider', () => {
  it('posts generateContent with the key header and parses text + usage', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      candidates: [{ content: { parts: [{ text: '{"action":null}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new GeminiProvider().completeText({
      model: 'gemini-3.5-flash-lite', apiKey: 'gemini-test-secret', userPrompt: 'hi', maxTokens: 16,
    });
    expect(result).toMatchObject({ provider: 'gemini', text: '{"action":null}' });
    expect(result.usage).toMatchObject({ promptTokens: 5, totalTokens: 6 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('gemini-3.5-flash-lite:generateContent');
    // Key travels only in the header, never the URL or body.
    expect(url).not.toContain('gemini-test-secret');
    expect(JSON.stringify((init.body as string) ?? '')).not.toContain('gemini-test-secret');
    expect(init.headers).toMatchObject({ 'X-goog-api-key': 'gemini-test-secret' });
  });

  it('surfaces blocks and HTTP errors without retry on 400', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new GeminiProvider().completeText({ model: 'm', apiKey: 'k', userPrompt: 'hi', maxTokens: 8 }))
      .rejects.toMatchObject({ name: 'ProviderError', provider: 'gemini' });
  });
});

describe('OpenRouterProvider', () => {
  it('posts chat completions and captures zero-cost usage', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 21, completion_tokens: 2, total_tokens: 23, cost: 0 },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new OpenRouterProvider().completeText({
      model: 'x:free', apiKey: 'or-test-secret', userPrompt: 'hi', maxTokens: 16,
    });
    expect(result).toMatchObject({ provider: 'openrouter', text: 'OK' });
    expect(result.usage).toMatchObject({ cost: 0 });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer or-test-secret' });
    expect(JSON.stringify(init.body)).not.toContain('or-test-secret');
  });

  it('wraps provider error payloads and retries 429 once by default', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('limited', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'OK' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new OpenRouterProvider().completeText({ model: 'x:free', apiKey: 'k', userPrompt: 'hi', maxTokens: 8 });
    expect(result.text).toBe('OK');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new ProviderError('x', 'openrouter', 'm', 429, true)).toMatchObject({ retryable: true });
  });
});

describe('provider selection', () => {
  it('defaults to gemini flash-lite with no explicit fallback', () => {
    expect(selectProvider({})).toEqual({ provider: 'gemini', model: 'gemini-3.5-flash-lite', fallback: [] });
    expect(selectProvider({ ASTRIX_AI_PROVIDER: 'openrouter' })).toMatchObject({
      provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free',
    });
    expect(selectProvider({ ASTRIX_AI_PROVIDER: 'openrouter', ASTRIX_AI_MODEL: 'a:b', ASTRIX_AI_FALLBACK: 'gemini, nim' }))
      .toMatchObject({ provider: 'openrouter', model: 'a:b', fallback: ['gemini', 'nim'] });
  });

  it('maps keys to server-side env vars only', () => {
    expect(keyEnvVarFor('gemini')).toBe('GEMINI_API_KEY');
    expect(keyEnvVarFor('openrouter')).toBe('OPENROUTER_API_KEY');
    expect(lookupProviderModel('openrouter', 'nvidia/nemotron-3-super-120b-a12b:free')).toMatchObject({ label: expect.stringContaining('Super') });
    expect(lookupProviderModel('gemini', 'nope')).toBeUndefined();
  });
});
