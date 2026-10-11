/**
 * Phase 5.1 replay harness: reconstruct a recorded run without fresh model
 * calls or live network dependencies.
 *
 * Model: an InputLog (genesis snapshot + tick-stamped external inputs) folds
 * deterministically — fresh sim from genesis, apply each tick's inputs in
 * seq order, step fixed quanta to the recorded final tick. Internal
 * derivations (auto-approvals, plan activation, step records, event emission)
 * recompute; they were never logged, so nothing double-applies.
 */
import { WorldSimulation } from './WorldSimulation';
import { LocalGathererAgent } from '../agent/LocalGathererAgent';
import { ManualAgent } from '../agent/ManualAgent';
import type { AgentDecision } from '../agent/Agent';
import type { ActionType, InputEntry, InputLog, RiskLevel, WorldState } from '../world/types';

export class ReplayError extends Error {}

/** Canonical JSON: object keys sorted recursively; arrays keep order. */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (typeof value === 'object') {
    // Skip undefined-valued keys: JSON cloning drops them, and a present-
    // undefined property (e.g. event.entityId) is semantically identical to
    // an absent one. Without this, clone-vs-live comparisons diverge.
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** cyrb53 hash → 16 hex chars. Pure TS: identical strings hash identically on any engine. */
export function cyrb53(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < input.length; index += 1) {
    const ch = input.charCodeAt(index);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(16, '0');
}

/**
 * Deterministic hash of the FULL authoritative WorldState. Renderer and DOM
 * hold no game state (read-only views), so nothing presentation-only lives
 * inside the hashed state. Floats serialize via JSON shortest-round-trip,
 * deterministic per JS spec on a given engine; cross-engine float identity
 * is explicitly NOT guaranteed (see limits).
 */
export function stateHash(state: Readonly<WorldState>): string {
  return cyrb53(canonicalize(state));
}

function mapAgent(name: string): LocalGathererAgent | ManualAgent {
  if (name === 'LocalGathererAgent') return new LocalGathererAgent();
  if (name === 'ManualAgent') return new ManualAgent();
  throw new ReplayError(
    `cannot replay runs driven by ${name}: model-backed decisions need a canned-decision driver (Phase 5.2); only LocalGathererAgent/ManualAgent replay exactly`,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new ReplayError('malformed input payload: expected object');
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new ReplayError('malformed input payload: expected string');
  return value;
}

/** Apply one logged input to a replay sim. modelDecision entries are evidence only — skip. */
export function applyInput(sim: WorldSimulation, entry: InputEntry): void {
  const p = entry.payload;
  switch (entry.kind) {
    case 'directive': {
      const decision = asRecord(p['decision']) as unknown as AgentDecision;
      const workerId = p['workerId'] === undefined ? undefined : asString(p['workerId']);
      const planId = p['planId'] === undefined ? undefined : asString(p['planId']);
      sim.issueDirective(decision, workerId, planId);
      return;
    }
    case 'clearDirectives': sim.clearDirectives(); return;
    case 'propose':
      sim.proposeAction(
        asString(p['actionType']) as ActionType,
        asString(p['targetEntityId']),
        asRecord(p['parameters']),
        asString(p['riskLevel']) as RiskLevel,
        asString(p['agentId']),
      );
      return;
    case 'approve': sim.approveProposal(asString(p['proposalId'])); return;
    case 'reject': sim.rejectProposal(asString(p['proposalId'])); return;
    case 'cancelProposal': sim.cancelProposal(asString(p['proposalId'])); return;
    case 'submitPlan':
      sim.submitPlan(asString(p['kind']), p['quantity'] as number, p['resource'] as 'wood' | 'food' | undefined);
      return;
    case 'completePlan': sim.completePlan(asString(p['planId'])); return;
    case 'cancelPlan': sim.cancelPlan(asString(p['planId'])); return;
    case 'setAgent': sim.setAgent(mapAgent(asString(p['agent']))); return;
    case 'policy': sim.autoApproveUpTo = asString(p['level']) as RiskLevel; return;
    case 'journal': {
      const { turn, source, goal, candidates, verdict, chosen } = p;
      sim.recordJournal({
        turn: turn as number, source: source as string,
        goal: (goal ?? null) as string | null,
        candidates: (candidates ?? []) as string[],
        verdict: verdict as string, chosen: (chosen ?? null) as string | null,
      });
      return;
    }
    case 'reconcileTree':
      sim.reconcileTreeFromAuthority(asString(p['treeId']), p['health'] as number, p['verified'] as boolean, asString(p['reference']));
      return;
    case 'reconcileFarm': {
      const chain = p['chain'] as { state: 'unbuilt' | 'built'; nonce: number; woodSpent: number; authority: string } | null;
      sim.reconcileFarmLease(chain, (p['slot'] as number | null) ?? null);
      return;
    }
    case 'applyFarmBuild': sim.applyVerifiedFarmBuild(p['woodSpent'] as number, asString(p['reference'])); return;
    case 'grantLease': sim.grantLease(asString(p['entityId']), p['holder'] as 'local' | 'er', p['nonceFloor'] as number); return;
    case 'leaseVerified': sim.markLeaseVerified(asString(p['entityId']), p['slot'] as number, p['nonce'] as number); return;
    case 'leaseStale': sim.markLeaseStale(asString(p['entityId'])); return;
    case 'speculative': sim.recordSpeculative(asString(p['entityId']), asString(p['kind']), asString(p['detail'])); return;
    case 'resolveSpeculative':
      sim.resolveSpeculative(
        asString(p['speculativeId']),
        p['rule'] as 'no-merge' | 'adopt-if-contiguous',
        asRecord(p['authoritative']) as unknown as { nonce: number; count: number },
      );
      return;
    case 'externalEvent':
      sim.recordExternalEvent(
        asString(p['type']) as WorldState['events'][number]['type'],
        p['entityId'] === undefined ? undefined : asString(p['entityId']),
        asRecord(p['data']),
      );
      return;
    case 'modelDecision':
      // Evidence for future canned-decision replay; the decision's effects
      // (proposals/directives) are already in the log as their own entries.
      return;
    default:
      throw new ReplayError(`unknown input kind: ${String((entry as InputEntry).kind)}`);
  }
}

export interface ReplayResult {
  sim: WorldSimulation;
  finalHash: string;
  /** Requested checkpoint ticks → state hash at that tick. */
  checkpoints: Map<number, string>;
  /** Cloned states at checkpoint ticks (only when opts.captureStates). */
  states: Map<number, WorldState>;
}

/**
 * Fold a log into a fresh sim. Steps fixed quanta 0..finalTick; inputs apply
 * in (tick, seq) order on arrival at their tick. Throws ReplayError on
 * malformed logs or model-backed drivers.
 */
export function replayLog(log: InputLog, opts: { checkpoints?: number[]; captureStates?: boolean } = {}): ReplayResult {
  if (log.version !== 1) throw new ReplayError(`unsupported input log version: ${String((log as { version?: unknown }).version)}`);
  const wanted = new Set(opts.checkpoints ?? []);
  const sim = new WorldSimulation(
    JSON.parse(JSON.stringify(log.genesis)) as WorldState,
    mapAgent(log.genesisAgent),
  );
  sim.autoApproveUpTo = log.genesisPolicy;
  const byTick = new Map<number, InputEntry[]>();
  for (const entry of log.inputs) {
    const list = byTick.get(entry.tick) ?? [];
    list.push(entry);
    byTick.set(entry.tick, list);
  }
  for (const list of byTick.values()) list.sort((a, b) => a.seq - b.seq);
  let previousTick = -1;
  const orderedTicks = [...byTick.keys()].sort((a, b) => a - b);
  for (const tick of orderedTicks) {
    if (tick < 0 || tick > log.finalTick) throw new ReplayError(`input tick ${tick} outside run 0..${log.finalTick}`);
    if (tick < previousTick) throw new ReplayError('input log ticks out of order');
    previousTick = tick;
  }
  const checkpoints = new Map<number, string>();
  const states = new Map<number, WorldState>();
  const capture = (tick: number) => {
    checkpoints.set(tick, stateHash(sim.state));
    if (opts.captureStates) states.set(tick, JSON.parse(JSON.stringify(sim.state)) as WorldState);
  };
  // Checkpoint(t) = state after all inputs at ticks ≤ t applied and all
  // steps through tick t executed. Tick-0 inputs apply before the tick-0
  // checkpoint, so a divergence at the first input reports tick 0, not the
  // next checkpoint.
  for (let tick = 0; tick <= log.finalTick; tick += 1) {
    for (const entry of byTick.get(tick) ?? []) applyInput(sim, entry);
    if (wanted.has(sim.state.tick)) capture(sim.state.tick);
    if (tick < log.finalTick) sim.advanceUntil(() => false, 1);
  }
  return { sim, finalHash: stateHash(sim.state), checkpoints, states };
}

/** Shallow structural diff of two states: top-level scalars, entities, proposals, plans, journal, leases, events. */
export function diffStates(a: Readonly<WorldState>, b: Readonly<WorldState>): string[] {
  const paths: string[] = [];
  const push = (path: string) => { if (paths.length < 25) paths.push(path); };
  for (const key of ['tick', 'wood', 'food', 'nextEntityNumber', 'nextFoodNumber', 'nextProposalNumber', 'nextEventSequence', 'nextSpeculativeNumber', 'nextPlanNumber'] as const) {
    if (!Object.is(a[key], b[key])) push(String(key));
  }
  const entityIds = new Set([...Object.keys(a.entities), ...Object.keys(b.entities)]);
  for (const id of [...entityIds].sort()) {
    if (canonicalize(a.entities[id]) !== canonicalize(b.entities[id])) push(`entities.${id}`);
  }
  const proposalCount = Math.max(a.proposals.length, b.proposals.length);
  for (let index = 0; index < proposalCount; index += 1) {
    if (canonicalize(a.proposals[index]) !== canonicalize(b.proposals[index])) push(`proposals[${index}]`);
  }
  const planIds = new Set([...Object.keys(a.plans), ...Object.keys(b.plans)]);
  for (const id of [...planIds].sort()) {
    if (canonicalize(a.plans[id]) !== canonicalize(b.plans[id])) push(`plans.${id}`);
  }
  if (a.journal.length !== b.journal.length) push('journal.length');
  for (let index = 0; index < Math.min(a.journal.length, b.journal.length); index += 1) {
    if (canonicalize(a.journal[index]) !== canonicalize(b.journal[index])) push(`journal[${index}]`);
  }
  if (a.events.length !== b.events.length) push('events.length');
  for (let index = 0; index < Math.min(a.events.length, b.events.length); index += 1) {
    if (canonicalize(a.events[index]) !== canonicalize(b.events[index])) push(`events[${index}]`);
  }
  const leaseIds = new Set([...Object.keys(a.leases), ...Object.keys(b.leases)]);
  for (const id of [...leaseIds].sort()) {
    if (canonicalize(a.leases[id]) !== canonicalize(b.leases[id])) push(`leases.${id}`);
  }
  if (canonicalize(a.speculative) !== canonicalize(b.speculative)) push('speculative');
  return paths;
}

export interface Divergence {
  tick: number;
  paths: string[];
}

/**
 * First checkpoint tick where two replays disagree, with the changed state
 * paths at that tick. Requires captureStates on both results; pass the two
 * checkpoint maps plus a state lookup.
 */
export function findDivergence(
  a: Pick<ReplayResult, 'checkpoints' | 'states'>,
  b: Pick<ReplayResult, 'checkpoints' | 'states'>,
): Divergence | null {
  const ticks = [...new Set([...a.checkpoints.keys(), ...b.checkpoints.keys()])].sort((x, y) => x - y);
  for (const tick of ticks) {
    if (a.checkpoints.get(tick) !== b.checkpoints.get(tick)) {
      const stateA = a.states.get(tick);
      const stateB = b.states.get(tick);
      return { tick, paths: stateA && stateB ? diffStates(stateA, stateB) : [] };
    }
  }
  return null;
}
