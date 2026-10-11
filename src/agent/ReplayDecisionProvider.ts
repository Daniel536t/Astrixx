/**
 * Phase 5.2 model-backed replay: serve recorded model turns without model
 * calls or network requests.
 *
 * Each recorded turn is bound to its originating request context (turn
 * order + observation digest). The provider recomputes the digest from the
 * live replayed observation and REFUSES on mismatch, exhaustion, or model
 * drift — a recorded response can never silently serve a different request.
 * Recorded provider failures (timeouts) are re-thrown with the recorded
 * message so the real failure paths execute; recorded invalid text flows
 * through the real parse/validate path.
 */
import type { AgentObservation } from './Agent';
import type { DecisionProvider, ProviderRawDecision } from './ModelDrivenAgent';
import { canonicalize, cyrb53 } from '../simulation/replay';
import type { InputLog } from '../world/types';

export interface RecordedTurn {
  turn: number;
  tick: number;
  observationDigest: string;
  model: string;
  /** Serve this text (decision/invalid/no-op paths). Exclusive with throws. */
  rawText?: string;
  /** Serve a provider failure instead (timeout path). */
  throws?: string;
}

export class ReplayBindingError extends Error {}

/** Extract provider-replayable turns from an input log, in recorded order. */
export function recordedTurnsFromLog(log: InputLog): RecordedTurn[] {
  return log.inputs
    .filter((entry) => entry.kind === 'modelDecision')
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => {
      const p = entry.payload;
      const turn = p['turn'];
      const observationDigest = p['observationDigest'];
      const model = p['model'];
      if (typeof turn !== 'number' || typeof observationDigest !== 'string' || typeof model !== 'string') {
        throw new ReplayBindingError(`modelDecision entry #${entry.seq} lacks binding fields; cannot replay faithfully`);
      }
      const rawText = p['rawText'];
      const outcome = p['outcome'];
      // Provider-error turns carry no text; everything else must.
      if (outcome === 'provider-error') {
        const detail = p['detail'];
        if (typeof detail !== 'string') {
          throw new ReplayBindingError(`modelDecision entry #${entry.seq} failure lacks detail; cannot replay faithfully`);
        }
        return { turn, tick: entry.tick, observationDigest, model, throws: detail };
      }
      if (typeof rawText !== 'string') {
        throw new ReplayBindingError(`modelDecision entry #${entry.seq} lacks rawText; cannot replay faithfully`);
      }
      return { turn, tick: entry.tick, observationDigest, model, rawText };
    });
}

export class ReplayDecisionProvider implements DecisionProvider {
  readonly providerId = 'replay:recorded';
  readonly served: number[] = [];
  private cursor = 0;

  constructor(
    private readonly turns: RecordedTurn[],
    private readonly expectedModel?: string,
  ) {}

  async requestDecision(
    observation: AgentObservation,
    _plan?: string | null,
    _recentOutcomes?: string[],
  ): Promise<ProviderRawDecision> {
    if (this.cursor >= this.turns.length) {
      throw new ReplayBindingError(
        `replay transcript exhausted at request ${this.cursor + 1}; refusing to fabricate a decision`,
      );
    }
    const recorded = this.turns[this.cursor++]!;
    const digest = cyrb53(canonicalize(observation));
    if (digest !== recorded.observationDigest) {
      throw new ReplayBindingError(
        `request context drift at recorded turn ${recorded.turn} (tick ${recorded.tick}): observation digest mismatch; refusing to serve`,
      );
    }
    if (this.expectedModel && recorded.model !== this.expectedModel) {
      throw new ReplayBindingError(
        `model drift at recorded turn ${recorded.turn}: expected ${this.expectedModel}, recorded ${recorded.model}; refusing to serve`,
      );
    }
    this.served.push(recorded.turn);
    if (recorded.throws !== undefined) throw new Error(recorded.throws);
    // Latency/usage are telemetry, not state: replayed as zero, and the
    // mismatch is explicit here rather than hidden.
    return { rawText: recorded.rawText ?? '', model: recorded.model, latencyMs: 0, usage: null };
  }
}
