import { describe, expect, it } from 'vitest';
import { ModelDrivenAgent } from './ModelDrivenAgent';
import type { DecisionProvider } from './ModelDrivenAgent';
import { MockProvider, decisionJson } from './MockProvider';
import { ManualAgent } from './ManualAgent';
import { WorldSimulation } from '../simulation/WorldSimulation';
import { createWorld } from '../world/createWorld';

const decision = (actionType: string, targetEntityId: string) => decisionJson(actionType, targetEntityId);

describe('ModelDrivenAgent', () => {
  it('completes consecutive model-driven turns on a changing world (wood then food)', async () => {
    // The model agent IS the sim's agent: nothing scripted competes, so every
    // verified proposal here is model-driven by construction.
    const provider = new MockProvider([
      decision('GATHER', 'tree-04'),
      decision('PICK_UP', 'log-01'),
      decision('DELIVER', 'settlement-01'),
      decision('HARVEST', 'berry-patch-01'),
    ]);
    const agent = new ModelDrivenAgent(provider, { maxTurns: 10 });
    const simulation = new WorldSimulation(createWorld(), agent);
    // PICK_UP/HARVEST/DELIVER targets only exist after prior turns; drive turn by turn.
    const t1 = await agent.runModelTurn(simulation);
    expect(t1.result).toMatchObject({ kind: 'verified' });
    expect(t1.model).toBe('mock-model');

    // After felling, the world changed: the next observation must show the log.
    const t2 = await agent.runModelTurn(simulation);
    expect(t2.result).toMatchObject({ kind: 'verified' });

    const t3 = await agent.runModelTurn(simulation);
    expect(t3.result).toMatchObject({ kind: 'verified' });
    expect(simulation.state.wood).toBe(1);

    const t4 = await agent.runModelTurn(simulation);
    expect(t4.result).toMatchObject({ kind: 'verified' });

    // Observations across turns reflect the changing world, not a replay.
    expect(provider.seen.length).toBe(4);
    expect(provider.seen[0]?.wood).toBe(0);
    expect(provider.seen[2]?.worker.carrying).not.toBeNull();
    expect(agent.turns.every((t) => t.providerId === 'mock:scripted')).toBe(true);
  });

  it('rejects an illegal decision and replans on the next turn', async () => {
    const provider = new MockProvider([
      decision('GATHER', 'tree-99'),
      decision('GATHER', 'tree-04'),
    ]);
    const agent = new ModelDrivenAgent(provider, { maxTurns: 2 });
    const simulation = new WorldSimulation(createWorld(), agent);
    const records = await agent.run(simulation);
    expect(records[0]?.result).toMatchObject({ kind: 'rejected', reason: 'unknown-target' });
    expect(records[1]?.result).toMatchObject({ kind: 'verified' });
    // The rejected turn proposed nothing and mutated nothing by itself.
    expect(simulation.state.proposals).toHaveLength(1);
  });

  it('records provider failures instead of throwing', async () => {
    const failing: DecisionProvider = {
      providerId: 'mock:failing',
      requestDecision: async () => { throw new Error('boom'); },
    };
    const agent = new ModelDrivenAgent(failing, { maxTurns: 1 });
    const records = await agent.run(new WorldSimulation());
    expect(records[0]?.result).toMatchObject({ kind: 'rejected', reason: 'provider-error' });
  });

  it('stops on operator request and runs zero further turns', async () => {
    const provider = new MockProvider([decision('GATHER', 'tree-04')]);
    const agent = new ModelDrivenAgent(provider);
    agent.stop();
    expect(agent.isStopped).toBe(true);
    const records = await agent.run(new WorldSimulation());
    expect(records).toHaveLength(0);
    expect(provider.seen).toHaveLength(0);
  });

  it('adopts a model-supplied revised plan and keeps it inspectable', async () => {
    const provider = new MockProvider([
      '{"action": null, "intent": "survey", "expectation": "no change", "revisedPlan": "Fell tree-04, then gather berries"}',
    ]);
    const agent = new ModelDrivenAgent(provider, { maxTurns: 1 });
    await agent.run(new WorldSimulation());
    expect(agent.plan).toBe('Fell tree-04, then gather berries');
    expect(agent.turns[0]?.result).toMatchObject({ kind: 'no-op' });
  });
});

describe('governance stop and cancellation', () => {
  it('cancels a pending high-risk proposal without mutating the world', () => {
    const simulation = new WorldSimulation();
    const woodBefore = simulation.state.wood;
    const proposal = simulation.proposeAction('GATHER', 'tree-01', {}, 'HIGH');
    expect(proposal.status).toBe('PROPOSED');
    expect(simulation.cancelProposal(proposal.id)).toBe(true);
    expect(proposal.status).toBe('CANCELLED');
    expect(simulation.cancelProposal(proposal.id)).toBe(false);
    expect(simulation.state.wood).toBe(woodBefore);
    expect(simulation.state.events.some((e) => e.type === 'TREE_CHOPPED' && e.entityId === 'tree-01')).toBe(false);
  });

  it('refuses to cancel a proposal that is already executing', () => {
    const simulation = new WorldSimulation();
    const proposal = simulation.proposeAction('GATHER', 'tree-04');
    expect(proposal.status).toBe('EXECUTING');
    expect(simulation.cancelProposal(proposal.id)).toBe(false);
  });

  it('a rejected proposal never produces its own protected mutation', () => {
    // Wilderness boots idle: governance isolation is tested without a
    // background loop, so the rejected target must be untouched because no
    // directive ever drives it.
    const simulation = new WorldSimulation(createWorld(), new ManualAgent());
    const proposal = simulation.proposeAction('GATHER', 'tree-01', {}, 'HIGH');
    expect(simulation.rejectProposal(proposal.id)).toBe(true);
    simulation.advanceUntil(() => false, 200);
    // No autonomous work runs without directives, and the rejected proposal
    // authorizes nothing — so its target must be untouched.
    expect(simulation.state.entities['tree-01']).toMatchObject({ kind: 'tree', health: 2, state: 'standing' });
    expect(
      simulation.state.events.some((e) => (e.type === 'TREE_CHOPPED' || e.type === 'TREE_DAMAGED') && e.entityId === 'tree-01'),
    ).toBe(false);
    expect(proposal.status).toBe('REJECTED');
  });
});

describe('approval binding and verification distinctness', () => {
  it('does not consume an approval for one target on work toward another', () => {
    const simulation = new WorldSimulation(createWorld(), new ManualAgent());
    const gated = simulation.proposeAction('GATHER', 'tree-01', {}, 'HIGH');
    expect(simulation.approveProposal(gated.id)).toBe(true);
    expect(simulation.approveProposal(gated.id)).toBe(false); // stale reuse refused
    simulation.advanceUntil(() => false, 200);
    // Nothing executes without a directive; the approved tree-01 proposal
    // simply waits for its human-authorized execution.
    expect(gated.status).toBe('APPROVED');
    expect(simulation.state.entities['tree-01']).toMatchObject({ kind: 'tree', health: 2, state: 'standing' });
  });

  it('records EXECUTED and VERIFIED as distinct transitions', () => {
    const simulation = new WorldSimulation();
    expect(simulation.advanceUntil((s) => s.wood === 1, 2400)).toBe(true);
    const changes = simulation.state.events.filter((e) => e.type === 'ACTION_STATUS_CHANGED');
    const statuses = changes.map((e) => e.data['status']);
    expect(statuses).toContain('EXECUTED');
    expect(statuses).toContain('VERIFIED');
    const gather = simulation.state.proposals.find((p) => p.actionType === 'GATHER');
    const order = changes.filter((e) => e.data['proposalId'] === gather?.id).map((e) => e.data['status']);
    expect(order.indexOf('EXECUTED')).toBeLessThan(order.indexOf('VERIFIED'));
  });
});

describe('tree damage versus felling semantics', () => {
  it('emits TREE_DAMAGED on partial hits and exactly one TREE_CHOPPED per felled tree', () => {
    const simulation = new WorldSimulation();
    expect(simulation.advanceUntil((s) => s.events.some((e) => e.type === 'TREE_DAMAGED'), 1200)).toBe(true);
    expect(simulation.state.events.filter((e) => e.type === 'TREE_CHOPPED')).toHaveLength(0);
    // The GATHER proposal stays executing through the partial hit.
    expect(simulation.state.proposals.some((p) => p.actionType === 'GATHER' && p.status === 'EXECUTING')).toBe(true);
    expect(simulation.advanceUntil((s) => s.wood === 1, 2400)).toBe(true);
    // Scope to the tree that produced the delivered log: crew workers may
    // fell other trees concurrently, and that is legitimate parallelism.
    const delivered = Object.values(simulation.state.entities).find((e) => e.kind === 'log' && e.state === 'delivered');
    const created = simulation.state.events.find((e) => e.type === 'RESOURCE_CREATED' && e.entityId === delivered?.id);
    const sourceTree = created?.data['sourceTreeId'] as string | undefined;
    expect(sourceTree).toBeTruthy();
    expect(simulation.state.events.filter((e) => e.type === 'TREE_CHOPPED' && e.entityId === sourceTree)).toHaveLength(1);
    expect(simulation.state.events.some((e) => e.type === 'TREE_DAMAGED' && e.entityId === sourceTree)).toBe(true);
    expect(simulation.state.proposals.some((p) => p.actionType === 'GATHER' && p.targetEntityId === sourceTree && p.status === 'VERIFIED')).toBe(true);
  });
});
