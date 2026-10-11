/** Deterministic scripted provider for tests: no model, no network. */
import type { AgentObservation } from './Agent';
import type { DecisionProvider, ProviderRawDecision } from './ModelDrivenAgent';

export const decisionJson = (actionType: string, targetEntityId: string) =>
  `{"action": {"actionType": "${actionType}", "targetEntityId": "${targetEntityId}"}, "intent": "test ${actionType} ${targetEntityId}", "expectation": "world changes"}`;

export class MockProvider implements DecisionProvider {
  readonly providerId = 'mock:scripted';
  private cursor = 0;
  readonly seen: AgentObservation[] = [];
  constructor(private readonly scripts: string[]) {}
  async requestDecision(observation: AgentObservation): Promise<ProviderRawDecision> {
    this.seen.push(observation);
    const rawText = this.cursor < this.scripts.length
      ? this.scripts[this.cursor++]!
      : '{"action": null, "intent": "hold", "expectation": "no change"}';
    return { rawText, model: 'mock-model', latencyMs: 1, usage: null };
  }
}
