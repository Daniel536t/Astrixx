/**
 * Generic provider-backed DecisionProvider: any InferenceProvider can drive
 * Moss decisions through the shared observation prompt + validation path.
 */
import type { AgentObservation } from '../Agent';
import { buildDecisionPrompt } from '../nvidia/DecisionSchema';
import type { DecisionProvider, ProviderRawDecision } from '../ModelDrivenAgent';
import type { InferenceProvider } from './InferenceProvider';
import { lookupProviderModel } from './ProviderRegistry';

export class ProviderDecisionAdapter implements DecisionProvider {
  readonly providerId: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly provider: InferenceProvider,
    readonly modelId: string,
    private readonly apiKey: string,
    options: { maxTokens?: number; timeoutMs?: number; temperature?: number } = {},
  ) {
    const entry = lookupProviderModel(provider.name as 'gemini' | 'openrouter', modelId);
    this.providerId = `${provider.name}:${modelId}`;
    this.maxTokens = options.maxTokens ?? entry?.defaultMaxTokens ?? 1024;
    this.timeoutMs = options.timeoutMs ?? entry?.timeoutMs ?? 90_000;
    this.temperature = options.temperature ?? 0;
  }

  private readonly temperature: number;

  async requestDecision(
    observation: AgentObservation,
    plan: string | null,
    recentOutcomes: string[],
  ): Promise<ProviderRawDecision> {
    const result = await this.provider.completeText({
      model: this.modelId,
      apiKey: this.apiKey,
      userPrompt: buildDecisionPrompt(observation, plan, recentOutcomes),
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      timeoutMs: this.timeoutMs,
      jsonMode: true,
    });
    return {
      rawText: result.text,
      model: result.model,
      latencyMs: result.latencyMs,
      usage: result.usage
        ? { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, totalTokens: result.usage.totalTokens }
        : null,
    };
  }
}
