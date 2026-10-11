import { createWorld } from '../world/createWorld';
import { LocalGathererAgent } from '../agent/LocalGathererAgent';
import type { Agent, AgentDecision } from '../agent/Agent';
import { distance, BASE_HOUSING, BERRY_REGROW_DURATION, CONSUMPTION_TICKS_PER_WORKER, FARM_GROW_DURATION, FARM_SLOTS, FARM_WOOD_COST, GROWTH_ARRIVAL_COST, GROWTH_CHECK_TICKS, GROWTH_FOOD_THRESHOLD, HOUSING_PER_HOUSE, HOUSE_SLOTS, MAX_WORKERS, REST_BUFF_TICKS, REST_SECONDS, REST_WORK_RATE, SAPLING_GROW_DURATION, SETTLEMENT_ID, SHELTER_BRANCH_COST, SHELTER_BUILD_SECONDS, SHELTER_FOOTPRINT, SHELTER_WOOD_COST, WORKER_ID, type ActionProposal, type ActionType, type DecisionRecord, type GamePlan, type InputEntry, type InputKind, type InputLog, type PlanStepRecord, type RiskLevel, type StockpileResource, type Vec2, type WorldEntity, type WorldEvent, type WorldState } from '../world/types';
import { checkCraft, getRecipe, recipeSatisfied } from '../game/recipes';
import { DEFAULT_HOUSE_BLUEPRINT, getBlueprint } from '../game/blueprints';
import { findShelterSite, HOUSE_SITE_TOLERANCE, searchNearbySite, validateSite } from '../game/shelter';

const STEP = 0.16;
const CHOP_DURATION = 1.35;
const HARVEST_DURATION = 1.2;
const BUILD_DURATION = 2.4;
const PLANT_DURATION = 1.0;
const ARRIVAL_DISTANCE = 0.12;
const MAX_LOGGED_EVENTS = 240;
const PLAN_TTL_TICKS = 3600;
const MAX_JOURNAL = 40;

const RISK_RANK: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

type Worker = Extract<WorldEntity, { kind: 'worker' }>;
/** Free-site construction parameters: shelters, and player-placed houses sized by blueprint. */
type SiteBuildSpec = {
  structureType: 'shelter' | 'house';
  woodCost: number;
  branchCost: number;
  footprint: number;
  buildSeconds: number;
  /** Search radius for approximate requests (exact requests never search). */
  tolerance: number;
  blueprint?: string;
};

export function workersOf(state: WorldState): Worker[] {
  return Object.values(state.entities)
    .filter((entity): entity is Worker => entity.kind === 'worker')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export class WorldSimulation {
  readonly state: WorldState;
  private listeners = new Set<(state: WorldState, latest: WorldEvent[]) => void>();
  private accumulator = 0;
  private agent: Agent;
  /** Player-issued directives take precedence over the agent's own decisions. */
  readonly directives: Array<AgentDecision & { workerId?: string; planId?: string }> = [];
  /** Proposals at or below this risk auto-approve; above it they hold for humans. */
  private _autoApproveUpTo: RiskLevel = 'LOW';
  get autoApproveUpTo(): RiskLevel {
    return this._autoApproveUpTo;
  }
  set autoApproveUpTo(level: RiskLevel) {
    this._autoApproveUpTo = level;
    this.logInput('policy', { level });
  }
  /**
   * Append-only authoritative input log (Phase 5.1). Every EXTERNAL mutating
   * call appends exactly one entry; internal derivations never log. Always
   * on: appends are O(1) and change no behavior. Unbounded by design — a cap
   * would destroy replay — see the bounded-history architecture item.
   */
  readonly inputLog: InputEntry[] = [];
  private inputSeq = 0;
  private readonly genesisSnapshot: WorldState;
  private readonly genesisAgent: string;
  private readonly genesisPolicy: RiskLevel;
  private foodAccumulator = 0;
  private foodWasLow = false;
  private hungerNotified = false;
  private waterAccumulator = 0;
  private waterWasLow = false;
  private thirstNotified = false;
  private leaseDeferNotedEpoch = -2;

  constructor(state: WorldState = createWorld(), agent: Agent = new LocalGathererAgent()) {
    this.state = state;
    this.agent = agent;
    // Plain-data deep clone: WorldState holds only JSON-safe values, so this
    // avoids lib-dependent structuredClone and stays byte-identical.
    this.genesisSnapshot = JSON.parse(JSON.stringify(state)) as WorldState;
    this.genesisAgent = agent.constructor.name;
    this.genesisPolicy = this._autoApproveUpTo;
  }

  /** Append one external input to the replay log. Internal derivations must not call this. */
  private logInput(kind: InputKind, payload: Record<string, unknown>): void {
    // Deep-clone: callers often retain and later mutate the same objects
    // (e.g. proposal parameters); the log must capture arrival-time values.
    const frozen = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    this.inputLog.push({ seq: this.inputSeq++, tick: this.state.tick, kind, payload: frozen });
  }

  /**
   * Capture hook for inputs that arrive without a dedicated logging call
   * site — currently the per-turn model decision in ModelDrivenAgent. The
   * decision's EFFECTS (proposals/directives) are logged at their own
   * entries; this preserves the decision itself for future canned replay.
   */
  recordInput(kind: InputKind, payload: Record<string, unknown>): void {
    this.logInput(kind, payload);
  }

  /** Export a self-contained replay log: genesis plus all recorded inputs. */
  exportLog(): InputLog {
    return {
      version: 1,
      genesis: JSON.parse(JSON.stringify(this.genesisSnapshot)) as WorldState,
      genesisAgent: this.genesisAgent,
      genesisPolicy: this.genesisPolicy,
      finalTick: this.state.tick,
      inputs: this.inputLog.map((entry) => ({ ...entry, payload: { ...entry.payload } })),
    };
  }

  /** Swap the driving agent (e.g. local baseline ↔ model-driven ↔ manual). */
  setAgent(agent: Agent): void {
    this.agent = agent;
    this.logInput('setAgent', { agent: agent.constructor.name });
  }

  /** Queue a player-issued directive. Executed ahead of agent decisions. */
  issueDirective(decision: AgentDecision, workerId?: string, planId?: string): void {
    this.directives.push({ ...decision, ...(workerId ? { workerId } : {}), ...(planId ? { planId } : {}) });
    if (this.directives.length > 8) this.directives.shift();
    this.logInput('directive', { decision, ...(workerId ? { workerId } : {}), ...(planId ? { planId } : {}) });
  }

  clearDirectives(): void {
    this.directives.length = 0;
    this.logInput('clearDirectives', {});
  }

  subscribe(listener: (state: WorldState, latest: WorldEvent[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  proposeAction(actionType: ActionType, targetEntityId: string, parameters: Record<string, unknown> = {}, riskLevel: ActionProposal['riskLevel'] = 'LOW', agentId: string = WORKER_ID): ActionProposal {
    this.logInput('propose', { actionType, targetEntityId, parameters, riskLevel, agentId });
    return this.proposeActionInner(actionType, targetEntityId, parameters, riskLevel, agentId);
  }

  /**
   * Proposal minting without input logging — for INTERNAL derivations only
   * (autonomous decisions, plan submission, delivery chaining). External
   * callers must use proposeAction so the replay log stays complete without
   * double-applying internally generated proposals.
   */
  private proposeActionInner(actionType: ActionType, targetEntityId: string, parameters: Record<string, unknown> = {}, riskLevel: ActionProposal['riskLevel'] = 'LOW', agentId: string = WORKER_ID): ActionProposal {
    // Construction is inherently costly: the gateway assigns HIGH regardless
    // of what the proposer requested. The model can never downgrade risk.
    const effectiveRisk = actionType === 'BUILD' ? 'HIGH' : riskLevel;
    const proposal: ActionProposal = {
      id: `proposal-${String(this.state.nextProposalNumber++).padStart(4, '0')}`,
      agentId,
      actionType,
      targetEntityId,
      parameters,
      riskLevel: effectiveRisk,
      createdAt: this.state.tick,
      status: 'PROPOSED',
    };
    this.state.proposals.push(proposal);
    this.emit('ACTION_PROPOSED', proposal.agentId, { proposalId: proposal.id, actionType, targetEntityId, riskLevel: effectiveRisk, ...parameters });
    if (RISK_RANK[effectiveRisk] <= RISK_RANK[this.autoApproveUpTo]) {
      this.setProposalStatus(proposal, 'APPROVED');
      this.emit('GOVERNANCE_PERMISSION_GRANTED', proposal.agentId, { proposalId: proposal.id, actionType, targetEntityId, riskLevel: effectiveRisk, policy: `auto-approval-up-to-${this.autoApproveUpTo}` });
      this.setProposalStatus(proposal, 'EXECUTING');
    }
    return proposal;
  }

  approveProposal(proposalId: string): boolean {
    const proposal = this.state.proposals.find((item) => item.id === proposalId);
    if (!proposal || proposal.status !== 'PROPOSED') return false;
    this.logInput('approve', { proposalId });
    this.setProposalStatus(proposal, 'APPROVED');
    this.emit('GOVERNANCE_PERMISSION_GRANTED', proposal.agentId, { proposalId: proposal.id, actionType: proposal.actionType, targetEntityId: proposal.targetEntityId, riskLevel: proposal.riskLevel, policy: 'explicit-human-approval' });
    this.syncPlanWithProposal(proposal);
    return true;
  }

  rejectProposal(proposalId: string): boolean {
    const proposal = this.state.proposals.find((item) => item.id === proposalId);
    if (!proposal || proposal.status !== 'PROPOSED') return false;
    this.logInput('reject', { proposalId });
    this.setProposalStatus(proposal, 'REJECTED');
    this.emit('GOVERNANCE_PERMISSION_DENIED', proposal.agentId, { proposalId: proposal.id, actionType: proposal.actionType, targetEntityId: proposal.targetEntityId, riskLevel: proposal.riskLevel, policy: 'explicit-human-rejection' });
    this.syncPlanWithProposal(proposal);
    return true;
  }

  /**
   * Operator cancellation: recalls a proposal that governance has not yet
   * released for execution. EXECUTING/EXECUTED proposals cannot be recalled —
   * they are already mutating (or mutated) the world.
   */
  cancelProposal(proposalId: string): boolean {
    const proposal = this.state.proposals.find((item) => item.id === proposalId);
    if (!proposal || (proposal.status !== 'PROPOSED' && proposal.status !== 'APPROVED')) return false;
    this.logInput('cancelProposal', { proposalId });
    this.setProposalStatus(proposal, 'CANCELLED');
    this.syncPlanWithProposal(proposal);
    return true;
  }

  // ---- Governed plans: one proposal authorizes a bounded set of steps ----

  planRiskForKind(kind: string): ActionProposal['riskLevel'] {
    return kind.startsWith('construct-') ? 'HIGH' : 'LOW';
  }

  planAllowedActions(kind: string, resource?: 'wood' | 'food'): ActionType[] {
    const haul: ActionType[] = ['PICK_UP', 'DELIVER', 'MOVE_TO'];
    if (kind === 'fetch-water') {
      return ['HARVEST', ...haul];
    }
    if (kind === 'plant') {
      return ['PLANT', 'MOVE_TO'];
    }
    if (kind === 'craft') {
      return ['COLLECT', 'CRAFT', 'DELIVER', 'MOVE_TO'];
    }
    if (kind === 'gather-wood' || (kind === 'preserve' && resource === 'wood') || (kind === 'prioritize' && resource !== 'food')) {
      return ['GATHER', ...haul];
    }
    if (kind === 'gather-food' || (kind === 'preserve' && resource !== 'wood') || (kind === 'prioritize' && resource === 'food')) {
      return ['HARVEST', ...haul];
    }
    if (kind === 'construct-shelter') {
      return ['GATHER', 'COLLECT', 'PICK_UP', 'DELIVER', 'MOVE_TO', 'BUILD'];
    }
    return ['GATHER', 'HARVEST', ...haul, 'BUILD'];
  }

  planSpendCap(kind: string, quantity: number, blueprint?: string): number {
    if (kind === 'construct-house') {
      const bp = getBlueprint(blueprint ?? DEFAULT_HOUSE_BLUEPRINT) ?? getBlueprint(DEFAULT_HOUSE_BLUEPRINT)!;
      return bp.woodCost * quantity;
    }
    if (kind === 'construct-farm') return FARM_WOOD_COST * quantity;
    if (kind === 'construct-shelter') return SHELTER_WOOD_COST * quantity;
    return 0;
  }

  submitPlan(kind: string, quantity: number, resource?: 'wood' | 'food', blueprint?: string): { plan: GamePlan; proposal: ActionProposal } {
    this.logInput('submitPlan', { kind, quantity, ...(resource ? { resource } : {}), ...(blueprint ? { blueprint } : {}) });
    const plan: GamePlan = {
      id: `plan-${String(this.state.nextPlanNumber++).padStart(2, '0')}`,
      kind,
      quantity,
      resource,
      ...(blueprint ? { blueprint } : {}),
      status: 'awaiting-approval',
      proposalId: null,
      constraints: {
        allowedActions: this.planAllowedActions(kind, resource),
        spendCapWood: this.planSpendCap(kind, quantity, blueprint),
        expiresTick: this.state.tick + PLAN_TTL_TICKS,
      },
      spentWood: 0,
      steps: [],
      createdAt: this.state.tick,
    };
    this.state.plans[plan.id] = plan;
    const proposal = this.proposeActionInner('PLAN', SETTLEMENT_ID, { planId: plan.id, kind, quantity, ...(resource ? { resource } : {}) }, this.planRiskForKind(kind), WORKER_ID);
    plan.proposalId = proposal.id;
    this.emit('PLAN_STATUS_CHANGED', undefined, { planId: plan.id, status: plan.status, kind, quantity });
    if (proposal.status === 'EXECUTING') this.activatePlan(plan);
    return { plan, proposal };
  }

  private activatePlan(plan: GamePlan): void {
    if (plan.status !== 'awaiting-approval') return;
    plan.status = 'active';
    this.emit('PLAN_STATUS_CHANGED', undefined, { planId: plan.id, status: 'active', proposalId: plan.proposalId });
  }

  private syncPlanWithProposal(proposal: ActionProposal): void {
    const planId = proposal.parameters['planId'];
    if (typeof planId !== 'string') return;
    const plan = this.state.plans[planId];
    if (!plan) return;
    if (proposal.status === 'APPROVED' || proposal.status === 'EXECUTING') {
      this.activatePlan(plan);
    } else if (proposal.status === 'REJECTED' && (plan.status === 'awaiting-approval' || plan.status === 'active')) {
      plan.status = 'rejected';
      this.emit('PLAN_STATUS_CHANGED', undefined, { planId: plan.id, status: 'rejected', proposalId: proposal.id });
    } else if (proposal.status === 'CANCELLED' && plan.status !== 'completed') {
      plan.status = 'cancelled';
      this.clearPlanTasks(plan.id);
      this.emit('PLAN_STATUS_CHANGED', undefined, { planId: plan.id, status: 'cancelled', proposalId: proposal.id });
    }
  }

  /** Mark a plan completed (e.g. its goal verified). Stops further steps. */
  completePlan(planId: string): boolean {
    const plan = this.state.plans[planId];
    if (!plan || (plan.status !== 'active' && plan.status !== 'blocked')) return false;
    this.logInput('completePlan', { planId });
    plan.status = 'completed';
    this.clearPlanTasks(plan.id);
    this.emit('PLAN_STATUS_CHANGED', undefined, { planId: plan.id, status: 'completed' });
    const proposal = plan.proposalId ? this.state.proposals.find((item) => item.id === plan.proposalId) : undefined;
    if (proposal && (proposal.status === 'APPROVED' || proposal.status === 'EXECUTING')) {
      this.setProposalStatus(proposal, 'EXECUTED');
      this.setProposalStatus(proposal, 'VERIFIED');
    }
    return true;
  }

  /** Revoke a plan: release holds, stop its workers, record explicitly. */
  cancelPlan(planId: string): boolean {
    const plan = this.state.plans[planId];
    if (!plan || (plan.status !== 'active' && plan.status !== 'awaiting-approval' && plan.status !== 'blocked')) return false;
    this.logInput('cancelPlan', { planId });
    const proposal = plan.proposalId ? this.state.proposals.find((item) => item.id === plan.proposalId) : undefined;
    if (proposal && (proposal.status === 'PROPOSED' || proposal.status === 'APPROVED')) {
      this.cancelProposal(proposal.id);
    } else {
      plan.status = 'cancelled';
      this.clearPlanTasks(plan.id);
      this.emit('PLAN_STATUS_CHANGED', undefined, { planId: plan.id, status: 'cancelled' });
      this.closePlanProposal(proposal);
    }
    return true;
  }

  /**
   * Close a plan's own authorization record when the plan itself ends.
   * completePlan verifies it; cancellation/expiry cancel it. Without this,
   * an EXECUTING plan proposal strands forever: cancelProposal only recalls
   * pre-execution proposals, and nothing else settles plan proposals.
   */
  private closePlanProposal(proposal: ActionProposal | undefined): void {
    if (proposal && proposal.status === 'EXECUTING') {
      this.setProposalStatus(proposal, 'CANCELLED');
    }
  }

  private clearPlanTasks(planId: string): void {
    for (const worker of workersOf(this.state)) {
      if (worker.task?.planId === planId) {
        worker.task = null;
        worker.activity = 'idle';
        worker.targetId = null;
      }
      if (worker.deliveryPlanId === planId) worker.deliveryPlanId = undefined;
    }
    for (let index = this.directives.length - 1; index >= 0; index -= 1) {
      if (this.directives[index]?.planId === planId) this.directives.splice(index, 1);
    }
  }

  private expirePlans(): void {
    for (const plan of Object.values(this.state.plans)) {
      if (plan.status === 'active' && this.state.tick > plan.constraints.expiresTick) {
        plan.status = 'expired';
        this.clearPlanTasks(plan.id);
        this.emit('PLAN_STATUS_CHANGED', undefined, { planId: plan.id, status: 'expired', reason: 'ttl' });
        const proposal = plan.proposalId ? this.state.proposals.find((item) => item.id === plan.proposalId) : undefined;
        this.closePlanProposal(proposal);
      }
    }
  }

  recordStep(planId: string, record: Omit<PlanStepRecord, 'index' | 'at'>): void {
    const plan = this.state.plans[planId];
    if (!plan) return;
    plan.steps.push({ ...record, index: plan.steps.length, at: this.state.tick });
  }

  recordJournal(entry: Omit<DecisionRecord, 'at'>): void {
    this.logInput('journal', { ...entry });
    this.state.journal.push({ ...entry, at: this.state.tick });
    while (this.state.journal.length > MAX_JOURNAL) this.state.journal.shift();
  }

  private setProposalStatus(proposal: ActionProposal, status: ActionProposal['status']): void {
    proposal.status = status;
    this.emit('ACTION_STATUS_CHANGED', proposal.agentId, { proposalId: proposal.id, status });
  }

  /** Carried-resource kind to stockpile resource. Null when not haulable. */
  private static stockpileFor(kind: string): StockpileResource | null {
    if (kind === 'log') return 'wood';
    if (kind === 'food') return 'food';
    if (kind === 'water') return 'water';
    return null;
  }

  private stockpileTotal(resource: StockpileResource): number {
    return resource === 'wood' ? this.state.wood : resource === 'food' ? this.state.food : this.state.water;
  }

  private addToStockpile(resource: StockpileResource, amount: number): number {
    if (resource === 'wood') this.state.wood += amount;
    else if (resource === 'food') this.state.food += amount;
    else this.state.water += amount;
    return this.stockpileTotal(resource);
  }

  recordExternalEvent(type: WorldEvent['type'], entityId: string | undefined, data: Record<string, unknown>): WorldEvent {
    this.logInput('externalEvent', { type, ...(entityId !== undefined ? { entityId } : {}), data });
    return this.emit(type, entityId, data);
  }

  /**
   * Single-writer lease bookkeeping. Granting a lease to 'er' means the
   * local sim surrenders authoritative writes for that entity; granting to
   * 'local' takes them back. Every transition emits LEASE_CHANGED.
   */
  grantLease(entityId: string, holder: 'local' | 'er', nonceFloor: number): void {
    this.logInput('grantLease', { entityId, holder, nonceFloor });
    this.grantLeaseInner(entityId, holder, nonceFloor);
  }

  /** Lease grant without input logging — for INTERNAL derivation (reconciliation). */
  private grantLeaseInner(entityId: string, holder: 'local' | 'er', nonceFloor: number): void {
    const previous = this.state.leases[entityId];
    this.state.leases[entityId] = {
      entityId,
      holder,
      epoch: (previous?.epoch ?? 0) + 1,
      nonceFloor,
      lastVerifiedSlot: previous?.lastVerifiedSlot ?? null,
      stale: holder === 'er',
    };
    this.emit('LEASE_CHANGED', entityId, { holder, epoch: this.state.leases[entityId]!.epoch, nonceFloor });
  }

  markLeaseVerified(entityId: string, slot: number, nonce: number): void {
    const lease = this.state.leases[entityId];
    if (!lease) return;
    this.logInput('leaseVerified', { entityId, slot, nonce });
    this.markLeaseVerifiedInner(entityId, slot, nonce);
  }

  /** Lease verification without input logging — for INTERNAL derivation. */
  private markLeaseVerifiedInner(entityId: string, slot: number, nonce: number): void {
    const lease = this.state.leases[entityId];
    if (!lease) return;
    lease.lastVerifiedSlot = slot;
    lease.nonceFloor = Math.max(lease.nonceFloor, nonce);
    lease.stale = false;
  }

  markLeaseStale(entityId: string): void {
    const lease = this.state.leases[entityId];
    if (!lease || lease.stale) return;
    this.logInput('leaseStale', { entityId });
    lease.stale = true;
    this.emit('LEASE_CHANGED', entityId, { holder: lease.holder, epoch: lease.epoch, stale: true });
  }

  /**
   * Record offline activity as explicitly speculative. It is stored apart
   * from authoritative state and is never merged silently — resolution goes
   * through resolveSpeculative with a documented rule.
   */
  recordSpeculative(entityId: string, kind: string, detail: string): string {
    this.logInput('speculative', { entityId, kind, detail });
    const id = `spec-${String(this.state.nextSpeculativeNumber++).padStart(3, '0')}`;
    this.state.speculative.push({ id, entityId, kind, notedAt: this.state.tick, detail, resolution: 'pending' });
    this.emit('SPECULATIVE_NOTED', entityId, { speculativeId: id, kind, detail });
    return id;
  }

  /**
   * Resolve a speculative record under an explicit rule. This experiment's
   * rule ('no-merge') never folds speculative increments into the
   * authoritative counter; adoption requires a contiguous nonce proof via
   * resolveSpeculativeAdopted (unused here, present for the documented
   * alternative). Every resolution emits RECONCILIATION_RESOLVED.
   */
  resolveSpeculative(speculativeId: string, rule: 'no-merge' | 'adopt-if-contiguous', authoritative: { nonce: number; count: number }): boolean {
    const record = this.state.speculative.find((item) => item.id === speculativeId);
    if (!record || record.resolution !== 'pending') return false;
    this.logInput('resolveSpeculative', { speculativeId, rule, authoritative });
    if (rule === 'no-merge') {
      record.resolution = 'discarded-held-for-review';
      this.emit('RECONCILIATION_RESOLVED', record.entityId, {
        speculativeId, rule, outcome: 'discarded-held-for-review',
        authoritativeNonce: authoritative.nonce, authoritativeCount: authoritative.count,
      });
      return true;
    }
    return false;
  }

  /**
   * Lease-aware farm reconciliation: the single place where verified chain
   * state meets the local farm entity. Never invents or overwrites:
   * - chain built + no local farm → create presentation, grant lease to ER.
   * - chain built + local farm exists → adopt (no duplicate), grant lease.
   * - chain unbuilt/absent → no lease (local-only mode); an existing lease
   *   with conflicting content is held, never auto-resolved.
   * Returns a short outcome tag for callers/tests.
   */
  reconcileFarmLease(chain: { state: 'unbuilt' | 'built'; nonce: number; woodSpent: number; authority: string } | null, slot: number | null): string {
    this.logInput('reconcileFarm', { chain: chain ? { ...chain } : null, slot });
    const local = this.state.entities['farm-01'];
    const localIsFarm = local !== undefined && local.kind === 'farm';
    if (!chain || chain.state === 'unbuilt') {
      const lease = this.state.leases['farm-01'];
      if (lease && lease.holder === 'er') {
        this.emit('AUTHORITATIVE_STATE_CONFLICT', 'farm-01', { reason: 'Lease held by ER but chain shows unbuilt/absent; holding for review, local state untouched.', slot });
        return 'conflict-held';
      }
      return 'local-only';
    }
    if (!localIsFarm) {
      this.state.entities['farm-01'] = { id: 'farm-01', kind: 'farm', position: { ...FARM_SLOTS[0]! }, state: 'growing', progress: 0 };
      this.emit('LOCAL_STATE_RECONCILED', 'farm-01', { state: 'growing', reference: `chain-built nonce ${chain.nonce}` });
    }
    this.grantLeaseInner('farm-01', 'er', chain.nonce);
    if (slot !== null) this.markLeaseVerifiedInner('farm-01', slot, chain.nonce);
    return localIsFarm ? 'adopted' : 'created';
  }
  applyVerifiedFarmBuild(woodSpent: number, reference: string): boolean {
    this.logInput('applyFarmBuild', { woodSpent, reference });
    const existing = this.state.entities['farm-01'];
    if (existing && existing.kind === 'farm') {
      this.emit('AUTHORITATIVE_STATE_CONFLICT', 'farm-01', { reason: 'Verified farm build refused: farm-01 already exists locally.', reference });
      return false;
    }
    if (!Number.isSafeInteger(woodSpent) || woodSpent <= 0 || this.state.wood < woodSpent) {
      this.emit('AUTHORITATIVE_STATE_CONFLICT', 'farm-01', { reason: 'Verified farm build refused: local stockpile cannot cover the committed cost.', reference });
      return false;
    }
    this.state.wood -= woodSpent;
    this.state.entities['farm-01'] = { id: 'farm-01', kind: 'farm', position: { ...FARM_SLOTS[0]! }, state: 'growing', progress: 0 };
    this.emit('CONSTRUCTION_STARTED', 'farm-01', { structureType: 'farm', woodSpent, reference, source: 'magicblock-verified' });
    this.emit('CONSTRUCTION_COMPLETED', 'farm-01', { structureType: 'farm', woodSpent, reference, source: 'magicblock-verified' });
    this.emit('LOCAL_STATE_RECONCILED', 'farm-01', { state: 'growing', reference });
    this.finishActiveProposal('BUILD', SETTLEMENT_ID, () => this.state.entities['farm-01']?.kind === 'farm');
    return true;
  }

  reconcileTreeFromAuthority(treeId: string, health: number, verified: boolean, reference: string): boolean {
    this.logInput('reconcileTree', { treeId, health, verified, reference });
    const tree = this.state.entities[treeId];
    if (!verified || !Number.isInteger(health) || !tree || tree.kind !== 'tree' || health < 0 || health > tree.maxHealth) {
      this.emit('AUTHORITATIVE_STATE_CONFLICT', treeId, { reason: 'Unverified or invalid authoritative tree state was refused.', reference });
      return false;
    }
    const pendingMagicProposal = this.state.proposals.some((proposal) => proposal.targetEntityId === treeId
      && proposal.actionType === 'GATHER'
      && proposal.parameters['execution'] === 'magicblock-er'
      && (proposal.status === 'PROPOSED' || proposal.status === 'APPROVED' || proposal.status === 'EXECUTING'));
    if (health > tree.health) {
      this.emit('AUTHORITATIVE_STATE_CONFLICT', treeId, { reason: 'Refusing to overwrite newer local state with an older authoritative state.', localHealth: tree.health, authoritativeHealth: health, reference });
      return false;
    }
    if (health === tree.health && (health === 0) === (tree.state === 'depleted')) {
      if (pendingMagicProposal && health === 0) {
        const proposal = this.state.proposals.find((item) => item.targetEntityId === treeId
          && item.actionType === 'GATHER'
          && item.parameters['execution'] === 'magicblock-er'
          && (item.status === 'PROPOSED' || item.status === 'APPROVED' || item.status === 'EXECUTING'));
        if (proposal) {
          proposal.status = 'VERIFIED';
          this.emit('ACTION_STATUS_CHANGED', proposal.agentId, { proposalId: proposal.id, status: 'VERIFIED', execution: 'magicblock-er', reference });
        }
      }
      return true;
    }
    if (health === tree.health) {
      this.emit('AUTHORITATIVE_STATE_CONFLICT', treeId, { reason: 'Health matches but local lifecycle state conflicts with verified authority.', localState: tree.state, authoritativeState: health === 0 ? 'depleted' : 'standing', reference });
      return false;
    }
    tree.health = health;
    tree.state = health === 0 ? 'depleted' : 'standing';
    this.emit('LOCAL_STATE_RECONCILED', treeId, { health, state: tree.state, reference });
    if (pendingMagicProposal && health === 0) {
      const proposal = this.state.proposals.find((item) => item.targetEntityId === treeId          && item.actionType === 'GATHER'
          && item.parameters['execution'] === 'magicblock-er'
          && (item.status === 'PROPOSED' || item.status === 'APPROVED' || item.status === 'EXECUTING'));
      if (proposal) {
        proposal.status = 'VERIFIED';
        this.emit('ACTION_STATUS_CHANGED', proposal.agentId, { proposalId: proposal.id, status: 'VERIFIED', execution: 'magicblock-er', reference });
      }
    }
    return true;
  }

  /**
   * Execution records that the action ran. Verification is a separate step
   * that checks the resulting world state — an action is VERIFIED only when
   * its intended state change is actually observed, never merely because the
   * execution path returned successfully. Terminal failures on plan steps
   * are recorded into the parent plan.
   */
  private isVirtualPlanStep(proposal: ActionProposal): boolean {
    return proposal.id.includes(':step-');
  }

  private finishAction(proposal: ActionProposal, succeeded: boolean): void {
    // Virtual plan steps are never stored in state.proposals: record the
    // terminal outcome directly into the parent plan, no status events.
    if (this.isVirtualPlanStep(proposal)) {
      const planId = proposal.parameters['planId'];
      if (typeof planId === 'string' && !succeeded) {
        this.recordStep(planId, {
          actionType: proposal.actionType,
          targetEntityId: proposal.targetEntityId,
          source: typeof proposal.parameters['source'] === 'string' ? proposal.parameters['source'] as string : 'sim',
          status: 'failed',
          note: 'execution failed',
        });
      }
      return;
    }
    this.setProposalStatus(proposal, succeeded ? 'EXECUTED' : 'FAILED');
    const planId = proposal.parameters['planId'];
    if (typeof planId === 'string' && !succeeded) {
      this.recordStep(planId, {
        actionType: proposal.actionType,
        targetEntityId: proposal.targetEntityId,
        source: typeof proposal.parameters['source'] === 'string' ? proposal.parameters['source'] as string : 'sim',
        status: 'failed',
        note: 'execution failed',
      });
    }
  }

  private verifyAction(proposal: ActionProposal, outcomeHolds: boolean): void {
    if (this.isVirtualPlanStep(proposal)) {
      const planId = proposal.parameters['planId'];
      if (typeof planId === 'string') {
        this.recordStep(planId, {
          actionType: proposal.actionType,
          targetEntityId: proposal.targetEntityId,
          source: typeof proposal.parameters['source'] === 'string' ? proposal.parameters['source'] as string : 'sim',
          status: outcomeHolds ? 'verified' : 'failed',
          note: outcomeHolds ? 'postcondition independently verified' : 'postcondition did not hold',
        });
      }
      return;
    }
    this.setProposalStatus(proposal, outcomeHolds ? 'VERIFIED' : 'FAILED');
    const planId = proposal.parameters['planId'];
    if (typeof planId === 'string') {
      this.recordStep(planId, {
        actionType: proposal.actionType,
        targetEntityId: proposal.targetEntityId,
        source: typeof proposal.parameters['source'] === 'string' ? proposal.parameters['source'] as string : 'sim',
        status: outcomeHolds ? 'verified' : 'failed',
        note: outcomeHolds ? 'postcondition independently verified' : 'postcondition did not hold',
      });
    }
  }

  tick(deltaSeconds: number): void {
    this.accumulator += Math.min(deltaSeconds, 0.1);
    while (this.accumulator >= STEP) {
      this.accumulator -= STEP;
      this.state.tick += 1;
      this.simulateStep(STEP);
    }
  }

  advanceUntil(predicate: (state: WorldState) => boolean, maxSteps = 2400): boolean {
    for (let index = 0; index < maxSteps && !predicate(this.state); index += 1) {
      this.state.tick += 1;
      this.simulateStep(STEP);
    }
    return predicate(this.state);
  }

  private simulateStep(delta: number): void {
    this.tickSettlement(delta);
    for (const worker of workersOf(this.state)) {
      if (worker.carrying) {
        this.stepCarrying(worker);
        continue;
      }
      if (worker.task) {
        this.stepTask(worker, delta);
        continue;
      }
      this.stepDecision(worker);
    }
  }

  /** Food and water consumption, hunger/thirst, growth, and regrowth. All deterministic. */
  private tickSettlement(delta: number): void {
    const workers = workersOf(this.state);
    if (workers.length > 0) {
      this.foodAccumulator += (workers.length / CONSUMPTION_TICKS_PER_WORKER) * (delta / STEP);
      while (this.foodAccumulator >= 1) {
        this.foodAccumulator -= 1;
        if (this.state.food > 0) {
          this.state.food -= 1;
          this.hungerNotified = false;
          this.emit('FOOD_CONSUMED', SETTLEMENT_ID, { resource: 'food', amount: 1, total: this.state.food, population: workers.length });
        } else if (!this.hungerNotified) {
          this.hungerNotified = true;
          this.emit('POPULATION_HUNGRY', SETTLEMENT_ID, { population: workers.length, food: 0 });
        }
      }
      // Water mirrors food: same rate, same non-lethal semantics. Thirst is
      // reported, never fatal — consistent with hunger.
      this.waterAccumulator += (workers.length / CONSUMPTION_TICKS_PER_WORKER) * (delta / STEP);
      while (this.waterAccumulator >= 1) {
        this.waterAccumulator -= 1;
        if (this.state.water > 0) {
          this.state.water -= 1;
          this.thirstNotified = false;
        } else if (!this.thirstNotified) {
          this.thirstNotified = true;
          this.emit('POPULATION_THIRSTY', SETTLEMENT_ID, { population: workers.length, water: 0 });
        }
      }
    }
    const low = this.state.food <= 1;
    if (low && !this.foodWasLow) this.emit('FOOD_LOW', SETTLEMENT_ID, { food: this.state.food });
    this.foodWasLow = low;
    const waterLow = this.state.water <= 1;
    if (waterLow && !this.waterWasLow) this.emit('WATER_LOW', SETTLEMENT_ID, { water: this.state.water });
    this.waterWasLow = waterLow;
    for (const entity of Object.values(this.state.entities)) {
      if (entity.kind === 'farm' && entity.state === 'growing') {
        entity.progress = Math.min(1, entity.progress + delta / FARM_GROW_DURATION);
        if (entity.progress >= 1) entity.state = 'ready';
      }
      // Berry patches regrow on their own: a harvested patch becomes
      // available again after BERRY_REGROW_DURATION sim-seconds. Forage is
      // renewable but slow — the crank that makes gather-food repeatable.
      if (entity.kind === 'berry-patch' && entity.state === 'harvested') {
        entity.progress = Math.min(1, (entity.progress ?? 0) + delta / BERRY_REGROW_DURATION);
        if (entity.progress >= 1) {
          entity.state = 'available';
          entity.progress = 0;
        }
      }
      // Saplings mature on their own: a planted tree becomes standing timber
      // after SAPLING_GROW_DURATION sim-seconds. Nature's crank, not labor.
      if (entity.kind === 'tree' && entity.state === 'sapling') {
        entity.progress = Math.min(1, (entity.progress ?? 0) + delta / SAPLING_GROW_DURATION);
        if (entity.progress >= 1) {
          entity.state = 'standing';
          entity.health = entity.maxHealth;
          entity.progress = 0;
          this.emit('TREE_MATURED', entity.id, { health: entity.health, state: entity.state });
        }
      }
      // Wildlife wander: deterministic per-tick drift, no frame timing.
      // Deer avoid workers within 2.5 (flee); otherwise slow forage drift.
      if (entity.kind === 'animal' && entity.state !== 'fleeing') {
        const nearest = workers.length > 0
          ? Math.min(...workers.map((w) => Math.hypot(w.position.x - entity.position.x, w.position.z - entity.position.z)))
          : Infinity;
        if (nearest < 2.5) {
          entity.state = 'fleeing';
        } else {
          entity.state = 'wandering';
          const t = this.state.tick;
          const seed = entity.id.charCodeAt(entity.id.length - 1) + entity.id.length * 7;
          entity.position = {
            x: entity.position.x + Math.sin((t + seed * 13) * 0.05) * 0.02,
            z: entity.position.z + Math.cos((t + seed * 29) * 0.04) * 0.02,
          };
        }
      } else if (entity.kind === 'animal' && entity.state === 'fleeing') {
        const nearestWorker = workers
          .map((w) => ({ w, d: Math.hypot(w.position.x - entity.position.x, w.position.z - entity.position.z) }))
          .sort((a, b) => a.d - b.d)[0];
        if (!nearestWorker || nearestWorker.d >= 3.5) {
          entity.state = 'wandering';
        } else if (nearestWorker.d > 0.01) {
          const dx = (entity.position.x - nearestWorker.w.position.x) / nearestWorker.d;
          const dz = (entity.position.z - nearestWorker.w.position.z) / nearestWorker.d;
          entity.position = { x: entity.position.x + dx * 0.05, z: entity.position.z + dz * 0.05 };
        }
      }
    }
    if (this.state.tick > 0 && this.state.tick % GROWTH_CHECK_TICKS === 0) this.maybeGrow();
    this.expirePlans();
  }

  private maybeGrow(): void {
    const workers = workersOf(this.state);
    if (workers.length >= MAX_WORKERS || this.state.food < GROWTH_FOOD_THRESHOLD) return;
    const houses = Object.values(this.state.entities).filter((entity) => entity.kind === 'house' && entity.state === 'complete').length;
    if (workers.length >= BASE_HOUSING + houses * HOUSING_PER_HOUSE) return;
    this.state.food -= GROWTH_ARRIVAL_COST;
    const id = `worker-${String(workers.length + 1).padStart(2, '0')}`;
    const settlement = this.state.entities[SETTLEMENT_ID];
    const at = settlement && settlement.kind === 'settlement' ? { ...settlement.position } : { x: 0, z: 0 };
    this.state.entities[id] = { id, kind: 'worker', position: at, carrying: null, activity: 'idle', targetId: null, task: null, inventory: {}, capacity: 10, restedUntilTick: 0, equipment: { axe: 'basic-axe', basket: false } };
    this.emit('ENTITY_SPAWNED', id, { kind: 'worker', position: at });
    this.emit('POPULATION_JOINED', id, { population: workers.length + 1, food: this.state.food });
  }

  /**
   * Fail the DELIVER proposal minted for one specific haul, matched by the
   * carried resource id. Never touches another worker's haul proposal, and
   * never re-settles a proposal that already reached a terminal state.
   */
  private failHaulProposal(carriedId: string | null): void {
    if (!carriedId) return;
    const proposal = [...this.state.proposals].reverse().find((item) =>
      item.actionType === 'DELIVER'
      && item.targetEntityId === SETTLEMENT_ID
      && item.parameters['resourceId'] === carriedId
      && (item.status === 'EXECUTING' || item.status === 'APPROVED'));
    if (proposal) this.finishAction(proposal, false);
  }

  private stepCarrying(worker: Worker): void {
    const carriedId = worker.carrying;
    const resourceEntity = carriedId ? this.state.entities[carriedId] : undefined;
    const settlement = this.state.entities[SETTLEMENT_ID];
    if (!settlement || settlement.kind !== 'settlement') {
      // Settlement gone: delivery can never verify. Fail the matched haul
      // proposal (live only) so the action settles instead of leaking; the
      // worker keeps its load until the world is whole again.
      this.failHaulProposal(carriedId);
      return;
    }
    if (!resourceEntity || (resourceEntity.kind !== 'log' && resourceEntity.kind !== 'food' && resourceEntity.kind !== 'water')) {
      // Ghost load: the carried resource no longer exists. Drop the
      // reference, free the worker, and settle the matched haul attempt.
      worker.carrying = null;
      worker.targetId = null;
      worker.activity = 'idle';
      this.failHaulProposal(carriedId);
      if (worker.deliveryPlanId && this.state.plans[worker.deliveryPlanId]) {
        this.recordStep(worker.deliveryPlanId, {
          actionType: 'DELIVER', targetEntityId: SETTLEMENT_ID, source: 'sim',
          status: 'blocked', note: 'carried resource missing; stale haul cleared',
        });
      }
      worker.deliveryPlanId = undefined;
      worker.deliveryProposalId = undefined;
      return;
    }
    worker.activity = 'carrying';
    this.moveToward(worker.position, settlement.position, STEP, { resource: resourceEntity.kind === 'log' ? 'wood' : resourceEntity.kind === 'food' ? 'food' : 'water', targetEntityId: settlement.id });
    resourceEntity.position = { ...worker.position };
    if (distance(worker.position, settlement.position) <= ARRIVAL_DISTANCE) {
      resourceEntity.state = 'delivered';
      resourceEntity.position = { ...settlement.position };
      worker.carrying = null;
      worker.targetId = null;
      worker.activity = 'idle';
      const resource = WorldSimulation.stockpileFor(resourceEntity.kind);
      if (!resource) return;
      const stockpileBefore = this.stockpileTotal(resource);
      // Explicit attribution: settle this haul's own DELIVER proposal, never
      // the newest live one (which may belong to a concurrent haul).
      const ownDeliver = worker.deliveryProposalId
        ? this.state.proposals.find((item) => item.id === worker.deliveryProposalId)
        : [...this.state.proposals].reverse().find((item) =>
          item.actionType === 'DELIVER'
          && item.targetEntityId === SETTLEMENT_ID
          && item.parameters['resourceId'] === resourceEntity.id);
      const deliverPlan = (worker.deliveryPlanId ?? ownDeliver?.parameters['planId']) as unknown;
      this.emit('RESOURCE_DELIVERED', resourceEntity.id, this.stampPlan({ workerId: worker.id, settlementId: settlement.id, resource }, deliverPlan));
      const total = this.addToStockpile(resource, 1);
      this.emit('RESOURCE_ADDED', settlement.id, this.stampPlan({ resource, amount: 1, total }, deliverPlan));
      this.finishDeliveryProposal(ownDeliver, resourceEntity, resource, stockpileBefore, deliverPlan);
      worker.deliveryPlanId = undefined;
      worker.deliveryProposalId = undefined;
    }
  }

  /**
   * Settle one completed haul: its own stored proposal when live, else the
   * parent plan's step record. Terminal proposals are never re-settled;
   * another worker's proposal is never touched.
   */
  private finishDeliveryProposal(
    ownDeliver: ActionProposal | undefined,
    resourceEntity: { id: string; state: string },
    resource: StockpileResource,
    stockpileBefore: number,
    deliverPlan: unknown,
  ): void {
    if (ownDeliver && (ownDeliver.status === 'EXECUTING' || ownDeliver.status === 'APPROVED')) {
      this.finishAction(ownDeliver, true);
      this.verifyAction(ownDeliver, resourceEntity.state === 'delivered'
        && this.stockpileTotal(resource) === stockpileBefore + 1);
      return;
    }
    if (typeof deliverPlan === 'string' && this.state.plans[deliverPlan]) {
      const ok = resourceEntity.state === 'delivered'
        && this.stockpileTotal(resource) === stockpileBefore + 1;
      this.recordStep(deliverPlan, {
        actionType: 'DELIVER', targetEntityId: SETTLEMENT_ID, source: 'sim',
        status: ok ? 'verified' : 'failed',
        note: ok ? 'postcondition independently verified' : 'postcondition did not hold',
      });
    }
  }

  private stepTask(worker: Worker, delta: number): void {
    const task = worker.task;
    if (!task) return;
    if (task.kind === 'chop') this.stepChop(worker, task.targetId, delta);
    else if (task.kind === 'harvest') this.stepHarvest(worker, task.targetId, delta);
    else if (task.kind === 'plant') this.stepPlant(worker, task.targetId, delta);
    else if (task.kind === 'craft') this.stepCraft(worker, task.targetId, delta);
    else if (task.kind === 'rest') this.stepRest(worker, task.targetId, delta);
    else this.stepBuildProgress(worker, task.targetId, delta);
  }

  /** Rested workers do timed work faster. Pure function of authoritative ticks. */
  private workRate(worker: Worker): number {
    return this.state.tick < worker.restedUntilTick ? REST_WORK_RATE : 1;
  }

  /**
   * Settle a dead task's authorizing proposal without double-settling:
   * plan tasks record a blocked step; legacy tasks fail their own live
   * proposal only. A shared proposal already settled (e.g. VERIFIED by the
   * worker that won the race) is never touched.
   */
  private settleStaleTask(task: { planId?: string; proposalId?: string }, actionType: ActionType, targetId: string, note: string): void {
    if (task.planId) {
      this.recordStep(task.planId, {
        actionType,
        targetEntityId: targetId,
        source: 'sim',
        status: 'blocked',
        note,
      });
      return;
    }
    const proposal = (task.proposalId ? this.state.proposals.find((item) => item.id === task.proposalId) : undefined)
      ?? this.findActiveProposal(actionType, targetId);
    if (proposal && (proposal.status === 'EXECUTING' || proposal.status === 'APPROVED')) {
      this.finishAction(proposal, false);
    }
  }

  private stepChop(worker: Worker, treeId: string, delta: number): void {
    const task = worker.task;
    if (!task || task.kind !== 'chop') return;
    task.elapsed += delta * this.workRate(worker);
    if (task.elapsed < CHOP_DURATION) return;
    const tree = this.state.entities[treeId];
    const pendingChainProposal = tree?.kind === 'tree' && this.state.proposals.find((proposal) => proposal.actionType === 'GATHER'
      && proposal.targetEntityId === tree.id
      && proposal.parameters['execution'] === 'magicblock-er'
      && (proposal.status === 'PROPOSED' || proposal.status === 'APPROVED' || proposal.status === 'EXECUTING'));
    if (tree?.kind === 'tree' && tree.id === 'tree-01' && tree.health > 0 && pendingChainProposal) {
      worker.activity = 'idle';
      worker.targetId = null;
      worker.task = null;
      pendingChainProposal.parameters['awaitingAuthority'] = true;
      this.emit('LOCAL_STATE_TRANSITION_DEFERRED', tree.id, { reason: 'tree-01 transition is awaiting verified MagicBlock execution.', proposalId: pendingChainProposal.id });
      return;
    }
    if (tree && tree.kind === 'tree') {
      // Stale-task guard: another worker may have felled this tree while
      // this task was mid-swing. Felling twice would duplicate both the
      // TREE_CHOPPED record and the log mutation, so a non-standing tree
      // ends the task with no transition (and a blocked plan step, if any).
      if (tree.state !== 'standing' || tree.health <= 0) {
        this.settleStaleTask(task, 'GATHER', tree.id, 'tree already depleted; stale chop task cleared');
        worker.task = null;
        worker.activity = 'idle';
        worker.targetId = null;
        return;
      }
      tree.health = Math.max(0, tree.health - (worker.equipment?.axe === 'stone-axe' ? 2 : 1));
      if (tree.health === 0) {
        tree.state = 'depleted';
        const logId = `log-${String(this.state.nextEntityNumber++).padStart(2, '0')}`;
        this.state.entities[logId] = { id: logId, kind: 'log', position: { ...tree.position }, state: 'ground' };
        this.emit('TREE_CHOPPED', tree.id, this.stampPlan({ health: tree.health, state: tree.state, resource: 'wood' }, task.planId));
        this.emit('RESOURCE_CREATED', logId, this.stampPlan({ resource: 'wood', amount: 1, sourceTreeId: tree.id }, task.planId));
        this.finishActiveProposal(
          'GATHER',
          tree.id,
          () => {
            const log = this.state.entities[logId];
            return tree.state === 'depleted' && log?.kind === 'log' && log.state === 'ground';
          },
          task.planId,
        );
        worker.task = null;
        worker.activity = 'idle';
        worker.targetId = null;
      } else {
        // Partial damage is not a felling: report it distinctly and keep
        // the GATHER proposal executing until the tree is actually down.
        task.elapsed = 0;
        this.emit('TREE_DAMAGED', tree.id, this.stampPlan({ health: tree.health, state: tree.state, resource: 'wood' }, task.planId));
      }
    } else {
      worker.task = null;
      worker.activity = 'idle';
      worker.targetId = null;
    }
  }

  private stepHarvest(worker: Worker, targetId: string, delta: number): void {
    const task = worker.task;
    if (!task || task.kind !== 'harvest') return;
    task.elapsed += delta * this.workRate(worker);
    if (task.elapsed < HARVEST_DURATION) return;
    const target = this.state.entities[targetId];
    if (target && target.kind === 'berry-patch' && target.state === 'available') {
      target.state = 'harvested';
      this.emit('BERRY_PATCH_HARVESTED', target.id, this.stampPlan({ workerId: worker.id, state: target.state }, task.planId));
      const foodId = `food-${String(this.state.nextFoodNumber++).padStart(2, '0')}`;
      this.state.entities[foodId] = { id: foodId, kind: 'food', position: { ...target.position }, state: 'ground' };
      this.emit('RESOURCE_CREATED', foodId, this.stampPlan({ resource: 'food', amount: 1, sourcePatchId: target.id }, task.planId));
      this.finishActiveProposal(
        'HARVEST',
        target.id,
        () => {
          const food = this.state.entities[foodId];
          return target.state === 'harvested' && food?.kind === 'food' && food.state === 'ground';
        },
        task.planId,
      );
    } else if (target && target.kind === 'farm' && target.state === 'ready') {
      target.state = 'growing';
      target.progress = 0;
      this.emit('FARM_HARVESTED', target.id, this.stampPlan({ workerId: worker.id, state: target.state }, task.planId));
      const foodId = `food-${String(this.state.nextFoodNumber++).padStart(2, '0')}`;
      this.state.entities[foodId] = { id: foodId, kind: 'food', position: { ...target.position }, state: 'ground' };
      this.emit('RESOURCE_CREATED', foodId, this.stampPlan({ resource: 'food', amount: 1, sourceFarmId: target.id }, task.planId));
      this.finishActiveProposal(
        'HARVEST',
        target.id,
        () => {
          const food = this.state.entities[foodId];
          return target.state === 'growing' && food?.kind === 'food' && food.state === 'ground';
        },
        task.planId,
      );
    } else if (target && (target.kind === 'well' || target.kind === 'pond')) {
      // Wells and ponds never run dry: drawing costs worker time, not stock.
      // Each draw fills one waterskin at the draw site. Waterskins share the
      // food id-counter namespace with a distinct prefix, so ids stay unique.
      this.emit('WATER_DRAWN', target.id, this.stampPlan({ workerId: worker.id }, task.planId));
      const waterId = `water-${String(this.state.nextFoodNumber++).padStart(2, '0')}`;
      this.state.entities[waterId] = { id: waterId, kind: 'water', position: { ...target.position }, state: 'ground' };
      this.emit('RESOURCE_CREATED', waterId, this.stampPlan({ resource: 'water', amount: 1, sourceWellId: target.id }, task.planId));
      this.finishActiveProposal(
        'HARVEST',
        target.id,
        () => {
          const water = this.state.entities[waterId];
          return water?.kind === 'water' && water.state === 'ground';
        },
        task.planId,
      );
    } else {
      // Stale-task termination: the target became unavailable while this
      // task ran (harvested by another worker, farm regrowing, or gone).
      // No mutation and no harvest event — but the attempt must terminate
      // explicitly, or its proposal leaks as EXECUTING forever and plan
      // drivers stall a full step budget waiting for a step never recorded.
      const staleNote = !target
        ? 'target missing; stale harvest task cleared'
        : target.kind === 'berry-patch'
          ? 'patch already harvested; stale harvest task cleared'
          : target.kind === 'farm'
            ? 'farm not ready; stale harvest task cleared'
            : 'target unavailable; stale harvest task cleared';
      if (task.planId) {
        this.recordStep(task.planId, {
          actionType: 'HARVEST',
          targetEntityId: targetId,
          source: 'sim',
          status: 'blocked',
          note: staleNote,
        });
      } else {
        this.settleStaleTask(task, 'HARVEST', targetId, staleNote);
      }
    }
    worker.task = null;
    worker.activity = 'idle';
    worker.targetId = null;
  }

  private stepPlant(worker: Worker, treeId: string, delta: number): void {
    const task = worker.task;
    if (!task || task.kind !== 'plant') return;
    task.elapsed += delta * this.workRate(worker);
    if (task.elapsed < PLANT_DURATION) return;
    const tree = this.state.entities[treeId];
    if (tree && tree.kind === 'tree' && tree.state === 'depleted') {
      tree.state = 'sapling';
      tree.health = 1;
      tree.progress = 0;
      this.emit('TREE_PLANTED', tree.id, this.stampPlan({ health: tree.health, state: tree.state }, task.planId));
      this.finishActiveProposal(
        'PLANT',
        tree.id,
        () => {
          const planted = this.state.entities[treeId];
          return planted?.kind === 'tree' && planted.state === 'sapling';
        },
        task.planId,
      );
    } else {
      // Stale planting: something else restored or removed the site.
      this.settleStaleTask(task, 'PLANT', treeId, 'planting site no longer available; stale plant task cleared');
    }
    worker.task = null;
    worker.activity = 'idle';
    worker.targetId = null;
  }

  /**
   * Crafting completion: inputs are re-validated NOW (not trusted from task
   * start — the world may have changed while the worker walked and worked)
   * and consumed exactly once, then the output is granted. Cancellation or
   * interruption before this point costs nothing, because nothing is taken
   * until completion. That is the whole resource policy, and it is tested.
   */
  private stepCraft(worker: Worker, campId: string, delta: number): void {
    const task = worker.task;
    if (!task || task.kind !== 'craft' || !task.recipeId) return;
    const recipe = getRecipe(task.recipeId);
    if (!recipe) {
      this.settleStaleTask(task, 'CRAFT', campId, 'unknown recipe; stale craft task cleared');
      worker.task = null;
      worker.activity = 'idle';
      worker.targetId = null;
      return;
    }
    task.elapsed += delta * this.workRate(worker);
    if (task.elapsed < recipe.workSeconds) return;
    const readiness = checkCraft(this.state, worker.id, recipe);
    if (!readiness.ok) {
      this.emit('CRAFTING_FAILED', campId, this.stampPlan({ workerId: worker.id, recipe: recipe.id, reason: readiness.reason }, task.planId));
      this.settleStaleTask(task, 'CRAFT', campId, `crafting failed: ${readiness.reason}`);
      worker.task = null;
      worker.activity = 'idle';
      worker.targetId = null;
      return;
    }
    for (const [material, need] of Object.entries(recipe.inputs)) {
      const left = (worker.inventory[material] ?? 0) - (need ?? 0);
      if (left <= 0) delete worker.inventory[material];
      else worker.inventory[material] = left;
    }
    const output = recipe.output.kind === 'axe' ? { axe: recipe.output.axe } : { basket: true, capacity: recipe.output.capacity };
    if (recipe.output.kind === 'axe') worker.equipment.axe = recipe.output.axe;
    else {
      worker.equipment.basket = true;
      worker.capacity = recipe.output.capacity;
    }
    this.emit('CRAFTING_COMPLETED', campId, this.stampPlan({ workerId: worker.id, recipe: recipe.id, output }, task.planId));
    this.finishActiveProposal(
      'CRAFT',
      campId,
      () => recipeSatisfied(this.state, worker.id, recipe),
      task.planId,
    );
    worker.task = null;
    worker.activity = 'idle';
    worker.targetId = null;
  }

  /**
   * Rest: the worker sleeps at a complete shelter for REST_SECONDS, then
   * wakes rested — timed work runs faster until restedUntilTick. The buff is
   * authoritative tick state (replay-safe); interruption before completion
   * grants nothing.
   */
  private stepRest(worker: Worker, shelterId: string, delta: number): void {
    const task = worker.task;
    if (!task || task.kind !== 'rest') return;
    task.elapsed += delta;
    if (task.elapsed < REST_SECONDS) return;
    const shelter = this.state.entities[shelterId];
    if (!shelter || shelter.kind !== 'shelter' || shelter.state !== 'complete') {
      this.settleStaleTask(task, 'REST', shelterId, 'shelter unavailable; stale rest task cleared');
      worker.task = null;
      worker.activity = 'idle';
      worker.targetId = null;
      return;
    }
    worker.restedUntilTick = this.state.tick + REST_BUFF_TICKS;
    this.emit('REST_COMPLETED', shelter.id, this.stampPlan({ workerId: worker.id, restedUntilTick: worker.restedUntilTick }, task.planId));
    this.finishActiveProposal(
      'REST',
      shelter.id,
      () => {
        const w = this.state.entities[worker.id];
        return w?.kind === 'worker' && w.restedUntilTick > this.state.tick;
      },
      task.planId,
    );
    worker.task = null;
    worker.activity = 'idle';
    worker.targetId = null;
  }

  /**
   * Wilderness shelter construction at an explicit (x, z) site — or the
   * deterministic free site nearest the builder when none is given.
   *
   * Shape mirrors houses: walk first, pay on arrival. Cost is a mixed purse
   * deducted ONCE when the site is created: SHELTER_WOOD_COST from the shared
   * stockpile plus SHELTER_BRANCH_COST from the builder's own inventory.
   * Walking re-entries (directive persistence, runner re-issues) spend
   * nothing; resuming an interrupted site spends nothing. Invalid sites and
   * shortfalls fail with CONSTRUCTION_FAILED before any deduction line.
   */
  private startSiteBuild(
    worker: Worker,
    decision: AgentDecision,
    proposal: ActionProposal,
    stepPlan: GamePlan | undefined,
    spec: SiteBuildSpec,
  ): void {
    const kind = spec.structureType;
    const isKind = (entity: WorldEntity | undefined): entity is Extract<WorldEntity, { kind: 'shelter' | 'house' }> =>
      entity !== undefined && entity.kind === kind;
    const fail = (reason: string, detail: Record<string, unknown> = {}): void => {
      this.refuseAction(proposal);
      this.emit('CONSTRUCTION_FAILED', SETTLEMENT_ID, this.stampPlan({ workerId: worker.id, proposalId: proposal.id, reason, structureType: kind, ...(spec.blueprint ? { blueprint: spec.blueprint } : {}), ...detail }, proposal.parameters['planId']));
    };
    const engage = (shelterId: string, site: { x: number; z: number }, elapsed: number): void => {
      worker.targetId = shelterId;
      if (Math.hypot(worker.position.x - site.x, worker.position.z - site.z) > 1.5) {
        worker.activity = 'moving';
        this.moveToward(worker.position, site, STEP, { purpose: 'construction', structureType: kind, targetEntityId: shelterId });
        return;
      }
      worker.activity = 'building';
      worker.task = { kind: 'build', targetId: shelterId, elapsed, ...(typeof proposal.parameters['planId'] === 'string' ? { planId: proposal.parameters['planId'] as string } : {}), ...(this.state.proposals.includes(proposal) ? { proposalId: proposal.id } : {}) };
    };
    // Re-entry: this proposal already opened a site (it paid at creation).
    // Walk back to it and resume — never pay twice. A finished site means
    // the work is done: settle the proposal against that fact.
    const joinedId = proposal.parameters['structureId'];
    if (typeof joinedId === 'string') {
      const joined = this.state.entities[joinedId];
      if (isKind(joined)) {
        if (joined.state === 'complete') {
          this.finishAction(proposal, true);
          this.verifyAction(proposal, true);
          return;
        }
        engage(joined.id, joined.position, joined.progress * spec.buildSeconds);
        return;
      }
    }
    const rawX = decision.parameters?.['x'];
    const rawZ = decision.parameters?.['z'];
    // No coordinates: the simulation picks the deterministic free site
    // nearest the builder. Placement authority lives here alone — callers
    // never invent coordinates, so plans, validation, and execution agree.
    let siteX: number;
    let siteZ: number;
    if (typeof rawX === 'number' && typeof rawZ === 'number') {
      siteX = rawX;
      siteZ = rawZ;
    } else {
      // Plan-pinned site first (picked once, reused by every later step),
      // else the deterministic free site nearest the builder.
      const planRef = typeof proposal.parameters['planId'] === 'string'
        ? this.state.plans[proposal.parameters['planId']]
        : undefined;
      const picked = planRef?.site ?? findShelterSite(this.state, worker.position, spec.footprint);
      if (!picked) {
        fail('invalid-placement', { siteReason: `no clear ground for a ${kind}` });
        return;
      }
      siteX = picked.x;
      siteZ = picked.z;
      // Pin the pick to this proposal (and the plan, when governed): later
      // re-drives walk to the SAME ground instead of re-picking (and
      // dithering) from each new position.
      proposal.parameters['x'] = siteX;
      proposal.parameters['z'] = siteZ;
      if (planRef && planRef.status === 'active') planRef.site = { x: siteX, z: siteZ };
    }
    // Resume first: an unfinished site at this spot keeps its progress and
    // costs nothing more — it was valid when raised, and its own footprint
    // would fail a fresh validation. A finished shelter here means
    // double-build: refuse without consulting anything else.
    const existing = Object.values(this.state.entities).find(
      (entity) => isKind(entity) && Math.hypot(entity.position.x - siteX, entity.position.z - siteZ) <= 0.5,
    );
    const exactRequest = proposal.parameters['exact'] === true || decision.parameters?.['exact'] === true;
    const approximateRequest = typeof rawX === 'number' && typeof rawZ === 'number' && !exactRequest;
    if (isKind(existing)) {
      // A finished structure on an approximate request falls through to the
      // tolerance search below; exact or simulation-picked sites refuse.
      if (existing.state === 'complete' && !approximateRequest) {
        fail('invalid-placement', { siteReason: `site already holds ${existing.id}` });
        return;
      }
      if (existing.state !== 'complete') {
        proposal.parameters['structureId'] = existing.id;
        engage(existing.id, existing.position, existing.progress * spec.buildSeconds);
        return;
      }
    }
    const site = validateSite(this.state, siteX, siteZ, spec.footprint, worker.id);
    if (!site.ok) {
      // Approximate requests search within tolerance and RECORD the
      // deviation (requested vs accepted, both visible on the proposal and
      // the start event). Exact coordinates never relocate: they fail here.
      if (!exactRequest) {
        const nearby = searchNearbySite(this.state, siteX, siteZ, spec.tolerance, worker.id, spec.footprint);
        if (nearby) {
          proposal.parameters['deviation'] = { requested: { x: siteX, z: siteZ }, chosen: { x: nearby.x, z: nearby.z } };
          siteX = nearby.x;
          siteZ = nearby.z;
        } else {
          fail('invalid-placement', { siteReason: `${site.reason}; no valid ground within tolerance` });
          return;
        }
      } else {
        fail('invalid-placement', { siteReason: site.reason, exact: true });
        return;
      }
    }
    // Walk before paying: arrival re-runs this whole method, and only the
    // arrival pass reaches the deduction lines below.
    if (Math.hypot(worker.position.x - siteX, worker.position.z - siteZ) > 1.5) {
      worker.targetId = null;
      worker.activity = 'moving';
      this.moveToward(worker.position, { x: siteX, z: siteZ }, STEP, { purpose: 'construction', structureType: kind });
      return;
    }
    if (stepPlan && (stepPlan.spentWood + spec.woodCost > stepPlan.constraints.spendCapWood || this.state.wood < spec.woodCost)) {
      fail(stepPlan.spentWood + spec.woodCost > stepPlan.constraints.spendCapWood ? 'spend-cap' : 'insufficient-wood', { need: spec.woodCost, have: this.state.wood });
      return;
    }
    if (this.state.wood < spec.woodCost) {
      fail('insufficient-wood', { need: spec.woodCost, have: this.state.wood });
      return;
    }
    if ((worker.inventory['branch'] ?? 0) < spec.branchCost) {
      fail('insufficient-materials', { need: spec.branchCost, have: worker.inventory['branch'] ?? 0, material: 'branch' });
      return;
    }
    this.state.wood -= spec.woodCost;
    worker.inventory['branch'] = (worker.inventory['branch'] ?? 0) - spec.branchCost;
    if ((worker.inventory['branch'] ?? 0) <= 0) delete worker.inventory['branch'];
    if (stepPlan) stepPlan.spentWood += spec.woodCost;
    const count = Object.values(this.state.entities).filter((entity) => entity.kind === kind).length;
    const shelterId = `${kind}-${String(count + 1).padStart(2, '0')}`;
    proposal.parameters['structureId'] = shelterId;
    this.state.entities[shelterId] = kind === 'shelter'
      ? { id: shelterId, kind: 'shelter', position: { x: siteX, z: siteZ }, state: 'construction', progress: 0, footprint: spec.footprint }
      : { id: shelterId, kind: 'house', position: { x: siteX, z: siteZ }, state: 'construction', progress: 0, blueprint: spec.blueprint ?? DEFAULT_HOUSE_BLUEPRINT, footprint: spec.footprint };
    worker.targetId = shelterId;
    this.emit('CONSTRUCTION_STARTED', shelterId, this.stampPlan({ workerId: worker.id, proposalId: proposal.id, structureType: kind, ...(spec.blueprint ? { blueprint: spec.blueprint } : {}), woodSpent: spec.woodCost, branchSpent: spec.branchCost, woodRemaining: this.state.wood, site: { x: siteX, z: siteZ }, ...(proposal.parameters['deviation'] ? { deviation: proposal.parameters['deviation'] } : {}), ...(proposal.parameters['exact'] === true || decision.parameters?.['exact'] === true ? { exact: true } : {}) }, proposal.parameters['planId']));
    engage(shelterId, { x: siteX, z: siteZ }, 0);
  }

  private stepBuildProgress(worker: Worker, structureId: string, delta: number): void {    const task = worker.task;
    if (!task || task.kind !== 'build') return;
    const structure = this.state.entities[structureId];
    if (!structure || (structure.kind !== 'house' && structure.kind !== 'farm' && structure.kind !== 'shelter')) {
      // Stale build: the structure vanished mid-task. Settle the attempt
      // without touching a shared proposal another builder may still be
      // driving — cooperative joins reuse one proposal across workers.
      if (task.planId) {
        this.recordStep(task.planId, {
          actionType: 'BUILD', targetEntityId: structureId, source: 'sim',
          status: 'blocked', note: 'structure missing; stale build task cleared',
        });
      } else {
        const proposal = task.proposalId ? this.state.proposals.find((item) => item.id === task.proposalId) : undefined;
        const otherBuilder = workersOf(this.state).some((other) => other.id !== worker.id && other.task?.kind === 'build');
        if (proposal && !otherBuilder && (proposal.status === 'EXECUTING' || proposal.status === 'APPROVED')) {
          this.finishAction(proposal, false);
        }
      }
      worker.task = null;
      worker.activity = 'idle';
      worker.targetId = null;
      return;
    }
    task.elapsed += delta * this.workRate(worker);
    // Build duration comes from the house blueprint, the fixed shelter
    // crank, or the fixed farm crank — never from wall-clock or animation.
    const duration = structure.kind === 'house'
      ? (getBlueprint(structure.blueprint ?? DEFAULT_HOUSE_BLUEPRINT)?.buildSeconds ?? BUILD_DURATION)
      : structure.kind === 'shelter' ? SHELTER_BUILD_SECONDS : BUILD_DURATION;
    if (structure.kind === 'house' || structure.kind === 'shelter') {
      const before = structure.progress;
      structure.progress = Math.min(1, task.elapsed / duration);
      // Observable stages: frame → walls → roof, one event each as the work
      // crosses thirds. Never fabricated — each fires exactly once per build.
      for (const [edge, stage] of [[1 / 3, 'frame'], [2 / 3, 'walls']] as const) {
        if (before < edge && structure.progress >= edge) {
          this.emit('CONSTRUCTION_STAGE', structure.id, this.stampPlan({ workerId: worker.id, structureType: structure.kind, ...(structure.kind === 'house' ? { blueprint: structure.blueprint ?? DEFAULT_HOUSE_BLUEPRINT } : {}), stage, progress: structure.progress }, task.planId));
        }
      }
    }
    if (task.elapsed >= duration) {
      if (structure.kind === 'house' || structure.kind === 'shelter') {
        structure.state = 'complete';
        structure.progress = 1;
      } else {
        structure.state = 'growing';
        structure.progress = 0;
      }
      this.emit('CONSTRUCTION_COMPLETED', structure.id, this.stampPlan({ workerId: worker.id, structureType: structure.kind }, task.planId));
      const finished = structure;
      this.finishActiveProposal(
        'BUILD',
        SETTLEMENT_ID,
        () => {
          const current = this.state.entities[finished.id];
          return current?.kind === finished.kind && (finished.kind === 'farm' ? current.state === 'growing' : current.state === 'complete');
        },
        task.planId,
      );
      worker.task = null;
      worker.activity = 'idle';
      worker.targetId = null;
    }
  }

  /**
   * Whether a directive can still succeed from the worker's current state.
   * Pure observer of (action, target state): no worker identity beyond the
   * DELIVER carrying check, so staleness is global — if it fails here, no
   * driver sharing the target can succeed either.
   */
  private isDirectiveAchievable(worker: Worker, directive: { actionType: ActionType; targetEntityId: string }): boolean {
    const target = this.state.entities[directive.targetEntityId];
    if (!target) return false;
    switch (directive.actionType) {
      case 'PICK_UP':
        return (target.kind === 'log' || target.kind === 'food' || target.kind === 'water') && target.state === 'ground';
      case 'GATHER':
        return target.kind === 'tree' && target.state === 'standing';
      case 'HARVEST':
        return (target.kind === 'berry-patch' && target.state === 'available')
          || (target.kind === 'farm' && target.state === 'ready')
          || target.kind === 'well' || target.kind === 'pond';
      case 'BUILD':
        return target.kind === 'settlement';
      case 'PLANT':
        return target.kind === 'tree' && target.state === 'depleted';
      case 'COLLECT':
        return (target.kind === 'branch' || target.kind === 'stone') && target.state === 'ground';
      case 'CRAFT':
        return target.kind === 'settlement';
      case 'REST':
        return target.kind === 'shelter' && target.state === 'complete';
      case 'DELIVER':
        return worker.carrying !== null;
      case 'MOVE_TO':
      case 'PLAN':
        return true;
    }
  }

  private stepDecision(worker: Worker): void {
    const isFree = (w: Worker) => (w.activity === 'idle' || w.activity === 'moving') && !w.carrying && !w.task;
    const directiveIndex = this.directives.findIndex((directive) => {
      if (directive.workerId) return directive.workerId === worker.id;
      return isFree(worker);
    });
    if (directiveIndex >= 0) {
      const directive = this.directives[directiveIndex]!;
      const outcome = this.driveDecision(worker, directive, false);
      if (!this.isDirectiveAchievable(worker, directive)) {
        // Dead engagement: the target became invalid mid-route (felled,
        // harvested, picked up, or gone) or was never valid. Free the worker
        // and drop the directive so the queue head cannot block behind it;
        // fail this attempt's own live stored proposal, if any. Shared
        // proposals another worker may still be driving are only failed when
        // the target is globally unachievable — in which case no driver can
        // succeed — and chain-authority proposals are never failed locally.
        // (Virtual plan steps are not stored proposals; their dud path is
        // failDudProposal, unchanged.)
        worker.activity = 'idle';
        worker.targetId = null;
        this.directives.splice(directiveIndex, 1);
        const attempt = outcome.proposal && this.state.proposals.includes(outcome.proposal)
          ? outcome.proposal : undefined;
        if (attempt
          && attempt.parameters['execution'] !== 'magicblock-er'
          && (attempt.status === 'EXECUTING' || attempt.status === 'APPROVED')) {
          this.finishAction(attempt, false);
        }
        return;
      }
      // Directives persist while the worker is en route and the proposal is
      // live; they clear on engagement, fulfillment, or recorded failure.
      // Without persistence, the idle-reset would strand mid-route workers;
      // without clearing, stale directives would spin forever.
      const live = this.findActiveProposal(directive.actionType, directive.targetEntityId);
      const stillEnRoute = worker.activity === 'moving' && (live?.id === outcome.proposal?.id);
      if (!stillEnRoute) this.directives.splice(directiveIndex, 1);
      return;
    }
    if (this.agent.controlsWorker?.(worker.id) === false) {
      worker.activity = 'idle';
      worker.targetId = null;
      return;
    }
    const observation = this.agent.observe(this.state);
    observation.worker = { id: worker.id, x: worker.position.x, z: worker.position.z, carrying: worker.carrying };
    observation.claimedTargetIds = workersOf(this.state)
      .filter((other) => other.id !== worker.id && other.targetId !== null)
      .map((other) => other.targetId as string);
    const decision = this.agent.decide(observation);
    if (!decision) {
      worker.activity = 'idle';
      worker.targetId = null;
      return;
    }
    this.driveDecision(worker, decision, true);
  }

  private driveDecision(worker: Worker, decision: AgentDecision & { planId?: string }, recordObservation: boolean): { proposal: ActionProposal | null; fresh: boolean } {
    const target = this.state.entities[decision.targetEntityId];
    if (!target) return { proposal: null, fresh: false };
    // Plan-authorized path: the plan's proposal already passed governance, so
    // steps execute without minting per-action proposals. The gate below is
    // enforced at execution time, not just planning time.
    if (decision.planId) {
      const plan = this.state.plans[decision.planId];
      if (!plan || plan.status !== 'active' || this.state.tick > plan.constraints.expiresTick) {
        if (plan) {
          this.recordStep(plan.id, {
            actionType: decision.actionType, targetEntityId: decision.targetEntityId,
            source: 'sim', status: 'blocked', note: !plan || plan.status !== 'active' ? `plan ${plan?.status ?? 'missing'}` : 'plan expired',
          });
        }
        return { proposal: null, fresh: false };
      }
      if (!plan.constraints.allowedActions.includes(decision.actionType)) {
        this.recordStep(plan.id, {
          actionType: decision.actionType, targetEntityId: decision.targetEntityId,
          source: 'sim', status: 'blocked', note: 'outside approved authority',
        });
        return { proposal: null, fresh: false };
      }
      const virtual: ActionProposal = {
        id: `${plan.id}:step-${plan.steps.length}`,
        agentId: worker.id,
        actionType: decision.actionType,
        targetEntityId: decision.targetEntityId,
        parameters: { ...(decision.parameters ?? {}), planId: plan.id, source: decision.reason },
        riskLevel: 'LOW',
        createdAt: this.state.tick,
        status: 'EXECUTING',
      };
      if (!recordObservation) {
        this.emit('AGENT_DECIDED', worker.id, { actionType: decision.actionType, targetEntityId: decision.targetEntityId, reason: decision.reason, planId: plan.id });
      }
      this.executeDecision(worker, decision, virtual);
      this.failDudProposal(worker, virtual);
      return { proposal: virtual, fresh: true };
    }
    const pendingMagicProposal = this.state.proposals.find((proposal) => proposal.actionType === 'GATHER'
      && proposal.targetEntityId === decision.targetEntityId
      && proposal.parameters['execution'] === 'magicblock-er'
      && proposal.parameters['awaitingAuthority'] !== true
      && (proposal.status === 'PROPOSED' || proposal.status === 'APPROVED' || proposal.status === 'EXECUTING'));
    if (pendingMagicProposal && decision.actionType === 'GATHER') {
      this.executeDecision(worker, decision, pendingMagicProposal);
      return { proposal: pendingMagicProposal, fresh: false };
    }
    const activeProposal = this.findActiveProposal(decision.actionType, decision.targetEntityId);
    if (activeProposal) {
      this.executeDecision(worker, decision, activeProposal);
      return { proposal: activeProposal, fresh: false };
    }
    if (recordObservation) {
      const observationId = `observation-${String(this.state.nextEventSequence).padStart(4, '0')}`;
      const observation = this.agent.observe(this.state);
      const observationEvent = this.emit('AGENT_OBSERVED', worker.id, { observationId, tick: observation.tick, availableTrees: observation.trees.filter((tree) => tree.available).map((tree) => tree.id), availableLogs: observation.logs.filter((log) => log.available).map((log) => log.id), availableBerryPatches: observation.berryPatches.filter((patch) => patch.available).map((patch) => patch.id), availableFood: observation.foodResources.filter((food) => food.available).map((food) => food.id), wood: observation.wood, food: observation.food });
      const decisionEvent = this.emit('AGENT_DECIDED', worker.id, { observationId, actionType: decision.actionType, targetEntityId: decision.targetEntityId, reason: decision.reason });
      const proposal = this.proposeActionInner(decision.actionType, decision.targetEntityId, decision.parameters ?? { reason: decision.reason }, decision.actionType === 'BUILD' ? 'HIGH' : 'LOW', worker.id);
      const proposalEvent = this.state.events.find((event) => event.data['proposalId'] === proposal.id && event.type === 'ACTION_PROPOSED');
      if (proposalEvent) {
        proposalEvent.data['observationId'] = observationId;
        proposalEvent.data['decisionEventId'] = decisionEvent.id;
        proposalEvent.data['observationEventId'] = observationEvent.id;
        decisionEvent.data['proposalId'] = proposal.id;
        observationEvent.data['proposalId'] = proposal.id;
      }
      this.executeDecision(worker, decision, proposal);
      this.failDudProposal(worker, proposal);
      return { proposal, fresh: true };
    }
    const decisionEvent = this.emit('AGENT_DECIDED', worker.id, this.stampPlan({ actionType: decision.actionType, targetEntityId: decision.targetEntityId, reason: decision.reason }, (decision as { planId?: string }).planId));
    const proposal = this.proposeActionInner(decision.actionType, decision.targetEntityId, decision.parameters ?? { reason: decision.reason }, decision.actionType === 'BUILD' ? 'HIGH' : 'LOW', worker.id);
    decisionEvent.data['proposalId'] = proposal.id;
    this.executeDecision(worker, decision, proposal);
    this.failDudProposal(worker, proposal);
    return { proposal, fresh: true };
  }

  /**
   * Refuse an action at execution time: inputs, hands, or prerequisites do
   * not hold. Legacy proposals settle FAILED; virtual plan steps record a
   * failed step. Already-settled proposals are never touched twice.
   */
  private refuseAction(proposal: ActionProposal): void {
    if (proposal.status === 'EXECUTING' || proposal.status === 'APPROVED') this.finishAction(proposal, false);
  }

  /**
   * A freshly proposed action the worker cannot even begin (stale target,
   * empty-handed DELIVER, busy worker) is recorded FAILED rather than left
   * EXECUTING forever. Adopted live proposals are never touched here.
   */
  private failDudProposal(worker: Worker, proposal: ActionProposal): void {
    if (worker.activity === 'idle' && !worker.carrying && !worker.task && proposal.status === 'EXECUTING') {
      if (this.isVirtualPlanStep(proposal)) {
        const planId = proposal.parameters['planId'];
        if (typeof planId === 'string') {
          this.recordStep(planId, {
            actionType: proposal.actionType,
            targetEntityId: proposal.targetEntityId,
            source: typeof proposal.parameters['source'] === 'string' ? proposal.parameters['source'] as string : 'sim',
            status: 'blocked',
            note: 'step could not start (stale target or busy worker)',
          });
        }
        return;
      }
      this.finishAction(proposal, false);
    }
  }

  private executeDecision(worker: Worker, decision: AgentDecision, proposal: ActionProposal): void {
    const executionAuthorized = proposal.parameters['execution'] === 'magicblock-er'
      ? proposal.status === 'APPROVED' || proposal.status === 'EXECUTING'
      : this.agent.executeAction(this, proposal);
    // A held proposal (PROPOSED MEDIUM/HIGH) is left pending for human
    // review — never executed, never deleted. An APPROVED local proposal
    // carries human authorization: promote it to EXECUTING exactly once.
    // (MagicBlock proposals are excluded: their execution is the external ER
    // submission, so APPROVED must survive unchanged until reconciliation.)
    if (!executionAuthorized) return;
    if (proposal.parameters['execution'] !== 'magicblock-er' && proposal.status === 'APPROVED') {
      this.setProposalStatus(proposal, 'EXECUTING');
    }
    const target = this.state.entities[decision.targetEntityId];
    if (!target) return;

    if (decision.actionType === 'PICK_UP' && (target.kind === 'log' || target.kind === 'food' || target.kind === 'water') && target.state === 'ground') {
      worker.targetId = target.id;
      worker.activity = 'moving';
      this.moveToward(worker.position, target.position, STEP, { resource: target.kind === 'log' ? 'wood' : target.kind === 'food' ? 'food' : 'water', targetEntityId: target.id });
      if (distance(worker.position, target.position) <= ARRIVAL_DISTANCE) {
        target.state = 'carried';
        target.position = { ...worker.position };
        worker.carrying = target.id;
        worker.activity = 'carrying';
        worker.targetId = SETTLEMENT_ID;
        this.finishAction(proposal, true);
        const resource = target.kind === 'log' ? 'wood' : target.kind === 'food' ? 'food' : 'water';
        this.emit('RESOURCE_PICKED_UP', target.id, this.stampPlan({ workerId: worker.id, resource }, proposal.parameters['planId']));
        this.verifyAction(proposal, worker.carrying === target.id && target.state === 'carried');
        const pickupPlanId = proposal.parameters['planId'];
        // Plan-governed hauls verify through the parent plan, not through a
        // per-step DELIVER proposal. Carry the plan on the worker instead.
        if (typeof pickupPlanId === 'string' && this.state.plans[pickupPlanId]?.status === 'active') {
          worker.deliveryPlanId = pickupPlanId;
        } else {
          const delivery = this.proposeActionInner('DELIVER', SETTLEMENT_ID, {
            resourceId: target.id, resource,
            ...(typeof pickupPlanId === 'string' ? { planId: pickupPlanId } : {}),
          }, 'LOW', worker.id);
          this.setProposalStatus(delivery, 'EXECUTING');
          worker.deliveryProposalId = delivery.id;
        }
      }
      return;
    }

    if (decision.actionType === 'GATHER' && target.kind === 'tree' && target.state === 'standing') {
      if (!this.state.events.some((event) => event.type === 'RESOURCE_TARGETED' && event.entityId === target.id && event.data['workerId'] === worker.id && event.data['proposalId'] === proposal.id)) {
        this.emit('RESOURCE_TARGETED', target.id, this.stampPlan({ workerId: worker.id, resource: 'wood', proposalId: proposal.id }, proposal.parameters['planId']));
      }
      worker.targetId = target.id;
      if (distance(worker.position, target.position) > 0.68) {
        worker.activity = 'moving';
        this.moveToward(worker.position, target.position, STEP, { resource: 'wood', targetEntityId: target.id });
        return;
      }
      worker.activity = 'chopping';
      worker.task = { kind: 'chop', targetId: target.id, elapsed: 0, ...(typeof proposal.parameters['planId'] === 'string' ? { planId: proposal.parameters['planId'] as string } : {}), ...(this.state.proposals.includes(proposal) ? { proposalId: proposal.id } : {}) };
      this.emit('GATHER_ACTION_STARTED', target.id, this.stampPlan({ workerId: worker.id, duration: CHOP_DURATION, proposalId: proposal.id, resource: 'wood' }, proposal.parameters['planId']));
      return;
    }

    if (decision.actionType === 'HARVEST' && ((target.kind === 'berry-patch' && target.state === 'available') || (target.kind === 'farm' && target.state === 'ready') || target.kind === 'well' || target.kind === 'pond')) {
      const harvestResource = target.kind === 'well' || target.kind === 'pond' ? 'water' : 'food';
      if (!this.state.events.some((event) => event.type === 'RESOURCE_TARGETED' && event.entityId === target.id && event.data['workerId'] === worker.id && event.data['proposalId'] === proposal.id)) {
        this.emit('RESOURCE_TARGETED', target.id, this.stampPlan({ workerId: worker.id, resource: harvestResource, proposalId: proposal.id }, proposal.parameters['planId']));
      }
      worker.targetId = target.id;
      if (distance(worker.position, target.position) > 0.72) {
        worker.activity = 'moving';
        this.moveToward(worker.position, target.position, STEP, { resource: harvestResource, targetEntityId: target.id });
        return;
      }
      worker.activity = 'gathering';
      worker.task = { kind: 'harvest', targetId: target.id, elapsed: 0, ...(typeof proposal.parameters['planId'] === 'string' ? { planId: proposal.parameters['planId'] as string } : {}), ...(this.state.proposals.includes(proposal) ? { proposalId: proposal.id } : {}) };
      this.emit('GATHER_ACTION_STARTED', target.id, this.stampPlan({ workerId: worker.id, duration: HARVEST_DURATION, proposalId: proposal.id, resource: harvestResource }, proposal.parameters['planId']));
      return;
    }

    if (decision.actionType === 'PLANT' && target.kind === 'tree' && target.state === 'depleted') {
      // Reforestation: a worker replants a felled stump site. Prerequisites
      // enforced here: hands must be free and the site must still be a
      // stump — arrival re-checks, and stepPlant re-checks at completion.
      if (worker.carrying) return;
      if (!this.state.events.some((event) => event.type === 'RESOURCE_TARGETED' && event.entityId === target.id && event.data['workerId'] === worker.id && event.data['proposalId'] === proposal.id)) {
        this.emit('RESOURCE_TARGETED', target.id, this.stampPlan({ workerId: worker.id, resource: 'wood', proposalId: proposal.id, purpose: 'replant' }, proposal.parameters['planId']));
      }
      worker.targetId = target.id;
      if (distance(worker.position, target.position) > 0.68) {
        worker.activity = 'moving';
        this.moveToward(worker.position, target.position, STEP, { resource: 'wood', targetEntityId: target.id, purpose: 'replant' });
        return;
      }
      worker.activity = 'gathering';
      worker.task = { kind: 'plant', targetId: target.id, elapsed: 0, ...(typeof proposal.parameters['planId'] === 'string' ? { planId: proposal.parameters['planId'] as string } : {}), ...(this.state.proposals.includes(proposal) ? { proposalId: proposal.id } : {}) };
      this.emit('GATHER_ACTION_STARTED', target.id, this.stampPlan({ workerId: worker.id, duration: PLANT_DURATION, proposalId: proposal.id, resource: 'wood', purpose: 'replant' }, proposal.parameters['planId']));
      return;
    }

    if (decision.actionType === 'COLLECT') {
      // Pocket the material into personal inventory (never the stockpile).
      if (!((target.kind === 'branch' || target.kind === 'stone') && target.state === 'ground')) {
        this.refuseAction(proposal);
        return;
      }
      // Hands must be free: a laden worker fails explicitly here rather than
      // stranding an EXECUTING proposal behind a dropped directive.
      if (worker.carrying) {
        this.refuseAction(proposal);
        return;
      }
      const material = target.kind;
      if (!this.state.events.some((event) => event.type === 'RESOURCE_TARGETED' && event.entityId === target.id && event.data['workerId'] === worker.id && event.data['proposalId'] === proposal.id)) {
        this.emit('RESOURCE_TARGETED', target.id, this.stampPlan({ workerId: worker.id, resource: material, proposalId: proposal.id }, proposal.parameters['planId']));
      }
      worker.targetId = target.id;
      if (distance(worker.position, target.position) > 0.5) {
        worker.activity = 'moving';
        this.moveToward(worker.position, target.position, STEP, { resource: material, targetEntityId: target.id });
        return;
      }
      // Arrival re-checks freshness AND capacity: another worker may have
      // taken it first, or the pack may be full. Consumed nothing either way.
      const fresh = this.state.entities[target.id];
      const load = Object.values(worker.inventory).reduce((sum, count) => sum + count, 0);
      if (!fresh || fresh.kind !== material || (fresh.kind !== 'branch' && fresh.kind !== 'stone') || fresh.state !== 'ground') {
        this.refuseAction(proposal);
        return;
      }
      if (load >= worker.capacity) {
        this.refuseAction(proposal);
        return;
      }
      fresh.state = 'collected';
      worker.inventory[material] = (worker.inventory[material] ?? 0) + 1;
      worker.activity = 'idle';
      worker.targetId = null;
      this.finishAction(proposal, true);
      this.emit('MATERIAL_COLLECTED', target.id, this.stampPlan({ workerId: worker.id, material, total: worker.inventory[material] }, proposal.parameters['planId']));
      this.verifyAction(proposal, fresh.state === 'collected' && (worker.inventory[material] ?? 0) >= 1);
      return;
    }

    if (decision.actionType === 'CRAFT') {
      // Crafting happens at the camp, from the worker's own inventory.
      // Prerequisites are enforced here AND re-checked at completion.
      if (target.kind !== 'settlement') {
        this.refuseAction(proposal);
        return;
      }
      const rawRecipe = decision.parameters?.['recipe'];
      const recipe = typeof rawRecipe === 'string' ? getRecipe(rawRecipe) : undefined;
      if (!recipe) {
        this.refuseAction(proposal);
        return;
      }
      if (worker.carrying) {
        this.refuseAction(proposal);
        return;
      }
      const start = checkCraft(this.state, worker.id, recipe);
      if (!start.ok) {
        this.refuseAction(proposal);
        return;
      }
      worker.targetId = target.id;
      if (distance(worker.position, target.position) > 1.2) {
        worker.activity = 'moving';
        this.moveToward(worker.position, target.position, STEP, { purpose: 'craft', recipe: recipe.id, targetEntityId: target.id });
        return;
      }
      worker.activity = 'crafting';
      worker.task = { kind: 'craft', targetId: target.id, elapsed: 0, recipeId: recipe.id, ...(typeof proposal.parameters['planId'] === 'string' ? { planId: proposal.parameters['planId'] as string } : {}), ...(this.state.proposals.includes(proposal) ? { proposalId: proposal.id } : {}) };
      this.emit('CRAFTING_STARTED', target.id, this.stampPlan({ workerId: worker.id, recipe: recipe.id, duration: recipe.workSeconds, proposalId: proposal.id }, proposal.parameters['planId']));
      return;
    }

    if (decision.actionType === 'REST') {
      // Rest happens at a complete shelter — a construction site is not a bed.
      if (target.kind !== 'shelter' || target.state !== 'complete') {
        this.refuseAction(proposal);
        return;
      }
      if (worker.carrying) {
        this.refuseAction(proposal);
        return;
      }
      worker.targetId = target.id;
      if (distance(worker.position, target.position) > 1.0) {
        worker.activity = 'moving';
        this.moveToward(worker.position, target.position, STEP, { purpose: 'rest', targetEntityId: target.id });
        return;
      }
      worker.activity = 'resting';
      worker.task = { kind: 'rest', targetId: target.id, elapsed: 0, ...(typeof proposal.parameters['planId'] === 'string' ? { planId: proposal.parameters['planId'] as string } : {}), ...(this.state.proposals.includes(proposal) ? { proposalId: proposal.id } : {}) };
      return;
    }

    if (decision.actionType === 'BUILD' && target.kind === 'settlement') {
      // Prerequisites are enforced here, not trusted from the proposer: the
      // worker must be free and the stockpile must cover the cost.
      const structure = decision.parameters?.['structure'] === 'farm' ? 'farm' : decision.parameters?.['structure'] === 'shelter' ? 'shelter' : 'house';
      // Blueprint-driven houses: unknown blueprint IDs fail safely here,
      // before any walk, spend, or state change.
      const rawBlueprint = decision.parameters?.['blueprint'];
      const blueprint = structure === 'house'
        ? (typeof rawBlueprint === 'string' ? getBlueprint(rawBlueprint) : undefined) ?? getBlueprint(DEFAULT_HOUSE_BLUEPRINT)!
        : undefined;
      if (structure === 'house' && typeof rawBlueprint === 'string' && !getBlueprint(rawBlueprint)) {
        this.refuseAction(proposal);
        this.emit('CONSTRUCTION_FAILED', target.id, this.stampPlan({ workerId: worker.id, proposalId: proposal.id, reason: 'unknown-blueprint', structureType: structure, blueprint: rawBlueprint }, proposal.parameters['planId']));
        return;
      }
      const cost = structure === 'farm' ? FARM_WOOD_COST : structure === 'shelter' ? SHELTER_WOOD_COST : blueprint!.woodCost;
      const branchCost = structure === 'house' ? blueprint!.branchCost : 0;
      if (worker.carrying) return;
      // Plan spend authority (enforced atomically with the deduct below so
      // competing plans cannot overspend the shared stockpile or a cap).
      const stepPlanId = proposal.parameters['planId'];
      const stepPlan = typeof stepPlanId === 'string' ? this.state.plans[stepPlanId] : undefined;
      if (stepPlan && (stepPlan.spentWood + cost > stepPlan.constraints.spendCapWood || this.state.wood < cost)) {
        this.finishAction(proposal, false);
        this.emit('CONSTRUCTION_FAILED', target.id, this.stampPlan({ workerId: worker.id, proposalId: proposal.id, planId: stepPlan.id, reason: stepPlan.spentWood + cost > stepPlan.constraints.spendCapWood ? 'spend-cap' : 'insufficient-wood', structureType: structure, need: cost, have: this.state.wood }, proposal.parameters['planId']));
        return;
      }
      // Chain slice: farm-01 construction through MagicBlock defers the local
      // transition until verified chain state is reconciled. Only the first
      // farm plot is covered; houses and later plots stay fully local.
      // Defer while a chain build is live OR the write lease is held by ER.
      const farmsBuilt = Object.values(this.state.entities).filter((entity) => entity.kind === 'farm').length;
      const pendingChainBuild = this.state.proposals.find((proposal) => proposal.actionType === 'BUILD'
        && proposal.parameters['execution'] === 'magicblock-er'
        && (proposal.status === 'PROPOSED' || proposal.status === 'APPROVED' || proposal.status === 'EXECUTING'));
      const leaseHolder = this.state.leases['farm-01']?.holder;
      if (structure === 'farm' && farmsBuilt === 0 && (pendingChainBuild || leaseHolder === 'er')) {
        if (pendingChainBuild && pendingChainBuild.parameters['awaitingAuthority'] !== true) {
          pendingChainBuild.parameters['awaitingAuthority'] = true;
          this.emit('LOCAL_STATE_TRANSITION_DEFERRED', 'farm-01', { reason: 'farm-01 construction is awaiting verified MagicBlock execution.', proposalId: pendingChainBuild.id });
        } else if (!pendingChainBuild) {
          if (this.leaseDeferNotedEpoch !== this.state.leases['farm-01']?.epoch) {
            this.leaseDeferNotedEpoch = this.state.leases['farm-01']?.epoch ?? -1;
            this.emit('LOCAL_STATE_TRANSITION_DEFERRED', 'farm-01', { reason: 'farm-01 write lease is held by the rollup; local construction refused.', lease: leaseHolder });
          }
        }
        worker.activity = 'idle';
        worker.targetId = null;
        return;
      }
      // Wilderness shelters build at planner-chosen free locations with a
      // mixed purse (stockpiled wood + pocketed branches). Houses and farms
      // keep their fixed-slot path below; shelters never touch it.
      if (structure === 'shelter') {
        this.startSiteBuild(worker, decision, proposal, stepPlan, { structureType: 'shelter', woodCost: SHELTER_WOOD_COST, branchCost: SHELTER_BRANCH_COST, footprint: SHELTER_FOOTPRINT, buildSeconds: SHELTER_BUILD_SECONDS, tolerance: 2.0 });
        return;
      }
      // Player-directed houses (coordinates present) use the same free-site
      // authority as shelters, sized by the blueprint footprint: exact
      // requests fail rather than relocate; approximate ones record any
      // deviation. Houses without coordinates keep the legacy plot path.
      if (structure === 'house' && typeof decision.parameters?.['x'] === 'number' && typeof decision.parameters?.['z'] === 'number') {
        this.startSiteBuild(worker, decision, proposal, stepPlan, { structureType: 'house', woodCost: blueprint!.woodCost, branchCost: blueprint!.branchCost, footprint: blueprint!.footprint, buildSeconds: blueprint!.buildSeconds, tolerance: HOUSE_SITE_TOLERANCE, blueprint: blueprint!.id });
        return;
      }
      // Cooperative join: another worker already started this proposal's
      // structure — help finish it instead of spending twice.
      const startedId = proposal.parameters['structureId'];
      if (typeof startedId === 'string') {
        const started = this.state.entities[startedId];
        if (started && (started.kind === 'house' || started.kind === 'farm')) {
          worker.targetId = target.id;
          if (distance(worker.position, target.position) > 0.9) {
            worker.activity = 'moving';
            this.moveToward(worker.position, target.position, STEP, { resource: 'wood', targetEntityId: target.id, purpose: 'construction' });
            return;
          }
          worker.activity = 'building';
          worker.task = { kind: 'build', targetId: startedId, elapsed: 0, ...(typeof proposal.parameters['planId'] === 'string' ? { planId: proposal.parameters['planId'] as string } : {}), ...(this.state.proposals.includes(proposal) ? { proposalId: proposal.id } : {}) };
          return;
        }
      }
      if (this.state.wood < cost) {
        this.finishAction(proposal, false);
        this.emit('CONSTRUCTION_FAILED', target.id, this.stampPlan({ workerId: worker.id, proposalId: proposal.id, reason: 'insufficient-wood', structureType: structure, need: cost, have: this.state.wood }, proposal.parameters['planId']));
        return;
      }
      if (structure === 'house' && (worker.inventory['branch'] ?? 0) < branchCost) {
        this.finishAction(proposal, false);
        this.emit('CONSTRUCTION_FAILED', target.id, this.stampPlan({ workerId: worker.id, proposalId: proposal.id, reason: 'insufficient-materials', structureType: structure, need: branchCost, have: worker.inventory['branch'] ?? 0, material: 'branch' }, proposal.parameters['planId']));
        return;
      }
      const slots = structure === 'farm' ? FARM_SLOTS : HOUSE_SLOTS;
      // Plot capacity counts plot-built structures only; free-placed houses
      // (which carry a footprint) never consume a plot.
      const used = Object.values(this.state.entities).filter((entity) => entity.kind === structure && !(entity.kind === 'house' && typeof entity.footprint === 'number')).length;
      const total = Object.values(this.state.entities).filter((entity) => entity.kind === structure).length;
      if (used >= slots.length) {
        this.finishAction(proposal, false);
        this.emit('CONSTRUCTION_FAILED', target.id, this.stampPlan({ workerId: worker.id, proposalId: proposal.id, reason: 'invalid-placement', structureType: structure }, proposal.parameters['planId']));
        return;
      }
      // Plot placement: an explicit slot index, else the first free plot.
      // Coordinate requests never reach here (free-site path above), so a
      // requested position is never silently snapped to a plot.
      let slotIndex = used;
      if (structure === 'house') {
        const rawSlot = decision.parameters?.['slot'];
        const slotFree = (index: number): boolean => {
          const slot = slots[index];
          if (!slot) return false;
          return !Object.values(this.state.entities).some(
            (entity) => ((entity.kind === 'house' || entity.kind === 'farm')
              && Math.hypot(entity.position.x - slot.x, entity.position.z - slot.z) < 1.0)
              || ((entity.kind === 'house' || entity.kind === 'shelter') && typeof entity.footprint === 'number'
                && Math.hypot(entity.position.x - slot.x, entity.position.z - slot.z) < entity.footprint + 1.2),
          );
        };
        if (typeof rawSlot === 'number' && Number.isInteger(rawSlot)) {
          slotIndex = rawSlot;
        } else {
          // Legacy default: first free plot in slot order (identical to the
          // old slots[used] when plots fill sequentially).
          slotIndex = slots.findIndex((_, index) => slotFree(index));
        }
        const slot = slots[slotIndex];
        if (!slot || !slotFree(slotIndex)) {
          this.finishAction(proposal, false);
          this.emit('CONSTRUCTION_FAILED', target.id, this.stampPlan({ workerId: worker.id, proposalId: proposal.id, reason: 'invalid-placement', structureType: structure, slot: slotIndex }, proposal.parameters['planId']));
          return;
        }
        proposal.parameters['slot'] = slotIndex;
      }
      worker.targetId = target.id;
      if (distance(worker.position, target.position) > 0.9) {
        worker.activity = 'moving';
        this.moveToward(worker.position, target.position, STEP, { resource: 'wood', targetEntityId: target.id, purpose: 'construction' });
        return;
      }
      this.state.wood -= cost;
      if (branchCost > 0) {
        worker.inventory['branch'] = (worker.inventory['branch'] ?? 0) - branchCost;
        if ((worker.inventory['branch'] ?? 0) <= 0) delete worker.inventory['branch'];
      }
      if (stepPlan) stepPlan.spentWood += cost;
      const slot = slots[structure === 'house' ? (proposal.parameters['slot'] as number) : used]!;
      const structureId = `${structure}-${String(total + 1).padStart(2, '0')}`;
      proposal.parameters['structureId'] = structureId;
      this.state.entities[structureId] = structure === 'farm'
        ? { id: structureId, kind: 'farm', position: { ...slot }, state: 'growing', progress: 0 }
        : { id: structureId, kind: 'house', position: { ...slot }, state: 'construction', progress: 0, blueprint: blueprint!.id };
      worker.activity = 'building';
      worker.task = { kind: 'build', targetId: structureId, elapsed: 0, ...(typeof proposal.parameters['planId'] === 'string' ? { planId: proposal.parameters['planId'] as string } : {}), ...(this.state.proposals.includes(proposal) ? { proposalId: proposal.id } : {}) };
      this.emit('CONSTRUCTION_STARTED', structureId, this.stampPlan({ workerId: worker.id, proposalId: proposal.id, structureType: structure, blueprint: structure === 'house' ? blueprint!.id : undefined, woodSpent: cost, branchSpent: branchCost, woodRemaining: this.state.wood }, proposal.parameters['planId']));
      return;
    }

    if (decision.actionType === 'MOVE_TO') {
      worker.targetId = target.id;
      if (distance(worker.position, target.position) <= ARRIVAL_DISTANCE) {
        worker.activity = 'idle';
        worker.targetId = null;
        const arrivedAt = { ...target.position };
        const movePlan = proposal.parameters['planId'];
        this.finishActiveProposal('MOVE_TO', target.id, () => distance(worker.position, arrivedAt) <= ARRIVAL_DISTANCE + 0.01, typeof movePlan === 'string' ? movePlan : undefined);
        return;
      }
      worker.activity = 'moving';
      this.moveToward(worker.position, target.position, STEP, { targetEntityId: target.id });
      return;
    }
  }

  private findActiveProposal(actionType: ActionType, targetEntityId: string): ActionProposal | undefined {
    for (let index = this.state.proposals.length - 1; index >= 0; index -= 1) {
      const proposal = this.state.proposals[index];
      if (proposal?.actionType === actionType && proposal.targetEntityId === targetEntityId && (proposal.status === 'PROPOSED' || proposal.status === 'APPROVED' || proposal.status === 'EXECUTING')) return proposal;
    }
    return undefined;
  }

  private finishActiveProposal(actionType: ActionType, targetEntityId: string, outcomeHolds: () => boolean = () => true, planId?: string): void {
    const proposal = this.findActiveProposal(actionType, targetEntityId);
    if (proposal) {
      this.finishAction(proposal, true);
      this.verifyAction(proposal, outcomeHolds());
      return;
    }
    // No stored proposal (e.g. a plan step executing under plan authority):
    // record the terminal outcome directly into the plan.
    if (planId) {
      const ok = outcomeHolds();
      this.recordStep(planId, {
        actionType, targetEntityId, source: 'sim', status: ok ? 'verified' : 'failed',
        note: ok ? 'postcondition independently verified' : 'postcondition did not hold',
      });
    }
  }

  /** Attach the parent plan to step-event data when one governs the action. */
  private stampPlan(data: Record<string, unknown>, planId: unknown): Record<string, unknown> {
    return typeof planId === 'string' ? { ...data, planId } : data;
  }

  private moveToward(position: Vec2, target: Vec2, delta: number, context: Record<string, unknown> = {}): void {    const before = { ...position };
    const dx = target.x - position.x;
    const dz = target.z - position.z;
    const length = Math.hypot(dx, dz);
    if (length <= 2.35 * delta + ARRIVAL_DISTANCE) {
      position.x = target.x;
      position.z = target.z;
    } else if (length > 0) {
      const amount = Math.min(1, (2.35 * delta) / length);
      position.x += dx * amount;
      position.z += dz * amount;
    }
    if (Math.hypot(position.x - before.x, position.z - before.z) > 0.015) {
      this.emit('AGENT_MOVED', WORKER_ID, { from: before, to: { ...position }, ...context });
    }
  }

  private emit(type: WorldEvent['type'], entityId?: string, data: Record<string, unknown> = {}): WorldEvent {
    const sequence = this.state.nextEventSequence++;
    const event: WorldEvent = { id: `event-${String(sequence).padStart(4, '0')}`, sequence, type, timestamp: this.state.tick, entityId, data };
    this.state.events.push(event);
    if (this.state.events.length > MAX_LOGGED_EVENTS) {
      // Shed the oldest movement trace first: a crew of workers emits several
      // AGENT_MOVED per step, which would otherwise evict the consequential
      // causal chain the Observatory is for.
      const movedIndex = this.state.events.findIndex((candidate) => candidate.type === 'AGENT_MOVED');
      if (movedIndex >= 0) this.state.events.splice(movedIndex, 1);
      else this.state.events.splice(0, this.state.events.length - MAX_LOGGED_EVENTS);
    }
    for (const listener of this.listeners) listener(this.state, [event]);
    return event;
  }
}
