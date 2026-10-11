/**
 * Second-agent experiment: two directive drivers sharing one world.
 *
 * Moss (worker-01/02) and Rival (worker-03) pursue the same scarce timber
 * with the same planner policy. Directives bypass claim exclusion, so both
 * crews can target one tree — exercising the stale-task guards, proposal
 * settlement, and delivery attribution under genuine contention. No new
 * mechanics, no economy changes: only existing decisions, validation,
 * governance, and stepping, measured.
 */
import { WorldSimulation, workersOf } from '../simulation/WorldSimulation';
import { createWorld } from '../world/createWorld';
import { LocalGathererAgent } from '../agent/LocalGathererAgent';
import { ManualAgent } from '../agent/ManualAgent';
import { nextStep } from './planner';
import { validateDecisionAgainstWorld } from '../agent/nvidia/DecisionSchema';
import type { GameGoal } from './goals';
import type { WorkerEntity } from '../world/types';
import { replayLog, stateHash } from '../simulation/replay';

export interface DuelDriver {
  id: string;
  workerIds: string[];
  goal: GameGoal;
}

export interface DuelTurn {
  round: number;
  driver: string;
  worker: string | null;
  action: string | null;
  target: string | null;
  proposalId: string | null;
  outcome: string;
}

export interface DuelMeasurements {
  rounds: number;
  turns: DuelTurn[];
  wood: number;
  food: number;
  deliveriesByWorker: Record<string, number>;
  failedProposals: string[];
  damagedTrees: number;
  felledTrees: number;
  logsPerFelledTree: Record<string, number>;
  /** GATHER proposals driven by more than one worker (cooperative sharing). */
  sharedGatherProposals: string[];
  proposalsTerminal: boolean;
  directivesDrained: boolean;
  replayHashEqual: boolean;
}

function woodGoal(id: string): GameGoal {
  return { id, kind: 'gather-wood', quantity: 999, status: 'active', note: 'duel timber race', createdAt: 0 };
}

function freeWorker(sim: WorldSimulation, workerIds: string[]): WorkerEntity | null {
  for (const id of workerIds) {
    const entity = sim.state.entities[id];
    if (
      entity?.kind === 'worker'
      && (entity.activity === 'idle' || entity.activity === 'moving')
      && !entity.carrying && !entity.task
    ) {
      return entity;
    }
  }
  return null;
}

function carryingWorker(sim: WorldSimulation, workerIds: string[]): WorkerEntity | null {
  for (const id of workerIds) {
    const entity = sim.state.entities[id];
    if (entity?.kind === 'worker' && entity.carrying) return entity;
  }
  return null;
}

const TERMINAL = new Set(['VERIFIED', 'FAILED', 'REJECTED', 'CANCELLED']);

export function runDuel(rounds = 10, roundBudget = 120): { sim: WorldSimulation; turns: DuelTurn[] } {
  // The duel is a three-worker contention experiment: its crew is part of the
  // duel's genesis (built before the sim snapshots it), not of wilderness
  // genesis — so replay from the duel genesis stays exact.
  const world = createWorld();
  for (const [id, x, z] of [['worker-02', 1.4, 1.0], ['worker-03', -1.2, 1.4]] as const) {
    world.entities[id] = { id, kind: 'worker', position: { x, z }, carrying: null, activity: 'idle', targetId: null, task: null, inventory: {}, capacity: 10, restedUntilTick: 0, equipment: { axe: 'basic-axe', basket: false } };
  }
  const sim = new WorldSimulation(world, new ManualAgent());
  const observer = new LocalGathererAgent();
  const drivers: DuelDriver[] = [
    { id: 'moss', workerIds: ['worker-01', 'worker-02'], goal: woodGoal('goal-moss') },
    { id: 'rival', workerIds: ['worker-03'], goal: woodGoal('goal-rival') },
  ];
  const turns: DuelTurn[] = [];
  const driveOne = (round: number, driver: DuelDriver): void => {
    const hauler = carryingWorker(sim, driver.workerIds);
    if (hauler) {
      // Haul completes on its own; never task a laden worker.
      turns.push({ round, driver: driver.id, worker: hauler.id, action: 'DELIVER', target: 'settlement-01', proposalId: null, outcome: 'hauling' });
      return;
    }
    const worker = freeWorker(sim, driver.workerIds);
    if (!worker) {
      turns.push({ round, driver: driver.id, worker: null, action: null, target: null, proposalId: null, outcome: 'busy' });
      return;
    }
    const obs = observer.observe(sim.state);
    obs.worker = { id: worker.id, x: worker.position.x, z: worker.position.z, carrying: worker.carrying };
    obs.claimedTargetIds = workersOf(sim.state)
      .filter((other) => other.id !== worker.id && other.targetId !== null)
      .map((other) => other.targetId as string);
    const step = nextStep(driver.goal, obs);
    if (!step || step.actionType === 'DELIVER') {
      turns.push({ round, driver: driver.id, worker: worker.id, action: step?.actionType ?? null, target: step?.targetEntityId ?? null, proposalId: null, outcome: step ? 'auto-haul' : 'no-step' });
      return;
    }
    const verdict = validateDecisionAgainstWorld(
      { action: { actionType: step.actionType, targetEntityId: step.targetEntityId, parameters: {} }, intent: 'duel-turn', expectation: 'goal progress' },
      sim.state,
    );
    if (!verdict.ok) {
      turns.push({ round, driver: driver.id, worker: worker.id, action: step.actionType, target: step.targetEntityId, proposalId: null, outcome: `invalid:${verdict.reason}` });
      return;
    }
    // Directive-only: the sim mints a proposal iff none is live, otherwise
    // the driver adopts the live one (fresh:false). Minting here as well
    // would orphan EXECUTING proposals no worker ever drives.
    sim.issueDirective(
      { actionType: step.actionType, targetEntityId: step.targetEntityId, reason: `${driver.id}: ${step.reason}`, parameters: step.parameters ?? {} },
      worker.id,
    );
    turns.push({
      round, driver: driver.id, worker: worker.id, action: step.actionType,
      target: step.targetEntityId, proposalId: null, outcome: 'driving',
    });
  };
  for (let round = 0; round < rounds; round += 1) {
    // Both drivers decide against the SAME world snapshot window before
    // either acts: directives bypass claim exclusion, so overlapping target
    // choices produce genuine contention instead of serialized turns.
    for (const driver of drivers) driveOne(round, driver);
    sim.advanceUntil(() => false, roundBudget);
  }
  // Drain: let in-flight tasks, hauls, and directives settle so end-of-duel
  // assertions observe terminal states, not mid-flight ones. No new
  // decisions are issued here; parked autonomy invents nothing.
  sim.advanceUntil((state) => {
    const live = state.proposals.some((p) => !TERMINAL.has(p.status));
    const busy = Object.values(state.entities).some((e) =>
      e.kind === 'worker' && (e.task !== null || e.carrying !== null));
    return !live && !busy && sim.directives.length === 0;
  }, 2000);
  return { sim, turns };
}

export function measureDuel(sim: WorldSimulation, turns: DuelTurn[]): DuelMeasurements {
  const rounds = turns.length === 0 ? 0 : Math.max(...turns.map((t) => t.round)) + 1;
  const deliveriesByWorker: Record<string, number> = {};
  for (const event of sim.state.events) {
    if (event.type === 'RESOURCE_DELIVERED') {
      const workerId = String(event.data['workerId'] ?? 'unknown');
      deliveriesByWorker[workerId] = (deliveriesByWorker[workerId] ?? 0) + 1;
    }
  }
  const failedProposals = sim.state.proposals
    .filter((p) => p.status === 'FAILED')
    .map((p) => `${p.id}:${p.actionType}:${p.targetEntityId}`);
  // Cooperative sharing: GATHER proposals driven by more than one worker
  // (directives adopt the live proposal instead of stacking duplicates).
  const driversByGather = new Map<string, Set<string>>();
  for (const event of sim.state.events) {
    if (event.type !== 'GATHER_ACTION_STARTED') continue;
    const proposalId = event.data['proposalId'];
    const workerId = event.data['workerId'];
    if (typeof proposalId !== 'string' || typeof workerId !== 'string') continue;
    const drivers = driversByGather.get(proposalId) ?? new Set<string>();
    drivers.add(workerId);
    driversByGather.set(proposalId, drivers);
  }
  const sharedGatherProposals = [...driversByGather.entries()]
    .filter(([, drivers]) => drivers.size > 1)
    .map(([proposalId]) => proposalId);
  const felled = Object.values(sim.state.entities).filter((e) => e.kind === 'tree' && e.state === 'depleted');
  const logsPerFelledTree: Record<string, number> = {};
  for (const tree of felled) {
    if (tree.kind !== 'tree') continue;
    logsPerFelledTree[tree.id] = sim.state.events.filter((e) =>
      e.type === 'RESOURCE_CREATED' && (e.data['sourceTreeId'] as string | undefined) === tree.id).length;
  }
  const replayed = replayLog(sim.exportLog());
  return {
    rounds,
    turns,
    wood: sim.state.wood,
    food: sim.state.food,
    deliveriesByWorker,
    failedProposals,
    damagedTrees: sim.state.events.filter((e) => e.type === 'TREE_DAMAGED').length,
    felledTrees: felled.length,
    logsPerFelledTree,
    sharedGatherProposals,
    proposalsTerminal: sim.state.proposals.every((p) => TERMINAL.has(p.status)),
    directivesDrained: sim.directives.length === 0,
    replayHashEqual: replayed.finalHash === stateHash(sim.state),
  };
}
