/**
 * GoalRunner: headless, goal-driven turn loop used by the judge demo and
 * backend runs. Each turn: observe → decide (planner, mock, or model via
 * callback) → validate → propose → authorize → advance to settlement →
 * verify → record an evidence row. Nothing is fabricated: every row quotes
 * authoritative state before and after.
 */
import { WorldSimulation } from '../simulation/WorldSimulation';
import { LocalGathererAgent } from '../agent/LocalGathererAgent';
import { ManualAgent } from '../agent/ManualAgent';
import type { AgentDecision } from '../agent/Agent';
import { validateDecisionAgainstWorld } from '../agent/nvidia/DecisionSchema';
import { isGoalRelevant } from './planner';
import { nextStep } from './planner';
import { GoalTracker, type GameGoal } from './goals';
import { policyFor, type ControlMode } from './modes';

export interface EvidenceRow {
  turn: number;
  source: string;
  action: string | null;
  target: string | null;
  proposalId: string | null;
  planId: string | null;
  risk: string | null;
  authorized: boolean;
  executed: boolean;
  verified: boolean;
  note: string;
  worldAfter: { tick: number; wood: number; food: number; water: number; houses: number };
}

export type DecideFn = (
  obs: ReturnType<LocalGathererAgent['observe']>,
  goal: GameGoal,
) => Promise<{ action: AgentDecision | null; source: string; rawText?: string }> | { action: AgentDecision | null; source: string; rawText?: string };

export function plannerDecide(obs: Parameters<DecideFn>[0], goal: GameGoal): { action: AgentDecision | null; source: string } {
  return { action: nextStep(goal, obs), source: 'planner' };
}

export class GoalRunner {
  private readonly observer = new LocalGathererAgent();
  private turn = 0;
  readonly rows: EvidenceRow[] = [];
  /** Rejected action:target signatures to avoid re-proposing blindly. */
  private readonly rejected = new Set<string>();
  /** Proposal ids already accounted for in rejection learning. */
  private readonly seenSettled = new Set<string>();
  private goalId: string | null = null;
  /** Goal id → active plan id. One governed plan authorizes a goal's routine steps. */
  private readonly planByGoal = new Map<string, string>();

  constructor(
    readonly sim: WorldSimulation,
    readonly tracker: GoalTracker,
    readonly mode: ControlMode,
  ) {
    const policy = policyFor(mode);
    sim.autoApproveUpTo = policy.autoApproveUpTo;
    // The runner drives exclusively through directives; the sim's own agent
    // is parked on manual so no autonomous policy competes for the worker.
    sim.setAgent(new ManualAgent());
    sim.clearDirectives();
  }

  worldAfter() {
    return {
      tick: this.sim.state.tick,
      wood: this.sim.state.wood,
      food: this.sim.state.food,
      water: this.sim.state.water,
      houses: Object.values(this.sim.state.entities).filter((e) => e.kind === 'house' && e.state === 'complete').length,
    };
  }

  private record(row: Omit<EvidenceRow, 'turn' | 'worldAfter'>): EvidenceRow {
    const full: EvidenceRow = { turn: ++this.turn, ...row, worldAfter: this.worldAfter() };
    this.rows.push(full);
    return full;
  }

  async runTurn(decide: DecideFn, maxSteps = 1500): Promise<EvidenceRow> {
    const goal = this.tracker.active;
    if (!goal) {
      return this.record({ source: 'runner', action: null, target: null, proposalId: null, planId: null, risk: null, authorized: false, executed: false, verified: false, note: 'no active goal' });
    }
    // Learn human rejections that happened outside turns (judge clicks).
    // A new goal clears all skips.
    if (this.goalId !== goal.id) {
      this.goalId = goal.id;
      this.rejected.clear();
    }
    for (const proposal of this.sim.state.proposals) {
      if ((proposal.status === 'REJECTED' || proposal.status === 'CANCELLED') && !this.seenSettled.has(proposal.id)) {
        this.seenSettled.add(proposal.id);
        this.rejected.add(`${proposal.actionType}:${proposal.targetEntityId}`);
        // A rejected PLAN proposal also blocks its goal's next step once:
        // surface the replan visibly instead of silently minting a new plan.
        const planId = proposal.parameters['planId'];
        if (typeof planId === 'string' && proposal.actionType === 'PLAN') {
          this.rejected.add(`plan:${goal.id}`);
        }
      }
    }
    const obs = this.observer.observe(this.sim.state);
    const decided = await decide(obs, goal);
    if (!decided.action) {
      // Nothing to do right now (e.g. all patches harvested and regrowing):
      // let world cranks turn instead of spinning no-step turns with zero
      // ticks passing. A regrow/maturation may unblock the next turn; if the
      // goal completes meanwhile (or expires), reflect it.
      this.sim.advanceUntil(() => false, 400);
      this.tracker.update(this.sim.state);
      if (!this.tracker.active || this.tracker.active.id !== goal.id) {
        const plan = this.planByGoal.get(goal.id) ? this.sim.state.plans[this.planByGoal.get(goal.id)!] : undefined;
        if (plan && (plan.status === 'active' || plan.status === 'blocked')) this.sim.completePlan(plan.id);
        this.planByGoal.delete(goal.id);
      }
      this.sim.recordJournal({ turn: this.turn + 1, source: decided.source, goal: goal.id, candidates: [], verdict: 'no-step', chosen: null });
      return this.record({ source: decided.source, action: null, target: null, proposalId: null, planId: null, risk: null, authorized: false, executed: false, verified: false, note: 'no step available (goal may be blocked or complete)' });
    }
    const { actionType, targetEntityId } = decided.action;
    const sig = `${actionType}:${targetEntityId}`;
    if (this.rejected.has(sig)) {
      // One-shot skip: visibly replan this turn, then allow the action to be
      // proposed again later for fresh human review.
      this.rejected.delete(sig);
      this.sim.recordJournal({ turn: this.turn + 1, source: decided.source, goal: goal.id, candidates: [sig], verdict: `skipped-rejected:${sig}`, chosen: null });
      return this.record({ source: decided.source, action: actionType, target: targetEntityId, proposalId: null, planId: null, risk: null, authorized: false, executed: false, verified: false, note: `skipped: ${sig} was rejected before; replanning around it` });
    }
    const verdict = validateDecisionAgainstWorld(
      // Real step parameters (recipe, structure): the validator itself
      // rejects execution-routing and risk smuggling, so passing them here
      // validates what will actually execute instead of a hollowed-out copy.
      { action: { actionType, targetEntityId, parameters: decided.action.parameters ?? {} }, intent: 'runner-turn', expectation: 'goal progress' },
      this.sim.state,
    );
    if (!verdict.ok) {
      this.sim.recordJournal({ turn: this.turn + 1, source: decided.source, goal: goal.id, candidates: [sig], verdict: `invalid:${verdict.reason}`, chosen: null });
      return this.record({ source: decided.source, action: actionType, target: targetEntityId, proposalId: null, planId: null, risk: null, authorized: false, executed: false, verified: false, note: `validation rejected: ${verdict.reason} ${verdict.detail}` });
    }
    if (!isGoalRelevant(goal, this.observer.observe(this.sim.state), { actionType, targetEntityId })) {
      this.sim.recordJournal({ turn: this.turn + 1, source: decided.source, goal: goal.id, candidates: [sig], verdict: 'off-goal', chosen: null });
      return this.record({ source: decided.source, action: actionType, target: targetEntityId, proposalId: null, planId: null, risk: null, authorized: false, executed: false, verified: false, note: 'rejected as off-goal: legal but does not serve the active goal' });
    }
    // Craft goals name their recipe: the relevance gate cannot see
    // parameters, so a wrong-recipe CRAFT is rejected explicitly here.
    if (goal.kind === 'craft' && actionType === 'CRAFT' && (decided.action.parameters?.['recipe'] ?? null) !== (goal.recipe ?? null)) {
      this.sim.recordJournal({ turn: this.turn + 1, source: decided.source, goal: goal.id, candidates: [sig], verdict: 'off-goal', chosen: null });
      return this.record({ source: decided.source, action: actionType, target: targetEntityId, proposalId: null, planId: null, risk: null, authorized: false, executed: false, verified: false, note: 'rejected as off-goal: wrong recipe for this goal' });
    }
    // One governed plan per goal authorizes all routine steps. No per-step
    // proposals are minted on this path; steps execute as virtual plan steps.
    let plan = this.planByGoal.get(goal.id) ? this.sim.state.plans[this.planByGoal.get(goal.id)!] : undefined;
    if (!plan) {
      const submitted = this.sim.submitPlan(goal.kind, goal.quantity, goal.resource, goal.blueprint);
      plan = submitted.plan;
      this.planByGoal.set(goal.id, plan.id);
      this.sim.recordJournal({ turn: this.turn + 1, source: decided.source, goal: goal.id, candidates: [sig], verdict: `plan-submitted:${plan.id}`, chosen: sig });
    }
    const proposal = plan.proposalId ? this.sim.state.proposals.find((p) => p.id === plan.proposalId) : undefined;
    // Plan-level rejection is inert: no steps execute. Surface it once, then
    // release the mapping so a later turn mints a fresh plan for approval.
    if (plan.status === 'rejected' || plan.status === 'cancelled' || plan.status === 'expired'
      || proposal?.status === 'REJECTED' || proposal?.status === 'CANCELLED') {
      this.planByGoal.delete(goal.id);
      if (this.rejected.has(`plan:${goal.id}`)) {
        this.rejected.delete(`plan:${goal.id}`);
        this.sim.recordJournal({ turn: this.turn + 1, source: decided.source, goal: goal.id, candidates: [sig], verdict: `plan-${plan.status}`, chosen: null });
        return this.record({ source: decided.source, action: actionType, target: targetEntityId, proposalId: null, planId: plan.id, risk: proposal?.riskLevel ?? null, authorized: false, executed: false, verified: false, note: `skipped: plan ${plan.id} was ${plan.status}; replanning around it` });
      }
      this.sim.recordJournal({ turn: this.turn + 1, source: decided.source, goal: goal.id, candidates: [sig], verdict: `plan-${plan.status}-inert`, chosen: null });
      return this.record({ source: decided.source, action: actionType, target: targetEntityId, proposalId: proposal?.id ?? null, planId: plan.id, risk: proposal?.riskLevel ?? null, authorized: false, executed: false, verified: false, note: `plan ${plan.status}: no steps executed` });
    }
    if (plan.status !== 'active' || !proposal || proposal.status === 'PROPOSED') {
      return this.record({ source: decided.source, action: actionType, target: targetEntityId, proposalId: proposal?.id ?? null, planId: plan.id, risk: proposal?.riskLevel ?? null, authorized: false, executed: false, verified: false, note: `held for human approval (${proposal?.status ?? plan.status})` });
    }
    // Drive one plan-authorized step: re-issue the validated decision with
    // its planId on every unsettled tick until the plan records a terminal
    // step outcome. Virtual steps never touch state.proposals. DELIVER is
    // automatic: a carrying worker delivers via the carrying branch, so a
    // DELIVER turn waits for that branch instead of tasking an idle worker
    // (which would record a spurious blocked step and stop the wait early).
    const stepsBefore = plan.steps.length;
    let settled: boolean;
    if (actionType === 'DELIVER') {
      settled = this.sim.advanceUntil((state) => {
        const current = state.plans[plan.id];
        if (!current || current.status !== 'active') return true;
        if (current.steps.length > stepsBefore) return true;
        return !Object.values(state.entities).some((e) => e.kind === 'worker' && e.carrying);
      }, maxSteps);
    } else {
      const directive = { actionType, targetEntityId, reason: `runner: driving ${plan.id}`, parameters: decided.action.parameters ?? {}, planId: plan.id };
      settled = this.sim.advanceUntil((state) => {
        const current = state.plans[plan.id];
        if (!current || current.status !== 'active') return true;
        if (current.steps.length > stepsBefore) return true;
        if (this.sim.directives.length === 0) {
          this.sim.issueDirective({ ...directive }, undefined, plan.id);
        }
        return false;
      }, maxSteps);
    }
    const after = this.sim.state.plans[plan.id];
    const lastStep = after && after.steps.length > stepsBefore ? after.steps[after.steps.length - 1]! : undefined;
    const verified = settled && lastStep?.status === 'verified';
    this.sim.clearDirectives();
    this.sim.recordJournal({ turn: this.turn + 1, source: decided.source, goal: goal.id, candidates: [sig], verdict: verified ? 'step-verified' : `step-${lastStep?.status ?? 'unsettled'}`, chosen: sig });
    this.tracker.update(this.sim.state);
    if (!this.tracker.active || this.tracker.active.id !== goal.id) {
      // Goal completed by this step: close the plan and verify its proposal.
      this.sim.completePlan(plan.id);
      this.planByGoal.delete(goal.id);
    }
    return this.record({
      source: decided.source,
      action: actionType,
      target: targetEntityId,
      proposalId: proposal.id,
      planId: plan.id,
      risk: proposal.riskLevel,
      authorized: true,
      executed: settled,
      verified: Boolean(verified),
      note: verified ? 'postcondition independently verified' : `unsettled: step ${lastStep?.status ?? 'pending'}`,
    });
  }
}
