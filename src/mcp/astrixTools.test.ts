import { describe, expect, it } from 'vitest';
import { dispatchTool } from './astrixTools';
import { WorldSimulation } from '../simulation/WorldSimulation';

describe('ASTrix MCP tools', () => {
  it('observes and reports status without mutating', () => {
    const sim = new WorldSimulation();
    const eventsBefore = sim.state.events.length;
    const observed = dispatchTool(sim, 'observe_world', {});
    expect(observed.ok).toBe(true);
    if (observed.ok) {
      expect(observed.data).toMatchObject({ worker: { id: 'worker-01' }, wood: 0 });
    }
    const status = dispatchTool(sim, 'simulation_status', {});
    expect(status.ok).toBe(true);
    expect(sim.state.events.length).toBe(eventsBefore);
    expect(sim.state.proposals).toHaveLength(0);
  });

  it('lists the real action registry', () => {
    const listed = dispatchTool(new WorldSimulation(), 'list_actions', {});
    expect(listed).toMatchObject({ ok: true });
    if (listed.ok) {
      const actions = (listed.data as { actions: Array<{ actionType: string }> }).actions.map((a) => a.actionType);
      expect(actions).toEqual(['GATHER', 'HARVEST', 'PICK_UP', 'DELIVER', 'COLLECT', 'CRAFT', 'REST', 'BUILD', 'PLANT', 'MOVE_TO']);
    }
  });

  it('proposes LOW actions into execution and holds HIGH for humans', () => {
    const sim = new WorldSimulation();
    const low = dispatchTool(sim, 'propose_action', { actionType: 'GATHER', targetEntityId: 'tree-04' });
    expect(low).toMatchObject({ ok: true, data: { status: 'EXECUTING', heldForHumanApproval: false } });
    const high = dispatchTool(sim, 'propose_action', { actionType: 'GATHER', targetEntityId: 'tree-01', riskLevel: 'HIGH' });
    expect(high).toMatchObject({ ok: true, data: { status: 'PROPOSED', heldForHumanApproval: true } });
    // The tool layer cannot approve: the HIGH proposal is still pending.
    const status = dispatchTool(sim, 'proposal_status', {
      proposalId: (high as { ok: true; data: { proposalId: string } }).data.proposalId,
    });
    expect(status).toMatchObject({ ok: true, data: { status: 'PROPOSED' } });
  });

  it('rejects unknown tools, bad arguments, illegal targets, and escalation params', () => {
    const sim = new WorldSimulation();
    expect(dispatchTool(sim, 'nope', {})).toMatchObject({ ok: false });
    expect(dispatchTool(sim, 'propose_action', { actionType: 'GATHER' })).toMatchObject({ ok: false });
    expect(dispatchTool(sim, 'propose_action', { actionType: 'GATHER', targetEntityId: 'tree-99' })).toMatchObject({ ok: false });
    expect(
      dispatchTool(sim, 'propose_action', { actionType: 'GATHER', targetEntityId: 'tree-01', parameters: { execution: 'magicblock-er' } }),
    ).toMatchObject({ ok: false });
    expect(dispatchTool(sim, 'proposal_status', { proposalId: 'proposal-9999' })).toMatchObject({ ok: false });
    expect(sim.state.proposals).toHaveLength(0);
  });
});
