/**
 * Crafting slice regression tests: raw materials → pocketed inventory →
 * governed crafting → changed capability. Every consequential transition
 * goes through proposals and verification; nothing is free, nothing doubles.
 */
import { describe, expect, it } from 'vitest';
import { WorldSimulation } from './WorldSimulation';
import { createWorld } from '../world/createWorld';
import { ManualAgent } from '../agent/ManualAgent';
import { GoalTracker } from '../game/goals';
import { GoalRunner, plannerDecide } from '../game/runner';
import { parseCommand } from '../game/goals';
import { replayLog, stateHash } from './replay';

function manualSim() {
  return new WorldSimulation(createWorld(), new ManualAgent());
}

function workerOf(sim: WorldSimulation, id = 'worker-01') {
  const worker = sim.state.entities[id];
  if (!worker || worker.kind !== 'worker') throw new Error(`${id} missing`);
  return worker;
}

function teleport(sim: WorldSimulation, x: number, z: number): void {
  workerOf(sim).position = { x, z };
}

function inventoryOf(sim: WorldSimulation): Record<string, number> {
  return workerOf(sim).inventory;
}

describe('material collection', () => {
  it('pockets a branch into inventory with a verified proposal', () => {
    const sim = manualSim();
    const branch = sim.state.entities['branch-01'];
    if (!branch || branch.kind !== 'branch') throw new Error('branch-01 missing');
    teleport(sim, branch.position.x, branch.position.z);
    const proposal = sim.proposeAction('COLLECT', 'branch-01', {}, 'LOW');
    expect(proposal.status).toBe('EXECUTING');
    sim.issueDirective({ actionType: 'COLLECT', targetEntityId: 'branch-01', reason: 'test', parameters: {} }, 'worker-01');
    expect(sim.advanceUntil(() => proposal.status === 'VERIFIED', 600)).toBe(true);
    expect(branch).toMatchObject({ state: 'collected' });
    expect(inventoryOf(sim)).toMatchObject({ branch: 1 });
    expect(sim.state.events.some((e) => e.type === 'MATERIAL_COLLECTED' && e.entityId === 'branch-01')).toBe(true);
  });

  it('refuses a second collection of the same branch without duplicating', () => {
    const sim = manualSim();
    const branch = sim.state.entities['branch-01'];
    if (!branch || branch.kind !== 'branch') throw new Error('branch-01 missing');
    teleport(sim, branch.position.x, branch.position.z);
    sim.issueDirective({ actionType: 'COLLECT', targetEntityId: 'branch-01', reason: 'first', parameters: {} }, 'worker-01');
    expect(sim.advanceUntil(() => (inventoryOf(sim)['branch'] ?? 0) === 1, 600)).toBe(true);
    const retry = sim.proposeAction('COLLECT', 'branch-01', {}, 'LOW');
    sim.issueDirective({ actionType: 'COLLECT', targetEntityId: 'branch-01', reason: 'retry', parameters: {} }, 'worker-01');
    sim.advanceUntil(() => false, 60);
    expect(retry.status).toBe('FAILED');
    expect(inventoryOf(sim)).toMatchObject({ branch: 1 });
    expect(sim.state.events.filter((e) => e.type === 'MATERIAL_COLLECTED' && e.entityId === 'branch-01')).toHaveLength(1);
  });

  it('respects pack capacity: a full pack fails collection and leaves the stone', () => {
    const sim = manualSim();
    const worker = workerOf(sim);
    worker.inventory = { branch: 10 };
    const stone = sim.state.entities['stone-01'];
    if (!stone || stone.kind !== 'stone') throw new Error('stone-01 missing');
    teleport(sim, stone.position.x, stone.position.z);
    const proposal = sim.proposeAction('COLLECT', 'stone-01', {}, 'LOW');
    sim.issueDirective({ actionType: 'COLLECT', targetEntityId: 'stone-01', reason: 'overfull', parameters: {} }, 'worker-01');
    sim.advanceUntil(() => false, 120);
    expect(proposal.status).toBe('FAILED');
    expect(stone).toMatchObject({ state: 'ground' });
    expect(inventoryOf(sim)).toMatchObject({ branch: 10 });
  });
});

describe('stone axe crafting', () => {
  function stockedSim(): WorldSimulation {
    const sim = manualSim();
    workerOf(sim).inventory = { branch: 3, stone: 2 };
    teleport(sim, 0.5, 0);
    return sim;
  }

  it('consumes inputs exactly once and equips the stone axe', () => {
    const sim = stockedSim();
    const proposal = sim.proposeAction('CRAFT', 'settlement-01', { recipe: 'stone-axe' }, 'LOW');
    expect(proposal.status).toBe('EXECUTING');
    sim.issueDirective({ actionType: 'CRAFT', targetEntityId: 'settlement-01', reason: 'test', parameters: { recipe: 'stone-axe' } }, 'worker-01');
    expect(sim.advanceUntil(() => proposal.status === 'VERIFIED', 1200)).toBe(true);
    expect(inventoryOf(sim)).toEqual({});
    expect(workerOf(sim).equipment.axe).toBe('stone-axe');
    expect(sim.state.events.some((e) => e.type === 'CRAFTING_STARTED')).toBe(true);
    expect(sim.state.events.some((e) => e.type === 'CRAFTING_COMPLETED' && e.data['recipe'] === 'stone-axe')).toBe(true);
  });

  it('refuses crafting with missing ingredients and keeps the rest intact', () => {
    const sim = manualSim();
    workerOf(sim).inventory = { branch: 3, stone: 1 }; // one stone short
    teleport(sim, 0.5, 0);
    const proposal = sim.proposeAction('CRAFT', 'settlement-01', { recipe: 'stone-axe' }, 'LOW');
    sim.issueDirective({ actionType: 'CRAFT', targetEntityId: 'settlement-01', reason: 'short', parameters: { recipe: 'stone-axe' } }, 'worker-01');
    sim.advanceUntil(() => false, 120);
    expect(proposal.status).toBe('FAILED');
    expect(inventoryOf(sim)).toMatchObject({ branch: 3, stone: 1 });
    expect(workerOf(sim).equipment.axe).toBe('basic-axe');
    expect(sim.state.events.some((e) => e.type === 'CRAFTING_COMPLETED')).toBe(false);
  });

  it('refuses crafting without the prerequisite basic axe', () => {
    const sim = manualSim();
    const worker = workerOf(sim);
    worker.inventory = { branch: 3, stone: 2 };
    worker.equipment.axe = null;
    teleport(sim, 0.5, 0);
    const proposal = sim.proposeAction('CRAFT', 'settlement-01', { recipe: 'stone-axe' }, 'LOW');
    sim.issueDirective({ actionType: 'CRAFT', targetEntityId: 'settlement-01', reason: 'no-axe', parameters: { recipe: 'stone-axe' } }, 'worker-01');
    sim.advanceUntil(() => false, 120);
    expect(proposal.status).toBe('FAILED');
    expect(inventoryOf(sim)).toMatchObject({ branch: 3, stone: 2 });
  });

  it('rejects an unknown recipe without touching inventory', () => {
    const sim = stockedSim();
    const proposal = sim.proposeAction('CRAFT', 'settlement-01', { recipe: 'longbow' }, 'LOW');
    sim.issueDirective({ actionType: 'CRAFT', targetEntityId: 'settlement-01', reason: 'fantasy', parameters: { recipe: 'longbow' } }, 'worker-01');
    sim.advanceUntil(() => false, 120);
    expect(proposal.status).toBe('FAILED');
    expect(inventoryOf(sim)).toMatchObject({ branch: 3, stone: 2 });
  });

  it('cancelling mid-craft preserves every input: consume-at-completion', () => {
    const sim = manualSim();
    workerOf(sim).inventory = { branch: 3, stone: 2 };
    teleport(sim, 0.5, 0);
    const { plan } = sim.submitPlan('craft', 1);
    expect(plan.status).toBe('active');
    sim.issueDirective({ actionType: 'CRAFT', targetEntityId: 'settlement-01', reason: 'cancel-me', parameters: { recipe: 'stone-axe' } }, 'worker-01', plan.id);
    expect(sim.advanceUntil(() => workerOf(sim).task?.kind === 'craft', 600)).toBe(true);
    expect(sim.cancelPlan(plan.id)).toBe(true);
    expect(workerOf(sim).task).toBeNull();
    expect(inventoryOf(sim)).toMatchObject({ branch: 3, stone: 2 });
    expect(workerOf(sim).equipment.axe).toBe('basic-axe');
    expect(sim.state.events.some((e) => e.type === 'CRAFTING_COMPLETED')).toBe(false);
  });

  it('losing materials mid-craft fails honestly with inputs untouched', () => {
    const sim = manualSim();
    workerOf(sim).inventory = { branch: 3, stone: 2 };
    teleport(sim, 0.5, 0);
    const proposal = sim.proposeAction('CRAFT', 'settlement-01', { recipe: 'stone-axe' }, 'LOW');
    sim.issueDirective({ actionType: 'CRAFT', targetEntityId: 'settlement-01', reason: 'robbed', parameters: { recipe: 'stone-axe' } }, 'worker-01');
    expect(sim.advanceUntil(() => workerOf(sim).task?.kind === 'craft', 600)).toBe(true);
    workerOf(sim).inventory = { branch: 1 }; // something took the pack mid-work
    expect(sim.advanceUntil(() => proposal.status === 'FAILED', 600)).toBe(true);
    expect(sim.state.events.some((e) => e.type === 'CRAFTING_FAILED' && e.data['recipe'] === 'stone-axe')).toBe(true);
    expect(workerOf(sim).equipment.axe).toBe('basic-axe');
  });

  it('the stone axe fells a tree in one blow: no partial damage', () => {
    const sim = manualSim();
    const worker = workerOf(sim);
    worker.inventory = { branch: 3, stone: 2 };
    worker.equipment.axe = 'stone-axe'; // pre-equipped: measure the tool, not the craft
    const tree = sim.state.entities['tree-02'];
    if (!tree || tree.kind !== 'tree') throw new Error('tree-02 missing');
    teleport(sim, tree.position.x, tree.position.z);
    sim.issueDirective({ actionType: 'GATHER', targetEntityId: 'tree-02', reason: 'fell fast', parameters: {} }, 'worker-01');
    expect(sim.advanceUntil(() => tree.state === 'depleted', 900)).toBe(true);
    expect(sim.state.events.some((e) => e.type === 'TREE_DAMAGED' && e.entityId === 'tree-02')).toBe(false);
    expect(sim.state.events.some((e) => e.type === 'TREE_CHOPPED' && e.entityId === 'tree-02')).toBe(true);
  });
});

describe('carrying basket', () => {
  it('raises capacity 10 to 15 and cannot be woven twice', () => {
    const sim = manualSim();
    workerOf(sim).inventory = { branch: 4 };
    teleport(sim, 0.5, 0);
    const proposal = sim.proposeAction('CRAFT', 'settlement-01', { recipe: 'carrying-basket' }, 'LOW');
    sim.issueDirective({ actionType: 'CRAFT', targetEntityId: 'settlement-01', reason: 'basket', parameters: { recipe: 'carrying-basket' } }, 'worker-01');
    expect(sim.advanceUntil(() => proposal.status === 'VERIFIED', 1200)).toBe(true);
    expect(workerOf(sim).capacity).toBe(15);
    expect(workerOf(sim).equipment.basket).toBe(true);
    const second = sim.proposeAction('CRAFT', 'settlement-01', { recipe: 'carrying-basket' }, 'LOW');
    workerOf(sim).inventory = { branch: 4 };
    sim.issueDirective({ actionType: 'CRAFT', targetEntityId: 'settlement-01', reason: 'again', parameters: { recipe: 'carrying-basket' } }, 'worker-01');
    sim.advanceUntil(() => false, 120);
    expect(second.status).toBe('FAILED');
    expect(workerOf(sim).capacity).toBe(15);
  });
});

describe('craft goal planning', () => {
  it('completes "make a better axe" through collect and craft steps', async () => {
    const sim = new WorldSimulation(createWorld());
    const tracker = new GoalTracker();
    const runner = new GoalRunner(sim, tracker, 'delegated');
    const parsed = parseCommand('make a better axe');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('craft command not parsed');
    tracker.setGoal({ ...parsed.goal }, 0);
    let guard = 0;
    while (tracker.active && guard++ < 14) {
      await runner.runTurn(plannerDecide);
    }
    expect(tracker.active).toBeNull();
    expect(sim.state.entities['worker-01']).toMatchObject({ kind: 'worker' });
    const worker = workerOf(sim);
    expect(worker.equipment.axe).toBe('stone-axe');
    expect(sim.state.events.some((e) => e.type === 'MATERIAL_COLLECTED' && e.data['material'] === 'branch')).toBe(true);
    expect(sim.state.events.some((e) => e.type === 'MATERIAL_COLLECTED' && e.data['material'] === 'stone')).toBe(true);
    expect(sim.state.events.some((e) => e.type === 'CRAFTING_COMPLETED' && e.data['recipe'] === 'stone-axe')).toBe(true);
    const plan = Object.values(sim.state.plans).find((p) => p.kind === 'craft');
    expect(plan?.status).toBe('completed');
    expect(plan?.steps.filter((s) => s.status === 'verified').length).toBeGreaterThanOrEqual(6);
  });

  it('routes around a collected branch to the remaining ones', async () => {
    const sim = new WorldSimulation(createWorld());
    const spent = sim.state.entities['branch-01'];
    if (!spent || spent.kind !== 'branch') throw new Error('branch-01 missing');
    spent.state = 'collected';
    const tracker = new GoalTracker();
    const runner = new GoalRunner(sim, tracker, 'delegated');
    tracker.setGoal({ kind: 'craft', quantity: 1, recipe: 'stone-axe', note: 't' }, 0);
    let guard = 0;
    while (tracker.active && guard++ < 14) {
      await runner.runTurn(plannerDecide);
    }
    expect(tracker.active).toBeNull();
    expect(workerOf(sim).equipment.axe).toBe('stone-axe');
    expect(runner.rows.some((r) => r.target === 'branch-01' && r.verified)).toBe(false);
  });

  it('an already-satisfied goal creates no work', async () => {
    const sim = new WorldSimulation(createWorld());
    workerOf(sim).equipment.axe = 'stone-axe';
    const tracker = new GoalTracker();
    const runner = new GoalRunner(sim, tracker, 'delegated');
    tracker.setGoal({ kind: 'craft', quantity: 1, recipe: 'stone-axe', note: 't' }, 0);
    await runner.runTurn(plannerDecide);
    expect(tracker.active).toBeNull();
    expect(sim.state.proposals).toHaveLength(0);
  });

  it('unsupported items fail honestly at the command line', () => {
    expect(parseCommand('make a bow')).toMatchObject({ ok: false });
    expect(parseCommand('build a granary')).toMatchObject({ ok: false });
    const clarify = parseCommand('make a bow');
    if (clarify.ok) throw new Error('bow should not parse');
    expect(clarify.clarify).toMatch(/stone axe/i);
  });
});

describe('craft governance', () => {
  it('a held HIGH craft executes nothing until approved, and rejection consumes nothing', () => {
    const sim = manualSim();
    workerOf(sim).inventory = { branch: 3, stone: 2 };
    teleport(sim, 0.5, 0);
    const proposal = sim.proposeAction('CRAFT', 'settlement-01', { recipe: 'stone-axe' }, 'HIGH');
    expect(proposal.status).toBe('PROPOSED');
    sim.issueDirective({ actionType: 'CRAFT', targetEntityId: 'settlement-01', reason: 'held', parameters: { recipe: 'stone-axe' } }, 'worker-01');
    sim.advanceUntil(() => false, 200);
    expect(workerOf(sim).task).toBeNull();
    expect(proposal.status).toBe('PROPOSED');
    expect(sim.rejectProposal(proposal.id)).toBe(true);
    expect(inventoryOf(sim)).toMatchObject({ branch: 3, stone: 2 });
    expect(workerOf(sim).equipment.axe).toBe('basic-axe');
    expect(sim.state.events.some((e) => e.type === 'CRAFTING_COMPLETED')).toBe(false);
  });
});

describe('craft replay', () => {
  it('replays a collect-and-craft run to the same final state', () => {
    // Inputs only — no direct state edits — so the run is replayable by
    // construction. Five real collects, then the craft.
    const live = new WorldSimulation(createWorld(), new ManualAgent());
    for (const target of ['branch-01', 'branch-02', 'branch-03', 'stone-01', 'stone-02']) {
      const material = target.startsWith('branch') ? 'branch' : 'stone';
      live.issueDirective({ actionType: 'COLLECT', targetEntityId: target, reason: 'replay', parameters: {} }, 'worker-01');
      const need = target === 'branch-03' ? 3 : target === 'stone-02' ? 2 : (live.state.entities['worker-01']?.kind === 'worker' ? (live.state.entities['worker-01'].inventory[material] ?? 0) + 1 : 1);
      expect(live.advanceUntil(() => {
        const w = live.state.entities['worker-01'];
        return w?.kind === 'worker' && (w.inventory[material] ?? 0) >= need;
      }, 1500), `collect ${target}`).toBe(true);
    }
    live.issueDirective({ actionType: 'CRAFT', targetEntityId: 'settlement-01', reason: 'replay', parameters: { recipe: 'stone-axe' } }, 'worker-01');
    expect(live.advanceUntil(() => {
      const w = live.state.entities['worker-01'];
      return w?.kind === 'worker' && w.equipment.axe === 'stone-axe';
    }, 2000)).toBe(true);
    const log = live.exportLog();
    const liveHash = stateHash(live.state);
    const replayed = replayLog(log);
    expect(replayed.finalHash).toBe(liveHash);
    const rw = replayed.sim.state.entities['worker-01'];
    if (!rw || rw.kind !== 'worker') throw new Error('replayed worker missing');
    expect(rw.equipment.axe).toBe('stone-axe');
    expect(rw.inventory).toEqual({});
  });
});
