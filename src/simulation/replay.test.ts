import { describe, expect, it } from 'vitest';
import { WorldSimulation } from './WorldSimulation';
import { LocalGathererAgent } from '../agent/LocalGathererAgent';
import { ManualAgent } from '../agent/ManualAgent';
import { createWorld } from '../world/createWorld';
import type { InputLog } from '../world/types';
import {
  applyInput,
  canonicalize,
  diffStates,
  findDivergence,
  replayLog,
  ReplayError,
  stateHash,
} from './replay';

// Golden genesis hash: createWorld() is seeded wilderness genesis, so any
// change to initial conditions must break loudly here. Regenerate deliberately only.
const GENESIS_HASH = '0015ef3d7f334f03';

function everyNth(finalTick: number, n: number): number[] {
  const points: number[] = [0];
  for (let tick = n; tick < finalTick; tick += n) points.push(tick);
  points.push(finalTick);
  return [...new Set(points)];
}

describe('replay infrastructure', () => {
  it('hashes genesis deterministically with a stable golden value', () => {
    const first = stateHash(createWorld());
    expect(first).toBe(stateHash(createWorld()));
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(first).toBe(GENESIS_HASH);
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalize({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('replays an autonomous wood loop with no fresh decisions', () => {
    const live = new WorldSimulation(createWorld(), new LocalGathererAgent());
    expect(live.advanceUntil((state) => state.wood === 1, 1800)).toBe(true);
    const log = live.exportLog();
    // Pure autonomy: no directives, proposals, or plans were injected.
    expect(log.inputs).toHaveLength(0);
    const liveHash = stateHash(live.state);

    const first = replayLog(log, { checkpoints: everyNth(log.finalTick, 25), captureStates: true });
    const second = replayLog(log, { checkpoints: everyNth(log.finalTick, 25), captureStates: true });
    expect(first.finalHash).toBe(liveHash);
    expect(second.finalHash).toBe(liveHash);
    expect(first.checkpoints).toEqual(second.checkpoints);
    expect(first.sim.state.wood).toBe(1);
    expect(findDivergence(first, second)).toBeNull();
    expect(diffStates(first.sim.state, second.sim.state)).toEqual([]);
  });

  it('replays a governed approval/rejection scenario exactly', () => {
    const live = new WorldSimulation(createWorld(), new ManualAgent());
    live.autoApproveUpTo = 'LOW';
    // HIGH plan held, then rejected: inert, no steps.
    const held = live.submitPlan('construct-house', 1);
    expect(held.proposal.status).toBe('PROPOSED');
    expect(live.rejectProposal(held.proposal.id)).toBe(true);
    expect(held.plan.status).toBe('rejected');
    // LOW plan activates; drive one wood step through it.
    const active = live.submitPlan('gather-wood', 1);
    expect(active.plan.status).toBe('active');
    const gather = { actionType: 'GATHER' as const, targetEntityId: 'tree-04', reason: 'replay probe', parameters: {} };
    live.advanceUntil((state) => {
      const plan = state.plans[active.plan.id];
      if (plan && plan.steps.length > 0) return true;
      if (live.directives.length === 0) live.issueDirective({ ...gather }, 'worker-01', active.plan.id);
      return false;
    }, 1500);
    expect(active.plan.steps.length).toBeGreaterThan(0);
    // MEDIUM proposal held, then explicitly approved and driven to VERIFIED.
    const medium = live.proposeAction('GATHER', 'tree-05', {}, 'MEDIUM');
    expect(medium.status).toBe('PROPOSED');
    expect(live.approveProposal(medium.id)).toBe(true);
    live.advanceUntil((state) => {
      const current = state.proposals.find((p) => p.id === medium.id);
      if (current?.status === 'VERIFIED') return true;
      if (live.directives.length === 0) {
        live.issueDirective({ actionType: 'GATHER', targetEntityId: 'tree-05', reason: 'replay probe', parameters: {} }, 'worker-01');
      }
      return false;
    }, 1500);
    expect(live.state.proposals.find((p) => p.id === medium.id)?.status).toBe('VERIFIED');
    expect(live.completePlan(active.plan.id)).toBe(true);
    live.recordJournal({ turn: 1, source: 'replay-test', goal: null, candidates: [], verdict: 'replay-probe', chosen: null });
    live.clearDirectives();
    // External reconciliation inputs (local tree + lease/speculative paths).
    expect(live.reconcileTreeFromAuthority('tree-02', 1, true, 'replay-test')).toBe(true);
    live.grantLease('tree-02', 'local', 0);
    live.markLeaseStale('tree-02');
    const specId = live.recordSpeculative('tree-02', 'offline-chop', 'replay probe');
    expect(live.resolveSpeculative(specId, 'no-merge', { nonce: 0, count: 0 })).toBe(true);
    live.recordExternalEvent('INTEGRATION_MODE_SELECTED', 'world', { mode: 'replay-test' });

    const log = live.exportLog();
    expect(log.inputs.length).toBeGreaterThan(10);
    const liveHash = stateHash(live.state);
    const replayed = replayLog(log, { checkpoints: everyNth(log.finalTick, 50), captureStates: true });
    expect(replayed.finalHash).toBe(liveHash);
    expect(replayed.sim.state.proposals.find((p) => p.id === medium.id)?.status).toBe('VERIFIED');
    expect(replayed.sim.state.plans[held.plan.id]?.status).toBe('rejected');
    expect(replayed.sim.state.plans[active.plan.id]?.status).toBe('completed');
    expect(diffStates(live.state, replayed.sim.state)).toEqual([]);
  });

  it('identifies the first divergence when an input is tampered', () => {
    const live = new WorldSimulation(createWorld(), new ManualAgent());
    live.autoApproveUpTo = 'LOW';
    const medium = live.proposeAction('GATHER', 'tree-05', {}, 'MEDIUM');
    const approveTick = live.state.tick;
    expect(live.approveProposal(medium.id)).toBe(true);
    live.advanceUntil((state) => state.proposals.find((p) => p.id === medium.id)?.status === 'VERIFIED', 1500);
    const log = live.exportLog();

    // Tamper: drop the approval. Everything else identical.
    const tampered: InputLog = {
      ...log,
      inputs: log.inputs.filter((entry) => !(entry.kind === 'approve' && entry.payload['proposalId'] === medium.id)),
    };
    const points = everyNth(log.finalTick, 10);
    const honest = replayLog(log, { checkpoints: points, captureStates: true });
    const dishonest = replayLog(tampered, { checkpoints: points, captureStates: true });
    expect(honest.finalHash).not.toBe(dishonest.finalHash);
    const divergence = findDivergence(honest, dishonest);
    expect(divergence).not.toBeNull();
    // The missing approval changes proposal status at the approval tick.
    expect(divergence!.tick).toBe(approveTick);
    expect(divergence!.paths.some((path) => path.startsWith('proposals['))).toBe(true);
  });

  it('rejects malformed logs and model-backed drivers with clear errors', () => {
    const live = new WorldSimulation(createWorld(), new ManualAgent());
    live.advanceUntil(() => false, 5);
    const log = live.exportLog();
    expect(() => replayLog({ ...log, version: 2 } as unknown as InputLog)).toThrow(ReplayError);
    expect(() => replayLog({
      ...log,
      genesisAgent: 'ModelDrivenAgent',
    }, {})).toThrow(/canned-decision/);
    expect(() => applyInput(live, { seq: 0, tick: 0, kind: 'bogus' as never, payload: {} })).toThrow(ReplayError);
  });

  it('round-trips farm reconciliation and lease verification through replay', () => {
    // Note: live.state.wood is assigned directly here on purpose in other
    // tests, but direct field assignment bypasses the input log by design —
    // replay covers runs driven through public methods. This scenario uses
    // only logged entry points: chain-built presentation reconciled, then
    // lease verified at a slot (pure local computation, no network).
    const live = new WorldSimulation(createWorld(), new ManualAgent());
    expect(live.reconcileFarmLease({ state: 'built', nonce: 1, woodSpent: 3, authority: 'replay-test' }, 4242)).toBe('created');
    live.markLeaseVerified('farm-01', 4242, 1);
    live.advanceUntil(() => false, 5);
    const log = live.exportLog();
    const replayed = replayLog(log);
    expect(replayed.finalHash).toBe(stateHash(live.state));
    expect(replayed.sim.state.entities['farm-01']).toMatchObject({ kind: 'farm' });
    expect(replayed.sim.state.leases['farm-01']).toMatchObject({ holder: 'er', lastVerifiedSlot: 4242, stale: false });
    expect(diffStates(live.state, replayed.sim.state)).toEqual([]);
  });
});
