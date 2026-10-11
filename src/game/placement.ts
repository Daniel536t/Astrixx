/**
 * Location intent: what "where" means before it becomes coordinates.
 *
 * World conventions (documented once, used everywhere): X grows east,
 * Z grows south — so north is -Z, east is +X. `near` is ~3.2 units from the
 * landmark, `far` is ~6.5. Parsing is stateless text work; resolution reads
 * authoritative state. An exact request that fails validation is REJECTED,
 * never silently relocated — the refusal names the reason.
 */
import type { WorldState } from '../world/types';

export type Compass = 'north' | 'northeast' | 'east' | 'southeast' | 'south' | 'southwest' | 'west' | 'northwest';

export type EntityRef =
  | { kind: 'camp' }
  | { kind: 'pond' }
  | { kind: 'tree'; which: string };

export type PlaceIntent =
  | { kind: 'auto' }
  | { kind: 'exact'; x: number; z: number }
  | { kind: 'relative'; from: EntityRef; dir: Compass; dist: 'near' | 'far' }
  | { kind: 'near'; entity: EntityRef };

export const COMPASS_VECTORS: Record<Compass, { x: number; z: number }> = {
  north: { x: 0, z: -1 },
  northeast: { x: 0.7071, z: -0.7071 },
  east: { x: 1, z: 0 },
  southeast: { x: 0.7071, z: 0.7071 },
  south: { x: 0, z: 1 },
  southwest: { x: -0.7071, z: 0.7071 },
  west: { x: -1, z: 0 },
  northwest: { x: -0.7071, z: -0.7071 },
};

const COMPASS_WORDS: Array<[RegExp, Compass]> = [
  [/\bnorth-?east\b/, 'northeast'],
  [/\bsouth-?east\b/, 'southeast'],
  [/\bsouth-?west\b/, 'southwest'],
  [/\bnorth-?west\b/, 'northwest'],
  [/\bnorth(ern)?\b/, 'north'],
  [/\bsouth(ern)?\b/, 'south'],
  [/\beast(ern)?\b/, 'east'],
  [/\bwest(ern)?\b/, 'west'],
];

/** Extract a placement intent from command text. Pure text work, no world. */
export function parsePlaceIntent(input: string): { intent: PlaceIntent; note: string } {
  const exact = input.match(/\bx\s*:?\s*(-?\d+(?:\.\d+)?)[,\s]+z\s*:?\s*(-?\d+(?:\.\d+)?)/i);
  if (exact) {
    return {
      intent: { kind: 'exact', x: Number(exact[1]), z: Number(exact[2]) },
      note: `exact requested position X:${exact[1]} Z:${exact[2]}`,
    };
  }
  const landmark = parseLandmark(input);
  for (const [pattern, dir] of COMPASS_WORDS) {
    if (pattern.test(input)) {
      const dist = /\b(far|distant|deep)\b/.test(input) ? 'far' as const : 'near' as const;
      const from = landmark ?? { kind: 'camp' } as EntityRef;
      return {
        intent: { kind: 'relative', from, dir, dist },
        note: `${dist} ${dir} of ${describeRef(from)}`,
      };
    }
  }
  if (/\b(beside|near|by|around|next to|close to|along)\b/.test(input)) {
    if (!landmark) {
      return { intent: { kind: 'auto' }, note: 'no clear landmark; automatic placement' };
    }
    return { intent: { kind: 'near', entity: landmark }, note: `near ${describeRef(landmark)}` };
  }
  return { intent: { kind: 'auto' }, note: 'automatic placement' };
}

function parseLandmark(input: string): EntityRef | null {
  if (/\b(camp|settlement|fire)\b/.test(input)) return { kind: 'camp' };
  if (/\b(pond|water|stream|lake)\b/.test(input)) return { kind: 'pond' };
  const treeId = input.match(/\btree-0(\d)\b/);
  if (treeId) return { kind: 'tree', which: `tree-0${treeId[1]}` };
  if (/\b(largest|biggest|tallest)\b.*\btree\b/.test(input) || /\btree\b.*\b(largest|biggest|tallest)\b/.test(input)) {
    return { kind: 'tree', which: 'largest' };
  }
  if (/\b(nearest|closest)\b.*\btree\b/.test(input)) return { kind: 'tree', which: 'nearest' };
  if (/\btree\b/.test(input) && /\b(which|what|that)\b/.test(input)) return { kind: 'tree', which: '?' };
  return null;
}

function describeRef(ref: EntityRef): string {
  if (ref.kind === 'camp') return 'the camp';
  if (ref.kind === 'pond') return 'the pond';
  if (ref.which === 'largest') return 'the largest standing tree';
  if (ref.which === 'nearest') return 'the nearest standing tree';
  return ref.which;
}

export interface ResolvedSite {
  ok: true;
  x: number;
  z: number;
  description: string;
}

export interface UnresolvedSite {
  ok: false;
  clarify: string;
}

/**
 * Resolve an intent against authoritative entities. Returns exact
 * coordinates plus a human-readable derivation — or a targeted question
 * when the reference is ambiguous.
 */
export function resolvePlaceIntent(
  state: Readonly<WorldState>,
  intent: PlaceIntent,
  from: { x: number; z: number },
): ResolvedSite | UnresolvedSite {
  if (intent.kind === 'auto') return { ok: false, clarify: '__AUTO__' };
  if (intent.kind === 'exact') return { ok: true, x: intent.x, z: intent.z, description: `exact requested position X:${intent.x} Z:${intent.z}` };
  const landmark = lookupLandmark(state, intent.kind === 'relative' ? intent.from : intent.entity, from);
  if (!landmark.ok) return landmark;
  if (intent.kind === 'near') {
    return { ok: true, x: landmark.x, z: landmark.z, description: `near ${landmark.description}` };
  }
  const vec = COMPASS_VECTORS[intent.dir];
  const radius = intent.dist === 'far' ? 6.5 : 3.2;
  return {
    ok: true,
    x: Math.round((landmark.x + vec.x * radius) * 100) / 100,
    z: Math.round((landmark.z + vec.z * radius) * 100) / 100,
    description: `${intent.dist} ${intent.dir} of ${landmark.description}`,
  };
}

function lookupLandmark(
  state: Readonly<WorldState>,
  ref: EntityRef,
  from: { x: number; z: number },
): { ok: true; x: number; z: number; description: string } | UnresolvedSite {
  if (ref.kind === 'camp') {
    const camp = state.entities['settlement-01'];
    const pos = camp && 'position' in camp ? camp.position : { x: 0, z: 0 };
    return { ok: true, x: pos.x, z: pos.z, description: 'the camp' };
  }
  if (ref.kind === 'pond') {
    const pond = state.entities['pond-01'];
    if (!pond || !('position' in pond)) return { ok: false, clarify: 'There is no pond landmark in this world right now.' };
    return { ok: true, x: pond.position.x, z: pond.position.z, description: 'the pond' };
  }
  const trees = Object.values(state.entities).filter(
    (e): e is Extract<typeof e, { kind: 'tree' }> => e.kind === 'tree' && e.state === 'standing',
  );
  if (trees.length === 0) return { ok: false, clarify: 'There is no standing tree to measure from — every tree is felled.' };
  if (ref.which === '?') {
    return { ok: false, clarify: `Which tree — the nearest, the largest, or an ID such as ${trees[0]!.id}?` };
  }
  if (ref.which === 'largest') {
    // Largest = healthiest standing tree, lowest ID breaks ties. Stable and
    // inspectable — the resolution names the tree it chose.
    const best = [...trees].sort((a, b) => b.health - a.health || (a.id < b.id ? -1 : 1))[0]!;
    return { ok: true, x: best.position.x, z: best.position.z, description: `${best.id} (the largest standing tree)` };
  }
  if (ref.which === 'nearest') {
    const best = [...trees].sort(
      (a, b) => Math.hypot(a.position.x - from.x, a.position.z - from.z) - Math.hypot(b.position.x - from.x, b.position.z - from.z),
    )[0]!;
    return { ok: true, x: best.position.x, z: best.position.z, description: `${best.id} (the nearest standing tree)` };
  }
  const named = state.entities[ref.which];
  if (!named || !('position' in named)) return { ok: false, clarify: `There is no ${ref.which} in this world. Standing trees: ${trees.map((t) => t.id).join(', ')}.` };
  return { ok: true, x: named.position.x, z: named.position.z, description: ref.which };
}
