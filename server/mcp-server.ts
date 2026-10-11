#!/usr/bin/env tsx
/**
 * ASTrix MCP server (stdio transport).
 *
 * Exposes the governed world-tool seam to agent harnesses such as TrueForge:
 * read-only observation plus proposal creation. Approvals and execution stay
 * inside WorldSimulation; this process never auto-approves HIGH proposals.
 *
 * Register in TrueForge under Settings → Connectors as a stdio MCP server
 * with command `tsx server/mcp-server.ts` (working directory: repo root),
 * then attach it to the astrix-steward agent with approval required for
 * `propose_action`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WorldSimulation } from '../src/simulation/WorldSimulation';
import { dispatchTool } from '../src/mcp/astrixTools';

const sim = new WorldSimulation();
const server = new McpServer({ name: 'astrix-world', version: '0.1.0' });

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

server.tool('observe_world', 'Read the authoritative world observation (never mutates).', {}, async () => text(dispatchTool(sim, 'observe_world', {})));
server.tool('simulation_status', 'Stockpiles, entity counts, proposals, and recent events (never mutates).', {}, async () => text(dispatchTool(sim, 'simulation_status', {})));
server.tool('list_actions', 'Supported action types and governance rules (never mutates).', {}, async () => text(dispatchTool(sim, 'list_actions', {})));
server.tool(
  'propose_action',
  'Create an action proposal through ASTrix governance. LOW may execute under standing policy; MEDIUM/HIGH stay PROPOSED for human approval.',
  {
    actionType: z.enum(['MOVE_TO', 'GATHER', 'HARVEST', 'PICK_UP', 'DELIVER']),
    targetEntityId: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()).optional(),
    riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  },
  async (args) => text(dispatchTool(sim, 'propose_action', args)),
);
server.tool(
  'proposal_status',
  'Inspect a proposal lifecycle state (never mutates).',
  { proposalId: z.string().min(1) },
  async (args) => text(dispatchTool(sim, 'proposal_status', args)),
);

await server.connect(new StdioServerTransport());
