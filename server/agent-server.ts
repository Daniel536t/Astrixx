#!/usr/bin/env tsx
/**
 * ASTrix agent backend (server-side only).
 *
 * Holds NVIDIA NIM credentials (environment variables, never logged, never
 * served) and runs the model-driven Moss loop against a headless
 * WorldSimulation. Runtime selection is explicit and reported on every
 * response:
 *   - `trueforge`  — decisions flow through a live TrueForge server turn.
 *   - `direct-nim` — TrueForge unreachable; NIM called directly (labelled).
 *   - `local-only` — no model credential configured; scripted baseline only.
 *
 * Endpoints:
 *   GET  /api/health
 *   POST /api/agent/run   { model?, maxTurns?, goal? }
 */
import http from 'node:http';
import { WorldSimulation } from '../src/simulation/WorldSimulation';
import { createWorld } from '../src/world/createWorld';
import { ModelDrivenAgent, type DecisionProvider } from '../src/agent/ModelDrivenAgent';
import { MODEL_REGISTRY, registryLookup, readCredential } from '../src/agent/nvidia/ModelRegistry';
import { NimDecisionProvider } from '../src/agent/nvidia/NimDecisionProvider';
import { TrueForgeRuntime, trueforgeModelFqn } from '../src/agent/trueforge/TrueForgeRuntime';
import { TrueForgeDecisionProvider } from '../src/agent/trueforge/TrueForgeDecisionProvider';
import {
  PROVIDER_MODELS,
  selectProvider as selectInference,
  createProvider,
  readProviderKey,
  type ProviderName,
} from '../src/agent/providers/ProviderRegistry';
import { ProviderDecisionAdapter } from '../src/agent/providers/ProviderDecisionAdapter';
import { parseCommand } from '../src/game/goals';
import { interpretCommand } from '../src/game/interpret';

const PORT = Number(process.env['ASTRIX_AGENT_PORT'] ?? 5193);
const TRUEFORGE_URL = process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790';
const DEFAULT_PRIMARY = process.env['ASTRIX_PRIMARY_MODEL'] ?? 'nvidia/nemotron-3-super-120b-a12b';

type RuntimeKind = 'trueforge' | 'direct-nim' | 'local-only';

async function selectProvider(modelId: string): Promise<{ provider: DecisionProvider; runtime: RuntimeKind; note: string }> {
  const entry = registryLookup(modelId);
  if (!entry) throw new Error(`Model ${modelId} is not in the registry.`);
  if (!readCredential(entry.keySlot)) {
    throw new Error(`No credential configured for slot ${entry.keySlot}; cannot serve model ${modelId}.`);
  }
  const runtime = new TrueForgeRuntime(TRUEFORGE_URL);
  const probe = await runtime.probe();
  if (probe.reachable) {
    try {
      await runtime.ensureNimProviders({ A: readCredential('A'), B: readCredential('B') });
      await runtime.ensureStewardAgent(trueforgeModelFqn(modelId));
      return { provider: new TrueForgeDecisionProvider(runtime, modelId), runtime: 'trueforge', note: 'TrueForge session turn' };
    } catch (error) {
      return {
        provider: new NimDecisionProvider(modelId),
        runtime: 'direct-nim',
        note: `TrueForge setup failed (${error instanceof Error ? error.message : String(error)}); direct NIM fallback`,
      };
    }
  }
  return {
    provider: new NimDecisionProvider(modelId),
    runtime: 'direct-nim',
    note: `TrueForge unreachable (${probe.detail}); direct NIM fallback`,
  };
}

function goals(name: string): (state: { wood: number; food: number }) => boolean {
  if (name === 'wood-food-1') return (s) => s.wood >= 1 && s.food >= 1;
  if (name === 'wood-1') return (s) => s.wood >= 1;
  return () => false;
}

const server = http.createServer((req, res) => {
  const respond = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }
  void (async () => {
    if (req.method === 'GET' && req.url === '/api/health') {
      const probe = await new TrueForgeRuntime(TRUEFORGE_URL).probe();
      const inference = selectInference();
      respond(200, {
        ok: true,
        primaryModel: DEFAULT_PRIMARY,
        trueforge: probe,
        inference: {
          provider: inference.provider,
          model: inference.model,
          fallback: inference.fallback,
          credentialConfigured: readProviderKey(inference.provider) !== null,
        },
        providers: PROVIDER_MODELS.map((m) => ({ provider: m.provider, id: m.id, credentialConfigured: readProviderKey(m.provider) !== null })),
        models: MODEL_REGISTRY.map((m) => ({ id: m.id, keySlot: m.keySlot, credentialConfigured: readCredential(m.keySlot) !== null })),
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/farm/state') {
      // Keyless delegated-state read: permissionless RPC, no wallet, no
      // spending. Reports delegation + decoded account, or an honest error
      // the game renders as STALE (never a substituted local value).
      try {
        const { Connection, PublicKey } = await import('@solana/web3.js');
        const { decodeFarmState, deriveFarmAddress } = await import('../src/magicblock/FarmChain');
        const programId = new PublicKey(process.env['ASTRIX_FARM_PROGRAM_ID'] ?? 'Gd5DXjcDxr1jJFS2LBzoLkZvYsHZWhVwbYdQ7eZEKSdP');
        const [farmAddress] = deriveFarmAddress(programId);
        const base = new Connection('https://api.devnet.solana.com', 'confirmed');
        const er = new Connection('https://devnet-eu.magicblock.app', 'confirmed');
        const { ConnectionMagicRouter } = await import('@magicblock-labs/ephemeral-rollups-sdk');
        const router = new ConnectionMagicRouter('https://devnet-router.magicblock.app', { commitment: 'confirmed' });
        const delegated = await router.getDelegationStatus(farmAddress).then((s) => s.isDelegated).catch(() => null);
        if (delegated === null) {
          respond(502, { ok: false, error: 'delegation-status-unknown' });
          return;
        }
        const source = delegated ? er : base;
        const account = await source.getAccountInfo(farmAddress, 'confirmed');
        if (!account) {
          respond(200, { ok: true, delegated, exists: false, farm: null, slot: null });
          return;
        }
        const farm = decodeFarmState(account.data, delegated ? 'er-read' : 'base-read');
        const slot = await source.getSlot('confirmed').catch(() => null);
        respond(200, { ok: true, delegated, exists: true, farm, slot, farmAddress: farmAddress.toBase58(), programId: programId.toBase58() });
      } catch (error) {
        respond(502, { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/api/interpret') {
      // Natural-language command → validated goal JSON. Deterministic parse
      // first (free, offline); model interpretation only when requested and
      // only through server-side keys. Never echoes keys.
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { text, useModel } = (raw ? JSON.parse(raw) : {}) as { text?: string; useModel?: boolean };
      if (!text || text.trim().length === 0) {
        respond(400, { ok: false, error: 'Empty command.' });
        return;
      }
      const parsed = parseCommand(text);
      if (parsed.ok || !useModel) {
        respond(200, { ok: true, source: parsed.ok ? 'deterministic-parser' : 'deterministic-clarify', parsed });
        return;
      }
      const inference = selectInference();
      const key = readProviderKey(inference.provider);
      if (!key) {
        respond(503, { ok: false, error: `Inference unavailable: no credential for ${inference.provider}.`, parsed });
        return;
      }
      try {
        const interpretation = await interpretCommand(createProvider(inference.provider), key, inference.model, text, 'a small settlement sim');
        respond(200, { ok: true, source: 'model-interpretation', parsed, interpretation });
      } catch (error) {
        respond(502, { ok: false, error: error instanceof Error ? error.message : String(error), parsed });
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/api/decide') {
      // Single model decision for a browser-supplied observation. Keys stay
      // server-side; the response carries provider/model/latency labels.
      // Optional explicit fallback engages ONLY if configured, each step recorded.
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { observation, plan, outcomes, timeoutMs } = (raw ? JSON.parse(raw) : {}) as {
        observation?: import('../src/agent/Agent').AgentObservation; plan?: string | null; outcomes?: string[]; timeoutMs?: number;
      };
      if (!observation) {
        respond(400, { ok: false, error: 'Missing observation.' });
        return;
      }
      const inference = selectInference();
      const attempts: Array<{ provider: ProviderName; model: string }> = [
        { provider: inference.provider, model: inference.model },
        ...inference.fallback.map((provider) => ({
          provider,
          model: (process.env[`ASTRIX_AI_MODEL_${provider.toUpperCase()}`] ?? '') || undefined as unknown as string,
        })).filter((a) => a.model),
      ];
      const failures: Array<{ provider: string; model: string; error: string }> = [];
      for (const attempt of attempts) {
        const key = readProviderKey(attempt.provider);
        if (!key) {
          failures.push({ provider: attempt.provider, model: attempt.model, error: 'no credential configured' });
          continue;
        }
        try {
          const adapter = new ProviderDecisionAdapter(createProvider(attempt.provider), attempt.model, key, {
            timeoutMs: Math.min(Math.max(timeoutMs ?? 90_000, 3000), 120_000),
          });
          const decision = await adapter.requestDecision(observation, plan ?? null, outcomes ?? []);
          respond(200, {
            ok: true,
            provider: attempt.provider,
            model: decision.model,
            providerId: adapter.providerId,
            latencyMs: decision.latencyMs,
            usage: decision.usage,
            rawText: decision.rawText,
            failures,
          });
          return;
        } catch (error) {
          failures.push({ provider: attempt.provider, model: attempt.model, error: error instanceof Error ? error.message : String(error) });
        }
      }
      // Every attempt failed (or no credential existed): report each failure.
      respond(502, { ok: false, error: 'All configured providers failed.', failures });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/agent/run') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { model, maxTurns, goal } = (raw ? JSON.parse(raw) : {}) as { model?: string; maxTurns?: number; goal?: string };
      const modelId = model ?? DEFAULT_PRIMARY;
      try {
        const { provider, runtime, note } = await selectProvider(modelId);
        // The model agent IS the simulation's agent: the sim's internal
        // loop consumes no other policy, so model proposals are never
        // fought over by the scripted baseline.
        const agent = new ModelDrivenAgent(provider, { maxTurns: Math.min(maxTurns ?? 12, 24) });
        const sim = new WorldSimulation(createWorld(), agent);
        const turns = await agent.run(sim, goals(goal ?? 'wood-food-1'));
        if (provider instanceof TrueForgeDecisionProvider) provider.stop();
        respond(200, {
          runtime, model: modelId, note,
          totals: { wood: sim.state.wood, food: sim.state.food, tick: sim.state.tick },
          goalMet: goals(goal ?? 'wood-food-1')(sim.state),
          turns: turns.map((t) => ({
            turn: t.turn, provider: t.providerId, model: t.model,
            latencyMs: t.latencyMs, usage: t.usage,
            intent: t.intent, expectation: t.expectation, result: t.result,
          })),
        });
      } catch (error) {
        respond(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    respond(404, { ok: false, error: 'Not found' });
  })().catch((error: unknown) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  });
});

server.listen(PORT, () => {
  console.log(`ASTrix agent backend on :${PORT} (primary ${DEFAULT_PRIMARY})`);
});
