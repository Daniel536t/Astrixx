/**
 * Reactive step planner: given the active goal and a fresh observation,
 * return the single next decision. No fixed sequences — every step is
 * re-derived from current state, so depletion, failure, and reprioritization
 * change behavior on the very next turn.
 */
import { FARM_WOOD_COST, SETTLEMENT_ID, SHELTER_BRANCH_COST, SHELTER_WOOD_COST, distance } from '../world/types';
import type { ActionType } from '../world/types';import type { AgentDecision, AgentObservation } from '../agent/Agent';
import type { GameGoal } from './goals';
import { getRecipe } from './recipes';
import { BLUEPRINTS, DEFAULT_HOUSE_BLUEPRINT, getBlueprint } from './blueprints';
import { claimSites } from './placement';
import { HOUSE_SITE_TOLERANCE } from './shelter';

function nearest<T extends { x: number; z: number }>(from: { x: number; z: number }, items: T[]): T | undefined {
  let best: T | undefined;
  let bestDist = Infinity;
  for (const item of items) {
    const d = distance(from, { x: item.x, z: item.z });
    if (d < bestDist) {
      bestDist = d;
      best = item;
    }
  }
  return best;
}

/** Deliver what is carried, preferring nothing — carrying always resolves first. */
function resolveCarrying(obs: AgentObservation, reason: string): AgentDecision | null {
  if (!obs.worker.carrying) return null;
  return { actionType: 'DELIVER', targetEntityId: SETTLEMENT_ID, reason };
}

/**
 * Goal-relevance: legality says the sim CAN do it; relevance says it serves
 * the active goal. A legal-but-off-goal model decision (gathering wood
 * during food preservation) is rejected as a miss, not executed.
 */
export function isGoalRelevant(
  goal: GameGoal,
  obs: AgentObservation,
  action: { actionType: ActionType; targetEntityId: string },
): boolean {
  if (action.actionType === 'MOVE_TO') return true;
  // Finishing an in-flight haul is always relevant.
  if (action.actionType === 'DELIVER') return obs.worker.carrying !== null;
  const isLogPickup = action.actionType === 'PICK_UP' && obs.logs.some((l) => l.id === action.targetEntityId);
  const isFoodPickup = action.actionType === 'PICK_UP' && obs.foodResources.some((f) => f.id === action.targetEntityId);
  const isWaterPickup = action.actionType === 'PICK_UP' && obs.foodResources.some((f) => f.id === action.targetEntityId && f.kind === 'water');
  const isWellHarvest = action.actionType === 'HARVEST' && (obs.wells ?? []).some((w) => w.id === action.targetEntityId);
  const isMaterialCollect = action.actionType === 'COLLECT'
    && [...obs.branches, ...obs.stones].some((m) => m.id === action.targetEntityId);
  // Satiation: gathering beyond the goal's need is off-goal, even when legal.
  // (This stopped a real hoarding loop where the model kept gathering wood
  // past the construction budget instead of building.)
  switch (goal.kind) {
    case 'gather-wood':
      if (obs.wood >= goal.quantity) return false;
      return action.actionType === 'GATHER' || isLogPickup;
    case 'gather-food':
      if (obs.food >= goal.quantity) return false;
      return action.actionType === 'HARVEST' || isFoodPickup;
    case 'preserve':
      if (goal.resource === 'wood') {
        if (obs.wood >= goal.quantity) return false;
        return action.actionType === 'GATHER' || isLogPickup;
      }
      if (obs.food >= goal.quantity) return false;
      return action.actionType === 'HARVEST' || isFoodPickup;
    case 'construct-house': {
      const bp = getBlueprint(goal.blueprint ?? DEFAULT_HOUSE_BLUEPRINT) ?? BLUEPRINTS[DEFAULT_HOUSE_BLUEPRINT]!;
      const finished = obs.houses.filter((h) => h.complete && (!goal.blueprint || goal.blueprint === 'homestead' || h.blueprint === goal.blueprint)).length;
      if (finished >= goal.quantity) return false;
      if (action.actionType === 'BUILD') {
        return obs.wood >= bp.woodCost && (obs.inventory['branch'] ?? 0) >= bp.branchCost;
      }
      if (obs.wood >= bp.woodCost && (obs.inventory['branch'] ?? 0) >= bp.branchCost) return false;
      if (obs.wood < bp.woodCost) return action.actionType === 'GATHER' || isLogPickup;
      return action.actionType === 'COLLECT' && obs.branches.some((b) => b.id === action.targetEntityId);
    }
    case 'construct-farm':
      if (action.actionType === 'BUILD') return obs.wood >= FARM_WOOD_COST;
      if (obs.wood >= FARM_WOOD_COST) return false;
      return action.actionType === 'GATHER' || isLogPickup;
    case 'construct-shelter': {
      const sheltered = obs.shelters.filter((s) => s.complete).length;
      if (sheltered >= goal.quantity) return false;
      if (action.actionType === 'BUILD') {
        return obs.wood >= SHELTER_WOOD_COST && (obs.inventory['branch'] ?? 0) >= SHELTER_BRANCH_COST;
      }
      if (obs.wood >= SHELTER_WOOD_COST && (obs.inventory['branch'] ?? 0) >= SHELTER_BRANCH_COST) return false;
      const collectBranch = action.actionType === 'COLLECT'
        && obs.branches.some((b) => b.id === action.targetEntityId);
      if (obs.wood < SHELTER_WOOD_COST) return action.actionType === 'GATHER' || isLogPickup;
      return collectBranch;
    }
    case 'prioritize':
      if (goal.resource === 'food') return action.actionType === 'HARVEST' || isFoodPickup;
      return action.actionType === 'GATHER' || isLogPickup;
    case 'plant':
      return action.actionType === 'PLANT';
    case 'fetch-water':
      return isWellHarvest || isWaterPickup;
    case 'craft': {
      // Already holding the output: every craft action is off-goal.
      const recipe = getRecipe(goal.recipe ?? '');
      if (!recipe) return false;
      const have = { axe: obs.equipment.axe, basket: obs.equipment.basket };
      if (recipe.output.kind === 'axe' && have.axe === recipe.output.axe) return false;
      if (recipe.output.kind === 'basket' && have.basket) return false;
      if (action.actionType === 'CRAFT') {
        if (action.targetEntityId !== SETTLEMENT_ID) return false;
        // Relevant only when the deficit is closed: crafting early wastes the trip.
        return Object.entries(recipe.inputs).every(([material, need]) => (obs.inventory[material] ?? 0) >= (need ?? 0));
      }
      if (action.actionType === 'COLLECT' && isMaterialCollect) {
        const material = [...obs.branches, ...obs.stones].find((m) => m.id === action.targetEntityId)?.kind;
        const need = (material === 'branch' ? recipe.inputs.branch : recipe.inputs.stone) ?? 0;
        const load = Object.values(obs.inventory).reduce((sum, count) => sum + count, 0);
        // Needed, unclaimed-adjacent, and pack space: an irrelevant or
        // over-full collect is not progress.
        return (obs.inventory[material ?? ''] ?? 0) < need && load < obs.capacity;
      }
      return false;
    }
  }
}

export function nextStep(goal: GameGoal, obs: AgentObservation): AgentDecision | null {
  const avoidWood = goal.avoid?.includes('wood') ?? false;
  const avoidFood = goal.avoid?.includes('food') ?? false;
  const claimed = new Set(obs.claimedTargetIds ?? []);
  const at = { x: obs.worker.x, z: obs.worker.z };

  const gatherWoodStep = (): AgentDecision | null => {
    if (avoidWood) return null;
    const carried = resolveCarrying(obs, 'Carry the load home before gathering more.');
    if (carried) return carried;
    const log = obs.logs.find((l) => l.available && !claimed.has(l.id));
    if (log) return { actionType: 'PICK_UP', targetEntityId: log.id, reason: 'A felled log is ready to carry home.' };
    const tree = nearest(at, obs.trees.filter((t) => t.available && !claimed.has(t.id)));
    if (tree) return { actionType: 'GATHER', targetEntityId: tree.id, reason: 'The goal needs timber; take the nearest standing tree.' };
    return null;
  };

  const gatherFoodStep = (): AgentDecision | null => {
    if (avoidFood) return null;
    const carried = resolveCarrying(obs, 'Carry the load home before gathering more.');
    if (carried) return carried;
    const food = obs.foodResources.find((f) => f.available && !claimed.has(f.id));
    if (food) return { actionType: 'PICK_UP', targetEntityId: food.id, reason: 'Gathered food is ready to carry home.' };
    const patches = obs.berryPatches.filter((p) => p.available && !claimed.has(p.id));
    const readyFarms = obs.farms.filter((f) => f.available && !claimed.has(f.id));
    const options = [...patches.map((p) => ({ ...p, kind: 'patch' as const })), ...readyFarms.map((f) => ({ ...f, kind: 'farm' as const }))];
    const nearestSource = options.sort((a, b) => distance({ x: obs.worker.x, z: obs.worker.z }, { x: a.x, z: a.z }) - distance({ x: obs.worker.x, z: obs.worker.z }, { x: b.x, z: b.z }))[0];
    if (nearestSource) return { actionType: 'HARVEST', targetEntityId: nearestSource.id, reason: nearestSource.kind === 'farm' ? 'A farm crop is ready; harvest it for renewable food.' : 'The goal needs food; harvest the nearest available patch.' };
    return null;
  };

  const plantStep = (): AgentDecision | null => {
    const carried = resolveCarrying(obs, 'Carry the load home before planting.');
    if (carried) return carried;
    const stump = nearest(at, (obs.stumps ?? []).filter((s) => !claimed.has(s.id)));
    if (stump) return { actionType: 'PLANT', targetEntityId: stump.id, reason: 'A felled stump can take a sapling; replant the nearest site.' };
    return null;
  };

  const gatherWaterStep = (): AgentDecision | null => {
    const carried = resolveCarrying(obs, 'Carry the load home before drawing more.');
    if (carried) return carried;
    const water = obs.foodResources.find((f) => f.kind === 'water' && f.available && !claimed.has(f.id));
    if (water) return { actionType: 'PICK_UP', targetEntityId: water.id, reason: 'A filled waterskin is ready to carry home.' };
    const well = nearest(at, (obs.wells ?? []).filter((w) => !claimed.has(w.id)));
    if (well) return { actionType: 'HARVEST', targetEntityId: well.id, reason: 'The settlement needs water; draw from the well.' };
    return null;
  };

  const craftStep = (recipeId: string | undefined): AgentDecision | null => {
    const recipe = getRecipe(recipeId ?? '');
    if (!recipe) return null;
    // Output owned: goal is satisfied — never craft past completion.
    if (recipe.output.kind === 'axe' && obs.equipment.axe === recipe.output.axe) return null;
    if (recipe.output.kind === 'basket' && obs.equipment.basket) return null;
    const carried = resolveCarrying(obs, 'Deliver the load before crafting; the work needs free hands.');
    if (carried) return carried;
    // Close the deficit first: nearest available unit of a still-needed material.
    const deficit = (Object.entries(recipe.inputs) as Array<[string, number | undefined]>)
      .filter(([material, need]) => (obs.inventory[material] ?? 0) < (need ?? 0))
      .map(([material]) => material);
    if (deficit.length > 0) {
      const load = Object.values(obs.inventory).reduce((sum, count) => sum + count, 0);
      if (load >= obs.capacity) return null; // full pack: wait, don't spin
      const sources = [...obs.branches, ...obs.stones]
        .filter((m) => m.available && !claimed.has(m.id) && deficit.includes(m.kind));
      const source = nearest(at, sources);
      if (source) return { actionType: 'COLLECT', targetEntityId: source.id, reason: `The ${recipe.id} needs ${deficit.join(' and ')}; collect the nearest ${source.kind}.` };
      return null; // nothing left to collect: report blocked, don't invent
    }
    // Prerequisite tool missing (e.g. basic axe lost): honest stop, not a loop.
    if (recipe.requiresAxe && obs.equipment.axe !== recipe.requiresAxe) return null;
    return { actionType: 'CRAFT', targetEntityId: SETTLEMENT_ID, parameters: { recipe: recipe.id }, reason: `Materials ready for the ${recipe.id}; craft it at the camp.` };
  };

  const buildStep = (structure: 'farm', cost: number): AgentDecision | null => {
    if (obs.wood >= cost && !obs.worker.carrying) {
      return { actionType: 'BUILD', targetEntityId: SETTLEMENT_ID, parameters: { structure: 'farm' }, reason: `Wood reserve covers the ${cost}-wood ${structure}; propose construction.` };
    }
    return gatherWoodStep();
  };

  /** Blueprint-driven house step: cost, branches, and site flow from the design. */
  const buildHouseStep = (blueprintId: string | undefined, site: { x: number; z: number } | undefined): AgentDecision | null => {
    const bp = getBlueprint(blueprintId ?? DEFAULT_HOUSE_BLUEPRINT) ?? BLUEPRINTS[DEFAULT_HOUSE_BLUEPRINT]!;
    const carried = resolveCarrying(obs, 'Deliver the load before building; the work needs free hands.');
    if (carried) return carried;
    const branches = obs.inventory['branch'] ?? 0;
    if (obs.wood >= bp.woodCost && branches >= bp.branchCost && !obs.worker.carrying) {
      return { actionType: 'BUILD', targetEntityId: SETTLEMENT_ID, parameters: { structure: 'house', blueprint: bp.id, ...(site ? { x: site.x, z: site.z } : {}), ...(site && goal.exactSite ? { exact: true } : {}) }, reason: `Reserves cover the ${bp.name} (${bp.woodCost} wood${bp.branchCost > 0 ? ` + ${bp.branchCost} branch` : ''}); propose construction.` };
    }
    if (obs.wood < bp.woodCost) return gatherWoodStep();
    const source = nearest(at, [...obs.branches].filter((b) => b.available && !claimed.has(b.id)));
    if (source) return { actionType: 'COLLECT', targetEntityId: source.id, reason: `The ${bp.name} needs poles; collect the nearest branch.` };
    return null;
  };

  const buildShelterStep = (quantity: number, siteOverride?: { x: number; z: number }): AgentDecision | null => {
    const site = siteOverride ?? goal.site;
    const done = obs.shelters.filter((s) => s.complete).length;
    if (done >= quantity) return null; // goal completes on the next check; never over-build
    const carried = resolveCarrying(obs, 'Deliver the load before building; the work needs free hands.');
    if (carried) return carried;
    const branches = obs.inventory['branch'] ?? 0;
    // Funded: the simulation picks the deterministic free site at execution
    // (single placement authority — the planner never invents coordinates),
    // unless the goal already resolved an exact player-directed site.
    if (obs.wood >= SHELTER_WOOD_COST && branches >= SHELTER_BRANCH_COST && !obs.worker.carrying) {
      return { actionType: 'BUILD', targetEntityId: SETTLEMENT_ID, parameters: { structure: 'shelter', ...(site ? { x: site.x, z: site.z } : {}), ...(site && goal.exactSite ? { exact: true } : {}) }, reason: site ? `Materials ready; propose the shelter at the requested site (X:${site.x} Z:${site.z}).` : 'Wood and poles cover the shelter; propose construction at a clear site.' };
    }
    if (obs.wood < SHELTER_WOOD_COST) return gatherWoodStep();
    const source = nearest(at, [...obs.branches].filter((b) => b.available && !claimed.has(b.id)));
    if (source) return { actionType: 'COLLECT', targetEntityId: source.id, reason: 'The shelter needs poles; collect the nearest branch.' };
    return null;
  };

  switch (goal.kind) {
    case 'gather-wood':
      if (obs.wood >= goal.quantity) return null;
      return gatherWoodStep();
    case 'gather-food':
      if (obs.food >= goal.quantity) return null;
      return gatherFoodStep();
    case 'fetch-water':
      if (obs.water >= goal.quantity) return null;
      return gatherWaterStep();
    case 'preserve': {
      const have = goal.resource === 'wood' ? obs.wood : obs.food;
      if (have >= goal.quantity) return null;
      return goal.resource === 'wood' ? gatherWoodStep() : gatherFoodStep();
    }
    case 'construct-house': {
      if (goal.sites && goal.sites.length > 0) {
        // Multi-site: work the first site no finished house fulfils. A site
        // already claimed by an unfinished house resumes at that house's
        // actual position (it may have shifted within tolerance).
        const mine = obs.houses.filter((h) => !goal.blueprint || h.blueprint === goal.blueprint);
        const claims = claimSites(goal.sites, mine, HOUSE_SITE_TOLERANCE);
        const open = claims.findIndex((c) => c === null || !c.complete);
        if (open < 0) return null;
        const claimant = claims[open];
        return buildHouseStep(goal.blueprint, claimant ? { x: claimant.x, z: claimant.z } : goal.sites[open]);
      }
      const finished = obs.houses.filter((h) => h.complete && (!goal.blueprint || goal.blueprint === 'homestead' || h.blueprint === goal.blueprint)).length;
      if (finished >= goal.quantity) return null;
      return buildHouseStep(goal.blueprint, goal.site);
    }
    case 'construct-farm':
      return buildStep('farm', FARM_WOOD_COST);
    case 'construct-shelter': {
      if (goal.sites && goal.sites.length > 0) {
        const claims = claimSites(goal.sites, obs.shelters, 2.0);
        const open = claims.findIndex((c) => c === null || !c.complete);
        if (open < 0) return null;
        const claimant = claims[open];
        return buildShelterStep(Number.POSITIVE_INFINITY, claimant ? { x: claimant.x, z: claimant.z } : goal.sites[open]);
      }
      if (obs.shelters.filter((s) => s.complete).length >= goal.quantity) return null;
      return buildShelterStep(goal.quantity);
    }
    case 'prioritize':
      if (goal.resource === 'food') return gatherFoodStep();
      return gatherWoodStep();
    case 'plant':
      return plantStep();
    case 'craft':
      return craftStep(goal.recipe);
  }
}
