import { describe, expect, it } from 'vitest';
import { createWorld, WILDERNESS_DEFAULT_SEED } from './createWorld';
import { WorldSimulation } from '../simulation/WorldSimulation';
import { ManualAgent } from '../agent/ManualAgent';
import { stateHash } from '../simulation/replay';

const minDist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

describe('wilderness genesis (Phase 1)', () => {
  it('spawns exactly one inhabitant with a real starting axe', () => {
    const world = createWorld();
    const workers = Object.values(world.entities).filter((e) => e.kind === 'worker');
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({
      id: 'worker-01', kind: 'worker',
      carrying: null, activity: 'idle', task: null,
      inventory: {}, capacity: 10, restedUntilTick: 0, equipment: { axe: 'basic-axe', basket: false },
    });
  });

  it('contains no house, farm, village, or extra workers at genesis', () => {
    const world = createWorld();
    expect(Object.values(world.entities).some((e) => e.kind === 'house')).toBe(false);
    expect(Object.values(world.entities).some((e) => e.kind === 'farm')).toBe(false);
    expect(Object.values(world.entities).some((e) => e.kind === 'villager')).toBe(false);
    expect(Object.values(world.entities).filter((e) => e.kind === 'worker')).toHaveLength(1);
    expect(world.wood).toBe(0);
  });

  it('provides natural water (pond), branches, stones, and wildlife — not a built well', () => {
    const world = createWorld();
    expect(world.entities['well-01']).toBeUndefined();
    expect(world.entities['pond-01']?.kind).toBe('pond');
    expect(Object.values(world.entities).filter((e) => e.kind === 'branch')).toHaveLength(4);
    expect(Object.values(world.entities).filter((e) => e.kind === 'stone')).toHaveLength(4);
    expect(world.entities['deer-01']).toMatchObject({ kind: 'animal', species: 'deer' });
    expect(Object.values(world.entities).filter((e) => e.kind === 'tree' && e.state === 'standing')).toHaveLength(6);
    expect(Object.values(world.entities).filter((e) => e.kind === 'berry-patch')).toHaveLength(2);
  });

  it('keeps resource placement spatially coherent (nothing stacked on the inhabitant)', () => {
    const world = createWorld();
    const worker = world.entities['worker-01'];
    if (!worker || worker.kind !== 'worker') throw new Error('worker-01 missing');
    for (const entity of Object.values(world.entities)) {
      if (entity.id === 'worker-01' || entity.id === 'settlement-01') continue;
      if (!('position' in entity)) continue;
      expect(minDist(worker.position, entity.position), `${entity.id} overlaps the inhabitant`).toBeGreaterThan(0.8);
    }
    const positions = Object.values(world.entities).filter((e) => 'position' in e).map((e) => (e as { position: { x: number; z: number } }).position);
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) {
        expect(minDist(positions[i]!, positions[j]!), `entities ${i}/${j} overlap`).toBeGreaterThanOrEqual(0.5);
      }
    }
  });

  it('reproduces the same authoritative state for a fixed seed and varies across seeds', () => {
    expect(stateHash(createWorld('seed-a'))).toBe(stateHash(createWorld('seed-a')));
    expect(stateHash(createWorld('seed-a'))).not.toBe(stateHash(createWorld('seed-b')));
    expect(createWorld().seed).toBe(WILDERNESS_DEFAULT_SEED);
  });

  it('starts idle: no autonomous proposals or tree-cutting without a goal', () => {
    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    sim.advanceUntil(() => false, 120);
    expect(sim.state.proposals).toHaveLength(0);
    expect(sim.state.events.some((e) => e.type === 'TREE_CHOPPED')).toBe(false);
    expect(sim.state.entities['worker-01']).toMatchObject({ activity: 'idle', carrying: null, task: null });
  });

  it('regrows harvested berry patches and wanders wildlife deterministically', () => {
    const first = new WorldSimulation(createWorld('deer-seed'), new ManualAgent());
    const second = new WorldSimulation(createWorld('deer-seed'), new ManualAgent());
    const patch = first.state.entities['berry-patch-01'];
    if (!patch || patch.kind !== 'berry-patch') throw new Error('berry-patch-01 missing');
    patch.state = 'harvested';
    patch.progress = 0;
    first.advanceUntil(() => {
      const p = first.state.entities['berry-patch-01'];
      return p?.kind === 'berry-patch' && p.state === 'available';
    }, 600);
    expect(first.state.entities['berry-patch-01']).toMatchObject({ kind: 'berry-patch', state: 'available' });
    second.advanceUntil(() => false, first.state.tick);
    const deerA = first.state.entities['deer-01'];
    const deerB = second.state.entities['deer-01'];
    expect(deerA).toMatchObject({ kind: 'animal' });
    expect(deerB).toMatchObject({ kind: 'animal' });
    if (deerA?.kind !== 'animal' || deerB?.kind !== 'animal') throw new Error('deer missing');
    expect(deerA.position).toEqual(deerB.position);
  });
});
