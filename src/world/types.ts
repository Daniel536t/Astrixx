export type Vec2 = { x: number; z: number };

export type TreeEntity = {
  id: string;
  kind: 'tree';
  position: Vec2;
  health: number;
  maxHealth: number;
  state: 'standing' | 'depleted' | 'sapling';
  /** Sapling growth 0→1; meaningful only while state === 'sapling'. */
  progress?: number;
};

export type WorkerEntity = {
  id: string;
  kind: 'worker';
  position: Vec2;
  carrying: string | null;
  activity: 'idle' | 'moving' | 'chopping' | 'gathering' | 'carrying' | 'building' | 'crafting' | 'resting';
  targetId: string | null;
  /** Active task progress. Replaces the old single global chop/harvest/build slots. */
  task: { kind: 'chop' | 'harvest' | 'build' | 'plant' | 'craft' | 'rest'; targetId: string; elapsed: number; planId?: string; proposalId?: string; recipeId?: string } | null;
  /** Plan governing the current haul. Lets plan deliveries verify without a DELIVER proposal. */
  deliveryPlanId?: string;
  /**
   * DELIVER proposal minted for the current haul (legacy path). Lets delivery
   * settle exactly its own proposal instead of the newest live one.
   */
  deliveryProposalId?: string;
  /** Personal material counts (branch, stone, fibre, ...). Global wood/food/water stockpiles remain the settlement stores. */
  inventory: Record<string, number>;
  /** Max total material units the worker can carry in inventory (excluding equipped tools). */
  capacity: number;
  /** Equipped tools. The starting axe is real authoritative state, not decoration. */
  equipment: { axe: 'basic-axe' | 'stone-axe' | null; basket: boolean };
  /** Sim tick until which rest bonus applies (0 = not rested). Set by REST at a complete shelter. */
  restedUntilTick: number;
};

export type BerryPatchEntity = {
  id: string;
  kind: 'berry-patch';
  position: Vec2;
  state: 'available' | 'harvested';
  /** Regrow progress 0→1 while harvested; meaningful only then. */
  progress?: number;
};

export type FoodEntity = {
  id: string;
  kind: 'food';
  position: Vec2;
  state: 'ground' | 'carried' | 'delivered';
};

export type WaterEntity = {
  id: string;
  kind: 'water';
  position: Vec2;
  state: 'ground' | 'carried' | 'delivered';
};

/** Village well: an inexhaustible draw site (harvest cost is worker time). */
export type WellEntity = {
  id: string;
  kind: 'well';
  position: Vec2;
};

export type ResourceEntity = LogEntity | FoodEntity | WaterEntity;

export type LogEntity = {
  id: string;
  kind: 'log';
  position: Vec2;
  state: 'ground' | 'carried' | 'delivered';
};

export type SettlementEntity = {
  id: string;
  kind: 'settlement';
  position: Vec2;
};

export type HouseEntity = {
  id: string;
  kind: 'house';
  position: Vec2;
  state: 'construction' | 'complete';
  progress: number;
  /** Blueprint id (default 'homestead' when absent, e.g. older saves). */
  blueprint?: string;
  /** Collision radius from the blueprint (absent on legacy slot houses). */
  footprint?: number;
};

export type FarmEntity = {
  id: string;
  kind: 'farm';
  position: Vec2;
  state: 'growing' | 'ready';
  progress: number;
};

/**
 * Wilderness shelter: a lean-to built at a validated free location (never a
 * fixed slot). Distinct from the camp anchor and from houses.
 */
export type ShelterEntity = {
  id: string;
  kind: 'shelter';
  position: Vec2;
  state: 'construction' | 'complete';
  progress: number;
  footprint: number;
};

export type VillagerEntity = {
  id: string;
  kind: 'villager';
  position: Vec2;
  activity: 'idle' | 'wandering';
};

/** Fallen branch: gatherable wood precursor (Phase 1 wilderness material). */
export type BranchEntity = {
  id: string;
  kind: 'branch';
  position: Vec2;
  state: 'ground' | 'collected';
};

/** Loose stone: gatherable crafting material (Phase 1 wilderness material). */
export type StoneEntity = {
  id: string;
  kind: 'stone';
  position: Vec2;
  state: 'ground' | 'collected';
};

/** Natural water source (pond/stream). Draw site; distinct from the built well. */
export type PondEntity = {
  id: string;
  kind: 'pond';
  position: Vec2;
  radius: number;
};

/** Wild animal with a minimal deterministic wander/forage loop. */
export type AnimalEntity = {
  id: string;
  kind: 'animal';
  species: 'deer' | 'rabbit';
  position: Vec2;
  state: 'wandering' | 'fleeing' | 'foraging';
};

export type WorldEntity = TreeEntity | WorkerEntity | LogEntity | FoodEntity | WaterEntity | WellEntity | BerryPatchEntity | SettlementEntity | HouseEntity | FarmEntity | ShelterEntity | VillagerEntity | BranchEntity | StoneEntity | PondEntity | AnimalEntity;
export type EntityId = string;
/** Stockpile resources: wood and food plus water drawn from the well. */
export type StockpileResource = 'wood' | 'food' | 'water';
export type ActionType = 'MOVE_TO' | 'GATHER' | 'HARVEST' | 'PICK_UP' | 'DELIVER' | 'BUILD' | 'PLAN' | 'PLANT' | 'COLLECT' | 'CRAFT' | 'REST';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type ProposalStatus = 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'EXECUTING' | 'EXECUTED' | 'VERIFIED' | 'FAILED' | 'CANCELLED';

export interface ActionProposal {
  id: string;
  agentId: EntityId;
  actionType: ActionType;
  targetEntityId: EntityId;
  parameters: Record<string, unknown>;
  riskLevel: RiskLevel;
  createdAt: number;
  status: ProposalStatus;
}

export type PlanStatus = 'active' | 'blocked' | 'completed' | 'cancelled' | 'rejected' | 'expired' | 'awaiting-approval';

export interface PlanStepRecord {
  index: number;
  actionType: ActionType;
  targetEntityId: string;
  source: string;
  status: 'verified' | 'failed' | 'blocked' | 'held';
  note: string;
  at: number;
}

export interface PlanConstraints {
  allowedActions: ActionType[];
  /** Wood reserved for this plan; BUILD deducts from it first. */
  spendCapWood: number;
  /** Tick after which the plan expires. */
  expiresTick: number;
}

export interface GamePlan {
  id: string;
  kind: string;
  quantity: number;
  resource?: 'wood' | 'food';
  /** Blueprint id for construction plans (e.g. construct-house). */
  blueprint?: string;
  status: PlanStatus;
  proposalId: string | null;
  constraints: PlanConstraints;
  spentWood: number;
  /** Placement pinned at execution (e.g. shelter site): picked once, reused
   * by every later step so drivers converge instead of re-picking. */
  site?: Vec2;
  steps: PlanStepRecord[];
  createdAt: number;
}

export interface DecisionRecord {
  turn: number;
  source: string;
  goal: string | null;
  candidates: string[];
  verdict: string;
  chosen: string | null;
  at: number;
}

/**
 * Authoritative input log (Phase 5.1 replay infrastructure).
 *
 * Every entry is an EXTERNAL input into the simulation: genesis plus one
 * record per public mutating call (directives, governance transitions, plan
 * lifecycle, agent/policy swaps, external reconciliation, journal writes,
 * captured model decisions). Internally derived transitions (proposal
 * auto-approval, plan activation, step records, event emission) are NOT
 * logged — they recompute deterministically during replay.
 */
export type InputKind =
  | 'directive' | 'clearDirectives'
  | 'propose' | 'approve' | 'reject' | 'cancelProposal'
  | 'submitPlan' | 'completePlan' | 'cancelPlan'
  | 'setAgent' | 'policy' | 'journal'
  | 'reconcileTree' | 'reconcileFarm' | 'applyFarmBuild'
  | 'grantLease' | 'leaseVerified' | 'leaseStale'
  | 'speculative' | 'resolveSpeculative'
  | 'externalEvent' | 'modelDecision';

export interface InputEntry {
  /** Append order; disambiguates same-tick inputs. */
  seq: number;
  /** Sim tick observed when the input arrived. */
  tick: number;
  kind: InputKind;
  payload: Record<string, unknown>;
}

export interface InputLog {
  version: 1;
  /** Deep clone of the state this run started from. */
  genesis: WorldState;
  /** Agent class driving at genesis (constructor name). */
  genesisAgent: string;
  /** Approval policy at genesis. */
  genesisPolicy: RiskLevel;
  /** Final tick reached by the recorded run. */
  finalTick: number;
  inputs: InputEntry[];
}

export type WorldEventType =
  | 'WORLD_INITIALIZED'
  | 'INTEGRATION_MODE_SELECTED'
  | 'ENTITY_SPAWNED'
  | 'AGENT_MOVED'
  | 'AGENT_OBSERVED'
  | 'AGENT_DECIDED'
  | 'RESOURCE_TARGETED'
  | 'GATHER_ACTION_STARTED'
  | 'TREE_DAMAGED'
  | 'TREE_CHOPPED'
  | 'TREE_PLANTED'
  | 'TREE_MATURED'
  | 'BERRY_PATCH_HARVESTED'
  | 'WATER_DRAWN'
  | 'RESOURCE_CREATED'
  | 'RESOURCE_PICKED_UP'
  | 'RESOURCE_DELIVERED'
  | 'RESOURCE_ADDED'
  | 'MATERIAL_COLLECTED'
  | 'CRAFTING_STARTED'
  | 'CRAFTING_COMPLETED'
  | 'CRAFTING_FAILED'
  | 'CONSTRUCTION_STARTED'
  | 'CONSTRUCTION_COMPLETED'
  | 'CONSTRUCTION_FAILED'
  | 'CONSTRUCTION_STAGE'
  | 'REST_COMPLETED'
  | 'FARM_HARVESTED'
  | 'FOOD_CONSUMED'
  | 'FOOD_LOW'
  | 'WATER_LOW'
  | 'POPULATION_HUNGRY'
  | 'POPULATION_THIRSTY'
  | 'POPULATION_JOINED'
  | 'ACTION_PROPOSED'
  | 'ACTION_STATUS_CHANGED'
  | 'GOVERNANCE_PERMISSION_GRANTED'
  | 'GOVERNANCE_PERMISSION_DENIED'
  | 'WORLD_STATE_DELEGATED'
  | 'TRANSACTION_AUTHORIZED'
  | 'TRANSACTION_SUBMITTED'
  | 'TRANSACTION_CONFIRMED'
  | 'WORLD_STATE_COMMITTED'
  | 'WORLD_STATE_UNDELEGATED'
  | 'AUTHORITATIVE_STATE_VERIFIED'
  | 'LOCAL_STATE_RECONCILED'
  | 'AUTHORITATIVE_STATE_CONFLICT'
  | 'CHAIN_OPERATION_FAILED'
  | 'LOCAL_STATE_TRANSITION_DEFERRED'
  | 'MAGICBLOCK_DELEGATION_REQUESTED'
  | 'MAGICBLOCK_DELEGATION_CONFIRMED'
  | 'MAGICBLOCK_EXECUTION_SUBMITTED'
  | 'MAGICBLOCK_EXECUTION_CONFIRMED'
  | 'MAGICBLOCK_STATE_VERIFIED'
  | 'MAGICBLOCK_COMMIT_REQUESTED'
  | 'MAGICBLOCK_COMMIT_CONFIRMED'
  | 'MAGICBLOCK_BASE_STATE_VERIFIED'
  | 'MAGICBLOCK_OPERATION_FAILED'
  | 'LEASE_CHANGED'
  | 'SPECULATIVE_NOTED'
  | 'RECONCILIATION_RESOLVED'
  | 'PLAN_STATUS_CHANGED';

export interface WorldEvent {
  id: string;
  sequence: number;
  type: WorldEventType;
  timestamp: number;
  entityId?: EntityId;
  data: Record<string, unknown>;
}

/**
 * Single-writer lease for a chain-covered entity. Exactly one holder may
 * produce authoritative transitions per epoch; anything else is speculative
 * by construction and must be recorded, never merged silently.
 */
export interface ChainLease {
  entityId: EntityId;
  holder: 'local' | 'er';
  epoch: number;
  /** Highest nonce the holder has produced; fencing floor for the next. */
  nonceFloor: number;
  lastVerifiedSlot: number | null;
  stale: boolean;
}

export interface SpeculativeRecord {
  id: string;
  entityId: EntityId;
  kind: string;
  notedAt: number;
  detail: string;
  resolution: 'pending' | 'adopted' | 'discarded-held-for-review';
}

export interface WorldState {
  tick: number;
  wood: number;
  food: number;
  water: number;
  /** Wilderness genesis seed. Optional so older serialized states still parse. */
  seed?: string;
  entities: Record<EntityId, WorldEntity>;
  events: WorldEvent[];
  proposals: ActionProposal[];
  plans: Record<EntityId, GamePlan>;
  journal: DecisionRecord[];
  leases: Record<EntityId, ChainLease>;
  speculative: SpeculativeRecord[];
  nextEntityNumber: number;
  nextFoodNumber: number;
  nextProposalNumber: number;
  nextEventSequence: number;
  nextSpeculativeNumber: number;
  nextPlanNumber: number;
}

export const SETTLEMENT_ID = 'settlement-01';
export const WORKER_ID = 'worker-01';
export const WELL_ID = 'well-01';
/** Fixed well site. The renderer draws the same coordinates. */
export const WELL_POSITION: Vec2 = { x: -1.9, z: -2.9 };
export const TREE_IDS = ['tree-01', 'tree-02', 'tree-03', 'tree-04', 'tree-05', 'tree-06'] as const;
/** Wood cost of one house. Checked at proposal validation AND execution. */
export const HOUSE_WOOD_COST = 2;
/** Wood cost of one farm. Checked at proposal validation AND execution. */
export const FARM_WOOD_COST = 3;
/** Shelter recipe: 2 stockpiled wood + 2 pocketed branches, deducted once at build start. */
export const SHELTER_WOOD_COST = 2;
export const SHELTER_BRANCH_COST = 2;
/** Shelter construction takes 6 sim-seconds of build work (staged thirds). */
export const SHELTER_BUILD_SECONDS = 6;
/** Shelter footprint radius for collision checks. */
export const SHELTER_FOOTPRINT = 1.2;
/** Rest takes 4 sim-seconds at a complete shelter and grants faster work. */
export const REST_SECONDS = 4;
export const REST_BUFF_TICKS = 1200;
export const REST_WORK_RATE = 1.5;
/** Fixed building slots: placement beyond these is rejected as invalid. */
export const HOUSE_SLOTS: ReadonlyArray<Vec2> = [{ x: 3.6, z: -1.2 }, { x: -3.8, z: 0.2 }, { x: 0.6, z: 4.3 }];
export const FARM_SLOTS: ReadonlyArray<Vec2> = [{ x: 2.5, z: 1.9 }, { x: -2.7, z: 2.6 }];
/** Farm regrow time in sim-seconds from harvest to ready. */
export const FARM_GROW_DURATION = 30;
/** Berry patch regrow time in sim-seconds from harvest to available. */
export const BERRY_REGROW_DURATION = 60;
/** Sapling maturation time in sim-seconds from planting to standing. */
export const SAPLING_GROW_DURATION = 45;
/** Food consumption: one unit per worker per this many ticks. */
export const CONSUMPTION_TICKS_PER_WORKER = 600;
/** New worker arrives when food >= this and housing allows, checked periodically. */
export const GROWTH_FOOD_THRESHOLD = 4;
export const GROWTH_ARRIVAL_COST = 2;
export const GROWTH_CHECK_TICKS = 1200;
export const MAX_WORKERS = 6;
/** Base housing capacity plus per completed house. */
export const BASE_HOUSING = 4;
export const HOUSING_PER_HOUSE = 2;

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
