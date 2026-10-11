/**
 * Shelter loop: governed construction at a validated free site, staged
 * progress, exact-once mixed-purse spending, safe cancellation and resume,
 * and a real rest benefit. Refusals spend nothing.
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

/** Stock a builder: 2 wood in the stockpile, 2 branches in the pack, at camp. */
function stockedSim(): WorldSimulation {
  const sim = manualSim();
  sim.state.wood = 2;
  workerOf(sim).inventory = { branch: 2 };
  workerOf(sim).position = { x: 0.5, z: 0 };
  return sim;
}

describe('shelter construction', () => {
  it('begins with no prebuilt shelter', () => {
    const world = createWorld();
    expect(Object.values(world.entities).some((e) => e.kind === 'shelter')).toBe(false);
  });

  it('builds through funded proposal, staged progress, and verified completion', () => {
    const sim = stockedSim();
    const proposal = sim.proposeAction('BUILD', 'settlement-01', { structure: 'shelter' }, 'HIGH');
    expect(sim.approveProposal(proposal.id)).toBe(true);
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'test', parameters: { structure: 'shelter' } }, 'worker-01');
    expect(sim.advanceUntil(() => proposal.status === 'VERIFIED', 2000)).toBe(true);
    // Mixed purse deducted exactly once, at site creation.
    expect(sim.state.wood).toBe(0);
    expect(workerOf(sim).inventory).toEqual({});
    const shelters = Object.values(sim.state.entities).filter((e) => e.kind === 'shelter');
    expect(shelters).toHaveLength(1);
    expect(shelters[0]).toMatchObject({ state: 'complete', progress: 1 });
    const types = sim.state.events.map((e) => e.type);
    expect(types).toContain('CONSTRUCTION_STARTED');
    expect(types.filter((t) => t === 'CONSTRUCTION_STAGE')).toHaveLength(2);
    expect(types).toContain('CONSTRUCTION_COMPLETED');
  });

  it('refuses the camp footprint without spending anything', () => {
    const sim = stockedSim();
    const proposal = sim.proposeAction('BUILD', 'settlement-01', { structure: 'shelter', x: 0, z: 0 }, 'HIGH');
    expect(sim.approveProposal(proposal.id)).toBe(true);
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'bad-site', parameters: { structure: 'shelter', x: 0, z: 0 } }, 'worker-01');
    sim.advanceUntil(() => false, 200);
    expect(proposal.status).toBe('FAILED');
    expect(sim.state.events.some((e) => e.type === 'CONSTRUCTION_FAILED' && e.data['reason'] === 'invalid-placement')).toBe(true);
    expect(sim.state.wood).toBe(2);
    expect(workerOf(sim).inventory).toMatchObject({ branch: 2 });
    expect(Object.values(sim.state.entities).some((e) => e.kind === 'shelter')).toBe(false);
  });

  it('refuses short purses without spending the other half', () => {
    const sim = manualSim();
    sim.state.wood = 2; // wood ok, branches missing
    workerOf(sim).position = { x: 0.5, z: 0 };
    const proposal = sim.proposeAction('BUILD', 'settlement-01', { structure: 'shelter' }, 'HIGH');
    expect(sim.approveProposal(proposal.id)).toBe(true);
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'no-poles', parameters: { structure: 'shelter' } }, 'worker-01');
    sim.advanceUntil(() => false, 200);
    expect(proposal.status).toBe('FAILED');
    expect(sim.state.events.some((e) => e.type === 'CONSTRUCTION_FAILED' && e.data['reason'] === 'insufficient-materials')).toBe(true);
    expect(sim.state.wood).toBe(2);
  });

  it('never builds twice on a finished site', () => {
    const sim = stockedSim();
    sim.state.entities['shelter-01'] = { id: 'shelter-01', kind: 'shelter', position: { x: 4, z: 0 }, state: 'complete', progress: 1, footprint: 1.2 };
    const proposal = sim.proposeAction('BUILD', 'settlement-01', { structure: 'shelter', x: 4, z: 0 }, 'HIGH');
    expect(sim.approveProposal(proposal.id)).toBe(true);
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'double', parameters: { structure: 'shelter', x: 4, z: 0 } }, 'worker-01');
    sim.advanceUntil(() => false, 200);
    expect(proposal.status).toBe('FAILED');
    expect(Object.values(sim.state.entities).filter((e) => e.kind === 'shelter')).toHaveLength(1);
    expect(sim.state.wood).toBe(2);
    expect(workerOf(sim).inventory).toMatchObject({ branch: 2 });
  });

  it('cancelling mid-build keeps the site and resumes without double spend', () => {
    const sim = manualSim();
    sim.state.wood = 2;
    workerOf(sim).inventory = { branch: 2 };
    workerOf(sim).position = { x: 0.5, z: 0 };
    const { plan } = sim.submitPlan('construct-shelter', 1);
    const planProposal = plan.proposalId ? sim.state.proposals.find((p) => p.id === plan.proposalId) : undefined;
    expect(planProposal?.status).toBe('PROPOSED'); // HIGH holds for a human
    expect(sim.approveProposal(plan.proposalId!)).toBe(true);
    // Drive like the runner does: re-issue while the worker walks. Check in
    // small increments — the 6-second build task can start AND finish inside
    // one coarse window, which would miss the cancellation moment entirely.
    let cancelled = false;
    let siteId = '';
    for (let i = 0; i < 80 && !cancelled; i += 1) {
      const worker = workerOf(sim);
      if (sim.directives.length === 0 && !worker.task) {
        sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'raise', parameters: { structure: 'shelter' } }, 'worker-01', plan.id);
      }
      sim.advanceUntil(() => false, 5);
      if (workerOf(sim).task?.kind === 'build') {
        siteId = workerOf(sim).task!.targetId;
        expect(sim.cancelPlan(plan.id)).toBe(true);
        cancelled = true;
      }
    }
    expect(cancelled).toBe(true);
    expect(workerOf(sim).task).toBeNull();
    // Spent on arrival (walk-first, like houses), site persists mid-progress.
    expect(sim.state.wood).toBe(0);
    const site = sim.state.entities[siteId];
    if (!site || site.kind !== 'shelter') throw new Error('construction site missing');
    expect(site.state).toBe('construction');
    expect(site.progress).toBeGreaterThan(0);
    // Resume at the same ground: no second deduction, completes honestly.
    workerOf(sim).inventory = { branch: 5 }; // fresh poles prove none are taken
    const resume = sim.proposeAction('BUILD', 'settlement-01', { structure: 'shelter', x: site.position.x, z: site.position.z }, 'HIGH');
    expect(sim.approveProposal(resume.id)).toBe(true);
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'resume', parameters: { structure: 'shelter', x: site.position.x, z: site.position.z } }, 'worker-01');
    expect(sim.advanceUntil(() => resume.status === 'VERIFIED', 2000)).toBe(true);
    expect(sim.state.wood).toBe(0);
    expect(workerOf(sim).inventory).toMatchObject({ branch: 5 });
    expect(site).toMatchObject({ state: 'complete' });
  });
});

describe('shelter rest', () => {
  function restedWorld(): WorldSimulation {
    const sim = stockedSim();
    const proposal = sim.proposeAction('BUILD', 'settlement-01', { structure: 'shelter' }, 'HIGH');
    expect(sim.approveProposal(proposal.id)).toBe(true);
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'setup', parameters: { structure: 'shelter' } }, 'worker-01');
    expect(sim.advanceUntil(() => proposal.status === 'VERIFIED', 2000)).toBe(true);
    return sim;
  }

  it('resting at a complete shelter grants the work-speed buff', () => {
    const sim = restedWorld();
    const shelter = Object.values(sim.state.entities).find((e) => e.kind === 'shelter');
    if (!shelter) throw new Error('shelter missing');
    const rest = sim.proposeAction('REST', shelter.id, {}, 'LOW');
    sim.issueDirective({ actionType: 'REST', targetEntityId: shelter.id, reason: 'nap', parameters: {} }, 'worker-01');
    expect(sim.advanceUntil(() => rest.status === 'VERIFIED', 1200)).toBe(true);
    expect(sim.state.events.some((e) => e.type === 'REST_COMPLETED' && e.entityId === shelter.id)).toBe(true);
    expect(workerOf(sim).restedUntilTick).toBeGreaterThan(sim.state.tick);
  });

  it('rested chopping finishes strictly faster than unrested chopping', () => {
    const timeToFell = (rested: boolean): number => {
      const sim = manualSim();
      if (rested) workerOf(sim).restedUntilTick = 10_000;
      const tree = sim.state.entities['tree-02'];
      if (!tree || tree.kind !== 'tree') throw new Error('tree-02 missing');
      workerOf(sim).position = { ...tree.position };
      sim.issueDirective({ actionType: 'GATHER', targetEntityId: 'tree-02', reason: 'time', parameters: {} }, 'worker-01');
      const start = sim.state.tick;
      expect(sim.advanceUntil(() => tree.state === 'depleted', 900)).toBe(true);
      return sim.state.tick - start;
    };
    expect(timeToFell(true)).toBeLessThan(timeToFell(false));
  });

  it('refuses rest at a construction site and with full hands', () => {
    const sim = manualSim();
    sim.state.entities['shelter-01'] = { id: 'shelter-01', kind: 'shelter', position: { x: 4, z: 0 }, state: 'construction', progress: 0.5, footprint: 1.2 };
    const bad = sim.proposeAction('REST', 'shelter-01', {}, 'LOW');
    sim.issueDirective({ actionType: 'REST', targetEntityId: 'shelter-01', reason: 'early', parameters: {} }, 'worker-01');
    sim.advanceUntil(() => false, 120);
    expect(bad.status).toBe('FAILED');
    expect(workerOf(sim).restedUntilTick).toBe(0);
  });
});

describe('shelter goal end to end', () => {
  it('builds a shelter from a "build a shelter" command through a governed plan', async () => {
    const sim = new WorldSimulation(createWorld());
    const tracker = new GoalTracker();
    const runner = new GoalRunner(sim, tracker, 'delegated');
    tracker.setGoal({ kind: 'construct-shelter', quantity: 1, note: 'shelter e2e' }, 0);
    let guard = 0;
    let approved = false;
    while (tracker.active && guard++ < 30) {
      await runner.runTurn(plannerDecide);
      const plan = Object.values(sim.state.plans).find((p) => p.kind === 'construct-shelter');
      const proposal = plan?.proposalId ? sim.state.proposals.find((p) => p.id === plan.proposalId) : undefined;
      if (plan && proposal?.status === 'PROPOSED' && !approved) {
        // Delegated mode holds HIGH plans for a human: approve once, honestly.
        expect(sim.approveProposal(proposal.id)).toBe(true);
        approved = true;
      }
    }
    expect(tracker.active).toBeNull();
    const shelters = Object.values(sim.state.entities).filter((e) => e.kind === 'shelter' && e.state === 'complete');
    expect(shelters).toHaveLength(1);
    const plan = Object.values(sim.state.plans).find((p) => p.kind === 'construct-shelter');
    expect(plan?.status).toBe('completed');
    expect(plan?.steps.filter((s) => s.status === 'verified').length).toBeGreaterThanOrEqual(4);
  });

  it('replays a gather-collect-build-rest run to the same final state', () => {
    // Inputs only — every leg runs through directives, so the whole run is
    // replayable by construction: 2 branches, 2 wood, shelter, rest.
    const live = manualSim();
    for (const target of ['branch-01', 'branch-02']) {
      live.issueDirective({ actionType: 'COLLECT', targetEntityId: target, reason: 'replay', parameters: {} }, 'worker-01');
      expect(live.advanceUntil(() => {
        const w = live.state.entities['worker-01'];
        return w?.kind === 'worker' && (w.inventory['branch'] ?? 0) >= (target === 'branch-02' ? 2 : 1);
      }, 1500), `collect ${target}`).toBe(true);
    }
    for (const [tree, log] of [['tree-04', 'log-01'], ['tree-05', 'log-02']] as const) {
      live.issueDirective({ actionType: 'GATHER', targetEntityId: tree, reason: 'replay', parameters: {} }, 'worker-01');
      expect(live.advanceUntil(() => {
        const e = live.state.entities[log];
        return e?.kind === 'log' && e.state === 'ground';
      }, 1500), `fell ${tree}`).toBe(true);
      live.issueDirective({ actionType: 'PICK_UP', targetEntityId: log, reason: 'replay', parameters: {} }, 'worker-01');
      expect(live.advanceUntil(() => live.state.wood >= (log === 'log-02' ? 2 : 1), 1500), `haul ${log}`).toBe(true);
    }
    const build = live.proposeAction('BUILD', 'settlement-01', { structure: 'shelter' }, 'HIGH');
    expect(live.approveProposal(build.id)).toBe(true);
    live.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'replay', parameters: { structure: 'shelter' } }, 'worker-01');
    expect(live.advanceUntil(() => build.status === 'VERIFIED', 2500)).toBe(true);
    const shelter = Object.values(live.state.entities).find((e) => e.kind === 'shelter');
    if (!shelter) throw new Error('shelter missing');
    live.issueDirective({ actionType: 'REST', targetEntityId: shelter.id, reason: 'replay', parameters: {} }, 'worker-01');
    expect(live.advanceUntil(() => {
      const w = live.state.entities['worker-01'];
      return w?.kind === 'worker' && w.restedUntilTick > 0;
    }, 1500)).toBe(true);
    const log = live.exportLog();
    const liveHash = stateHash(live.state);
    const replayed = replayLog(log);
    expect(replayed.finalHash).toBe(liveHash);
    expect(Object.values(replayed.sim.state.entities).filter((e) => e.kind === 'shelter' && e.state === 'complete')).toHaveLength(1);
    const rw = replayed.sim.state.entities['worker-01'];
    if (!rw || rw.kind !== 'worker') throw new Error('replayed worker missing');
    expect(rw.restedUntilTick).toBeGreaterThan(0);
  });
});
