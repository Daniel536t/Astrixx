import { describe, expect, it, vi, afterEach } from 'vitest';
import { nimChatCompletion } from './NimClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('nimChatCompletion', () => {
  it('parses content, reasoning, finish reason, and usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{ message: { content: 'OK', reasoning_content: 'thinking' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 3 } },
    })));
    const result = await nimChatCompletion({ model: 'm', apiKey: 'test-key-abc123', userPrompt: 'hi', maxTokens: 16 });
    expect(result).toMatchObject({ model: 'm', content: 'OK', reasoning: 'thinking', finishReason: 'stop' });
    expect(result.usage).toMatchObject({ promptTokens: 10, reasoningTokens: 3 });
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    // The key travels only in the Authorization header, never in the body or logs.
    expect(JSON.stringify(init.body)).not.toContain('test-key-abc123');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key-abc123', 'Content-Type': 'application/json' });
  });

  it('retries a transient 503 and then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('overloaded', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await nimChatCompletion({ model: 'm', apiKey: 'k', userPrompt: 'hi', maxTokens: 16, maxRetries: 1 });
    expect(result.content).toBe('OK');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces client errors with status and without retry', async () => {
    const fetchMock = vi.fn(async () => new Response('bad model', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(nimChatCompletion({ model: 'm', apiKey: 'k', userPrompt: 'hi', maxTokens: 16 })).rejects.toMatchObject({
      name: 'NimError', status: 400,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports timeouts as NimError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })),
    );
    await expect(
      nimChatCompletion({ model: 'm', apiKey: 'k', userPrompt: 'hi', maxTokens: 16, timeoutMs: 20 }),
    ).rejects.toMatchObject({ name: 'NimError', status: null });
  });
});
