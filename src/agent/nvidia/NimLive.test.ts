import { describe, expect, it } from 'vitest';
import { nimChatCompletion } from './NimClient';

/**
 * Real provider smoke test — SKIPPED unless a credential is present.
 * This is the only test that touches the network. It performs one minimal
 * completion and asserts availability only, never capability.
 */
const KEY = process.env['NVIDIA_NIM_API_KEY_A'];
const LIVE = typeof KEY === 'string' && KEY.length > 0;

describe.skipIf(!LIVE)('nim live provider (LIVE)', () => {
  it('completes a minimal request through the configured provider', async () => {
    // Muse Glimmer (slot A) answers reliably with a sufficient budget;
    // default retries absorb transient 429/503 capacity signals.
    const result = await nimChatCompletion({
      model: 'meta/muse-glimmer-30b',
      apiKey: KEY as string,
      userPrompt: 'Reply with exactly: OK',
      maxTokens: 512,
      temperature: 0,
      timeoutMs: 120_000,
    });
    expect(result.content).toContain('OK');
    expect(result.latencyMs).toBeGreaterThan(0);
  }, 180_000);
});
