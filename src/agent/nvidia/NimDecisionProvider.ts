/**
 * Live NIM-backed DecisionProvider. Reads the credential for the model's
 * registry slot from the environment at call time; the key is passed only to
 * the HTTPS request and never logged or returned.
 */
import type { AgentObservation } from '../Agent';
import { registryLookup, readCredential } from './ModelRegistry';
import { nimChatCompletion, NimError } from './NimClient';
import { buildDecisionPrompt } from './DecisionSchema';
import type { DecisionProvider, ProviderRawDecision } from '../ModelDrivenAgent';

export class NimDecisionProvider implements DecisionProvider {
  readonly providerId: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly temperature: number;

  constructor(
    readonly modelId: string,
    options: { maxTokens?: number; timeoutMs?: number; temperature?: number } = {},
  ) {
    const entry = registryLookup(modelId);
    if (!entry) throw new Error(`Model ${modelId} is not in the ASTrix registry.`);
    this.providerId = `nim:${modelId}`;
    this.maxTokens = options.maxTokens ?? entry.defaultMaxTokens;
    this.timeoutMs = options.timeoutMs ?? entry.timeoutMs;
    this.temperature = options.temperature ?? 0;
  }

  async requestDecision(
    observation: AgentObservation,
    plan: string | null,
    recentOutcomes: string[],
  ): Promise<ProviderRawDecision> {
    const entry = registryLookup(this.modelId);
    if (!entry) throw new NimError(`Model ${this.modelId} is not in the ASTrix registry.`, null, this.modelId);
    const apiKey = readCredential(entry.keySlot);
    if (!apiKey) {
      throw new NimError(
        `Credential for slot ${entry.keySlot} (${this.modelId}) is not configured. Set the associated environment variable.`,
        null,
        this.modelId,
      );
    }
    const completion = await nimChatCompletion({
      model: this.modelId,
      apiKey,
      userPrompt: buildDecisionPrompt(observation, plan, recentOutcomes),
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      timeoutMs: this.timeoutMs,
    });
    return {
      rawText: completion.content,
      model: completion.model,
      latencyMs: completion.latencyMs,
      usage: completion.usage,
    };
  }
}
