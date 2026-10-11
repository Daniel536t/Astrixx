/**
 * Crafting recipes: the transformation chain from raw wilderness materials
 * to new capabilities. Recipes are DATA — the engine (WorldSimulation),
 * the planner, and the validators all read this registry, so adding a
 * recipe never means duplicating logic across command handlers.
 *
 * Slice policy: every listed recipe must be executable end-to-end AND its
 * output must change a real mechanic. Decorative outputs are refused here,
 * not implied. (Knife/arrows wait on hunting mechanics — see CRAFTING doc.)
 */
import type { WorldState } from '../world/types';

export type RecipeId = 'stone-axe' | 'carrying-basket';

export interface Recipe {
  id: RecipeId;
  /** One-line human description for the Observatory and clarifications. */
  description: string;
  /** Material units consumed from worker inventory, exactly once at completion. */
  inputs: { branch?: number; stone?: number };
  /** Equipment the worker must already hold (checked at start AND completion). */
  requiresAxe?: 'basic-axe' | 'stone-axe';
  /** Work time in sim-seconds at the camp. */
  workSeconds: number;
  /** What completion grants. Exactly one of these. */
  output:
    | { kind: 'axe'; axe: 'stone-axe' }
    | { kind: 'basket'; capacity: number };
}

export const RECIPES: Record<RecipeId, Recipe> = {
  'stone-axe': {
    id: 'stone-axe',
    description: 'Stone axe: 3 branches + 2 stones, shaped with the basic axe at camp. Fells trees in one blow instead of two.',
    inputs: { branch: 3, stone: 2 },
    requiresAxe: 'basic-axe',
    workSeconds: 3.0,
    output: { kind: 'axe', axe: 'stone-axe' },
  },
  'carrying-basket': {
    id: 'carrying-basket',
    description: 'Carrying basket: 4 woven branches at camp. Raises inventory capacity from 10 to 15.',
    inputs: { branch: 4 },
    workSeconds: 2.0,
    output: { kind: 'basket', capacity: 15 },
  },
};

export function recipeList(): Recipe[] {
  return Object.values(RECIPES);
}

export function getRecipe(id: string): Recipe | undefined {
  if (id === 'stone-axe' || id === 'carrying-basket') return RECIPES[id];
  return undefined;
}

export interface CraftReadiness {
  ok: boolean;
  reason: string;
}

/**
 * Execution-time readiness: inputs present, prerequisites held, output not
 * already owned. Called at craft START and re-checked at COMPLETION, because
 * the world can change while the worker walks and works.
 */
export function checkCraft(
  state: Readonly<WorldState>,
  workerId: string,
  recipe: Recipe,
): CraftReadiness {
  const worker = state.entities[workerId];
  if (!worker || worker.kind !== 'worker') return { ok: false, reason: 'worker missing' };
  if (worker.carrying) return { ok: false, reason: 'hands full: deliver the load before crafting' };
  if (recipe.requiresAxe && worker.equipment.axe !== recipe.requiresAxe) {
    return { ok: false, reason: `requires an equipped ${recipe.requiresAxe}` };
  }
  for (const [material, need] of Object.entries(recipe.inputs)) {
    const have = worker.inventory[material] ?? 0;
    if (have < (need ?? 0)) return { ok: false, reason: `missing ${material}: need ${need}, have ${have}` };
  }
  if (recipe.output.kind === 'axe' && worker.equipment.axe === recipe.output.axe) {
    return { ok: false, reason: 'already equipped' };
  }
  if (recipe.output.kind === 'basket' && worker.equipment.basket) {
    return { ok: false, reason: 'already equipped' };
  }
  return { ok: true, reason: 'ready' };
}

/** Goal completion: the worker actually holds the recipe's output. */
export function recipeSatisfied(state: Readonly<WorldState>, workerId: string, recipe: Recipe): boolean {
  const worker = state.entities[workerId];
  if (!worker || worker.kind !== 'worker') return false;
  if (recipe.output.kind === 'axe') return worker.equipment.axe === recipe.output.axe;
  return worker.equipment.basket && worker.capacity >= recipe.output.capacity;
}
