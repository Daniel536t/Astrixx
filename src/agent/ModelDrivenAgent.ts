/**
 * Moss as a genuinely model-driven agent.
 *
 * The deterministic LocalGathererAgent is preserved as a baseline; this class
 * replaces only the decision step with model output obtained through an
 * injected DecisionProvider (live NIM, TrueForge-routed, or mock for tests).
 *
 * Loop contract per turn:
 *   observe (authoritative sim state, every turn) → provider decision →
 *   parse + validate against the live world → propose through governance →
 *   advance the sim within a bounded step budget → independent outcome check →
 *   record the turn (model id, latency, tokens, validation, approval,
 *   execution, verification — never private reasoning) → revise plan.
 *
 * Bounds: maxTurns, maxStepsPerTurn, and an operator stop flag. Stopping
 * prevents subsequent turns; in-flight provider calls are bounded by their
 * own timeout. A pending PROPOSED/APPROVED proposal can be cancelled; an
 * EXECUTING one cannot be recalled (it is already mutating the world).
 */
import { LocalGathererAgent } from './LocalGathererAgent';
import type { ActionGateway, Agent, AgentDecision, AgentObservation } from './Agent';
import type { ActionProposal, WorldState } from '../world/types';
import { WORKER_ID } from '../world/types';
import type { WorldSimulation } from '../simulation/WorldSimulation';
import {
  buildDecisionPrompt,
  parseStructuredDecision,
  validateDecisionAgainstWorld,
  type StructuredDecision,
} from './nvidia/DecisionSchema';
import { canonicalize, cyrb53 } from '../simulation/replay';
import type { NimUsage } from './nvidia/NimClient';

export interface ProviderRawDecision {
  /** Model's raw text reply (structured JSON expected). */
  rawText: string;
  /** Exact model id that produced the decision. Recorded on every turn. */
  model: string;
  latencyMs: number;
  usage: NimUsage | null;
}

export interface DecisionProvider {
  readonly providerId: string;
  requestDecision(observation: AgentObservation, plan: string | null, recentOutcomes: string[]): Promise<ProviderRawDecision>;
}

export type TurnResult =
  | { kind: 'no-op'; intent: string }
  | { kind: 'rejected'; reason: string; detail: string }
  | { kind: 'awaiting-approval'; proposalId: string }
  | { kind: 'verified'; proposalId: string }
  | { kind: 'failed'; proposalId: string; note: string }
  | { kind: 'budget-exhausted'; proposalId: string };

export interface TurnRecord {
  turn: number;
  providerId: string;
  model: string;
  latencyMs: number;
  usage: NimUsage | null;
  intent: string;
  expectation: string;
  result: TurnResult;
}

export interface ModelAgentOptions {
  maxTurns?: number;
  maxStepsPerTurn?: number;
  initialPlan?: string | null;
}

const DEFAULT_MAX_TURNS = 24;
const DEFAULT_MAX_STEPS_PER_TURN = 1200;

export class ModelDrivenAgent implements Agent {
  readonly id = WORKER_ID;
  private readonly observer = new LocalGathererAgent();
  private readonly provider: DecisionProvider;
  private readonly maxTurns: number;
  private readonly maxStepsPerTurn: number;
  private stopped = false;
  private pending: AgentDecision | null = null;
  plan: string | null;
  readonly turns: TurnRecord[] = [];

  constructor(provider: DecisionProvider, options: ModelAgentOptions = {}) {
    this.provider = provider;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxStepsPerTurn = options.maxStepsPerTurn ?? DEFAULT_MAX_STEPS_PER_TURN;
    this.plan = options.initialPlan ?? null;
  }

  get providerId(): string {
    return this.provider.providerId;
  }

  /** The model drives Moss (worker-01) only; other workers take planner directives or crew autonomy. */
  controlsWorker(workerId: string): boolean {
    return workerId === WORKER_ID;
  }

  stop(): void {
    this.stopped = true;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  observe(state: Readonly<WorldState>): AgentObservation {
    return this.observer.observe(state);
  }

  decide(_observation: AgentObservation): AgentDecision | null {
    // The pending decision persists for the whole turn: the simulation loop
    // re-polls decide() every step, and returning null mid-turn would read as
    // "no intent" and idle the worker. runModelTurn clears it when the turn
    // settles.
    return this.pending;
  }

  proposeAction(gateway: ActionGateway, decision: AgentDecision): ActionProposal {
    // Risk is assigned by the gateway layer, never the model: construction is
    // always HIGH (the sim enforces this again as a second barrier).
    // Decision parameters (e.g. BUILD structure) pass through untouched.
    const risk = decision.actionType === 'BUILD' ? 'HIGH' : 'LOW';
    return gateway.proposeAction(decision.actionType, decision.targetEntityId, { reason: decision.reason, ...(decision.parameters ?? {}) }, risk);
  }

  executeAction(gateway: ActionGateway, proposal: ActionProposal): boolean {
    // The agent may only release what standing policy already auto-approves.
    // MEDIUM/HIGH stay PROPOSED for a human; APPROVED means a human already
    // authorized this exact proposal (the sim promotes it to EXECUTING).
    if (proposal.status === 'EXECUTING' || proposal.status === 'APPROVED') return true;
    if (proposal.status === 'PROPOSED' && proposal.riskLevel === 'LOW') return gateway.approveProposal(proposal.id);
    return false;
  }

  /** Human governance events (approvals, rejections, cancellations) the agent must be able to observe and replan around. */
  governanceNotes(state: Readonly<WorldState>): string[] {
    return state.events
      .filter((e) => e.type === 'GOVERNANCE_PERMISSION_DENIED' || (e.type === 'ACTION_STATUS_CHANGED' && (e.data['status'] === 'REJECTED' || e.data['status'] === 'CANCELLED' || e.data['status'] === 'FAILED')))
      .slice(-3)
      .map((e) => {
        const proposal = state.proposals.find((p) => p.id === e.data['proposalId']);
        const what = proposal ? `${proposal.actionType} ${proposal.targetEntityId}` : 'a proposal';
        if (e.type === 'GOVERNANCE_PERMISSION_DENIED') return `Human rejected ${what} (${e.data['proposalId']}). Do not repeat it without a changed approach.`;
        return `${what} ended as ${e.data['status']} (${e.data['proposalId']}).`;
      });
  }

  recentOutcomeNotes(count = 4): string[] {
    return this.turns.slice(-count).map((turn) => {
      const r = turn.result;
      const summary =
        r.kind === 'verified' ? `verified ${r.proposalId}` :
        r.kind === 'failed' ? `failed ${r.proposalId} (${r.note})` :
        r.kind === 'rejected' ? `rejected (${r.reason})` :
        r.kind === 'awaiting-approval' ? `awaiting approval ${r.proposalId}` :
        r.kind === 'budget-exhausted' ? `unsettled ${r.proposalId}` : 'observed';
      return `t${turn.turn} [${turn.model}]: ${turn.intent} → ${summary}`;
    });
  }

  /**
   * Run one bounded model turn against a live simulation. Returns the turn
   * record. Never throws on model/validation failure — failures are recorded.
   */
  async runModelTurn(simulation: WorldSimulation): Promise<TurnRecord> {
    const turnIndex = this.turns.length + 1;
    const finish = (partial: Omit<TurnRecord, 'turn' | 'providerId'>): TurnRecord => {
      const record: TurnRecord = { turn: turnIndex, providerId: this.provider.providerId, ...partial };
      this.turns.push(record);
      return record;
    };

    const observation = this.observe(simulation.state);
    // Replay binding (Phase 5.2): digest of the exact request context. The
    // replay provider recomputes this from the replayed world and refuses on
    // mismatch, so a recorded response can never silently serve a drifted
    // request. Pure function of the observation; no behavior change.
    const observationDigest = cyrb53(canonicalize(observation));
    const governance = this.governanceNotes(simulation.state);
    let raw: ProviderRawDecision;
    try {
      raw = await this.provider.requestDecision(observation, this.plan, [...governance, ...this.recentOutcomeNotes()]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      simulation.recordInput('modelDecision', {
        turn: turnIndex, observationDigest, model: 'unknown', rawText: null,
        outcome: 'provider-error', detail,
      });
      return finish({
        model: 'unknown',
        latencyMs: 0,
        usage: null,
        intent: '(provider error)',
        expectation: '(none)',
        result: { kind: 'rejected', reason: 'provider-error', detail },
      });
    }

    const parsed: StructuredDecision | null = parseStructuredDecision(raw.rawText);
    if (!parsed) {
      const empty = raw.rawText.trim().length === 0;
      simulation.recordInput('modelDecision', {
        turn: turnIndex, observationDigest, model: raw.model, rawText: raw.rawText,
        outcome: empty ? 'empty-reply' : 'not-json',
      });
      return finish({
        model: raw.model, latencyMs: raw.latencyMs, usage: raw.usage,
        intent: empty ? '(empty reply)' : '(unparseable)', expectation: '(none)',
        result: {
          kind: 'rejected',
          reason: empty ? 'empty-reply' : 'not-json',
          detail: empty
            ? 'Provider returned no text (capacity, cutoff, or contract mismatch) — recorded as a provider failure, not a decision.'
            : 'Model reply contained no valid decision JSON.',
        },
      });
    }
    if (parsed.revisedPlan && parsed.revisedPlan.trim().length > 0) {
      this.plan = parsed.revisedPlan.trim();
    }
    if (parsed.action === null) {
      simulation.recordInput('modelDecision', {
        turn: turnIndex, observationDigest, model: raw.model, rawText: raw.rawText,
        outcome: 'no-op', intent: parsed.intent,
      });
      return finish({
        model: raw.model, latencyMs: raw.latencyMs, usage: raw.usage,
        intent: parsed.intent, expectation: parsed.expectation,
        result: { kind: 'no-op', intent: parsed.intent },
      });
    }
    const verdict = validateDecisionAgainstWorld(parsed, simulation.state);
    if (!verdict.ok) {
      simulation.recordInput('modelDecision', {
        turn: turnIndex, observationDigest, model: raw.model, rawText: raw.rawText,
        outcome: 'invalid', reason: verdict.reason, detail: verdict.detail,
      });
      return finish({
        model: raw.model, latencyMs: raw.latencyMs, usage: raw.usage,
        intent: parsed.intent, expectation: parsed.expectation,
        result: { kind: 'rejected', reason: verdict.reason, detail: verdict.detail },
      });
    }

    const decision = {
      actionType: parsed.action.actionType,
      targetEntityId: parsed.action.targetEntityId,
      reason: `model:${raw.model} :: ${parsed.intent}`,
      parameters: parsed.action.parameters ?? {},
    };
    // Replay capture (Phase 5.1/5.2): the decision bound to its originating
    // request context (turn, observation digest, raw text, model). The
    // replay provider serves this back without network calls and refuses on
    // context drift. Effects (proposals/directives) are logged separately.
    // No behavior change: logging only.
    simulation.recordInput('modelDecision', {
      turn: turnIndex, observationDigest, model: raw.model, rawText: raw.rawText,
      outcome: 'decision', intent: parsed.intent, decision,
    });
    const release = () => { this.pending = null; };
    const meta = {
      model: raw.model, latencyMs: raw.latencyMs, usage: raw.usage,
      intent: parsed.intent, expectation: parsed.expectation,
    };
    // Resume or respect an existing live proposal for the same action instead
    // of stacking duplicates: an APPROVED/EXECUTING one is driven to
    // settlement; a held PROPOSED one is reported, not re-proposed.
    const live = [...simulation.state.proposals].reverse().find((p) =>
      p.actionType === decision.actionType && p.targetEntityId === decision.targetEntityId &&
      (p.status === 'PROPOSED' || p.status === 'APPROVED' || p.status === 'EXECUTING'));
    if (live && live.status === 'PROPOSED') {
      return finish({ ...meta, result: { kind: 'awaiting-approval', proposalId: live.id } });
    }
    const proposal = live ?? this.proposeAction(simulation, decision);
    // proposeAction auto-approves at or below policy; anything else means
    // governance held it — report honestly and do not execute.
    if (proposal.status !== 'EXECUTING' && proposal.status !== 'APPROVED') {
      release();
      return finish({ ...meta, result: { kind: 'awaiting-approval', proposalId: proposal.id } });
    }
    this.pending = decision;
    const settled = simulation.advanceUntil(
      (state) => {
        const current = state.proposals.find((p) => p.id === proposal.id);
        return current !== undefined && ['VERIFIED', 'FAILED', 'REJECTED', 'CANCELLED'].includes(current.status);
      },
      this.maxStepsPerTurn,
    );
    const current = simulation.state.proposals.find((p) => p.id === proposal.id);
    release();
    if (!settled || !current) {
      return finish({
        model: raw.model, latencyMs: raw.latencyMs, usage: raw.usage,
        intent: parsed.intent, expectation: parsed.expectation,
        result: { kind: 'budget-exhausted', proposalId: proposal.id },
      });
    }
    if (current.status === 'VERIFIED') {
      return finish({
        model: raw.model, latencyMs: raw.latencyMs, usage: raw.usage,
        intent: parsed.intent, expectation: parsed.expectation,
        result: { kind: 'verified', proposalId: proposal.id },
      });
    }
    return finish({
      model: raw.model, latencyMs: raw.latencyMs, usage: raw.usage,
      intent: parsed.intent, expectation: parsed.expectation,
      result: { kind: 'failed', proposalId: proposal.id, note: `proposal ${current.status}` },
    });
  }

  /** Run bounded turns until stopped, out of turns, or the goal holds. */
  async run(simulation: WorldSimulation, isGoalMet?: (state: Readonly<WorldState>) => boolean): Promise<TurnRecord[]> {
    const records: TurnRecord[] = [];
    for (let i = 0; i < this.maxTurns && !this.stopped; i += 1) {
      if (isGoalMet?.(simulation.state)) break;
      records.push(await this.runModelTurn(simulation));
    }
    return records;
  }

  buildPrompt(observation: AgentObservation): string {
    return buildDecisionPrompt(observation, this.plan, this.recentOutcomeNotes());
  }
}
