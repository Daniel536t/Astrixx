/**
 * Phase 5.2 model-backed replay: recorded turns re-drive the real decision
 * pipeline (parse → validate → govern → execute → verify) with zero model
 * calls and zero network requests.
 */
import { describe, expect, it } from 'vitest';
import { WorldSimulation } from '../simulation/WorldSimulation';
import { createWorld } from '../world/createWorld';
import { LocalGathererAgent } from './LocalGathererAgent';
import type { AgentObservation } from './Agent';
import { ModelDrivenAgent, type DecisionProvider, type ProviderRawDecision } from './ModelDrivenAgent';
import { MockProvider, decisionJson } from './MockProvider';
import {
  recordedTurnsFromLog,
  ReplayBindingError,
  ReplayDecisionProvider,
} from './ReplayDecisionProvider';
import { stateHash } from '../simulation/replay';

/** Scripted provider that can also throw recorded-style failures (timeouts). */
class ScriptedProvider implements DecisionProvider {
  readonly providerId = 'test:scripted';
  private cursor = 0;
  constructor(private readonly scripts: Array<{ text: string } | { throw: string }>) {}
  async requestDecision(_observation?: AgentObservation, _plan?: string | null, _recentOutcomes?: string[]): Promise<ProviderRawDecision> {
    const script = this.cursor < this.scripts.length
      ? this.scripts[this.cursor++]!
      : { text: '{"action": null, "intent": "hold", "expectation": "none"}' };
    if ('throw' in script) throw new Error(script.throw);
    return { rawText: script.text, model: 'mock-model', latencyMs: 1, usage: null };
  }
}

const NULL_ACTION = '{"action": null, "intent": "rest", "expectation": "none"}';

async function liveRun(): Promise<{ sim: WorldSimulation; agent: ModelDrivenAgent; kinds: string[] }> {
  const sim = new WorldSimulation(createWorld());
  const agent = new ModelDrivenAgent(new ScriptedProvider([
    { text: decisionJson('GATHER', 'tree-04') },
    { text: 'this is not json {{{' },
    { throw: 'simulated timeout after 10000ms' },
    { text: NULL_ACTION },
  ]));
  sim.setAgent(agent);
  const kinds: string[] = [];
  for (let turn = 0; turn < 4; turn += 1) {
    const record = await agent.runModelTurn(sim);
    kinds.push(record.result.kind);
  }
  return { sim, agent, kinds };
}

function genesisObservation() {
  const sim = new WorldSimulation(createWorld());
  return new LocalGathererAgent().observe(sim.state);
}

describe('model-backed replay', () => {
  it('records bound turns across success, invalid, timeout, and no-op paths', async () => {
    const { sim, kinds } = await liveRun();
    expect(kinds).toEqual(['verified', 'rejected', 'rejected', 'no-op']);

    const tree = sim.state.entities['tree-04'];
    expect(tree).toMatchObject({ kind: 'tree', state: 'depleted' });

    const decisions = sim.inputLog.filter((entry) => entry.kind === 'modelDecision');
    expect(decisions).toHaveLength(4);
    expect(decisions.map((entry) => entry.payload['outcome'])).toEqual([
      'decision', 'not-json', 'provider-error', 'no-op',
    ]);
    for (const entry of decisions) {
      expect(entry.payload['turn']).toBeTypeOf('number');
      expect(entry.payload['observationDigest']).toMatch(/^[0-9a-f]{16}$/);
      expect(entry.payload['model']).toBeTypeOf('string');
    }
    // Ticks are non-decreasing; ordering is preserved for replay.
    const ticks = decisions.map((entry) => entry.tick);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
  });

  it('replays recorded turns through the real pipeline with no model calls', async () => {
    const live = await liveRun();
    const log = live.sim.exportLog();
    const liveHash = stateHash(live.sim.state);
    const turns = recordedTurnsFromLog(log);
    expect(turns.map((t) => t.turn)).toEqual([1, 2, 3, 4]);
    expect(turns[2]).toMatchObject({ throws: 'simulated timeout after 10000ms' });

    const sim = new WorldSimulation(createWorld());
    const provider = new ReplayDecisionProvider(turns);
    const agent = new ModelDrivenAgent(provider);
    sim.setAgent(agent);
    const kinds: string[] = [];
    for (let turn = 0; turn < 4; turn += 1) {
      const record = await agent.runModelTurn(sim);
      kinds.push(record.result.kind);
    }
    // Same pipeline outcomes, same final world — without any model call.
    expect(kinds).toEqual(['verified', 'rejected', 'rejected', 'no-op']);
    expect(stateHash(sim.state)).toBe(liveHash);
    expect(provider.served).toEqual([1, 2, 3, 4]);
    expect(provider.providerId).toBe('replay:recorded');

    // Input-log folding refuses model-backed drivers explicitly instead of
    // diverging silently; driver replay above is the supported path.
    const { replayLog: foldLog } = await import('../simulation/replay');
    expect(() => foldLog(log)).toThrow(/canned-decision/);
    // ...while modelDecision entries themselves fold cleanly when the
    // driver is deterministic (evidence, never effects).
    const manualLog = { ...log, inputs: log.inputs.filter((e) => e.kind === 'modelDecision') };
    const folded = foldLog({ ...manualLog, genesisAgent: 'ManualAgent' });
    expect(folded.sim.state.tick).toBe(log.finalTick);
  });

  it('covers the MockProvider happy path through replay as well', async () => {
    const sim = new WorldSimulation(createWorld());
    const agent = new ModelDrivenAgent(new MockProvider([decisionJson('GATHER', 'tree-04')]));
    sim.setAgent(agent);
    const first = await agent.runModelTurn(sim);
    expect(first.result.kind).toBe('verified');

    const turns = recordedTurnsFromLog(sim.exportLog());
    expect(turns).toHaveLength(1);
    const sim2 = new WorldSimulation(createWorld());
    const agent2 = new ModelDrivenAgent(new ReplayDecisionProvider(turns));
    sim2.setAgent(agent2);
    const second = await agent2.runModelTurn(sim2);
    expect(second.result.kind).toBe('verified');
    expect(stateHash(sim2.state)).toBe(stateHash(sim.state));
  });

  it('refuses drift, exhaustion, and model mismatch instead of fabricating', async () => {
    const live = await liveRun();
    const turns = recordedTurnsFromLog(live.sim.exportLog());
    const freshObs = genesisObservation();

    // Context drift: a different world's observation must not be served.
    const other = new WorldSimulation(createWorld());
    other.advanceUntil(() => false, 50);
    const driftedObs = new LocalGathererAgent().observe(other.state);
    const drifting = new ReplayDecisionProvider(turns);
    await expect(drifting.requestDecision(driftedObs, null, [])).rejects.toThrow(ReplayBindingError);

    // Exhaustion: a second request with only one recorded turn.
    const short = new ReplayDecisionProvider(turns.slice(0, 1));
    await short.requestDecision(freshObs, null, []);
    await expect(short.requestDecision(freshObs, null, [])).rejects.toThrow(/exhausted/);

    // Model drift: recorded mock-model vs demanded other-model.
    const strict = new ReplayDecisionProvider(turns, 'other-model');
    await expect(strict.requestDecision(freshObs, null, [])).rejects.toThrow(/model drift/);
  });

  it('rejects turn records that lack binding fields', () => {
    expect(() => recordedTurnsFromLog({
      version: 1,
      genesis: createWorld(),
      genesisAgent: 'ManualAgent',
      genesisPolicy: 'LOW',
      finalTick: 0,
      inputs: [{ seq: 0, tick: 0, kind: 'modelDecision', payload: { decision: {} } }],
    })).toThrow(ReplayBindingError);
  });
});
