/**
 * Architectural blueprint registry: data-driven building designs.
 *
 * A blueprint decides REAL construction parameters — cost, duration,
 * footprint, entity kind, and rendered asset — so adding a design never
 * means forking the construction implementation. Unknown IDs fail safely;
 * the registry never invents prices or properties.
 */

export type BlueprintCategory = 'shelter' | 'residence';

export interface Blueprint {
  /** Stable ID used in goals, proposals, entities, and rendering. */
  id: string;
  name: string;
  category: BlueprintCategory;
  description: string;
  /** World entity kind produced. */
  kind: 'shelter' | 'house';
  woodCost: number;
  branchCost: number;
  buildSeconds: number;
  footprint: number;
  /** Renderer asset key. One key, one silhouette — never shared silently. */
  asset: 'lean-to' | 'homestead' | 'cabin' | 'cottage';
}

export const BLUEPRINTS: Record<string, Blueprint> = {
  'lean-to': {
    id: 'lean-to',
    name: 'Woodland lean-to',
    category: 'shelter',
    description: 'A low canvas lean-to on poles. Free-placed, with a verified rest stop.',
    kind: 'shelter',
    woodCost: 2,
    branchCost: 2,
    buildSeconds: 6,
    footprint: 1.2,
    asset: 'lean-to',
  },
  'homestead': {
    id: 'homestead',
    name: 'Homestead cabin',
    category: 'residence',
    description: 'The original 2-wood settler cabin on a fixed plot. Backward-compatible default.',
    kind: 'house',
    woodCost: 2,
    branchCost: 0,
    buildSeconds: 2.4,
    footprint: 1.2,
    asset: 'homestead',
  },
  'timber-cabin': {
    id: 'timber-cabin',
    name: 'Timber cabin',
    category: 'residence',
    description: 'A tall, steep-gabled timber cabin for 4 wood. Stands above the homestead.',
    kind: 'house',
    woodCost: 4,
    branchCost: 0,
    buildSeconds: 5,
    footprint: 1.4,
    asset: 'cabin',
  },
  'thatched-cottage': {
    id: 'thatched-cottage',
    name: 'Thatched cottage',
    category: 'residence',
    description: 'A wide, low cottage with a thatch roof: 2 wood + 2 branches.',
    kind: 'house',
    woodCost: 2,
    branchCost: 2,
    buildSeconds: 3.5,
    footprint: 1.6,
    asset: 'cottage',
  },
};

export function getBlueprint(id: string | undefined): Blueprint | undefined {
  if (!id) return undefined;
  return BLUEPRINTS[id];
}

/** Default when a build names no design: the legacy homestead, unchanged. */
export const DEFAULT_HOUSE_BLUEPRINT = 'homestead';

export function blueprintList(): Blueprint[] {
  return Object.values(BLUEPRINTS);
}

export function cheapestResidence(): Blueprint {
  return BLUEPRINTS['homestead']!;
}
