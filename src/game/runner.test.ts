import { describe, expect, it } from 'vitest';
import { GoalRunner, plannerDecide } from './runner';
import { GoalTracker } from './goals';
import { WorldSimulation } from '../simulation/WorldSimulation';
import { createWorld } from '../world/createWorld';

function setup(mode: 'direct' | 'delegated' | 'supervised' = 'delegated') {
  const sim = new WorldSimulation(createWorld());
  const tracker = new GoalTracker();
  const runner = new GoalRunner(sim, tracker, mode);
  return { sim, tracker, runner };
}

describe('GoalRunner', () => {
  it('completes a gather-food goal with verified evidence rows', async () => {
    const { sim, tracker, runner } = setup();
    tracker.setGoal({ kind: 'gather-food', quantity: 4, note: 'demo' }, 0);
    let guard = 0;
    while (tracker.active && guard++ < 16) {
      await runner.runTurn(plannerDecide);
    }
    expect(sim.state.food).toBe(4);
    expect(tracker.active).toBeNull();
    expect(runner.rows.length).toBeGreaterThan(0);
    expect(runner.rows.every((r) => r.verified || r.action === null)).toBe(true);
    const row = runner.rows[0]!;
    expect(row).toMatchObject({ source: 'planner' });
    expect(row.worldAfter).toMatchObject({ food: expect.any(Number) });
    expect(typeof row.proposalId).toBe('string');
  });

  it('adapts to a depleted patch by using the remaining one', async () => {
    const { sim, tracker, runner } = setup();
    const patch = sim.state.entities['berry-patch-01'];
    if (patch?.kind === 'berry-patch') patch.state = 'harvested';
    tracker.setGoal({ kind: 'gather-food', quantity: 4, note: 'demo' }, 0);
    let guard = 0;
    while (tracker.active && guard++ < 16) {
      await runner.runTurn(plannerDecide);
    }
    // Consumption runs concurrently, so assert verified harvest work plus no
    // net loss rather than an exact ledger.
    expect(runner.rows.some((r) => r.target === 'berry-patch-02' && r.verified)).toBe(true);
    expect(sim.state.food).toBeGreaterThanOrEqual(3);
  });

  it('holds BUILD for approval, proves rejection is inert, then completes on approval', async () => {
    const { sim, tracker, runner } = setup('supervised');
    sim.state.wood = 2;
    tracker.setGoal({ kind: 'construct-house', quantity: 1, note: 'demo' }, 0);
    const held = await runner.runTurn(plannerDecide);
    expect(held).toMatchObject({ action: 'BUILD', verified: false });
    expect(held.note).toMatch(/approval/);
    const proposalId = held.proposalId!;
    // Judge rejects: no house, wood intact.
    expect(sim.rejectProposal(proposalId)).toBe(true);
    expect(sim.state.wood).toBe(2);
    expect(Object.values(sim.state.entities).some((e) => e.kind === 'house')).toBe(false);
    // Next turn replans around the rejection instead of re-proposing blindly.
    const replanned = await runner.runTurn(plannerDecide);
    expect(replanned.note).toMatch(/replanning|skipped/i);
    expect(replanned.proposalId).toBeNull();
    // Judge approves a fresh proposal: house completes, wood spent, verified.
    const held2 = await runner.runTurn(async () => ({ action: { actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'judge-approved retry' }, source: 'judge' }));
    expect(held2.proposalId).not.toBeNull();
    expect(sim.approveProposal(held2.proposalId!)).toBe(true);
    let guard = 0;
    while (sim.state.proposals.find((p) => p.id === held2.proposalId)?.status === 'APPROVED' && guard++ < 5) {
      await runner.runTurn(plannerDecide);
    }
    const done = sim.state.proposals.find((p) => p.id === held2.proposalId);
    expect(done?.status).toBe('VERIFIED');
    expect(sim.state.wood).toBe(0);
    expect(Object.values(sim.state.entities).some((e) => e.kind === 'house' && e.state === 'complete')).toBe(true);
  });

  it('records validation failures without proposing', async () => {
    const { sim, tracker, runner } = setup();
    tracker.setGoal({ kind: 'gather-wood', quantity: 1, note: 'demo' }, 0);
    const row = await runner.runTurn(() => ({ action: { actionType: 'GATHER', targetEntityId: 'nope', reason: 'bad' }, source: 'test' }));
    expect(row).toMatchObject({ verified: false, proposalId: null });
    expect(row.note).toMatch(/validation rejected/);
    expect(sim.state.proposals).toHaveLength(0);
  });
});
