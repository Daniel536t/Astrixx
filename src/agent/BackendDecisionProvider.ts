/**
 * Browser-side DecisionProvider that calls the server-side inference
 * endpoint. The browser never sees credentials — only the decision text plus
 * provider/model/latency labels. Any failure surfaces as a thrown error
 * (provider unavailable), never as a fabricated decision.
 */
import type { AgentObservation } from './Agent';
import type { DecisionProvider, ProviderRawDecision } from './ModelDrivenAgent';

export class BackendDecisionProvider implements DecisionProvider {
  readonly providerId: string;

  constructor(
    private readonly backendUrl: string,
    private readonly timeoutMs = 10_000,
  ) {
    this.providerId = `backend:${backendUrl}`;
  }

  async requestDecision(
    observation: AgentObservation,
    plan: string | null,
    recentOutcomes: string[],
  ): Promise<ProviderRawDecision> {
    let response: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs + 8000);
    try {
      response = await fetch(`${this.backendUrl}/api/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ observation, plan, outcomes: recentOutcomes, timeoutMs: this.timeoutMs }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`Inference backend unreachable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
    const data = (await response.json().catch(() => null)) as null | {
      ok?: boolean;
      rawText?: string;
      model?: string;
      provider?: string;
      latencyMs?: number;
      usage?: ProviderRawDecision['usage'];
      error?: string;
      failures?: unknown;
    };
    if (!response.ok || !data?.ok || typeof data.rawText !== 'string') {
      throw new Error(`Inference unavailable: ${data?.error ?? `HTTP ${response.status}`}`);
    }
    return {
      rawText: data.rawText,
      model: `${data.provider ?? 'unknown'}:${data.model ?? 'unknown'}`,
      latencyMs: data.latencyMs ?? 0,
      usage: data.usage ?? null,
    };
  }
}
