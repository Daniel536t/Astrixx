/**
 * ManualAgent: the direct-control driver. It never invents decisions
 * (decide() is always null) — the worker moves only on player-issued
 * directives queued via `simulation.issueDirective()`. Proposal and execution
 * gating mirror the standing policy: LOW may self-release, anything higher
 * waits for a human.
 */
import type { ActionGateway, Agent, AgentDecision, AgentObservation } from './Agent';
import { LocalGathererAgent } from './LocalGathererAgent';
import type { ActionProposal, WorldState } from '../world/types';

export class ManualAgent implements Agent {
  readonly id = 'worker-01';
  private readonly observer = new LocalGathererAgent();

  /** Manual mode drives nothing autonomously — only player directives move workers. */
  controlsWorker(_workerId: string): boolean {
    return false;
  }

  observe(state: Readonly<WorldState>): AgentObservation {
    return this.observer.observe(state);
  }

  decide(_observation: AgentObservation): AgentDecision | null {
    return null;
  }

  proposeAction(gateway: ActionGateway, decision: AgentDecision): ActionProposal {
    return gateway.proposeAction(decision.actionType, decision.targetEntityId, { reason: decision.reason, source: 'player-command' }, 'LOW');
  }

  executeAction(gateway: ActionGateway, proposal: ActionProposal): boolean {
    if (proposal.status === 'EXECUTING' || proposal.status === 'APPROVED') return true;
    if (proposal.status === 'PROPOSED' && proposal.riskLevel === 'LOW') return gateway.approveProposal(proposal.id);
    return false;
  }
}
