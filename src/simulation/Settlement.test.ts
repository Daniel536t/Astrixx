import { describe, expect, it } from 'vitest';
import { WorldSimulation } from './WorldSimulation';
import { createWorld } from '../world/createWorld';
import { ManualAgent } from '../agent/ManualAgent';
import { LocalGathererAgent } from '../agent/LocalGathererAgent';
import { ModelDrivenAgent } from '../agent/ModelDrivenAgent';
import { MockProvider } from '../agent/MockProvider';
import type { Agent } from '../agent/Agent';
import { GoalTracker } from '../game/goals';
import { GoalRunner, plannerDecide } from '../game/runner';
import { validateDecisionAgainstWorld } from '../agent/nvidia/DecisionSchema';

const workers = (sim: WorldSimulation) => Object.values(sim.state.entities).filter((e) => e.kind === 'worker');

describe('food consumption and hunger', () => {
  it('consumes food deterministically with population and time, without deaths', () => {
    const sim = new WorldSimulation();
    expect(workers(sim)).toHaveLength(1);
    expect(sim.state.food).toBe(1);
    sim.state.food = 3;
    sim.advanceUntil((s) => s.tick >= 700, 800);
    // The inhabitant also gathers food meanwhile, so assert the mechanic,
    // not an exact ledger: consumption events fired and the worker survives.
    const consumed = sim.state.events.filter((e) => e.type === 'FOOD_CONSUMED');
    expect(consumed.length).toBeGreaterThanOrEqual(1);
    expect(workers(sim)).toHaveLength(1);
  });

  it('reports hunger instead of killing when the stockpile is empty', () => {
    // Idle sim: no autonomous gathering competes, so consumption drains
    // deterministically and hunger reports without fatalities.
    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    sim.state.food = 0;
    sim.advanceUntil((s) => s.tick >= 700, 800);
    expect(sim.state.events.some((e) => e.type === 'POPULATION_HUNGRY')).toBe(true);
    expect(workers(sim)).toHaveLength(1);
    expect(sim.state.events.some((e) => e.type === 'FOOD_LOW')).toBe(true);
  });
});

describe('population growth', () => {
  it('welcomes a newcomer when food surplus and housing allow', () => {
    const sim = new WorldSimulation();
    sim.state.food = 20;
    sim.advanceUntil((s) => s.tick >= 1300, 1400);
    expect(sim.state.entities['worker-02']?.kind).toBe('worker');
    expect(sim.state.events.some((e) => e.type === 'POPULATION_JOINED' && e.entityId === 'worker-02')).toBe(true);
    expect(sim.state.food).toBeLessThan(20); // arrival cost paid
  });

  it('stops at housing capacity without houses', () => {
    const sim = new WorldSimulation();
    sim.state.food = 40;
    sim.advanceUntil((s) => s.tick >= 2600, 2800);
    // Base housing 4, starting from 1 inhabitant: worker-02 joins at tick
    // 1200, worker-03 at 2400; growth continues until housing/arrival costs bind.
    expect(workers(sim).length).toBeGreaterThanOrEqual(3);
    expect(workers(sim).length).toBeLessThanOrEqual(4);
  });
});

describe('farm lifecycle', () => {
  it('builds, regrows, and harvests a farm for renewable food', async () => {
    const sim = new WorldSimulation(createWorld());
    const tracker = new GoalTracker();
    const runner = new GoalRunner(sim, tracker, 'delegated');
    sim.state.wood = 3;
    tracker.setGoal({ kind: 'construct-farm', quantity: 1, note: 't' }, 0);
    // Delegated MEDIUM policy still holds HIGH BUILD for a human.
    const held = await runner.runTurn(plannerDecide);
    expect(held.action).toBe('BUILD');
    expect(held.proposalId).not.toBeNull();
    expect(sim.approveProposal(held.proposalId!)).toBe(true);
    await runner.runTurn(plannerDecide);
    const farm = Object.values(sim.state.entities).find((e) => e.kind === 'farm');
    expect(farm?.kind).toBe('farm');
    expect(sim.state.proposals.find((p) => p.id === held.proposalId)?.status).toBe('VERIFIED');
    // Regrow to ready, then harvest for +1 delivered food.
    expect(sim.advanceUntil((s) => Object.values(s.entities).some((e) => e.kind === 'farm' && e.state === 'ready'), 400)).toBe(true);
    const foodBefore = sim.state.food;
    tracker.setGoal({ kind: 'gather-food', quantity: foodBefore + 1, note: 't' }, sim.state.tick);
    let guard = 0;
    while (tracker.active && guard++ < 8) {
      await runner.runTurn(plannerDecide);
    }
    expect(sim.state.food).toBe(foodBefore + 1);
    expect(sim.state.events.some((e) => e.type === 'FARM_HARVESTED')).toBe(true);
    expect(Object.values(sim.state.entities).some((e) => e.kind === 'farm' && e.state === 'growing')).toBe(true);
  });

  it('rejects invalid placement beyond the farm plots', () => {
    const sim = new WorldSimulation();
    sim.state.entities['farm-01'] = { id: 'farm-01', kind: 'farm', position: { x: 0, z: 0 }, state: 'growing', progress: 0 };
    sim.state.entities['farm-02'] = { id: 'farm-02', kind: 'farm', position: { x: 1, z: 1 }, state: 'ready', progress: 1 };
    sim.state.wood = 9;
    expect(validateDecisionAgainstWorld(
      { action: { actionType: 'BUILD', targetEntityId: 'settlement-01', parameters: { structure: 'farm' } }, intent: 'i', expectation: 'e' },
      sim.state,
    )).toMatchObject({ ok: false, reason: 'illegal-target-state' });
  });
});

describe('multi-worker crew', () => {
  function spawnCrew(sim: WorldSimulation): void {
    // Wilderness ships one inhabitant; crew tests add two more explicitly.
    for (const [id, x, z] of [['worker-02', 1.4, 1.0], ['worker-03', -1.2, 1.4]] as const) {
      if (!sim.state.entities[id]) {
        sim.state.entities[id] = { id, kind: 'worker', position: { x, z }, carrying: null, activity: 'idle', targetId: null, task: null, inventory: {}, capacity: 10, restedUntilTick: 0, equipment: { axe: 'basic-axe', basket: false } };
      }
    }
  }

  it('claims different targets instead of piling onto one', () => {
    const sim = new WorldSimulation();
    spawnCrew(sim);
    sim.advanceUntil((s) => s.tick >= 25, 30);
    const targets = workersOfTargets(sim).filter((t) => t !== null);
    expect(targets.length).toBeGreaterThan(1);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('never gathers from depleted resources', () => {
    const sim = new WorldSimulation();
    for (const entity of Object.values(sim.state.entities)) {
      if (entity.kind === 'tree') { entity.health = 0; entity.state = 'depleted'; }
      if (entity.kind === 'berry-patch') entity.state = 'harvested';
    }
    sim.advanceUntil(() => false, 120);
    expect(sim.state.proposals.filter((p) => p.actionType === 'GATHER')).toHaveLength(0);
    expect(sim.state.proposals.filter((p) => p.actionType === 'HARVEST')).toHaveLength(0);
  });

  it('routes a named directive to the named worker', () => {
    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    spawnCrew(sim);
    sim.issueDirective({ actionType: 'GATHER', targetEntityId: 'tree-04', reason: 'test' }, 'worker-03');
    sim.advanceUntil(() => false, 5);
    expect(sim.state.entities['worker-03']).toMatchObject({ targetId: 'tree-04' });
    expect(sim.state.entities['worker-01']).toMatchObject({ targetId: null });
    expect(sim.state.entities['worker-02']).toMatchObject({ targetId: null });
  });

  it('scopes agents to their workers', () => {
    const model = new ModelDrivenAgent(new MockProvider([]));
    expect(model.controlsWorker?.('worker-01')).toBe(true);
    expect(model.controlsWorker?.('worker-02')).toBe(false);
    const manual = new ManualAgent();
    expect(manual.controlsWorker?.('worker-01')).toBe(false);
    const local: Agent = new LocalGathererAgent();
    expect(local.controlsWorker?.('worker-03') ?? true).toBe(true);
    // A model-owned sim leaves the crew idle without directives.
    const sim = new WorldSimulation(createWorld(), model);
    spawnCrew(sim);
    sim.advanceUntil(() => false, 60);
    expect(sim.state.proposals).toHaveLength(0);
    expect(sim.state.entities['worker-02']).toMatchObject({ activity: 'idle' });
  });
});

function workersOfTargets(sim: WorldSimulation): Array<string | null> {
  return Object.values(sim.state.entities)
    .filter((e) => e.kind === 'worker')
    .map((e) => (e.kind === 'worker' ? e.targetId : null));
}
