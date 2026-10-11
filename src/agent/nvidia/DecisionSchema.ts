/**
 * Structured action-decision contract between a model and ASTrix governance.
 *
 * The model proposes exactly one JSON object per turn. The gateway — never
 * the model — assigns risk, creates the proposal, and enforces approval.
 * Model-supplied `execution` parameters (e.g. `magicblock-er`) are always
 * stripped: the model cannot escalate itself onto the chain path.
 */
import type { ActionType, WorldState } from '../../world/types';
import { FARM_WOOD_COST, HOUSE_SLOTS, FARM_SLOTS, SETTLEMENT_ID, SHELTER_FOOTPRINT, SHELTER_WOOD_COST } from '../../world/types';
import { DEFAULT_HOUSE_BLUEPRINT, getBlueprint } from '../../game/blueprints';
import { findShelterSite, HOUSE_SITE_TOLERANCE, searchNearbySite, validateSite } from '../../game/shelter';
import type { AgentObservation } from '../Agent';

/**
 * Planning-time site legality for BUILD. Mirrors execution: a structure of
 * this kind already underway at the site may be resumed; workers never block
 * a site (they move, and the builder walks into it); exact requests must be
 * valid as given; approximate ones need ground within the execution tolerance.
 */
function siteLegal(state: Readonly<WorldState>, kind: 'house' | 'shelter', x: number, z: number, footprint: number, exact: boolean, tolerance: number): boolean {
  const reach = exact ? 0.5 : tolerance;
  const underway = Object.values(state.entities).some(
    (e) => e.kind === kind && e.state === 'construction' && Math.hypot(e.position.x - x, e.position.z - z) <= reach,
  );
  if (underway) return true;
  const workers = new Set(Object.values(state.entities).filter((e) => e.kind === 'worker').map((e) => e.id));
  if (validateSite(state, x, z, footprint, workers).ok) return true;
  return !exact && searchNearbySite(state, x, z, tolerance, workers, footprint) !== null;
}

export const SUPPORTED_ACTION_TYPES: ActionType[] = ['MOVE_TO', 'GATHER', 'HARVEST', 'PICK_UP', 'DELIVER', 'BUILD', 'PLANT', 'COLLECT', 'CRAFT', 'REST'];

export interface StructuredAction {
  actionType: ActionType;
  targetEntityId: string;
  parameters?: Record<string, unknown>;
}

export interface StructuredDecision {
  /** Null action = explicit no-op: keep observing this turn. */
  action: StructuredAction | null;
  /** One-sentence statement of what the agent intends to achieve. */
  intent: string;
  /** Observable world change the agent expects if the action executes. */
  expectation: string;
  /** Optional standing-plan revision. Null/omitted keeps the current plan. */
  revisedPlan?: string | null;
}

export type DecisionRejectionReason =
  | 'not-json'
  | 'bad-shape'
  | 'unknown-action'
  | 'unknown-target'
  | 'illegal-target-state'
  | 'forbidden-parameter';

export interface ValidatedDecision {
  ok: true;
  decision: StructuredDecision;
}

export interface RejectedDecision {
  ok: false;
  reason: DecisionRejectionReason;
  detail: string;
}

export function parseStructuredDecision(rawText: string): StructuredDecision | null {
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? rawText).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!('action' in parsed) || typeof parsed['intent'] !== 'string' || typeof parsed['expectation'] !== 'string') {
      return null;
    }
    const action = parsed['action'] as Record<string, unknown> | null;
    if (action !== null) {
      if (typeof action !== 'object' || typeof action['actionType'] !== 'string' || typeof action['targetEntityId'] !== 'string') {
        return null;
      }
      if (action['parameters'] !== undefined && (typeof action['parameters'] !== 'object' || action['parameters'] === null)) {
        return null;
      }
    }
    return {
      action: action
        ? {
            actionType: action['actionType'] as ActionType,
            targetEntityId: action['targetEntityId'] as string,
            parameters: (action['parameters'] as Record<string, unknown> | undefined) ?? {},
          }
        : null,
      intent: parsed['intent'] as string,
      expectation: parsed['expectation'] as string,
      revisedPlan:
        typeof parsed['revisedPlan'] === 'string'
          ? (parsed['revisedPlan'] as string)
          : null,
    };
  } catch {
    return null;
  }
}

/**
 * Validate a parsed decision against the real action registry and the live
 * world state. Pure function — safe to unit-test with fixtures.
 */
export function validateDecisionAgainstWorld(
  decision: StructuredDecision,
  state: Readonly<WorldState>,
): ValidatedDecision | RejectedDecision {
  if (decision.action === null) return { ok: true, decision };
  const { actionType, targetEntityId, parameters } = decision.action;
  if (!SUPPORTED_ACTION_TYPES.includes(actionType)) {
    return { ok: false, reason: 'unknown-action', detail: `Unsupported actionType ${actionType}.` };
  }
  if (parameters && ('execution' in parameters || 'riskLevel' in parameters)) {
    return {
      ok: false,
      reason: 'forbidden-parameter',
      detail: 'The model must not set execution routing or risk levels.',
    };
  }
  const target = state.entities[targetEntityId];
  if (!target) {
    return { ok: false, reason: 'unknown-target', detail: `Target ${targetEntityId} does not exist.` };
  }
  const legal = (() => {
    switch (actionType) {
      case 'GATHER':
        return target.kind === 'tree' && target.state === 'standing';
      case 'HARVEST':
        return (target.kind === 'berry-patch' && target.state === 'available')
          || (target.kind === 'farm' && target.state === 'ready')
          || target.kind === 'well' || target.kind === 'pond';
      case 'PICK_UP':
        return (target.kind === 'log' || target.kind === 'food' || target.kind === 'water') && target.state === 'ground';
      case 'DELIVER':
        return target.kind === 'settlement';
      case 'BUILD': {
        if (target.kind !== 'settlement') return false;
        const structure = parameters?.['structure'] === 'farm' ? 'farm' : parameters?.['structure'] === 'shelter' ? 'shelter' : 'house';
        if (structure === 'shelter') {
          if (state.wood < SHELTER_WOOD_COST) return false;
          const rawX = parameters?.['x'];
          const rawZ = parameters?.['z'];
          if (rawX !== undefined || rawZ !== undefined) {
            if (typeof rawX !== 'number' || typeof rawZ !== 'number') return false;
            return siteLegal(state, 'shelter', rawX, rawZ, SHELTER_FOOTPRINT, parameters?.['exact'] === true, 2.0);
          }
          // No coordinates: the simulation picks the free site — require that
          // one exists rather than guessing land use from here.
          const camp = state.entities[SETTLEMENT_ID];
          const from = camp && 'position' in camp ? camp.position : { x: 0, z: 0 };
          return findShelterSite(state, from) !== null;
        }
        const cost = FARM_WOOD_COST;
        if (structure === 'house') {
          // Blueprint-driven costs: unknown IDs fail here, branch pockets at
          // execution (this validator has no worker context by design).
          const rawBlueprint = parameters?.['blueprint'];
          if (rawBlueprint !== undefined && (typeof rawBlueprint !== 'string' || !getBlueprint(rawBlueprint))) return false;
          const bp = getBlueprint(typeof rawBlueprint === 'string' ? rawBlueprint : DEFAULT_HOUSE_BLUEPRINT) ?? getBlueprint(DEFAULT_HOUSE_BLUEPRINT)!;
          if (state.wood < bp.woodCost) return false;
          // Player-directed site: exact coordinates must be valid as given;
          // approximate ones need valid ground within the same tolerance the
          // simulation will search. Plot capacity does not apply.
          const rawX = parameters?.['x'];
          const rawZ = parameters?.['z'];
          if (rawX !== undefined || rawZ !== undefined) {
            if (typeof rawX !== 'number' || typeof rawZ !== 'number') return false;
            return siteLegal(state, 'house', rawX, rawZ, bp.footprint, parameters?.['exact'] === true, HOUSE_SITE_TOLERANCE);
          }
        } else if (state.wood < cost) return false;
        const slots = structure === 'farm' ? FARM_SLOTS : HOUSE_SLOTS;
        const used = Object.values(state.entities).filter((entity) => entity.kind === structure && !(entity.kind === 'house' && typeof entity.footprint === 'number')).length;
        return used < slots.length;
      }
      case 'MOVE_TO':
        return target.kind !== 'settlement' || true;
      case 'PLANT':
        return target.kind === 'tree' && target.state === 'depleted';
      case 'COLLECT':
        return (target.kind === 'branch' || target.kind === 'stone') && target.state === 'ground';
      case 'REST':
        return target.kind === 'shelter' && target.state === 'complete';
      case 'CRAFT': {
        if (target.kind !== 'settlement') return false;
        const recipe = parameters?.['recipe'];
        return recipe === 'stone-axe' || recipe === 'carrying-basket';
      }
    }
  })();
  if (!legal) {
    return {
      ok: false,
      reason: 'illegal-target-state',
      detail: `${actionType} is not legal against ${target.kind} ${targetEntityId} in its current state.`,
    };
  }
  return { ok: true, decision };
}

const ACTION_GUIDE = [
  'GATHER <tree-id> — walk to a standing tree and chop it (two hits fell a tree and create a log).',
  'HARVEST <berry-patch-id|farm-id> — gather an available berry patch or a ready farm (farms regrow on their own).',
  'HARVEST <well-id|pond-01> — draw water from the well or wilderness pond (never runs dry; each draw fills one waterskin).',
  'PICK_UP <log-id|food-id> — pick up a resource lying on the ground.',
  'DELIVER settlement-01 — only valid while carrying a log or food; the worker walks home and the stockpile increments.',
  'BUILD settlement-01 — construct a house (2 wood) or, with parameters {"structure":"farm"}, a farm (3 wood). HIGH risk: needs human approval unless the mode auto-approves it. Only 3 house and 2 farm plots exist.',
  'BUILD settlement-01 with parameters {"structure":"house","blueprint":"timber-cabin"|"thatched-cottage"} — cabin (4 wood, tall) or cottage (2 wood + 2 branch, wide thatch); default homestead (2 wood). Optional {"x","z"} builds nearest the point; invalid sites fail without spending.',
  'BUILD settlement-01 with parameters {"structure":"shelter"} — raise a wilderness shelter (2 wood + 2 pocketed branches) at a clear site the simulation picks; optional {"x","z"} pins a spot, rejected when blocked. HIGH risk. A finished shelter is a verified rest stop.',
  'REST <shelter-id> — sleep at a complete shelter (4s); timed work runs 1.5× faster while rested. Construction sites are not beds.',
  'MOVE_TO <entity-id> — reposition without gathering.',
  'PLANT <tree-id> — replant a depleted stump; a sapling matures into standing timber on its own.',
  'COLLECT <branch-id|stone-id> — pocket a fallen branch or loose stone into personal inventory (capacity-limited, hands must be free).',
  'CRAFT settlement-01 with parameters {"recipe":"stone-axe"|"carrying-basket"} — work at the camp: stone axe (3 branch + 2 stone, needs basic axe, fells in one blow) or basket (4 branch, capacity 10→15). LOW risk. Inputs are consumed at completion; cancelling first costs nothing.',
].join('\n');

export function buildDecisionPrompt(observation: AgentObservation, planSummary: string | null, recentOutcomes: string[]): string {
  const trees = observation.trees.map((t) => `${t.id}@(${t.x.toFixed(1)},${t.z.toFixed(1)})${t.available ? '' : '[depleted]'}`).join(', ') || 'none';
  const logs = observation.logs.map((l) => `${l.id}${l.available ? '' : '[taken]'}`).join(', ') || 'none';
  const patches = observation.berryPatches.map((p) => `${p.id}${p.available ? '' : '[harvested]'}`).join(', ') || 'none';
  const farms = observation.farms.map((f) => `${f.id}${f.available ? '[ready]' : '[growing]'}`).join(', ') || 'none built';
  const foods = observation.foodResources.map((f) => `${f.id}${f.available ? '' : '[taken]'}${f.kind === 'water' ? '[water]' : ''}`).join(', ') || 'none';
  const wells = (observation.wells ?? []).map((w) => `${w.id}@(${w.x.toFixed(1)},${w.z.toFixed(1)})`).join(', ') || 'none built';
  const shelters = observation.shelters.map((s) => `${s.id}${s.complete ? '[complete]' : '[building]'}`).join(', ') || 'none built';
  const wildlife = (observation.animals ?? []).map((a) => `${a.id}(${a.species},${a.state})`).join(', ') || 'none seen';
  const branches = observation.branches.map((b) => `${b.id}${b.available ? '' : '[taken]'}`).join(', ') || 'none';
  const stones = observation.stones.map((s) => `${s.id}${s.available ? '' : '[taken]'}`).join(', ') || 'none';
  const pack = Object.entries(observation.inventory).map(([m, n]) => `${m}×${n}`).join(', ') || 'empty';
  return [
    'You steward a small forest settlement. Reason ONLY about the real world below; do not invent buildings, tools, or mechanics.',
    `Tick ${observation.tick}. Stockpile: wood=${observation.wood}, food=${observation.food}.`,
    `Worker ${observation.worker.id} at (${observation.worker.x.toFixed(1)},${observation.worker.z.toFixed(1)}), carrying=${observation.worker.carrying ?? 'nothing'}.`,
    `Pack: ${pack} (capacity ${observation.capacity}). Equipped: axe=${observation.equipment.axe ?? 'none'}${observation.equipment.basket ? ', basket' : ''}.`,
    `Settlement at (${observation.settlement.x},${observation.settlement.z}).`,
    `Trees: ${trees}. Ground logs: ${logs}. Berry patches: ${patches}. Farms: ${farms}. Ground food: ${foods}. Wells: ${wells}. Branches: ${branches}. Stones: ${stones}. Shelters: ${shelters}. Wildlife: ${wildlife}.`,
    planSummary ? `Your standing plan: ${planSummary}` : 'You have no standing plan yet.',
    recentOutcomes.length > 0 ? `Recent verified outcomes: ${recentOutcomes.join(' | ')}` : 'No actions taken yet.',
    'Available actions (use exact IDs):',
    ACTION_GUIDE,
    'Rules: propose exactly ONE action or null (to keep observing). Repeat failed actions only with a changed approach. Wood before food when wood=0.',
    'Reply with exactly one JSON object, no other text:',
    '{"action": {"actionType": "GATHER|HARVEST|PICK_UP|DELIVER|MOVE_TO|PLANT|COLLECT|CRAFT|REST", "targetEntityId": "<id>", "parameters": {} } | null, "intent": "<one sentence>", "expectation": "<observable change>"}',
  ].join('\n');
}

export const DECISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'intent', 'expectation'],
  properties: {
    action: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['actionType', 'targetEntityId'],
          properties: {
            actionType: { type: 'string', enum: ['MOVE_TO', 'GATHER', 'HARVEST', 'PICK_UP', 'DELIVER', 'BUILD', 'COLLECT', 'CRAFT', 'REST'] },
            targetEntityId: { type: 'string', minLength: 1 },
            parameters: { type: 'object' },
          },
        },
      ],
    },
    intent: { type: 'string', minLength: 1 },
    expectation: { type: 'string', minLength: 1 },
    revisedPlan: { type: ['string', 'null'] },
  },
} as const;
