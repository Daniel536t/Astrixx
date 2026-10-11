/**
 * Phase 6 intent layer: paraphrases resolve, missing capabilities explain
 * with alternatives, gaps are recorded, locations resolve against the world.
 */
import { describe, expect, it } from 'vitest';
import { createWorld } from '../world/createWorld';
import { parseCommand } from './goals';
import { parsePlaceIntent, resolvePlaceIntent } from './placement';
import { nextStep, isGoalRelevant } from './planner';
import { ACTION_CAPABILITIES, MISSING_CAPABILITIES } from './capabilities';
import { BLUEPRINTS, getBlueprint } from './blueprints';
import { SUPPORTED_ACTION_TYPES } from '../agent/nvidia/DecisionSchema';
import type { AgentObservation } from '../agent/Agent';

const OBS: AgentObservation = {
  tick: 0, wood: 0, food: 1, water: 1,
  worker: { id: 'worker-01', x: 1.2, z: 0.6, carrying: null },
  workers: [{ id: 'worker-01', x: 1.2, z: 0.6, carrying: null, activity: 'idle' }],
  claimedTargetIds: [],
  settlement: { id: 'settlement-01', x: 0, z: 0 },
  trees: [{ id: 'tree-01', x: 2.9, z: -2.23, available: true }],
  logs: [], berryPatches: [], farms: [], foodResources: [],
  branches: [], stones: [], shelters: [], houses: [],
  inventory: {}, equipment: { axe: 'basic-axe', basket: false }, capacity: 10,
};

describe('capability registry honesty', () => {
  it('covers every supported action with an implemented entry', () => {
    for (const action of SUPPORTED_ACTION_TYPES) {
      if (action === 'PLAN') continue; // sim-internal, never model-facing
      const entry = ACTION_CAPABILITIES.find((c) => c.id === action);
      expect(entry, `registry entry for ${action}`).toBeDefined();
      expect(entry?.implemented).toBe(true);
    }
  });

  it('every missing capability names an alternative or admits none', () => {
    for (const [topic, entry] of Object.entries(MISSING_CAPABILITIES)) {
      expect(entry.understood.length, topic).toBeGreaterThan(0);
      expect(entry.missing.length, topic).toBeGreaterThan(0);
    }
  });

  it('registers at least three blueprints with distinct costs', () => {
    expect(getBlueprint('lean-to')).toBeDefined();
    expect(getBlueprint('timber-cabin')).toBeDefined();
    expect(getBlueprint('thatched-cottage')).toBeDefined();
    const costs = new Set(Object.values(BLUEPRINTS).map((b) => `${b.woodCost}w+${b.branchCost}b`));
    expect(costs.size).toBeGreaterThanOrEqual(3);
  });
});

describe('paraphrase intents', () => {
  it('resolves tool-for-cutting-trees to the stone-axe craft', () => {
    expect(parseCommand('Build me a better tool for cutting trees')).toMatchObject({
      ok: true, goal: { kind: 'craft', recipe: 'stone-axe' },
    });
  });

  it('routes blueprint names to the matching design', () => {
    expect(parseCommand('build a timber cabin')).toMatchObject({
      ok: true, goal: { kind: 'construct-house', blueprint: 'timber-cabin' },
    });
    expect(parseCommand('build a thatched cottage')).toMatchObject({
      ok: true, goal: { kind: 'construct-house', blueprint: 'thatched-cottage' },
    });
    expect(parseCommand('build a house')).toMatchObject({
      ok: true, goal: { kind: 'construct-house', blueprint: 'homestead' },
    });
  });

  it('asks for a design choice instead of guessing the cheapest', () => {
    const parsed = parseCommand('build the cheapest house');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('cheapest should clarify');
    expect(parsed.clarify).toMatch(/homestead.*2 wood/i);
    expect(parsed.clarify).toMatch(/cabin.*4 wood/i);
  });
});

describe('missing capabilities', () => {
  it.each([
    ['build a granary', 'granary'],
    ['Give me somewhere to store food', 'granary'],
    ['Make this place more defensible', 'defense'],
    ['Find a way across that river', 'bridge'],
    ['I want to start raising animals', 'taming'],
    ['stockpile fuel for the winter', 'warmth'],
    ['get animal', 'taming'],
    ['hunt the deer', 'hunting'],
  ])('"%s" explains honestly with a recorded gap', (text, gap) => {
    const parsed = parseCommand(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error(`${text} should not parse`);
    expect(parsed.gap).toBe(gap);
    expect(parsed.clarify).toMatch(/not implemented/i);
  });

  it('maps cozy rest requests to the shelter that actually exists', () => {
    expect(parseCommand('Make something cozy for the night')).toMatchObject({
      ok: true, goal: { kind: 'construct-shelter' },
    });
  });

  it('offers a working alternative instead of a dead end', () => {
    const parsed = parseCommand('build a granary');
    if (parsed.ok) throw new Error('granary should not parse');
    expect(parsed.clarify).toMatch(/shelter/i);
  });
});

describe('location intent', () => {
  it('parses exact coordinates', () => {
    expect(parsePlaceIntent('build a house at X: 45, Z: -20')).toMatchObject({
      intent: { kind: 'exact', x: 45, z: -20 },
    });
  });

  it('parses relative directions with near/far', () => {
    expect(parsePlaceIntent('build a house far east of the camp')).toMatchObject({
      intent: { kind: 'relative', dir: 'east', dist: 'far' },
    });
    expect(parsePlaceIntent('build a shelter west of the pond')).toMatchObject({
      intent: { kind: 'relative', dir: 'west' },
    });
  });

  it('resolves east-of-camp against the real camp position', () => {
    const world = createWorld();
    const { intent } = parsePlaceIntent('build a house far east of the camp');
    const resolved = resolvePlaceIntent(world, intent, { x: 0, z: 0 });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('should resolve');
    expect(resolved.x).toBeGreaterThan(4);
    expect(resolved.description).toMatch(/east of the camp/);
  });

  it('resolves the largest tree deterministically and names it', () => {
    const world = createWorld();
    const resolved = resolvePlaceIntent(world, { kind: 'near', entity: { kind: 'tree', which: 'largest' } }, { x: 0, z: 0 });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('should resolve');
    expect(resolved.description).toMatch(/largest standing tree/);
    const again = resolvePlaceIntent(world, { kind: 'near', entity: { kind: 'tree', which: 'largest' } }, { x: 9, z: 9 });
    expect(again).toEqual(resolved);
  });

  it('asks which tree when the reference is ambiguous', () => {
    const world = createWorld();
    const resolved = resolvePlaceIntent(world, { kind: 'near', entity: { kind: 'tree', which: '?' } }, { x: 0, z: 0 });
    expect(resolved.ok).toBe(false);
  });

  it('carries place intent from build commands into goals', () => {
    expect(parseCommand('build a house far east of the camp')).toMatchObject({
      ok: true, goal: { kind: 'construct-house', place: { kind: 'relative', dir: 'east' } },
    });
    expect(parseCommand('build a shelter at X: 5, Z: -5')).toMatchObject({
      ok: true, goal: { kind: 'construct-shelter', place: { kind: 'exact', x: 5, z: -5 } },
    });
  });
});

describe('blueprint planning', () => {
  const cabin = { id: 'g', kind: 'construct-house' as const, quantity: 1, blueprint: 'timber-cabin', status: 'active' as const, note: '', createdAt: 0 };

  it('funds the cabin at 4 wood, not the legacy 2', () => {
    expect(nextStep(cabin, { ...OBS, wood: 2 })?.actionType).toBe('GATHER');
    const funded = nextStep(cabin, { ...OBS, wood: 4 });
    expect(funded).toMatchObject({ actionType: 'BUILD', parameters: { structure: 'house', blueprint: 'timber-cabin' } });
  });

  it('collects branches for the cottage before building', () => {
    const cottage = { ...cabin, blueprint: 'thatched-cottage' };
    const stocked = {
      ...OBS,
      wood: 2,
      branches: [
        { id: 'branch-01', x: 3.0, z: -4.3, available: true, kind: 'branch' as const },
      ],
    };
    expect(nextStep(cottage, stocked)?.actionType).toBe('COLLECT');
    expect(nextStep(cottage, { ...stocked, inventory: { branch: 2 } })).toMatchObject({
      actionType: 'BUILD', parameters: { structure: 'house', blueprint: 'thatched-cottage' },
    });
  });

  it('counts only the requested design toward completion', () => {
    const done = { ...OBS, wood: 4, houses: [{ id: 'house-01', x: 0, z: 0, complete: true, blueprint: 'homestead' }] };
    expect(isGoalRelevant(cabin, done, { actionType: 'BUILD', targetEntityId: 'settlement-01' })).toBe(true);
    expect(isGoalRelevant(
      { ...cabin, blueprint: 'homestead' }, done, { actionType: 'BUILD', targetEntityId: 'settlement-01' },
    )).toBe(false);
  });
});
