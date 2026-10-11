import { describe, expect, it } from 'vitest';
import { e2ePredicates, e2eStageNames, type E2EStage } from './e2eStages';
import { WorldSimulation } from '../simulation/WorldSimulation';
import { createWorld } from '../world/createWorld';
import type { WorldState } from '../world/types';

function worker(state: WorldState, id: string) {
  let entity = state.entities[id];
  if (!entity || entity.kind !== 'worker') {
    // Wilderness ships one inhabitant; predicate tests spawn the crew they need.
    entity = { id, kind: 'worker', position: { x: 1.5, z: 0.5 }, carrying: null, activity: 'idle', targetId: null, task: null, inventory: {}, capacity: 10, restedUntilTick: 0, equipment: { axe: 'basic-axe', basket: false } };
    state.entities[id] = entity;
  }
  if (entity.kind !== 'worker') throw new Error(`${id} missing`);
  return entity;
}

describe('e2e stage predicates', () => {
  it('covers every named stage', () => {
    expect(Object.keys(e2ePredicates).sort()).toEqual([...e2eStageNames].sort());
  });

  it('asserts activity regardless of which worker performs it', () => {
    const state = createWorld();
    // The old failure shape: worker-01 idle while a sibling ferries food.
    worker(state, 'worker-01').activity = 'idle';
    state.entities['food-09'] = { id: 'food-09', kind: 'food', position: { x: 0, z: 0 }, state: 'carried' };
    worker(state, 'worker-02').carrying = 'food-09';
    expect(e2ePredicates.foodCarrying(state)).toBe(true);
    expect(e2ePredicates.woodCarrying(state)).toBe(false);
    expect(e2ePredicates.chopping(state)).toBe(false);
    expect(e2ePredicates.berryHarvesting(state)).toBe(false);

    worker(state, 'worker-03').activity = 'chopping';
    expect(e2ePredicates.chopping(state)).toBe(true);
    state.entities['log-09'] = { id: 'log-09', kind: 'log', position: { x: 0, z: 0 }, state: 'carried' };
    worker(state, 'worker-03').carrying = 'log-09';
    worker(state, 'worker-03').activity = 'carrying';
    expect(e2ePredicates.chopping(state)).toBe(false);
    expect(e2ePredicates.woodCarrying(state)).toBe(true);
  });

  it('accepts the first delivery without punishing crew overshoot', () => {
    const state = createWorld();
    expect(e2ePredicates.woodDelivered(state)).toBe(false);
    state.wood = 2; // crew delivered twice before the stage was checked
    expect(e2ePredicates.woodDelivered(state)).toBe(true);
  });

  it('still catches genuine failures at settlement', () => {
    const state = createWorld();
    state.wood = 1;
    // A food delivery stuck EXECUTING (never verified) must NOT settle.
    state.proposals.push({
      id: 'proposal-0001', agentId: 'worker-01', actionType: 'DELIVER',
      targetEntityId: 'settlement-01', parameters: { resource: 'food' },
      riskLevel: 'LOW', createdAt: 0, status: 'EXECUTING',
    });
    expect(e2ePredicates.finalSettlement(state)).toBe(false);
    // A verified WOOD delivery does not satisfy the food requirement.
    state.proposals[0]!.parameters['resource'] = 'wood';
    state.proposals[0]!.status = 'VERIFIED';
    expect(e2ePredicates.finalSettlement(state)).toBe(false);
    state.proposals[0]!.parameters['resource'] = 'food';
    expect(e2ePredicates.finalSettlement(state)).toBe(true);
  });

  it('reaches every stage headless through the real predicates (local-only epoch)', () => {
    const simulation = new WorldSimulation(createWorld());
    const order: E2EStage[] = ['chopping', 'woodCarrying', 'woodDelivered', 'berryHarvesting', 'foodCarrying', 'finalSettlement'];
    for (const stage of order) {
      expect(simulation.advanceUntil(e2ePredicates[stage], 3600), `stage ${stage} unreachable`).toBe(true);
    }
  });
});
