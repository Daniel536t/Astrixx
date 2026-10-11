import { SETTLEMENT_ID, WORKER_ID, type Vec2, type WorldEvent, type WorldState } from './types';

export const WILDERNESS_DEFAULT_SEED = 'astrix-wilderness-v1';
export const WILDERNESS_VERSION = 1;

/** Deterministic string hash (cyrb53) for seed derivation. */
function hashSeed(seed: string): number {
  let h1 = 0xdeadbeef ^ seed.length;
  let h2 = 0x41c6ce57 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Mulberry32 PRNG: deterministic per-seed placement. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clearOf(position: Vec2, others: Vec2[], minDist: number): boolean {
  return others.every((o) => Math.hypot(o.x - position.x, o.z - position.z) >= minDist);
}

function scatter(
  rand: () => number,
  count: number,
  taken: Vec2[],
  minR: number,
  maxR: number,
  minDist: number,
): Vec2[] {
  const out: Vec2[] = [];
  let guard = 0;
  while (out.length < count && guard < 400) {
    guard += 1;
    const angle = rand() * Math.PI * 2;
    const radius = minR + rand() * (maxR - minR);
    const candidate = { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
    if (!clearOf(candidate, taken, minDist) || !clearOf(candidate, out, minDist)) continue;
    out.push(candidate);
    taken.push(candidate);
  }
  return out;
}

/**
 * Wilderness genesis (Phase 1).
 *
 * One inhabitant (worker-01) with a real starting axe, a natural environment
 * (trees, branches, stones, berries, pond, wildlife), and a camp anchor at
 * the origin. The anchor keeps delivery/BUILD targeting and the Farm-01 lease
 * working until Phase 4 replaces settlement delivery with inventory storage;
 * it renders as a modest camp, never as houses/farms (none exist at genesis).
 * No autonomous work starts: the browser boots idle (ManualAgent) and the
 * baseline gatherer only runs inside explicit goals/tests.
 */
export function createWorld(seed: string = WILDERNESS_DEFAULT_SEED): WorldState {
  const rand = mulberry32(hashSeed(seed));
  const state: WorldState = {
    tick: 0,
    wood: 0,
    food: 1,
    water: 1,
    seed,
    entities: {},
    events: [],
    proposals: [],
    plans: {},
    journal: [],
    leases: {},
    speculative: [],
    nextEntityNumber: 1,
    nextFoodNumber: 1,
    nextProposalNumber: 1,
    nextEventSequence: 1,
    nextSpeculativeNumber: 1,
    nextPlanNumber: 1,
  };
  const emit = (type: WorldEvent['type'], entityId?: string, data: Record<string, unknown> = {}) => {
    const sequence = state.nextEventSequence++;
    state.events.push({ id: `event-${String(sequence).padStart(4, '0')}`, sequence, type, timestamp: 0, entityId, data });
  };

  // Camp anchor (transitional): position reference only, no buildings.
  state.entities[SETTLEMENT_ID] = { id: SETTLEMENT_ID, kind: 'settlement', position: { x: 0, z: 0 } };
  emit('ENTITY_SPAWNED', SETTLEMENT_ID, { kind: 'settlement', position: { x: 0, z: 0 }, camp: true });

  // Single inhabitant with a real axe, modest capacity, empty hands.
  state.entities[WORKER_ID] = {
    id: WORKER_ID, kind: 'worker', position: { x: 1.2, z: 0.6 },
    carrying: null, activity: 'idle', targetId: null, task: null,
    inventory: {}, capacity: 10, restedUntilTick: 0, equipment: { axe: 'basic-axe', basket: false },
  };
  emit('ENTITY_SPAWNED', WORKER_ID, { kind: 'worker', position: { x: 1.2, z: 0.6 }, equipment: { axe: 'basic-axe' } });

  const taken: Vec2[] = [{ x: 0, z: 0 }, { x: 1.2, z: 0.6 }];

  // Pond: natural water source, placed away from spawn.
  const pondAngle = rand() * Math.PI * 2;
  const pondRadius = 5.2 + rand() * 1.6;
  const pondPos = { x: Math.cos(pondAngle) * pondRadius, z: Math.sin(pondAngle) * pondRadius };
  taken.push(pondPos);
  state.entities['pond-01'] = { id: 'pond-01', kind: 'pond', position: pondPos, radius: 1.5 };
  emit('ENTITY_SPAWNED', 'pond-01', { kind: 'pond', position: pondPos });

  // Trees: 6 standing, spatially separated, none on top of camp/pond/spawn.
  const treePositions = scatter(rand, 6, taken, 3.4, 7.4, 1.6);
  treePositions.forEach((position, index) => {
    const id = `tree-0${index + 1}`;
    state.entities[id] = { id, kind: 'tree', position, health: 2, maxHealth: 2, state: 'standing' };
    emit('ENTITY_SPAWNED', id, { kind: 'tree', position });
  });

  // Berry patches: 2 available.
  const patchPositions = scatter(rand, 2, taken, 3.0, 7.0, 1.6);
  patchPositions.forEach((position, index) => {
    const id = `berry-patch-0${index + 1}`;
    state.entities[id] = { id, kind: 'berry-patch', position, state: 'available' };
    emit('ENTITY_SPAWNED', id, { kind: 'berry-patch', position });
  });

  // Fallen branches: 4 gatherable.
  const branchPositions = scatter(rand, 4, taken, 2.0, 6.4, 1.1);
  branchPositions.forEach((position, index) => {
    const id = `branch-0${index + 1}`;
    state.entities[id] = { id, kind: 'branch', position, state: 'ground' };
    emit('ENTITY_SPAWNED', id, { kind: 'branch', position });
  });

  // Loose stones: 4 gatherable.
  const stonePositions = scatter(rand, 4, taken, 2.0, 6.8, 1.1);
  stonePositions.forEach((position, index) => {
    const id = `stone-0${index + 1}`;
    state.entities[id] = { id, kind: 'stone', position, state: 'ground' };
    emit('ENTITY_SPAWNED', id, { kind: 'stone', position });
  });

  // One wild animal, placed at a valid remove from spawn.
  const animalPositions = scatter(rand, 1, taken, 4.0, 7.0, 2.0);
  const animalPos = animalPositions[0] ?? { x: -4, z: 4 };
  state.entities['deer-01'] = { id: 'deer-01', kind: 'animal', species: 'deer', position: animalPos, state: 'wandering' };
  emit('ENTITY_SPAWNED', 'deer-01', { kind: 'animal', species: 'deer', position: animalPos });

  emit('WORLD_INITIALIZED', undefined, {
    wilderness: WILDERNESS_VERSION, seed,
    treeCount: treePositions.length, berryPatchCount: patchPositions.length,
    branchCount: branchPositions.length, stoneCount: stonePositions.length,
    wood: 0, food: 1, water: 1, workers: 1,
  });
  return state;
}
