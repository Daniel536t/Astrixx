#!/usr/bin/env tsx
/**
 * Repeatable NVIDIA NIM evaluation for ASTrix model selection.
 *
 * Usage:
 *   NVIDIA_NIM_API_KEY_A=... NVIDIA_NIM_API_KEY_B=... npm run eval:models -- [--models=id1,id2] [--out=path]
 *
 * Four cheap scenarios per model (one completion each): basic validity,
 * shortage response, depleted-world restraint, and failure recovery. Records
 * validity, legality, latency, and token usage. Prints NO reasoning traces
 * and NO credentials. A failed request is recorded as a provider failure,
 * never as a capability verdict on its own.
 */
import fs from 'node:fs';
import { WorldSimulation } from '../src/simulation/WorldSimulation';
import { MODEL_REGISTRY, readCredential } from '../src/agent/nvidia/ModelRegistry';
import { NimDecisionProvider } from '../src/agent/nvidia/NimDecisionProvider';
import { parseStructuredDecision, validateDecisionAgainstWorld } from '../src/agent/nvidia/DecisionSchema';

interface ScenarioResult {
  scenario: string;
  ok: boolean;
  valid: boolean;
  legal: boolean;
  actionType: string | null;
  target: string | null;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  finishCapped: boolean;
  note: string;
}

function setup(name: string): WorldSimulation {
  const sim = new WorldSimulation();
  if (name === 'shortage') {
    sim.state.wood = 1;
  } else if (name === 'depleted') {
    for (const entity of Object.values(sim.state.entities)) {
      if (entity.kind === 'tree') { entity.health = 0; entity.state = 'depleted'; }
    }
  } else if (name === 'recovery') {
    const tree = sim.state.entities['tree-04'];
    if (tree?.kind === 'tree') { tree.health = 0; tree.state = 'depleted'; }
  }
  return sim;
}

const OUTCOMES: Record<string, string[]> = {
  basic: [],
  shortage: [],
  depleted: [],
  recovery: ['t1 [eval]: Fell tree-04 for timber → failed (proposal FAILED: target depleted)'],
};

async function runScenario(modelId: string, name: string): Promise<ScenarioResult> {
  const started = Date.now();
  const base = { scenario: name, ok: false, valid: false, legal: false, actionType: null as string | null, target: null as string | null, latencyMs: 0, promptTokens: null as number | null, completionTokens: null as number | null, finishCapped: false, note: '' };
  try {
    const provider = new NimDecisionProvider(modelId);
    const sim = setup(name);
    const agent = new (await import('../src/agent/ModelDrivenAgent')).ModelDrivenAgent(provider, { maxTurns: 1 });
    // Evaluate the decision WITHOUT executing: observe, request, parse, validate.
    const observation = agent.observe(sim.state);
    const raw = await provider.requestDecision(observation, 'Secure 1 wood, then 1 food.', OUTCOMES[name] ?? []);
    const parsed = parseStructuredDecision(raw.rawText);
    base.latencyMs = raw.latencyMs;
    base.promptTokens = raw.usage?.promptTokens ?? null;
    base.completionTokens = raw.usage?.completionTokens ?? null;
    if (!parsed) { base.note = 'unparseable reply'; return base; }
    base.valid = true;
    if (parsed.action === null) { base.ok = true; base.note = 'explicit no-op'; return base; }
    base.actionType = parsed.action.actionType;
    base.target = parsed.action.targetEntityId;
    const verdict = validateDecisionAgainstWorld(parsed, sim.state);
    base.legal = verdict.ok;
    base.note = verdict.ok ? `legal ${parsed.action.actionType} ${parsed.action.targetEntityId}` : `${verdict.reason}: ${verdict.detail}`;
    if (name === 'shortage' && verdict.ok) {
      base.ok = parsed.action.actionType === 'HARVEST' && parsed.action.targetEntityId === 'berry-patch-01';
      if (!base.ok) base.note += ' (expected HARVEST berry-patch-01 while food=0)';
    } else if (name === 'depleted' && parsed.action.actionType === 'GATHER') {
      base.ok = false;
      base.note += ' (proposed gathering in a fully depleted forest)';
    } else if (name === 'recovery') {
      base.ok = verdict.ok && parsed.action.targetEntityId !== 'tree-04';
      if (parsed.action.targetEntityId === 'tree-04') base.note += ' (repeated the failed target)';
    } else {
      base.ok = verdict.ok;
    }
    return base;
  } catch (error) {
    base.latencyMs = Date.now() - started;
    base.note = `provider failure: ${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}`;
    return base;
  }
}

const args = process.argv.slice(2);
const onlyFilter = args.find((a) => a.startsWith('--models='))?.slice('--models='.length).split(',').filter(Boolean);
const outPath = args.find((a) => a.startsWith('--out='))?.slice('--out='.length)
  ?? `artifacts/nim-eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

const models = MODEL_REGISTRY.filter((m) => !onlyFilter || onlyFilter.includes(m.id));
const report: Record<string, { keySlot: string; credentialConfigured: boolean; scenarios: ScenarioResult[] }> = {};

for (const model of models) {
  const configured = readCredential(model.keySlot) !== null;
  const scenarios: ScenarioResult[] = [];
  if (!configured) {
    console.log(`${model.id}: SKIP (no credential for slot ${model.keySlot})`);
    report[model.id] = { keySlot: model.keySlot, credentialConfigured: false, scenarios };
    continue;
  }
  for (const name of ['basic', 'shortage', 'depleted', 'recovery']) {
    const result = await runScenario(model.id, name);
    scenarios.push(result);
    console.log(`${model.id} [${name}]: ${result.ok ? 'OK' : 'MISS'} valid=${result.valid} legal=${result.legal} action=${result.actionType ?? '—'}@${result.target ?? '—'} ${result.latencyMs}ms tok=${result.promptTokens ?? '?'}/${result.completionTokens ?? '?'} :: ${result.note}`);
  }
  report[model.id] = { keySlot: model.keySlot, credentialConfigured: true, scenarios };
}

fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), report }, null, 2));
console.log(`Wrote ${outPath}`);
