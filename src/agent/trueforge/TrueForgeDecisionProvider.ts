/**
 * DecisionProvider routed through a TrueForge server turn.
 *
 * One TrueForge session is opened per agent run and reused across turns, so
 * TrueForge session persistence carries conversational context while every
 * turn still re-observes the authoritative simulation state. Stopping the
 * agent cancels the TrueForge turn/session so no autonomous turn follows.
 */
import type { AgentObservation } from '../Agent';
import type { DecisionProvider, ProviderRawDecision } from '../ModelDrivenAgent';
import { trueforgeModelFqn, type TrueForgeRuntime } from './TrueForgeRuntime';
import type { NimUsage } from '../nvidia/NimClient';

export class TrueForgeDecisionProvider implements DecisionProvider {
  readonly providerId: string;
  private sessionId: string | null = null;
  private stopped = false;

  constructor(
    private readonly runtime: TrueForgeRuntime,
    readonly modelId: string,
  ) {
    this.providerId = `trueforge:${trueforgeModelFqn(modelId)}`;
  }

  stop(): void {
    this.stopped = true;
    if (this.sessionId) void this.runtime.cancelSession(this.sessionId);
  }

  async requestDecision(
    observation: AgentObservation,
    plan: string | null,
    recentOutcomes: string[],
    promptBuilder?: (obs: AgentObservation, plan: string | null, outcomes: string[]) => string,
  ): Promise<ProviderRawDecision> {
    if (this.stopped) throw new Error('TrueForge provider is stopped; no further turns.');
    if (!this.sessionId) this.sessionId = await this.runtime.createSession();
    const { buildDecisionPrompt } = await import('../nvidia/DecisionSchema');
    const prompt = promptBuilder
      ? promptBuilder(observation, plan, recentOutcomes)
      : buildDecisionPrompt(observation, plan, recentOutcomes);
    const started = Date.now();
    const turn = await this.runtime.runDecisionTurn(this.sessionId, prompt);
    const usage: NimUsage | null = null; // token accounting comes from TrueForge session inspection, not the turn stream
    if (turn.approvalRequested) {
      throw new Error(`Turn held for human governance (TrueForge approval event); no decision returned.`);
    }
    return { rawText: turn.text, model: this.modelId, latencyMs: Date.now() - started, usage };
  }
}
