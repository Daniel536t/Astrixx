import { describe, expect, it, vi, afterEach } from 'vitest';
import { BackendDecisionProvider } from './BackendDecisionProvider';
import { createWorld } from '../world/createWorld';
import { LocalGathererAgent } from './LocalGathererAgent';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BackendDecisionProvider', () => {
  it('returns labelled decisions and never the key', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true, provider: 'gemini', model: 'gemini-3.5-flash-lite', latencyMs: 42,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      rawText: '{"action": null}',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new BackendDecisionProvider('http://127.0.0.1:5193');
    const obs = new LocalGathererAgent().observe(createWorld());
    const result = await provider.requestDecision(obs, null, []);
    expect(result).toMatchObject({ model: 'gemini:gemini-3.5-flash-lite', latencyMs: 42, rawText: '{"action": null}' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5193/api/decide');
    expect(JSON.stringify(init.body)).not.toContain('API_KEY');
  });

  it('throws on provider failure instead of fabricating', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 502 })));
    const provider = new BackendDecisionProvider('http://127.0.0.1:5193');
    const obs = new LocalGathererAgent().observe(createWorld());
    await expect(provider.requestDecision(obs, null, [])).rejects.toThrow(/unavailable|boom/);
  });
});
