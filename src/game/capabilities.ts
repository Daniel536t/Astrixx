/**
 * Shared capability registry: the ONE place that knows what the inhabitant
 * can do, what it costs, and what is honestly not implemented.
 *
 * Before this registry, supported actions were listed independently in the
 * model prompt, the MCP tool list, the planner, and the validators. Those
 * lists stay where they are (no broad rewrite), but every honest
 * clarification and every capability question is now answered from HERE, so
 * the agent can never describe a capability the simulation lacks.
 *
 * Missing capabilities are first-class entries: each names what was
 * understood, what is missing, and the nearest working alternative. When a
 * command hits one, the parser returns its explanation AND records a
 * capability gap for future development instead of a dead-end refusal.
 */

export interface CapabilityDef {
  /** Stable identifier (action type, recipe id, or topic key). */
  id: string;
  /** Human-readable description with real costs. */
  description: string;
  /** Short precondition text. */
  requires: string;
  /** True when the simulation executes it today. */
  implemented: boolean;
}

export const ACTION_CAPABILITIES: CapabilityDef[] = [
  { id: 'GATHER', description: 'Chop a standing tree (two blows with the basic axe, one with stone).', requires: 'standing tree', implemented: true },
  { id: 'HARVEST', description: 'Gather an available berry patch, a ready farm, or draw from well/pond.', requires: 'available patch, ready farm, well, or pond', implemented: true },
  { id: 'PICK_UP', description: 'Pick up a ground log, food basket, or waterskin for the haul home.', requires: 'ground resource, free hands', implemented: true },
  { id: 'DELIVER', description: 'Carry the load to the camp stockpile.', requires: 'carrying something', implemented: true },
  { id: 'COLLECT', description: 'Pocket a fallen branch or loose stone (pack capacity enforced).', requires: 'ground branch/stone, free hands, pack space', implemented: true },
  { id: 'CRAFT', description: 'Work a recipe at camp: stone axe (3 branch + 2 stone, needs basic axe) or basket (4 branch).', requires: 'recipe inputs in pack, free hands, at camp', implemented: true },
  { id: 'REST', description: 'Sleep at a complete shelter; timed work runs 1.5× faster while rested.', requires: 'complete shelter, free hands', implemented: true },
  { id: 'BUILD', description: 'Raise a house blueprint on a free slot, a farm, or a free-placed shelter.', requires: 'settlement + materials; always HIGH risk', implemented: true },
  { id: 'PLANT', description: 'Replant a depleted stump; saplings mature on their own.', requires: 'depleted tree stump', implemented: true },
  { id: 'MOVE_TO', description: 'Reposition without gathering.', requires: 'any entity', implemented: true },
];

export interface MissingCapability {
  /** What the player seemed to want. */
  understood: string;
  /** The capability that does not exist. */
  missing: string;
  /** Nearest working alternative, or null when there is none. */
  alternative: string | null;
}

export const MISSING_CAPABILITIES: Record<string, MissingCapability> = {
  'bridge': {
    understood: 'a way across a river or gap',
    missing: 'a river to cross and a bridge-building mechanic',
    alternative: 'say "build a house" or "build a shelter" to raise a real structure',
  },
  'granary': {
    understood: 'somewhere to store food',
    missing: 'a storage-building mechanic (stockpiles are safe and unlimited)',
    alternative: 'keep gathering (stockpiles hold everything), or "build a shelter" for a rest stop',
  },
  'hunting': {
    understood: 'meat from wildlife',
    missing: 'hunting, weapons, and butchering',
    alternative: '"status" shows the deer; berries and farms cover food',
  },
  'taming': {
    understood: 'a tamed or captured animal',
    missing: 'taming, trapping, pens, and animal husbandry',
    alternative: '"status" shows the deer; no action can catch it yet',
  },
  'defense': {
    understood: 'protection against attackers',
    missing: 'combat, walls, or threats',
    alternative: '"build a house" grows the settlement; safety is not currently at stake',
  },
  'warmth': {
    understood: 'staying warm at night',
    missing: 'temperature, nights, or fuel',
    alternative: '"build a shelter" gives a verified rest stop that speeds later work',
  },
  'bow': {
    understood: 'a ranged weapon',
    missing: 'bows and hunting',
    alternative: '"make a better axe" crafts a stone axe that fells trees in one blow',
  },
  'knife': {
    understood: 'a cutting blade',
    missing: 'a carving or skinning use for blades',
    alternative: '"make a better axe" for a real tool upgrade, or "make a basket" for +5 pack space',
  },
  'workshop': {
    understood: 'a dedicated crafting building',
    missing: 'dedicated crafting buildings (all crafting happens at camp)',
    alternative: '"make a better axe" works at the camp right now',
  },
  'layout': {
    understood: 'several buildings arranged relative to each other',
    missing: 'multi-structure layout planning (each goal raises one structure)',
    alternative: 'build sequentially: "build a cottage", then place the next with "near the camp" or coordinates',
  },
  'fishing': {
    understood: 'food from the pond',
    missing: 'fishing (the pond gives water only)',
    alternative: '"fetch water" draws from the pond; berries and farms cover food',
  },
  'mining': {
    understood: 'ore, coal, or iron',
    missing: 'mining and ores (loose stones are the only rock resource)',
    alternative: 'collect stones for the stone axe',
  },
};

export function capabilitySummary(): string {
  return ACTION_CAPABILITIES.filter((c) => c.implemented)
    .map((c) => `${c.id} (${c.requires})`)
    .join('; ');
}

export function missingSummary(): string {
  return 'Only stone-axe and carrying-basket are craftable; only lean-to shelters, houses, and farms are buildable. No hunting, taming, bridges, granaries, workshops, combat, or fishing.';
}
