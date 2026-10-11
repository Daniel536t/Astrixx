/**
 * Deterministic placement authority: pure, inspectable site validation
 * shared by the planner (site picking), the decision validator
 * (planning-time check), and the simulation (execution-time re-check).
 * One rule table, three callers.
 */
import { SHELTER_FOOTPRINT, type Vec2, type WorldState } from '../world/types';

export interface SiteVerdict {
  ok: boolean;
  reason: string;
}

/** Half-extent of the buildable wilderness square. */
export const BUILD_BOUNDS = 9;

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function validateShelterSite(state: Readonly<WorldState>, x: number, z: number, ignoreId?: string): SiteVerdict {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return { ok: false, reason: 'site is not a valid position' };
  if (Math.abs(x) > BUILD_BOUNDS || Math.abs(z) > BUILD_BOUNDS) {
    return { ok: false, reason: 'site is outside the buildable clearing' };
  }
  const at = { x, z };
  const R = SHELTER_FOOTPRINT;
  for (const entity of Object.values(state.entities)) {
    if (!('position' in entity)) continue;
    // The claimant never blocks its own site: the builder walks INTO the
    // arrival ring, and a 0.376-unit step can land inside the worker
    // exclusion radius. Without this, the walk overshoots the arrival
    // window and every later drive fails against the builder itself.
    if (ignoreId !== undefined && entity.id === ignoreId) continue;
    const d = dist(at, entity.position);
    switch (entity.kind) {
      case 'settlement':
        if (d < 2.8) return { ok: false, reason: 'site overlaps the camp' };
        break;
      case 'pond':
        if (d < entity.radius + R + 0.2) return { ok: false, reason: 'site is in the water' };
        break;
      case 'tree':
        if (d < R + 0.6) return { ok: false, reason: `site overlaps ${entity.id}` };
        break;
      case 'berry-patch':
      case 'well':
        if (d < R + 0.4) return { ok: false, reason: `site overlaps ${entity.id}` };
        break;
      case 'house':
      case 'farm':
      case 'shelter':
        if (d < R + 1.8) return { ok: false, reason: `site overlaps ${entity.id}` };
        break;
      case 'branch':
      case 'stone':
        if (entity.state === 'ground' && d < R - 0.3) return { ok: false, reason: `site buries ${entity.id}` };
        break;
      case 'worker':
      case 'villager':
        if (d < R) return { ok: false, reason: 'site is occupied' };
        break;
      default:
        break;
    }
  }
  return { ok: true, reason: 'clear ground' };
}

/**
 * Deterministic site picking: ring candidates around the camp, nearest
 * valid wins. Same state → same site, so plans, validation, and execution
 * never disagree about where the shelter goes.
 */
export function findShelterSite(state: Readonly<WorldState>, from: Vec2): Vec2 | null {
  const camp = state.entities['settlement-01'];
  const origin = camp && 'position' in camp ? camp.position : { x: 0, z: 0 };
  let best: Vec2 | null = null;
  let bestDist = Infinity;
  for (const radius of [3.5, 4.5, 5.5, 6.5, 7.5]) {
    for (let i = 0; i < 12; i += 1) {
      const angle = (i / 12) * Math.PI * 2;
      const candidate = { x: origin.x + Math.cos(angle) * radius, z: origin.z + Math.sin(angle) * radius };
      if (!validateShelterSite(state, candidate.x, candidate.z).ok) continue;
      const d = dist(from, candidate);
      if (d < bestDist) {
        bestDist = d;
        best = candidate;
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Placement tolerance for APPROXIMATE requests ("east of the camp"): spiral
 * offsets around the requested point, first valid wins. Exact-coordinate
 * requests never use this — they fail loudly instead. Fixed offsets, fixed
 * order: fully deterministic.
 */
export function searchNearbySite(
  state: Readonly<WorldState>,
  x: number,
  z: number,
  tolerance: number,
  ignoreId?: string,
): Vec2 | null {
  for (const radius of [0.5, 1.0, 1.5, 2.0]) {
    if (radius > tolerance) break;
    for (let i = 0; i < 8; i += 1) {
      const angle = (i / 8) * Math.PI * 2;
      const candidate = {
        x: Math.round((x + Math.cos(angle) * radius) * 100) / 100,
        z: Math.round((z + Math.sin(angle) * radius) * 100) / 100,
      };
      if (validateShelterSite(state, candidate.x, candidate.z, ignoreId).ok) return candidate;
    }
  }
  return null;
}
