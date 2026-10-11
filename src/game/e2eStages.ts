/**
 * Browser E2E stage predicates (used by `window.__ASTRIX_E2E__.advanceTo`).
 *
 * Intent per stage: activity stages prove the world *exhibits* the activity
 * (chop/carry/gather visuals + causal-chain progress); settlement stages
 * prove world-level outcomes. Worker identity is deliberately NOT part of
 * any predicate: three workers compete across two patches plus a
 * chain-backed farm, so requiring worker-01 specifically makes the stages
 * brittle even when the simulation behaves correctly (observed: worker-01
 * harvests the delegated farm in a loop while a sibling ferries the food).
 * Identity-specific coverage lives in unit tests instead
 * (`claims different targets`, `routes a named directive`, `scopes agents`).
 */
import type { WorldState } from '../world/types';

type Worker = Extract<WorldState['entities'][string], { kind: 'worker' }>;

function workersOf(state: Readonly<WorldState>): Worker[] {
  return Object.values(state.entities).filter(
    (entity): entity is Worker => entity.kind === 'worker',
  );
}

function carrying(state: Readonly<WorldState>, worker: Worker, kind: 'log' | 'food'): boolean {
  const resource = worker.carrying ? state.entities[worker.carrying] : undefined;
  return resource?.kind === kind;
}

export const e2eStageNames = [
  'chopping',
  'woodCarrying',
  'woodDelivered',
  'berryHarvesting',
  'foodCarrying',
  'finalSettlement',
] as const;

export type E2EStage = (typeof e2eStageNames)[number];

export const e2ePredicates: Record<E2EStage, (state: Readonly<WorldState>) => boolean> = {
  /** Some worker is visibly chopping: the wood loop has started. */
  chopping: (state) => workersOf(state).some((worker) => worker.activity === 'chopping'),
  /** Some worker is ferrying a log: fell → carry transition works. */
  woodCarrying: (state) => workersOf(state).some((worker) => carrying(state, worker, 'log')),
  /** First wood delivery landed (world-level; exact count would punish crew parallelism). */
  woodDelivered: (state) => state.wood >= 1,
  /** Some worker is visibly gathering: the food loop has started. */
  berryHarvesting: (state) => workersOf(state).some((worker) => worker.activity === 'gathering'),
  /** Some worker is ferrying food: harvest → carry transition works, no matter who ferries. */
  foodCarrying: (state) => workersOf(state).some((worker) => carrying(state, worker, 'food')),
  /** Wood stockpiled and a food delivery independently verified (world-level). */
  finalSettlement: (state) =>
    state.wood >= 1
    && state.proposals.some(
      (proposal) =>
        proposal.actionType === 'DELIVER'
        && proposal.parameters['resource'] === 'food'
        && proposal.status === 'VERIFIED',
    ),
};
