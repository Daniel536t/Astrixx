#!/usr/bin/env tsx
/**
 * Live TrueForge smoke run (requires a running server + NIM credentials).
 *
 * Registers both NIM providers, saves the steward agent, opens a session,
 * and runs ONE real decision turn against a live observation prompt.
 * Prints the parsed/validated verdict — never credentials or reasoning.
 */
import { WorldSimulation } from '../src/simulation/WorldSimulation';
import { createWorld } from '../src/world/createWorld';
import { ModelDrivenAgent } from '../src/agent/ModelDrivenAgent';
import { TrueForgeRuntime, trueforgeModelFqn } from '../src/agent/trueforge/TrueForgeRuntime';
import { TrueForgeDecisionProvider } from '../src/agent/trueforge/TrueForgeDecisionProvider';
import { readCredential } from '../src/agent/nvidia/ModelRegistry';

const baseUrl = process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790';
const modelId = process.argv[2] ?? 'poolside/laguna-xs-2.1';

const runtime = new TrueForgeRuntime(baseUrl);
console.log('probe:', await runtime.probe());
const registered = await runtime.ensureNimProviders({ A: readCredential('A'), B: readCredential('B') });
console.log('providers:', registered);
console.log('model FQN:', trueforgeModelFqn(modelId));
await runtime.ensureStewardAgent(trueforgeModelFqn(modelId));
console.log('agent: ensured');

const provider = new TrueForgeDecisionProvider(runtime, modelId);
const agent = new ModelDrivenAgent(provider, { maxTurns: 1 });
// The model agent drives the sim exclusively; no scripted policy competes.
const sim = new WorldSimulation(createWorld(), agent);
const [record] = await agent.run(sim, () => false);
console.log('turn:', JSON.stringify({
  provider: record?.providerId,
  model: record?.model,
  latencyMs: record?.latencyMs,
  usage: record?.usage,
  intent: record?.intent,
  expectation: record?.expectation,
  result: record?.result,
}, null, 2));
provider.stop();
process.exit(0);
