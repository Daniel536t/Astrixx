/**
 * TrueForge agent runtime adapter for ASTrix.
 *
 * Uses the real TrueForge server (agent loop, sessions, streaming turns,
 * cancellation) via the official `@truefoundry/trueforge-sdk`. NVIDIA NIM is
 * attached as a `custom` OpenAI-compatible model provider, so API keys live
 * in the TrueForge server / this backend process — never in browser code.
 *
 * Authority boundary: TrueForge runs the agent loop and produces structured
 * decision text. It NEVER mutates ASTrix world state. Every decision still
 * passes through `WorldSimulation` proposal → approval → execution →
 * independent verification. Tool approvals inside TrueForge are not a
 * substitute for ASTrix governance: any turn that pauses for a TrueForge
 * approval is cancelled and reported as held for human governance.
 */
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { DECISION_JSON_SCHEMA } from '../nvidia/DecisionSchema';
import { NVIDIA_NIM_BASE_URL, MODEL_REGISTRY } from '../nvidia/ModelRegistry';

export const TRUEFORGE_AGENT_NAME = 'astrix-steward';

/** One custom provider per credential slot — keys are never merged. */
export function providerNameForSlot(slot: 'A' | 'B'): string {
  return slot === 'A' ? 'nvidia-nim-a' : 'nvidia-nim-b';
}

/** Slugify an upstream model id into a TrueForge ResourceName. */
export function modelSlug(modelId: string): string {
  const slug = modelId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z][a-z0-9-]{0,62}[a-z0-9]$/.test(slug)) {
    throw new Error(`Cannot slug model id ${modelId} into a TrueForge resource name.`);
  }
  return slug;
}

export function trueforgeModelFqn(modelId: string): string {
  const entry = MODEL_REGISTRY.find((model) => model.id === modelId);
  if (!entry) throw new Error(`Model ${modelId} is not in the ASTrix registry.`);
  return `${providerNameForSlot(entry.keySlot)}/${modelSlug(modelId)}`;
}

export const MOSS_INSTRUCTIONS = [
  'You are Moss, steward of a small forest settlement in the living world ASTrix.',
  'Each turn you receive the authoritative world observation. Reason only about entities, IDs, and mechanics that appear in it.',
  'Propose exactly one action per turn as a single JSON object matching the required schema, or a null action to keep observing.',
  'Never repeat a failed action without a changed approach. Wood before food while wood is zero.',
  'You do not authorize actions: a separate governance layer approves, executes, and independently verifies outcomes.',
].join(' ');

/** Minimal structural surface of the TrueForge SDK used here (fakes in tests). */
export interface TurnStreamEvent {
  type: string;
  content?: string | null;
  state?: { status?: string };
}

export interface TrueForgeClientLike {
  sessions: {
    create(request: unknown): Promise<{ data: { id: string } }>;
    createTurnStream(sessionId: string, request: unknown): Promise<AsyncIterable<unknown> & { withMetadata?: () => AsyncIterable<{ data: TurnStreamEvent }> }>;
    cancel(sessionId: string): Promise<unknown>;
  };
  agents: {
    create(request: unknown): Promise<unknown>;
  };
}

export interface TrueForgeTurnResult {
  text: string;
  status: string;
  approvalRequested: boolean;
  eventTypes: string[];
}

export function buildNimProviderManifest(
  apiKey: string,
  provider: string,
  models: Array<{ id: string }> = MODEL_REGISTRY.filter((model) =>
    provider === providerNameForSlot(model.keySlot),
  ),
): unknown {
  return {
    manifest: {
      type: 'custom',
      name: provider,
      base_url: NVIDIA_NIM_BASE_URL,
      auth: { api_key: apiKey },
      models: models.map((model) => ({
        model_id: model.id,
        name: modelSlug(model.id),
        properties: {},
      })),
    },
  };
}

export function buildStewardAgentManifest(modelFqn: string): unknown {
  // camelCase SDK surface; the SDK serializes to the server's snake_case.
  return {
    name: TRUEFORGE_AGENT_NAME,
    description: 'ASTrix Moss: model-driven steward of the living clearing.',
    manifest: {
      model: { name: modelFqn, params: { temperature: 0 } },
      instructions: MOSS_INSTRUCTIONS,
      responseFormat: {
        type: 'json_schema',
        jsonSchema: { name: 'astrix-decision', description: 'Single ASTrix world action decision', schema: DECISION_JSON_SCHEMA, strict: true },
      },
      config: { iterationLimit: 10 },
    },
  };
}

export class TrueForgeRuntime {
  private client: TrueForgeClientLike | null = null;

  constructor(
    readonly baseUrl: string,
    private readonly clientFactory: (baseUrl: string) => TrueForgeClientLike = (url) =>
      new TrueForge({ baseUrl: url, timeoutInSeconds: 600 }) as unknown as TrueForgeClientLike,
  ) {}

  /** Liveness probe: can we reach a TrueForge server at all? */
  async probe(): Promise<{ reachable: boolean; detail: string }> {
    try {
      this.client = this.clientFactory(this.baseUrl);
      // createTurnStream is lazy; sessions.create with an invalid agent would
      // fail — instead probe via a cheap sessions.list-like call. The SDK
      // surface used here is create-only, so probe with fetch against docs.
      const response = await fetch(`${this.baseUrl}/api/v1/openapi.json`, { method: 'GET' });
      if (!response.ok) return { reachable: false, detail: `HTTP ${response.status}` };
      return { reachable: true, detail: 'openapi reachable' };
    } catch (error) {
      this.client = null;
      return { reachable: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private requireClient(): TrueForgeClientLike {
    if (!this.client) this.client = this.clientFactory(this.baseUrl);
    return this.client;
  }

  /**
   * Register the NIM custom providers for every configured credential slot.
   * Keys travel only in these server-to-server calls and are never merged:
   * slot A models stay on nvidia-nim-a, slot B on nvidia-nim-b.
   */
  async ensureNimProviders(keys: { A?: string | null; B?: string | null }): Promise<string[]> {
    const registered: string[] = [];
    for (const slot of ['A', 'B'] as const) {
      const key = keys[slot];
      if (!key) continue;
      const provider = providerNameForSlot(slot);
      const response = await fetch(`${this.baseUrl}/api/v1/settings/model-providers`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildNimProviderManifest(key, provider)),
      });
      if (!response.ok) {
        throw new Error(`TrueForge provider ${provider} registration failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
      }
      registered.push(provider);
    }
    return registered;
  }

  /** Save the steward agent; a 409 (already saved) is fine — reuse it. */
  async ensureStewardAgent(modelFqn: string): Promise<void> {
    try {
      await this.requireClient().agents.create(buildStewardAgentManifest(modelFqn));
    } catch (error) {
      if (!/409|already|exists|taken/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }

  async createSession(): Promise<string> {
    const session = await this.requireClient().sessions.create({ agent: { name: TRUEFORGE_AGENT_NAME } });
    return session.data.id;
  }

  /**
   * Run one decision turn. Accumulates streamed model text; if TrueForge
   * pauses for a tool approval/question, the turn is cancelled — ASTrix
   * governance (not the chat UI) is the approval authority.
   */
  async runDecisionTurn(sessionId: string, prompt: string): Promise<TrueForgeTurnResult> {
    const client = this.requireClient();
    const stream = await client.sessions.createTurnStream(sessionId, {
      input: [{ type: 'user.message', content: prompt }],
    });
    // The SDK exposes withMetadata(); fakes may yield { data } directly or
    // raw events — normalize all three shapes.
    const iterable: AsyncIterable<unknown> = typeof stream.withMetadata === 'function'
      ? stream.withMetadata()
      : stream;
    let text = '';
    let status = 'unknown';
    let approvalRequested = false;
    const eventTypes: string[] = [];
    for await (const item of iterable) {
      const event = (item as { data?: TurnStreamEvent }).data ?? (item as TurnStreamEvent);
      if (!event || typeof event.type !== 'string') continue;
      eventTypes.push(event.type);
      if (event.type === 'model.message.delta' && event.content) text += event.content;
      if (event.type === 'model.message' && event.content) text += event.content;
      if (/approval|question|human|checkpoint/i.test(event.type)) approvalRequested = true;
      if (event.type === 'turn.done') status = event.state?.status ?? 'done';
      if (event.type === 'turn.failed' || event.type === 'turn.cancelled') status = event.type;
    }
    if (approvalRequested) {
      await client.sessions.cancel(sessionId).catch(() => undefined);
      return { text, status: 'held-for-governance', approvalRequested, eventTypes };
    }
    return { text, status, approvalRequested, eventTypes };
  }

  async cancelSession(sessionId: string): Promise<void> {
    if (this.client) await this.client.sessions.cancel(sessionId).catch(() => undefined);
  }
}
