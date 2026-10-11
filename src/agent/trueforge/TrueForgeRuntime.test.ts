import { describe, expect, it } from 'vitest';
import {
  buildNimProviderManifest,
  buildStewardAgentManifest,
  modelSlug,
  providerNameForSlot,
  TRUEFORGE_AGENT_NAME,
  TrueForgeRuntime,
  type TrueForgeClientLike,
  type TurnStreamEvent,
} from './TrueForgeRuntime';
import { MODEL_REGISTRY } from '../nvidia/ModelRegistry';

function streamOf(events: TurnStreamEvent[]): AsyncIterable<{ data: TurnStreamEvent }> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield { data: event };
    },
  };
}

function fakeClient(events: TurnStreamEvent[], onCancel?: () => void): TrueForgeClientLike & { cancelled: boolean } {
  const state = { cancelled: false };
  return {
    cancelled: state.cancelled,
    sessions: {
      create: async () => ({ data: { id: 'session-1' } }),
      createTurnStream: async () => streamOf(events),
      cancel: async () => { state.cancelled = true; onCancel?.(); return {}; },
    },
    agents: { create: async () => ({}) },
  };
}

describe('model naming and manifests', () => {
  it('slugs every registry model into a valid TrueForge resource name', () => {
    expect(modelSlug('meta/muse-glimmer-30b')).toBe('meta-muse-glimmer-30b');
    for (const model of MODEL_REGISTRY) {
      expect(modelSlug(model.id)).toMatch(/^[a-z][a-z0-9-]{0,62}[a-z0-9]$/);
    }
    expect(() => modelSlug('!!!')).toThrow();
  });

  it('builds per-slot NIM provider manifests covering all nine models', () => {
    const manifestA = buildNimProviderManifest('secret-key-a', 'nvidia-nim-a') as {
      manifest: { type: string; name: string; base_url: string; auth: { api_key: string }; models: Array<{ model_id: string; name: string }> };
    };
    const manifestB = buildNimProviderManifest('secret-key-b', 'nvidia-nim-b') as {
      manifest: { type: string; name: string; base_url: string; auth: { api_key: string }; models: Array<{ model_id: string; name: string }> };
    };
    expect(manifestA.manifest.type).toBe('custom');
    expect(manifestA.manifest.name).toBe('nvidia-nim-a');
    expect(manifestA.manifest.base_url).toContain('nvidia.com');
    expect(manifestA.manifest.models.map((m) => m.model_id)).toEqual([
      'meta/muse-glimmer-30b',
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'poolside/laguna-xs-2.1',
      'nvidia/nemotron-3-ultra-550b-a55b',
    ]);
    expect(manifestB.manifest.models.map((m) => m.model_id)).toEqual([
      'z-ai/glm-5.3',
      'z-ai/glm-5.3-flash',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      'google/gemma-4-31b-it',
      'nvidia/nemotron-3-super-120b-a12b',
    ]);
    // Slots are never merged: no model appears under both providers.
    const overlap = manifestA.manifest.models.filter((m) => manifestB.manifest.models.some((n) => n.model_id === m.model_id));
    expect(overlap).toHaveLength(0);
  });

  it('keeps credentials out of the saved agent manifest', () => {
    const manifest = JSON.stringify(buildStewardAgentManifest(`${providerNameForSlot('A')}/laguna`));
    expect(manifest).toContain(TRUEFORGE_AGENT_NAME);
    expect(manifest).toContain('astrix-decision');
    expect(manifest).not.toContain('nvapi-');
    expect(manifest).not.toContain('api_key');
  });
});

describe('TrueForgeRuntime turns', () => {
  it('accumulates streamed deltas into decision text', async () => {
    const client = fakeClient([
      { type: 'turn.created' },
      { type: 'model.message.delta', content: '{"action":' },
      { type: 'model.message.delta', content: ' null}' },
      { type: 'turn.done', state: { status: 'completed' } },
    ]);
    const runtime = new TrueForgeRuntime('http://localhost:8790', () => client);
    const result = await runtime.runDecisionTurn('session-1', 'prompt');
    expect(result.text).toBe('{"action": null}');
    expect(result.status).toBe('completed');
    expect(result.approvalRequested).toBe(false);
  });

  it('cancels the turn and reports held-for-governance on approval events', async () => {
    let cancelled = false;
    const client = fakeClient(
      [
        { type: 'model.message.delta', content: '{"action":' },
        { type: 'tool.approval_required' },
        { type: 'turn.done', state: { status: 'awaiting_approval' } },
      ],
      () => { cancelled = true; },
    );
    const runtime = new TrueForgeRuntime('http://localhost:8790', () => client);
    const result = await runtime.runDecisionTurn('session-1', 'prompt');
    expect(result.approvalRequested).toBe(true);
    expect(result.status).toBe('held-for-governance');
    expect(cancelled).toBe(true);
  });
});
