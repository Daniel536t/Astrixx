/**
 * ASTrix MCP tools: the governed seam between an agent harness (TrueForge)
 * and the authoritative simulation.
 *
 * Read tools (`observe_world`, `list_actions`, `proposal_status`,
 * `simulation_status`) never mutate. `propose_action` only creates a
 * proposal through the simulation's own governance: LOW proposals become
 * EXECUTING per standing local policy, HIGH/MEDIUM stay PROPOSED until a
 * human approves via `approveProposal` (ASTrix UI / operator API) — the MCP
 * layer has no approval authority and no execution path around the sim loop.
 */
import { z } from 'zod';
import { LocalGathererAgent } from '../agent/LocalGathererAgent';
import { validateDecisionAgainstWorld } from '../agent/nvidia/DecisionSchema';
import { ACTION_CAPABILITIES } from '../game/capabilities';
import type { WorldSimulation } from '../simulation/WorldSimulation';

const observer = new LocalGathererAgent();

export const ProposeActionArgs = z.object({
  actionType: z.enum(['MOVE_TO', 'GATHER', 'HARVEST', 'PICK_UP', 'DELIVER', 'BUILD', 'PLANT', 'COLLECT', 'CRAFT', 'REST']),
  targetEntityId: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
});

export const ProposalStatusArgs = z.object({
  proposalId: z.string().min(1),
});

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export function observeWorld(sim: WorldSimulation): ToolResult {
  return { ok: true, data: observer.observe(sim.state) };
}

export function simulationStatus(sim: WorldSimulation): ToolResult {
  const kinds: Record<string, number> = {};
  for (const entity of Object.values(sim.state.entities)) {
    kinds[entity.kind] = (kinds[entity.kind] ?? 0) + 1;
  }
  return {
    ok: true,
    data: {
      tick: sim.state.tick,
      wood: sim.state.wood,
      food: sim.state.food,
      water: sim.state.water,
      entities: kinds,
      proposals: sim.state.proposals.map((p) => ({ id: p.id, actionType: p.actionType, target: p.targetEntityId, status: p.status })),
      recentEvents: sim.state.events.slice(-20).map((e) => ({ sequence: e.sequence, type: e.type, entityId: e.entityId })),
    },
  };
}

export function listActions(): ToolResult {
  // Derived from the shared capability registry — never a parallel list.
  // (The model prompt keeps its own tuned prose under DecisionSchema, but
  // every capability it names must exist here too; phase6 tests pin that.)
  return {
    ok: true,
    data: {
      actions: ACTION_CAPABILITIES.filter((c) => c.implemented).map((c) => ({
        actionType: c.id,
        requires: c.requires,
      })),
      governance: 'LOW auto-executes under standing local policy. Whether MEDIUM auto-executes depends on the control mode. HIGH (including every BUILD) remains PROPOSED until explicit human approval. Execution routing and risk assignment cannot be set through tools.',
    },
  };
}

export function proposeAction(sim: WorldSimulation, args: unknown): ToolResult {
  const parsed = ProposeActionArgs.safeParse(args);
  if (!parsed.success) return { ok: false, error: `Invalid arguments: ${parsed.error.message}` };
  const { actionType, targetEntityId, parameters, riskLevel } = parsed.data;
  const verdict = validateDecisionAgainstWorld(
    { action: { actionType, targetEntityId, parameters: parameters ?? {} }, intent: 'mcp-proposed', expectation: 'governed execution' },
    sim.state,
  );
  if (!verdict.ok) return { ok: false, error: `${verdict.reason}: ${verdict.detail}` };
  const proposal = sim.proposeAction(actionType, targetEntityId, parameters ?? {}, riskLevel ?? 'LOW');
  return {
    ok: true,
    data: {
      proposalId: proposal.id,
      status: proposal.status,
      heldForHumanApproval: proposal.status === 'PROPOSED',
    },
  };
}

export function proposalStatus(sim: WorldSimulation, args: unknown): ToolResult {
  const parsed = ProposalStatusArgs.safeParse(args);
  if (!parsed.success) return { ok: false, error: `Invalid arguments: ${parsed.error.message}` };
  const proposal = sim.state.proposals.find((p) => p.id === parsed.data.proposalId);
  if (!proposal) return { ok: false, error: `Unknown proposal ${parsed.data.proposalId}.` };
  return {
    ok: true,
    data: {
      proposalId: proposal.id,
      actionType: proposal.actionType,
      targetEntityId: proposal.targetEntityId,
      status: proposal.status,
      riskLevel: proposal.riskLevel,
    },
  };
}

export function dispatchTool(sim: WorldSimulation, name: string, args: unknown): ToolResult {
  switch (name) {
    case 'observe_world':
      return observeWorld(sim);
    case 'simulation_status':
      return simulationStatus(sim);
    case 'list_actions':
      return listActions();
    case 'propose_action':
      return proposeAction(sim, args);
    case 'proposal_status':
      return proposalStatus(sim, args);
    default:
      return { ok: false, error: `Unknown tool ${name}.` };
  }
}

export const TOOL_NAMES = ['observe_world', 'simulation_status', 'list_actions', 'propose_action', 'proposal_status'] as const;
