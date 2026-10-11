/**
 * Blueprint-driven houses: the selected design controls cost, duration,
 * footprint, and identity. Legacy homesteads behave exactly as before.
 * Unknown blueprint IDs fail safely without spending.
 */
import { describe, expect, it } from 'vitest';
import { WorldSimulation } from './WorldSimulation';
import { createWorld } from '../world/createWorld';
import { ManualAgent } from '../agent/ManualAgent';
import { GoalTracker } from '../game/goals';
import { GoalRunner, plannerDecide } from '../game/runner';
import { replayLog, stateHash } from './replay';

function manualSim() {
  return new WorldSimulation(createWorld(), new ManualAgent());
}

function workerOf(sim: WorldSimulation, id = 'worker-01') {
  const worker = sim.state.entities[id];
  if (!worker || worker.kind !== 'worker') throw new Error(`${id} missing`);
  return worker;
}

function fundWood(sim: WorldSimulation, n: number): void {
  sim.state.wood = n;
  workerOf(sim).position = { x: 0.3, z: 0 };
}

describe('blueprint construction', () => {
  it('builds a timber cabin for 4 wood with a longer build', () => {
    const sim = manualSim();
    fundWood(sim, 4);
    const proposal = sim.proposeAction('BUILD', 'settlement-01', { structure: 'house', blueprint: 'timber-cabin' }, 'HIGH');
    expect(sim.approveProposal(proposal.id)).toBe(true);
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'cabin', parameters: { structure: 'house', blueprint: 'timber-cabin' } }, 'worker-01');
    expect(sim.advanceUntil(() => proposal.status === 'VERIFIED', 2500)).toBe(true);
    expect(sim.state.wood).toBe(0);
    const cabin = sim.state.entities['house-01'];
    expect(cabin).toMatchObject({ kind: 'house', state: 'complete', blueprint: 'timber-cabin' });
    const started = sim.state.events.find((e) => e.type === 'CONSTRUCTION_STARTED' && e.entityId === 'house-01');
    expect(started?.data).toMatchObject({ blueprint: 'timber-cabin', woodSpent: 4 });
  });

  it('builds a cottage for 2 wood + 2 branches and refuses when poles are short', () => {
    const sim = manualSim();
    fundWood(sim, 2);
    workerOf(sim).inventory = { branch: 1 }; // one short
    const short = sim.proposeAction('BUILD', 'settlement-01', { structure: 'house', blueprint: 'thatched-cottage' }, 'HIGH');
    expect(sim.approveProposal(short.id)).toBe(true);
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'short', parameters: { structure: 'house', blueprint: 'thatched-cottage' } }, 'worker-01');
    sim.advanceUntil(() => false, 300);
    expect(short.status).toBe('FAILED');
    expect(sim.state.events.some((e) => e.type === 'CONSTRUCTION_FAILED' && e.data['reason'] === 'insufficient-materials')).toBe(true);
    expect(sim.state.wood).toBe(2); // nothing spent
    workerOf(sim).inventory = { branch: 2 };
    const proposal = sim.proposeAction('BUILD', 'settlement-01', { structure: 'house', blueprint: 'thatched-cottage' }, 'HIGH');
    expect(sim.approveProposal(proposal.id)).toBe(true);
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'cottage', parameters: { structure: 'house', blueprint: 'thatched-cottage' } }, 'worker-01');
    expect(sim.advanceUntil(() => proposal.status === 'VERIFIED', 2500)).toBe(true);
    expect(sim.state.wood).toBe(0);
    expect(workerOf(sim).inventory).toEqual({});
    expect(sim.state.entities['house-01']).toMatchObject({ kind: 'house', blueprint: 'thatched-cottage', state: 'complete' });
  });

  it('keeps the legacy 2-wood homestead byte-for-byte compatible', () => {
    const sim = manualSim();
    fundWood(sim, 2);
    const proposal = sim.proposeAction('BUILD', 'settlement-01', { structure: 'house' }, 'HIGH');
    expect(sim.approveProposal(proposal.id)).toBe(true);
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'legacy', parameters: { structure: 'house' } }, 'worker-01');
    expect(sim.advanceUntil(() => proposal.status === 'VERIFIED', 2000)).toBe(true);
    expect(sim.state.entities['house-01']).toMatchObject({ kind: 'house', state: 'complete' });
  });

  it('fails unknown blueprint IDs safely without spending', () => {
    const sim = manualSim();
    fundWood(sim, 9);
    const proposal = sim.proposeAction('BUILD', 'settlement-01', { structure: 'house', blueprint: 'castle' }, 'HIGH');
    expect(sim.approveProposal(proposal.id)).toBe(true);
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'fantasy', parameters: { structure: 'house', blueprint: 'castle' } }, 'worker-01');
    sim.advanceUntil(() => false, 200);
    expect(proposal.status).toBe('FAILED');
    expect(sim.state.events.some((e) => e.type === 'CONSTRUCTION_FAILED' && e.data['reason'] === 'unknown-blueprint')).toBe(true);
    expect(sim.state.wood).toBe(9);
    expect(Object.values(sim.state.entities).some((e) => e.kind === 'house')).toBe(false);
  });

  it('places directed houses at distinct free sites near the request, recording any deviation', () => {
    const sim = manualSim();
    fundWood(sim, 9);
    const proposals = [];
    for (const [i, x] of [[1, -6.0], [2, -5.8]] as const) {
      const proposal = sim.proposeAction('BUILD', 'settlement-01', { structure: 'house', x, z: 0 }, 'HIGH');
      expect(sim.approveProposal(proposal.id)).toBe(true);
      sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: `directed-${i}`, parameters: { structure: 'house', x, z: 0 } }, 'worker-01');
      expect(sim.advanceUntil(() => proposal.status === 'VERIFIED', 2500), `house ${i}`).toBe(true);
      proposals.push(proposal);
    }
    // The first request was clear ground (no deviation); the second overlapped
    // the first house and records requested vs chosen.
    expect(proposals[0]!.parameters['deviation']).toBeUndefined();
    expect(proposals[1]!.parameters['deviation']).toMatchObject({ requested: { x: -5.8, z: 0 } });
    const houses = Object.values(sim.state.entities).filter((e) => e.kind === 'house');
    expect(houses).toHaveLength(2);
    const positions = houses.map((h) => h.kind === 'house' ? `${h.position.x},${h.position.z}` : '');
    expect(new Set(positions).size).toBe(2);
    // Both stay near the requested east ground — no snapping to distant plots.
    for (const h of houses) {
      if (h.kind !== 'house') throw new Error('not a house');
      expect(Math.hypot(h.position.x + 5.9, h.position.z)).toBeLessThanOrEqual(3.2);
    }
  });

  it('runs a cabin goal end to end through the planner', async () => {
    const sim = new WorldSimulation(createWorld());
    const tracker = new GoalTracker();
    const runner = new GoalRunner(sim, tracker, 'delegated');
    tracker.setGoal({ kind: 'construct-house', quantity: 1, blueprint: 'timber-cabin', note: 'cabin e2e' }, 0);
    let guard = 0;
    let approved = false;
    while (tracker.active && guard++ < 30) {
      await runner.runTurn(plannerDecide);
      const plan = Object.values(sim.state.plans).find((p) => p.kind === 'construct-house');
      const proposal = plan?.proposalId ? sim.state.proposals.find((p) => p.id === plan.proposalId) : undefined;
      if (plan && proposal?.status === 'PROPOSED' && !approved) {
        expect(sim.approveProposal(proposal.id)).toBe(true);
        approved = true;
      }
    }
    expect(tracker.active).toBeNull();
    const cabins = Object.values(sim.state.entities).filter((e) => e.kind === 'house' && e.blueprint === 'timber-cabin' && e.state === 'complete');
    expect(cabins).toHaveLength(1);
  });

  it('replays a cottage build to the same final state', () => {
    const live = manualSim();
    live.state.wood = 0;
    // Inputs only: chop two trees, haul both logs, collect two branches.
    live.issueDirective({ actionType: 'GATHER', targetEntityId: 'tree-04', reason: 'replay', parameters: {} }, 'worker-01');
    expect(live.advanceUntil(() => {
      const e = live.state.entities['log-01'];
      return e?.kind === 'log' && e.state === 'ground';
    }, 1500)).toBe(true);
    live.issueDirective({ actionType: 'PICK_UP', targetEntityId: 'log-01', reason: 'replay', parameters: {} }, 'worker-01');
    expect(live.advanceUntil(() => live.state.wood >= 1, 1500)).toBe(true);
    live.issueDirective({ actionType: 'GATHER', targetEntityId: 'tree-05', reason: 'replay', parameters: {} }, 'worker-01');
    expect(live.advanceUntil(() => {
      const e = live.state.entities['log-02'];
      return e?.kind === 'log' && e.state === 'ground';
    }, 1500)).toBe(true);
    live.issueDirective({ actionType: 'PICK_UP', targetEntityId: 'log-02', reason: 'replay', parameters: {} }, 'worker-01');
    expect(live.advanceUntil(() => live.state.wood >= 2, 1500)).toBe(true);
    for (const target of ['branch-01', 'branch-02']) {
      live.issueDirective({ actionType: 'COLLECT', targetEntityId: target, reason: 'replay', parameters: {} }, 'worker-01');
      expect(live.advanceUntil(() => {
        const w = live.state.entities['worker-01'];
        return w?.kind === 'worker' && (w.inventory['branch'] ?? 0) >= (target === 'branch-02' ? 2 : 1);
      }, 1500)).toBe(true);
    }
    const build = live.proposeAction('BUILD', 'settlement-01', { structure: 'house', blueprint: 'thatched-cottage' }, 'HIGH');
    expect(live.approveProposal(build.id)).toBe(true);
    live.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'replay', parameters: { structure: 'house', blueprint: 'thatched-cottage' } }, 'worker-01');
    expect(live.advanceUntil(() => build.status === 'VERIFIED', 2500)).toBe(true);
    const log = live.exportLog();
    const replayed = replayLog(log);
    expect(replayed.finalHash).toBe(stateHash(live.state));
    const houses = Object.values(replayed.sim.state.entities).filter((e) => e.kind === 'house');
    expect(houses).toHaveLength(1);
    expect(houses[0]).toMatchObject({ blueprint: 'thatched-cottage', state: 'complete' });
  });
});
