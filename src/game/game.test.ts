import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseCommand, GoalTracker, isGoalComplete, type GameGoal } from './goals';
import { nextStep, isGoalRelevant } from './planner';
import { policyFor } from './modes';
import { validateInterpretedGoal, interpretCommand } from './interpret';
import { createWorld } from '../world/createWorld';
import type { AgentObservation } from '../agent/Agent';

afterEach(() => {
  vi.unstubAllGlobals();
});

const OBS: AgentObservation = {
  tick: 0, wood: 0, food: 0, water: 0,
  worker: { id: 'worker-01', x: 2.4, z: -1.0, carrying: null },
  workers: [{ id: 'worker-01', x: 2.4, z: -1.0, carrying: null, activity: 'idle' }],
  claimedTargetIds: [],
  settlement: { id: 'settlement-01', x: 0, z: 0 },
  trees: [
    { id: 'tree-01', x: -4.7, z: -2.6, available: true },
    { id: 'tree-04', x: 5.1, z: -3.1, available: true },
  ],
  logs: [], berryPatches: [{ id: 'berry-patch-01', x: -5.7, z: 3.6, available: true }], farms: [], foodResources: [],
  branches: [], stones: [], shelters: [], houses: [],
  inventory: {}, equipment: { axe: 'basic-axe', basket: false }, capacity: 10,
};

describe('parseCommand', () => {
  it('parses gather, build, prioritize, preserve, and stop intents', () => {
    expect(parseCommand('gather food')).toMatchObject({ ok: true, goal: { kind: 'gather-food', quantity: 1 } });
    expect(parseCommand('gather two food')).toMatchObject({ ok: true, goal: { kind: 'gather-food', quantity: 2 } });
    expect(parseCommand('Gather enough wood to construct a house')).toMatchObject({ ok: true, goal: { kind: 'construct-house' } });
    expect(parseCommand('build a bridge across the river')).toMatchObject({ ok: false });
    expect(parseCommand('Build a bridge across the river').ok).toBe(false);
    expect(parseCommand('stop gathering wood and prioritize food')).toMatchObject({ ok: true, goal: { kind: 'prioritize', resource: 'food', avoid: ['wood'] } });
    expect(parseCommand('keep our food reserves above 3')).toMatchObject({ ok: true, goal: { kind: 'preserve', resource: 'food', quantity: 3 } });
    expect(parseCommand('do something magical')).toMatchObject({ ok: false });
    expect(parseCommand('')).toMatchObject({ ok: false });
  });

  it('parses farm, expansion, assignment, and cancellation commands', () => {
    expect(parseCommand('build a farm')).toMatchObject({ ok: true, goal: { kind: 'construct-farm', quantity: 1 } });
    expect(parseCommand('prepare the settlement for expansion')).toMatchObject({ ok: true, goal: { kind: 'construct-house' } });
    expect(parseCommand('assign workers to gather resources for the next building')).toMatchObject({ ok: true, goal: { kind: 'gather-wood' } });
    expect(parseCommand('cancel goal')).toMatchObject({ ok: true, goal: { note: '__CANCEL__' } });
  });

  it('tracks farm completion and preserve goals', () => {
    const world = createWorld();
    expect(isGoalComplete({ id: 'g', kind: 'construct-farm', quantity: 1, status: 'active', note: '', createdAt: 0 }, world)).toBe(false);
    world.entities['farm-01'] = { id: 'farm-01', kind: 'farm', position: { x: 0, z: 0 }, state: 'growing', progress: 0 };
    expect(isGoalComplete({ id: 'g', kind: 'construct-farm', quantity: 1, status: 'active', note: '', createdAt: 0 }, world)).toBe(true);
    expect(isGoalComplete({ id: 'g', kind: 'preserve', quantity: 5, resource: 'food', status: 'active', note: '', createdAt: 0 }, world)).toBe(false);
    world.food = 5;
    expect(isGoalComplete({ id: 'g', kind: 'preserve', quantity: 5, resource: 'food', status: 'active', note: '', createdAt: 0 }, world)).toBe(true);
  });

  it('explains the bridge impossibility with a useful alternative', () => {    const result = parseCommand('Build a bridge across the river.');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.clarify).toMatch(/not implemented/i);
      expect(result.clarify).toMatch(/house/i);
      expect(result.gap).toBe('bridge');
    }
  });
});

describe('planner nextStep', () => {  it('sequences gather → pickup → deliver → build from fresh observations', () => {
    const build: GameGoal = { id: 'goal-01', kind: 'construct-house', quantity: 1, status: 'active', note: '', createdAt: 0 };
    // No wood: nearest standing tree (tree-04, not first-listed tree-01).
    expect(nextStep({ ...build }, OBS)).toMatchObject({ actionType: 'GATHER', targetEntityId: 'tree-04' });
    // Wood banked: propose construction.
    expect(nextStep({ ...build }, { ...OBS, wood: 2 })).toMatchObject({ actionType: 'BUILD', targetEntityId: 'settlement-01' });
    // Carrying: deliver first even under a build goal.
    expect(nextStep({ ...build }, { ...OBS, wood: 2, worker: { ...OBS.worker, carrying: 'log-01' } }))
      .toMatchObject({ actionType: 'DELIVER' });
  });

  it('honors prioritize/stop restrictions', () => {
    const pri: GameGoal = { id: 'goal-02', kind: 'prioritize', quantity: 0, resource: 'food', avoid: ['wood'], status: 'active', note: '', createdAt: 0 };
    expect(nextStep({ ...pri }, OBS)).toMatchObject({ actionType: 'HARVEST', targetEntityId: 'berry-patch-01' });
  });

  it('returns null when the goal is already satisfied', () => {
    const done = { id: 'goal-03', kind: 'gather-food', quantity: 1, status: 'active', note: '', createdAt: 0 } as const;
    expect(nextStep({ ...done }, { ...OBS, food: 1 })).toBeNull();
  });

  it('plants the nearest stump under a plant goal and stops when restored', () => {
    const plant: GameGoal = { id: 'goal-04', kind: 'plant', quantity: 0, status: 'active', note: '', createdAt: 0 };
    const stumped = {
      ...OBS,
      trees: [{ id: 'tree-01', x: -4.7, z: -2.6, available: false }],
      stumps: [{ id: 'tree-01', x: -4.7, z: -2.6 }],
    };
    expect(nextStep(plant, stumped)).toMatchObject({ actionType: 'PLANT', targetEntityId: 'tree-01' });
    expect(nextStep(plant, OBS)).toBeNull();
    expect(isGoalRelevant(plant, stumped, { actionType: 'PLANT', targetEntityId: 'tree-01' })).toBe(true);
    expect(isGoalRelevant(plant, stumped, { actionType: 'GATHER', targetEntityId: 'tree-04' })).toBe(false);
  });

  it('parses planting commands', () => {
    expect(parseCommand('plant tree')).toMatchObject({ ok: true, goal: { kind: 'plant' } });
    expect(parseCommand('replant the forest')).toMatchObject({ ok: true, goal: { kind: 'plant' } });
    const world = createWorld();
    expect(isGoalComplete({ id: 'g', kind: 'plant', quantity: 0, status: 'active', note: '', createdAt: 0 }, world)).toBe(true);
    const stump = world.entities['tree-01'];
    if (stump && stump.kind === 'tree') {
      stump.health = 0;
      stump.state = 'depleted';
    }
    expect(isGoalComplete({ id: 'g', kind: 'plant', quantity: 0, status: 'active', note: '', createdAt: 0 }, world)).toBe(false);
  });

  it('parses fetch-water commands and plans well draws', () => {
    expect(parseCommand('fetch water')).toMatchObject({ ok: true, goal: { kind: 'fetch-water', quantity: 1 } });
    expect(parseCommand('draw two water')).toMatchObject({ ok: true, goal: { kind: 'fetch-water', quantity: 2 } });
    const goal: GameGoal = { id: 'goal-w', kind: 'fetch-water', quantity: 1, status: 'active', note: '', createdAt: 0 };
    const obs = { ...OBS, water: 0, wells: [{ id: 'well-01', x: -1.9, z: -2.9 }] };
    expect(nextStep(goal, obs)).toMatchObject({ actionType: 'HARVEST', targetEntityId: 'well-01' });
    expect(nextStep(goal, { ...obs, water: 1 })).toBeNull();
    expect(isGoalRelevant(goal, obs, { actionType: 'HARVEST', targetEntityId: 'well-01' })).toBe(true);
    expect(isGoalRelevant(goal, obs, { actionType: 'GATHER', targetEntityId: 'tree-01' })).toBe(false);
    const world = createWorld();
    expect(isGoalComplete(goal, world)).toBe(true);
    world.water = 0;
    expect(isGoalComplete(goal, world)).toBe(false);
  });
});

describe('isGoalRelevant', () => {
  const foodGoal: GameGoal = { id: 'g', kind: 'preserve', quantity: 2, resource: 'food', status: 'active', note: '', createdAt: 0 };
  const obsFood: AgentObservation = {
    ...OBS,
    logs: [{ id: 'log-01', x: 0, z: 0, available: true }],
    foodResources: [{ id: 'food-01', x: 0, z: 0, available: true, kind: 'food' }],
  };
  it('accepts goal-serving actions and rejects legal-but-off-goal ones', () => {
    expect(isGoalRelevant(foodGoal, obsFood, { actionType: 'HARVEST', targetEntityId: 'berry-patch-01' })).toBe(true);
    expect(isGoalRelevant(foodGoal, obsFood, { actionType: 'PICK_UP', targetEntityId: 'food-01' })).toBe(true);
    expect(isGoalRelevant(foodGoal, obsFood, { actionType: 'GATHER', targetEntityId: 'tree-01' })).toBe(false);
    expect(isGoalRelevant(foodGoal, obsFood, { actionType: 'PICK_UP', targetEntityId: 'log-01' })).toBe(false);
    expect(isGoalRelevant(foodGoal, { ...obsFood, worker: { ...obsFood.worker, carrying: 'food-01' } }, { actionType: 'DELIVER', targetEntityId: 'settlement-01' })).toBe(true);
    expect(isGoalRelevant(foodGoal, obsFood, { actionType: 'DELIVER', targetEntityId: 'settlement-01' })).toBe(false);
    expect(isGoalRelevant(foodGoal, obsFood, { actionType: 'MOVE_TO', targetEntityId: 'tree-01' })).toBe(true);
  });

  it('treats gathering past satiation as off-goal', () => {
    const woodGoal: GameGoal = { id: 'g', kind: 'gather-wood', quantity: 2, status: 'active', note: '', createdAt: 0 };
    expect(isGoalRelevant(woodGoal, { ...obsFood, wood: 1 }, { actionType: 'GATHER', targetEntityId: 'tree-01' })).toBe(true);
    expect(isGoalRelevant(woodGoal, { ...obsFood, wood: 2 }, { actionType: 'GATHER', targetEntityId: 'tree-01' })).toBe(false);
    const buildGoal: GameGoal = { id: 'g', kind: 'construct-farm', quantity: 1, status: 'active', note: '', createdAt: 0 };
    expect(isGoalRelevant(buildGoal, { ...obsFood, wood: 3 }, { actionType: 'GATHER', targetEntityId: 'tree-01' })).toBe(false);
    expect(isGoalRelevant(buildGoal, { ...obsFood, wood: 3 }, { actionType: 'BUILD', targetEntityId: 'settlement-01' })).toBe(true);
  });
});

describe('GoalTracker', () => {
  it('completes, replaces, and cancels goals against authoritative state', () => {
    const tracker = new GoalTracker();
    const world = createWorld();
    const goal = tracker.setGoal({ kind: 'gather-wood', quantity: 1, note: 't' }, 0);
    expect(tracker.active?.id).toBe(goal.id);
    expect(tracker.update(world)).toBeNull();
    world.wood = 1;
    const completed = tracker.update(world);
    expect(completed?.status).toBe('completed');
    expect(tracker.active).toBeNull();
    const second = tracker.setGoal({ kind: 'prioritize', quantity: 0, resource: 'food', note: 't' }, 1);
    expect(tracker.cancel()?.id).toBe(second.id);
    expect(tracker.history.map((g) => g.status)).toEqual(['completed', 'cancelled']);
  });

  it('checks completion per goal kind', () => {
    const world = createWorld();
    expect(isGoalComplete({ id: 'g', kind: 'construct-house', quantity: 1, status: 'active', note: '', createdAt: 0 }, world)).toBe(false);
    world.entities['house-01'] = { id: 'house-01', kind: 'house', position: { x: 0, z: 0 }, state: 'complete', progress: 1 };
    expect(isGoalComplete({ id: 'g', kind: 'construct-house', quantity: 1, status: 'active', note: '', createdAt: 0 }, world)).toBe(true);
  });
});

describe('control modes', () => {
  it('encodes genuinely different authority', () => {
    expect(policyFor('direct')).toMatchObject({ agentLoop: false, autoApproveUpTo: 'LOW' });
    expect(policyFor('delegated')).toMatchObject({ agentLoop: true, autoApproveUpTo: 'MEDIUM' });
    expect(policyFor('supervised')).toMatchObject({ agentLoop: true, autoApproveUpTo: 'LOW' });
  });
});

describe('interpret validation', () => {
  it('accepts well-formed goals and rejects everything else', () => {
    expect(validateInterpretedGoal({ kind: 'gather-food', quantity: 2, note: 'n' })).toMatchObject({ kind: 'gather-food' });
    expect(validateInterpretedGoal({ kind: 'build-spaceship', quantity: 1, note: 'n' })).toBeNull();
    expect(validateInterpretedGoal({ kind: 'gather-wood', quantity: -1, note: 'n' })).toBeNull();
    expect(validateInterpretedGoal({ clarify: 'which?' })).toBeNull();
    expect(validateInterpretedGoal('just do it')).toBeNull();
  });

  it('routes model output through validation, never around it', async () => {
    const provider = {
      name: 'mock',
      completeText: async () => ({ provider: 'mock', model: 'm', text: '{"kind":"construct-house","quantity":1,"note":"ok"}', usage: null, latencyMs: 1 }),
    };
    const good = await interpretCommand(provider, 'k', 'm', 'build shelter', 'wood=0');
    expect(good).toMatchObject({ ok: true, goal: { kind: 'construct-house' }, provider: 'mock' });
    const liar = {
      name: 'mock',
      completeText: async () => ({ provider: 'mock', model: 'm', text: '{"kind":"build-spaceship","quantity":1,"note":"x"}', usage: null, latencyMs: 1 }),
    };
    const bad = await interpretCommand(liar, 'k', 'm', 'build spaceship', 'wood=0');
    expect(bad.ok).toBe(false);
    expect(bad.clarify).toBeTruthy();
  });
});
