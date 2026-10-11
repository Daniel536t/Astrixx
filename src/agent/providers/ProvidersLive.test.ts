import { describe, expect, it } from 'vitest';
import { GeminiProvider } from './GeminiProvider';
import { OpenRouterProvider } from './OpenRouterProvider';

/**
 * Gated live provider checks — SKIPPED without credentials. Each performs
 * one minimal completion asserting availability only. Free-tier usage is
 * verified via OpenRouter's `cost: 0`; Gemini returns no cost field, so its
 * free-tier status for these tiny calls is an assumption, recorded as such.
 */
const GEMINI_KEY = process.env['GEMINI_API_KEY'];
const OR_KEY = process.env['OPENROUTER_API_KEY'];

describe.skipIf(!GEMINI_KEY)('gemini live (LIVE)', () => {
  it('completes a minimal request', async () => {
    const result = await new GeminiProvider().completeText({
      model: 'gemini-3.5-flash-lite',
      apiKey: GEMINI_KEY as string,
      userPrompt: 'Reply with exactly: OK',
      maxTokens: 16,
      temperature: 0,
      timeoutMs: 60_000,
    });
    expect(result.text).toContain('OK');
  }, 90_000);
});

describe.skipIf(!OR_KEY)('openrouter live (LIVE)', () => {
  it('completes a minimal free-tier request at zero cost', async () => {
    const result = await new OpenRouterProvider().completeText({
      model: 'nvidia/nemotron-3-super-120b-a12b:free',
      apiKey: OR_KEY as string,
      userPrompt: 'Reply with exactly: OK',
      maxTokens: 64,
      temperature: 0,
      timeoutMs: 120_000,
    });
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.usage?.cost).toBe(0);
  }, 150_000);
});
