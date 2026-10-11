import { describe, expect, it } from 'vitest';
import { WorldSimulation } from './WorldSimulation';
import { createWorld } from '../world/createWorld';
import { ManualAgent } from '../agent/ManualAgent';
import { GoalTracker } from '../game/goals';
import { GoalRunner, plannerDecide } from '../game/runner';

function manualSim() {
  return new WorldSimulation(createWorld(), new ManualAgent());
}

describe('first-class governed plans', () => {
  it('executes a LOW plan with one proposal and virtual steps, not per-step proposals', async () => {
    const sim = new WorldSimulation(createWorld());
    const tracker = new GoalTracker();
    const runner = new GoalRunner(sim, tracker, 'delegated');
    tracker.setGoal({ kind: 'gather-food', quantity: 4, note: 'plan test' }, 0);
    let guard = 0;
    while (tracker.active && guard++ < 20) {
      await runner.runTurn(plannerDecide);
    }
    expect(tracker.active).toBeNull();
    // Exactly one governed proposal for the whole goal.
    expect(sim.state.proposals).toHaveLength(1);
    expect(sim.state.proposals[0]).toMatchObject({ actionType: 'PLAN', status: 'VERIFIED' });
    const plans = Object.values(sim.state.plans);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.status).toBe('completed');
    expect(plans[0]!.steps.filter((s) => s.status === 'verified').length).toBeGreaterThanOrEqual(3);
    // Step events reference the parent plan.
    const stepEvents = sim.state.events.filter((e) => typeof e.data['planId'] === 'string');
    expect(stepEvents.length).toBeGreaterThan(0);
    // Decision evidence retained without unbounded growth.
    expect(sim.state.journal.length).toBeGreaterThan(0);
    expect(sim.state.journal.length).toBeLessThanOrEqual(40);
  });

  it('holds HIGH plans for approval; rejection executes no steps', () => {
    const sim = manualSim();
    sim.autoApproveUpTo = 'LOW';
    sim.state.wood = 2;
    const { plan, proposal } = sim.submitPlan('construct-house', 1);
    expect(plan.status).toBe('awaiting-approval');
    expect(proposal.status).toBe('PROPOSED');
    // Attempting a step while awaiting approval is blocked, not executed.
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'early', parameters: {} }, undefined, plan.id);
    sim.advanceUntil(() => plan.steps.length > 0, 30);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ actionType: 'BUILD', status: 'blocked' });
    expect(plan.steps.filter((s) => s.status === 'verified')).toHaveLength(0);
    expect(Object.values(sim.state.entities).some((e) => e.kind === 'house')).toBe(false);
    // Rejection is inert: no workers move, no wood spent.
    expect(sim.rejectProposal(proposal.id)).toBe(true);
    expect(plan.status).toBe('rejected');
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'after-reject', parameters: {} }, undefined, plan.id);
    sim.advanceUntil(() => false, 30);
    expect(Object.values(sim.state.entities).some((e) => e.kind === 'house')).toBe(false);
    expect(sim.state.wood).toBe(2);
    expect(plan.steps.filter((s) => s.status === 'verified')).toHaveLength(0);
  });

  it('blocks actions outside the approved authority', () => {
    const sim = manualSim();
    const { plan, proposal } = sim.submitPlan('gather-wood', 2);
    expect(plan.status).toBe('active'); // LOW auto-approves
    expect(proposal.status).toBe('EXECUTING');
    expect(plan.constraints.allowedActions).not.toContain('BUILD');
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'smuggled', parameters: {} }, undefined, plan.id);
    sim.advanceUntil(() => plan.steps.length > 0, 30);
    expect(plan.steps[0]).toMatchObject({ actionType: 'BUILD', status: 'blocked', note: 'outside approved authority' });
    expect(Object.values(sim.state.entities).some((e) => e.kind === 'house')).toBe(false);
  });

  it('enforces the spend cap across competing steps', () => {
    const sim = manualSim();
    sim.state.wood = 4;
    const { plan } = sim.submitPlan('construct-house', 1);
    expect(plan.constraints.spendCapWood).toBe(2);
    // HIGH construction plans hold for explicit human approval.
    expect(plan.status).toBe('awaiting-approval');
    expect(sim.approveProposal(plan.proposalId!)).toBe(true);
    expect(plan.status).toBe('active');
    // First house spends the full cap.
    const first = { actionType: 'BUILD' as const, targetEntityId: 'settlement-01', reason: 'first', parameters: {} };
    expect(sim.advanceUntil(() => {
      if (Object.values(sim.state.entities).some((e) => e.kind === 'house' && e.state === 'complete')) return true;
      if (sim.directives.length === 0) sim.issueDirective({ ...first }, 'worker-01', plan.id);
      return false;
    }, 1200)).toBe(true);
    expect(plan.spentWood).toBe(2);
    expect(sim.state.wood).toBe(2);
    // Second build exceeds the cap and fails without spending.
    const second = { actionType: 'BUILD' as const, targetEntityId: 'settlement-01', reason: 'second', parameters: {} };
    sim.advanceUntil(() => {
      if (sim.state.events.some((e) => e.type === 'CONSTRUCTION_FAILED' && e.data['reason'] === 'spend-cap')) return true;
      if (sim.directives.length === 0) sim.issueDirective({ ...second }, 'worker-01', plan.id);
      return false;
    }, 600);
    expect(sim.state.events.some((e) => e.type === 'CONSTRUCTION_FAILED' && e.data['reason'] === 'spend-cap')).toBe(true);
    expect(Object.values(sim.state.entities).filter((e) => e.kind === 'house')).toHaveLength(1);
    expect(sim.state.wood).toBe(2);
  });

  it('cancels explicitly: workers stop, directives clear, no further steps', () => {
    const sim = manualSim();
    const { plan } = sim.submitPlan('gather-wood', 2);
    expect(plan.status).toBe('active');
    sim.issueDirective({ actionType: 'GATHER', targetEntityId: 'tree-04', reason: 'go', parameters: {} }, undefined, plan.id);
    sim.advanceUntil(() => (sim.state.entities['worker-01']?.kind === 'worker' && sim.state.entities['worker-01'].activity === 'moving'), 60);
    expect(sim.cancelPlan(plan.id)).toBe(true);
    expect(plan.status).toBe('cancelled');
    expect(sim.directives).toHaveLength(0);
    const stepsBefore = plan.steps.length;
    sim.advanceUntil(() => false, 120);
    expect(plan.steps).toHaveLength(stepsBefore);
    // Cancelling a terminal plan is a no-op.
    expect(sim.cancelPlan(plan.id)).toBe(false);
  });

  it('expires plans and blocks late steps', () => {
    const sim = manualSim();
    const { plan } = sim.submitPlan('gather-wood', 2);
    expect(plan.status).toBe('active');
    // Force expiry on the next settlement tick.
    plan.constraints.expiresTick = sim.state.tick;
    sim.advanceUntil(() => plan.status === 'expired', 10);
    expect(plan.status).toBe('expired');
    sim.issueDirective({ actionType: 'GATHER', targetEntityId: 'tree-04', reason: 'late', parameters: {} }, undefined, plan.id);
    sim.advanceUntil(() => false, 30);
    expect(plan.steps.some((s) => s.status === 'blocked')).toBe(true);
  });
});
