import type { ActionProposal, ActionType, WorldState } from '../world/types';

export interface AgentObservation {
  tick: number;
  wood: number;
  food: number;
  water: number;
  worker: { id: string; x: number; z: number; carrying: string | null };
  /** Every task-capable worker; `worker` above is the focus worker. */
  workers: Array<{ id: string; x: number; z: number; carrying: string | null; activity: string }>;
  /** Targets already claimed by other workers this step. */
  claimedTargetIds: string[];
  settlement: { id: string; x: number; z: number };
  trees: Array<{ id: string; x: number; z: number; available: boolean }>;
  /** Felled stump sites that can take a sapling. Optional; absent means none known. */
  stumps?: Array<{ id: string; x: number; z: number }>;
  logs: Array<{ id: string; x: number; z: number; available: boolean }>;
  berryPatches: Array<{ id: string; x: number; z: number; available: boolean }>;
  farms: Array<{ id: string; x: number; z: number; available: boolean }>;
  foodResources: Array<{ id: string; x: number; z: number; available: boolean; kind: 'food' | 'water' }>;
  /** Village wells. Optional; absent means none known. */
  wells?: Array<{ id: string; x: number; z: number }>;
  /** Built shelters and their completion. */
  shelters: Array<{ id: string; x: number; z: number; complete: boolean }>;
  /** Built houses (any blueprint) for satiation checks. */
  houses: Array<{ id: string; x: number; z: number; complete: boolean; blueprint: string }>;
  /** Observed wildlife. Optional; absent means none known. */
  animals?: Array<{ id: string; species: string; x: number; z: number; state: string }>;
  /** Gatherable wilderness materials on the ground. */
  branches: Array<{ id: string; x: number; z: number; available: boolean; kind: 'branch' }>;
  stones: Array<{ id: string; x: number; z: number; available: boolean; kind: 'stone' }>;
  /** Focus worker's personal inventory, equipment, and carrying capacity. */
  inventory: Record<string, number>;
  equipment: { axe: 'basic-axe' | 'stone-axe' | null; basket: boolean };
  capacity: number;
}

export interface AgentDecision {
  actionType: ActionType;
  targetEntityId: string;
  reason: string;
  parameters?: Record<string, unknown>;
}

export interface ActionGateway {
  proposeAction(actionType: ActionType, targetEntityId: string, parameters?: Record<string, unknown>, riskLevel?: ActionProposal['riskLevel']): ActionProposal;
  approveProposal(proposalId: string): boolean;
}

export interface Agent {
  readonly id: string;
  observe(state: Readonly<WorldState>): AgentObservation;
  decide(observation: AgentObservation): AgentDecision | null;
  proposeAction(gateway: ActionGateway, decision: AgentDecision): ActionProposal;
  executeAction(gateway: ActionGateway, proposal: ActionProposal): boolean;
  /**
   * Which workers this agent may drive. Defaults to all (existing agents are
   * unaffected); ManualAgent drives none, ModelDrivenAgent drives Moss only.
   */
  controlsWorker?(workerId: string): boolean;
}
