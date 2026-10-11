/**
 * Shelter placement rules, command parsing, and craft... shelter planning.
 * Pure placement authority lives in game/shelter.ts; the planner only asks
 * it, the simulation enforces it at execution.
 */
import { describe, expect, it } from 'vitest';
import { createWorld } from '../world/createWorld';
import { validateShelterSite, findShelterSite } from './shelter';
import { parseCommand } from './goals';
import { nextStep, isGoalRelevant } from './planner';
import type { AgentObservation } from '../agent/Agent';

const OBS: AgentObservation = {
  tick: 0, wood: 0, food: 1, water: 1,
  worker: { id: 'worker-01', x: 1.2, z: 0.6, carrying: null },
  workers: [{ id: 'worker-01', x: 1.2, z: 0.6, carrying: null, activity: 'idle' }],
  claimedTargetIds: [],
  settlement: { id: 'settlement-01', x: 0, z: 0 },
  trees: [{ id: 'tree-01', x: 2.9, z: -2.23, available: true }],
  logs: [], berryPatches: [], farms: [], foodResources: [],
  branches: [
    { id: 'branch-01', x: 3.0, z: -4.3, available: true, kind: 'branch' },
    { id: 'branch-02', x: -0.6, z: -2.4, available: true, kind: 'branch' },
  ],
  stones: [],
  shelters: [],
  houses: [],
  inventory: {}, equipment: { axe: 'basic-axe', basket: false }, capacity: 10,
};

describe('validateShelterSite', () => {
  it('refuses the camp, the pond, trees, and the map edge', () => {
    const world = createWorld();
    expect(validateShelterSite(world, 0, 0).ok).toBe(false); // camp
    const pond = world.entities['pond-01'];
    if (!pond || pond.kind !== 'pond') throw new Error('pond missing');
    expect(validateShelterSite(world, pond.position.x, pond.position.z).ok).toBe(false);
    const tree = world.entities['tree-01'];
    if (!tree || tree.kind !== 'tree') throw new Error('tree-01 missing');
    expect(validateShelterSite(world, tree.position.x, tree.position.z).ok).toBe(false);
    expect(validateShelterSite(world, 10, 0).ok).toBe(false); // outside bounds
    expect(validateShelterSite(world, NaN, 0).ok).toBe(false);
  });

  it('accepts clear ground and refuses crowding an existing shelter', () => {
    const world = createWorld();
    const site = findShelterSite(world, { x: 1.2, z: 0.6 });
    expect(site).not.toBeNull();
    expect(validateShelterSite(world, site!.x, site!.z)).toMatchObject({ ok: true });
    world.entities['shelter-01'] = { id: 'shelter-01', kind: 'shelter', position: { ...site! }, state: 'complete', progress: 1, footprint: 1.2 };
    expect(validateShelterSite(world, site!.x, site!.z).ok).toBe(false);
    const second = findShelterSite(world, { x: 1.2, z: 0.6 });
    expect(second).not.toBeNull();
    expect(Math.hypot(second!.x - site!.x, second!.z - site!.z)).toBeGreaterThan(2);
  });

  it('does not let the claimant block its own site while walking in', () => {
    const world = createWorld();
    const site = findShelterSite(world, { x: 1.2, z: 0.6 });
    expect(site).not.toBeNull();
    // The builder steps inside its own exclusion ring on approach: strict
    // validation fails, but execution (which ignores the claimant) passes.
    world.entities['worker-01'] = {
      ...(world.entities['worker-01'] as { id: string; kind: 'worker'; position: { x: number; z: number } }),
      position: { x: site!.x - 0.5, z: site!.z },
    } as never;
    expect(validateShelterSite(world, site!.x, site!.z).ok).toBe(false);
    expect(validateShelterSite(world, site!.x, site!.z, 'worker-01')).toMatchObject({ ok: true });
  });

  it('picks deterministically: same state, same site', () => {
    const a = findShelterSite(createWorld('s'), { x: 0, z: 0 });
    const b = findShelterSite(createWorld('s'), { x: 0, z: 0 });
    expect(a).toEqual(b);
  });
});

describe('shelter commands', () => {
  it('parses build-a-shelter into a construct-shelter goal', () => {
    expect(parseCommand('build a shelter')).toMatchObject({ ok: true, goal: { kind: 'construct-shelter', quantity: 1 } });
    expect(parseCommand('we need shelter')).toMatchObject({ ok: true, goal: { kind: 'construct-shelter' } });
  });

  it('answers animal commands honestly instead of guessing a goal', () => {
    for (const text of ['get animal', 'hunt the deer', 'tame the rabbit', 'catch an animal']) {
      const parsed = parseCommand(text);
      expect(parsed.ok, text).toBe(false);
      if (parsed.ok) throw new Error(`${text} should not parse`);
      expect(parsed.clarify).toMatch(/not implemented/i);
    }
  });
});

describe('shelter planning', () => {
  const goal = { id: 'g', kind: 'construct-shelter' as const, quantity: 1, status: 'active' as const, note: '', createdAt: 0 };

  it('gathers wood first when the stockpile is short', () => {
    const step = nextStep(goal, OBS);
    expect(step?.actionType).toBe('GATHER');
  });

  it('collects branches once wood is covered', () => {
    const step = nextStep(goal, { ...OBS, wood: 2 });
    expect(step).toMatchObject({ actionType: 'COLLECT' });
  });

  it('proposes the build (without inventing coordinates) when funded', () => {
    const step = nextStep(goal, { ...OBS, wood: 2, inventory: { branch: 2 } });
    expect(step).toMatchObject({ actionType: 'BUILD', targetEntityId: 'settlement-01', parameters: { structure: 'shelter' } });
    expect(step?.parameters).not.toHaveProperty('x');
  });

  it('stops when the shelter stands', () => {
    expect(nextStep(goal, { ...OBS, wood: 2, inventory: { branch: 2 }, shelters: [{ id: 'shelter-01', x: 1, z: 1, complete: true }] })).toBeNull();
    expect(isGoalRelevant(goal, OBS, { actionType: 'GATHER', targetEntityId: 'tree-01' })).toBe(true);
    expect(isGoalRelevant(
      goal,
      { ...OBS, wood: 2, inventory: { branch: 2 }, shelters: [{ id: 'shelter-01', x: 1, z: 1, complete: true }] },
      { actionType: 'BUILD', targetEntityId: 'settlement-01' },
    )).toBe(false);
  });
});
