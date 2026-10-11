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
  | { kind: 'near'; entity: EntityRef }
  | { kind: 'edge'; dir: Compass };

/** Distance from the camp to the clearing edge (inside the buildable square). */
export const CLEARING_EDGE = 7;

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
  if (/\b(edge|border|rim|perimeter|outskirts)\b/.test(input)) {
    for (const [pattern, dir] of COMPASS_WORDS) {
      if (pattern.test(input)) return { intent: { kind: 'edge', dir }, note: `along the ${dir} edge of the clearing` };
    }
  }
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
  if (intent.kind === 'edge') {
    const camp = state.entities['settlement-01'];
    const origin = camp && 'position' in camp ? camp.position : { x: 0, z: 0 };
    const vec = COMPASS_VECTORS[intent.dir];
    return {
      ok: true,
      x: Math.round((origin.x + vec.x * CLEARING_EDGE) * 100) / 100,
      z: Math.round((origin.z + vec.z * CLEARING_EDGE) * 100) / 100,
      description: `the ${intent.dir} edge of the clearing`,
    };
  }
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

export interface ResolvedSites {
  ok: true;
  sites: Array<{ x: number; z: number }>;
  description: string;
}

/**
 * Multi-structure placement: one approximate intent spread into `quantity`
 * candidate sites, spaced so neighbouring footprints never overlap. Sites
 * run perpendicular to the compass direction (a row ALONG the northern
 * edge runs east-west). Exact coordinates name a single site only.
 * Each site is still validated (with tolerance) at execution.
 */
export function resolvePlaceSites(
  state: Readonly<WorldState>,
  intent: PlaceIntent,
  quantity: number,
  from: { x: number; z: number },
  footprint: number,
): ResolvedSites | UnresolvedSite {
  if (intent.kind === 'exact' && quantity > 1) {
    return { ok: false, clarify: `Exact coordinates name one site, but ${quantity} structures were requested. Give an approximate area (e.g. "along the northern edge") or place them one at a time with coordinates.` };
  }
  const centre = resolvePlaceIntent(state, intent, from);
  if (!centre.ok) return centre;
  if (quantity <= 1) return { ok: true, sites: [{ x: centre.x, z: centre.z }], description: centre.description };
  const dir = intent.kind === 'relative' || intent.kind === 'edge' ? COMPASS_VECTORS[intent.dir] : { x: 0, z: -1 };
  const across = { x: -dir.z, z: dir.x };
  const spacing = footprint * 2 + 0.8;
  const sites = Array.from({ length: quantity }, (_, i) => {
    const offset = (i - (quantity - 1) / 2) * spacing;
    return { x: Math.round((centre.x + across.x * offset) * 100) / 100, z: Math.round((centre.z + across.z * offset) * 100) / 100 };
  });
  return { ok: true, sites, description: `${quantity} sites ${spacing.toFixed(1)} apart around ${centre.description}` };
}

/**
 * Which requested site each structure fulfils: greedy, nearest-first, one
 * structure per site, within the approximate-placement tolerance. Pure —
 * the planner and goal completion read the same answer.
 */
export function claimSites<T extends { x: number; z: number }>(
  sites: ReadonlyArray<{ x: number; z: number }>,
  structures: ReadonlyArray<T>,
  tolerance: number,
): Array<T | null> {
  const used = new Set<number>();
  return sites.map((site) => {
    let best = -1;
    let bestDist = Infinity;
    structures.forEach((s, index) => {
      if (used.has(index)) return;
      const d = Math.hypot(s.x - site.x, s.z - site.z);
      if (d <= tolerance + 0.25 && d < bestDist) {
        best = index;
        bestDist = d;
      }
    });
    if (best < 0) return null;
    used.add(best);
    return structures[best]!;
  });
}

const COMPASS_SET = new Set<string>(Object.keys(COMPASS_VECTORS));

/**
 * Schema check for a model-supplied placement intent. Only shapes the
 * deterministic resolver understands pass; anything else is rejected, so a
 * model can never smuggle raw coordinates past the exact/approximate rules.
 */
export function validatePlaceIntent(value: unknown): PlaceIntent | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const ref = (r: unknown): EntityRef | null => {
    if (typeof r !== 'object' || r === null) return null;
    const k = (r as Record<string, unknown>)['kind'];
    if (k === 'camp' || k === 'pond') return { kind: k };
    const which = (r as Record<string, unknown>)['which'];
    if (k === 'tree' && typeof which === 'string' && /^(largest|nearest|tree-\d{2})$/.test(which)) return { kind: 'tree', which };
    return null;
  };
  switch (v['kind']) {
    case 'auto':
      return { kind: 'auto' };
    case 'exact':
      return typeof v['x'] === 'number' && typeof v['z'] === 'number' && Number.isFinite(v['x']) && Number.isFinite(v['z']) ? { kind: 'exact', x: v['x'], z: v['z'] } : null;
    case 'relative': {
      const from = ref(v['from']);
      if (!from || typeof v['dir'] !== 'string' || !COMPASS_SET.has(v['dir']) || (v['dist'] !== 'near' && v['dist'] !== 'far')) return null;
      return { kind: 'relative', from, dir: v['dir'] as Compass, dist: v['dist'] };
    }
    case 'near': {
      const entity = ref(v['entity']);
      return entity ? { kind: 'near', entity } : null;
    }
    case 'edge':
      return typeof v['dir'] === 'string' && COMPASS_SET.has(v['dir']) ? { kind: 'edge', dir: v['dir'] as Compass } : null;
    default:
      return null;
  }
}
