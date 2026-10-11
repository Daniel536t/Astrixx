import { describe, expect, it } from 'vitest';
import { ModelDrivenAgent } from '../agent/ModelDrivenAgent';
import { MockProvider, decisionJson } from '../agent/MockProvider';
import { LocalGathererAgent } from '../agent/LocalGathererAgent';
import type { ActionGateway, Agent } from '../agent/Agent';
import type { ActionProposal, WorldState } from '../world/types';
import { WorldSimulation } from './WorldSimulation';
import { createWorld } from '../world/createWorld';

describe('construction lifecycle', () => {
  it('holds BUILD for approval, then builds a verified house on approval', async () => {
    const agent = new ModelDrivenAgent(new MockProvider([decisionJson('BUILD', 'settlement-01'), decisionJson('BUILD', 'settlement-01')]), { maxTurns: 2 });
    const sim = new WorldSimulation(createWorld(), agent);
    sim.state.wood = 2;
    // Turn 1: HIGH proposal held — reported, not executed, nothing spent.
    const t1 = await agent.runModelTurn(sim);
    expect(t1.result.kind).toBe('awaiting-approval');
    const proposalId = (t1.result as { proposalId: string }).proposalId;
    const proposal = sim.state.proposals.find((p) => p.id === proposalId);
    expect(proposal?.status).toBe('PROPOSED');
    expect(proposal?.riskLevel).toBe('HIGH');
    expect(sim.state.wood).toBe(2);
    // Human approves; turn 2 resumes the SAME proposal and verifies completion.
    expect(sim.approveProposal(proposalId)).toBe(true);
    const t2 = await agent.runModelTurn(sim);
    expect(t2.result).toMatchObject({ kind: 'verified', proposalId });
    expect(sim.state.wood).toBe(0);
    const houses = Object.values(sim.state.entities).filter((e) => e.kind === 'house');
    expect(houses).toHaveLength(1);
    expect(houses[0]).toMatchObject({ state: 'complete', progress: 1 });
    const types = sim.state.events.map((e) => e.type);
    expect(types.indexOf('CONSTRUCTION_STARTED')).toBeLessThan(types.indexOf('CONSTRUCTION_COMPLETED'));
  });

  it('fails construction honestly when the stockpile cannot cover the cost', async () => {
    const agent = new ModelDrivenAgent(new MockProvider([decisionJson('BUILD', 'settlement-01')]), { maxTurns: 2 });
    const sim = new WorldSimulation(createWorld(), agent);
    // Validation itself refuses BUILD with insufficient wood.
    const t1 = await agent.runModelTurn(sim);
    expect(t1.result).toMatchObject({ kind: 'rejected', reason: 'illegal-target-state' });
    expect(sim.state.proposals).toHaveLength(0);
  });

  it('fails at execution when wood runs out after approval', () => {
    // A stub agent that always pursues BUILD, so the sim loop itself reaches
    // the execution-time prerequisite check.
    const stub: Agent = {
      id: 'worker-01',
      observe: (state: Readonly<WorldState>) => new LocalGathererAgent().observe(state),
      decide: () => ({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'test' }),
      proposeAction: (gateway: ActionGateway, decision) =>
        gateway.proposeAction(decision.actionType, decision.targetEntityId, { reason: decision.reason }, 'HIGH'),
      executeAction: (_gateway: ActionGateway, proposal: ActionProposal) =>
        proposal.status === 'EXECUTING' || proposal.status === 'APPROVED',
    };
    const sim = new WorldSimulation(createWorld(), stub);
    sim.state.wood = 2;
    const forced = sim.proposeAction('BUILD', 'settlement-01', {}, 'HIGH');
    expect(sim.approveProposal(forced.id)).toBe(true);
    sim.state.wood = 0; // stockpile spent between approval and execution
    sim.advanceUntil((s) => ['VERIFIED', 'FAILED'].includes(s.proposals.find((p) => p.id === forced.id)?.status ?? ''), 1200);
    const done = sim.state.proposals.find((p) => p.id === forced.id);
    expect(done?.status).toBe('FAILED');
    expect(sim.state.events.some((e) => e.type === 'CONSTRUCTION_FAILED')).toBe(true);
    expect(Object.values(sim.state.entities).some((e) => e.kind === 'house')).toBe(false);
  });

  it('a rejected BUILD never spends wood or creates a house', () => {
    const sim = new WorldSimulation();
    sim.state.wood = 2;
    const proposal = sim.proposeAction('BUILD', 'settlement-01', {}, 'HIGH');
    expect(sim.rejectProposal(proposal.id)).toBe(true);
    sim.advanceUntil(() => false, 400);
    expect(sim.state.wood).toBe(2);
    expect(Object.values(sim.state.entities).some((e) => e.kind === 'house')).toBe(false);
    expect(proposal.status).toBe('REJECTED');
  });

  it('BUILD is always HIGH risk even when LOW is requested', () => {
    const sim = new WorldSimulation();
    const proposal = sim.proposeAction('BUILD', 'settlement-01', {}, 'LOW');
    expect(proposal.riskLevel).toBe('HIGH');
    expect(proposal.status).toBe('PROPOSED');
  });
});
