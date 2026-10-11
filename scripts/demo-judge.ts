#!/usr/bin/env tsx
/**
 * Executable judge demo: all twelve beats run against the real simulation —
 * no scripted video, no fabricated outcomes. Default uses the deterministic
 * planner as the decider (no inference); pass --live-interpret to route one
 * command through the backend model interpreter (gracefully skipped with a
 * recorded note when inference is unavailable).
 *
 *   npx tsx scripts/demo-judge.ts [--live-interpret]
 */
import fs from 'node:fs';
import { WorldSimulation } from '../src/simulation/WorldSimulation';
import { createWorld } from '../src/world/createWorld';
import { GoalTracker, parseCommand } from '../src/game/goals';
import { GoalRunner, plannerDecide, type EvidenceRow } from '../src/game/runner';

const LIVE = process.argv.includes('--live-interpret');
const BACKEND = process.env['ASTRIX_AGENT_BACKEND'] ?? 'http://127.0.0.1:5193';

interface Beat { beat: number; name: string; detail: string; evidence?: unknown }

const beats: Beat[] = [];
const beat = (n: number, name: string, detail: string, evidence?: unknown) => {
  beats.push({ beat: n, name, detail, evidence });
  console.log(`[${n}] ${name}: ${detail}`);
};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`DEMO ASSERTION FAILED: ${message}`);
  console.log(`    ✓ ${message}`);
}

async function runUntil(runner: GoalRunner, tracker: GoalTracker, done: () => boolean, cap: number, label: string): Promise<EvidenceRow[]> {
  const rows: EvidenceRow[] = [];
  for (let i = 0; i < cap && tracker.active && !done(); i += 1) {
    rows.push(await runner.runTurn(plannerDecide));
  }
  console.log(`    (${label}: ${rows.length} turns)`);
  return rows;
}

const sim = new WorldSimulation(createWorld());
const tracker = new GoalTracker();
const foodStart = sim.state.food;

// Beat 1–2: direct command to gather food; a verified delivery must land and
// the stockpile must not go backwards (consumption runs concurrently).
const cmd1 = parseCommand('gather food');
assert(cmd1.ok === true, 'command "gather food" parses to a goal');
if (cmd1.ok) tracker.setGoal({ kind: 'gather-food', quantity: foodStart + 1, note: 'demo' }, 0);
const direct = new GoalRunner(sim, tracker, 'direct');
await runUntil(direct, tracker, () => sim.state.food >= foodStart + 1, 10, 'direct food');
assert(sim.state.food >= foodStart, `stockpile held or grew (started ${foodStart}, now ${sim.state.food})`);
assert(direct.rows.some((r) => r.verified && r.action === 'HARVEST'), 'a harvest verified in the direct phase');
// Deliveries can settle as governed side effects inside another turn's
// advance (the carrying branch always finishes delivery); what matters is
// that a DELIVER proposal independently verified, not which row drove it.
assert(sim.state.proposals.some((p) => p.actionType === 'DELIVER' && p.status === 'VERIFIED'), 'a delivery verified in the direct phase');
beat(1, 'direct command', 'judge: "gather food"', { food: sim.state.food });
beat(2, 'workers deliver', 'stockpile changed through execution + verification', { rows: direct.rows.length });

// Beat 3–4: delegated preservation goal; agent works autonomously.
const cmd2 = parseCommand('keep our food reserves above 100 units');
const preserveTarget = cmd2.ok ? cmd2.goal.quantity : sim.state.food + 1;
if (cmd2.ok) tracker.setGoal({ ...cmd2.goal }, sim.state.tick);
const delegated = new GoalRunner(sim, tracker, 'delegated');
const foodBeforeDelegated = sim.state.food;
await runUntil(delegated, tracker, () => sim.state.food >= preserveTarget, 16, 'delegated preserve');
assert(
  delegated.rows.some((r) => r.verified && (r.action === 'HARVEST' || r.action === 'PICK_UP'))
    || sim.state.proposals.some((p) => (p.actionType === 'HARVEST' || p.actionType === 'DELIVER') && p.status === 'VERIFIED'),
  'delegated phase produced verified food work',
);
beat(3, 'delegated goal', 'judge sets a large food-preservation goal; agent selects actions within LOW/MEDIUM policy');
beat(4, 'autonomous execution', 'permitted actions executed without per-action approval', { rows: delegated.rows.length, foodBeforeDelegated, foodAfter: sim.state.food });

// Beat 5–6: genuine depletion then adaptation. Workers cooperate (any idle
// worker can take a directive), so accounting is by verified harvest targets
// across phases, not by which phase touched which patch.
const harvestedBy = (rows: EvidenceRow[]) => rows.filter((r) => r.action === 'HARVEST' && r.verified).map((r) => r.target);
const directPatches = harvestedBy(direct.rows);
const delegatedPatches = harvestedBy(delegated.rows);
const distinctPatches = [...new Set([...directPatches, ...delegatedPatches])];
const patchStates = ['berry-patch-01', 'berry-patch-02'].map((id) => `${id}=${sim.state.entities[id]?.kind === 'berry-patch' ? sim.state.entities[id].state : '?'}`).join(', ');
beat(5, 'constraint', `harvests genuinely deplete patches (${patchStates})`);
assert(distinctPatches.length >= 1, 'verified harvest work happened');
beat(6, 'adaptation', distinctPatches.length >= 2 ? `work moved across patches as each depleted (${distinctPatches.join(', ')})` : 'agent reported blocked when nothing remained; no fabrication', { directPatches, delegatedPatches });

// Beat 7–10: supervised construction proposal, rejection, proof of inertia.
const cmd3 = parseCommand('build a house');
assert(cmd3.ok === true, '"build a house" parses');
if (cmd3.ok) tracker.setGoal({ ...cmd3.goal }, sim.state.tick);
const supervised = new GoalRunner(sim, tracker, 'supervised');
await runUntil(supervised, tracker, () => sim.state.wood >= 2, 16, 'gather wood for house');
assert(sim.state.wood >= 2, `2 wood gathered (got ${sim.state.wood})`);
beat(7, 'stricter policy', 'supervised mode: MEDIUM/HIGH hold for approval');
// The crew may still be hauling when wood lands; run turns until the BUILD
// step surfaces, then require it to be held.
let held: Awaited<ReturnType<GoalRunner['runTurn']>> | null = null;
for (let i = 0; i < 6 && !held; i += 1) {
  const row = await supervised.runTurn(plannerDecide);
  if (row.action === 'BUILD') held = row;
}
assert(held && held.action === 'BUILD' && !held.verified && held.proposalId !== null, 'BUILD proposed and held');
beat(8, 'costly proposal', `house proposed (${held.proposalId}, HIGH risk, held)`);
const woodAtRejection = sim.state.wood;
assert(sim.rejectProposal(held.proposalId!), 'judge rejects: reserves too low');
assert(sim.state.wood === woodAtRejection, 'wood untouched by rejection');
assert(!Object.values(sim.state.entities).some((e) => e.kind === 'house'), 'no house entity exists');
beat(9, 'rejection', 'judge rejects the house');
beat(10, 'inertia proved', 'construction did not occur; stockpile intact', { wood: sim.state.wood });

// Beat 11: rejection observed → different valid action (skip, then gather).
const replan = await supervised.runTurn(plannerDecide);
assert(replan.proposalId === null && /skipped|replanning/i.test(replan.note), 'runner visibly replans instead of re-proposing');
beat(11, 'replan', `agent chose a different valid path (${replan.note})`);

// Optional completion: approve a fresh proposal and verify the house.
const retry = await supervised.runTurn(plannerDecide);
assert(retry.proposalId !== null, 'fresh BUILD proposal surfaced for review');
assert(sim.approveProposal(retry.proposalId!), 'judge approves');
await runUntil(supervised, tracker, () => !sim.state.proposals.find((p) => p.id === retry.proposalId) || ['VERIFIED', 'FAILED'].includes(sim.state.proposals.find((p) => p.id === retry.proposalId)?.status ?? ''), 6, 'build');
const finalProposal = sim.state.proposals.find((p) => p.id === retry.proposalId);
assert(finalProposal?.status === 'VERIFIED', `house proposal VERIFIED (got ${finalProposal?.status})`);
assert(Object.values(sim.state.entities).some((e) => e.kind === 'house' && e.state === 'complete'), 'a complete house exists in authoritative state');

// Beat 12: timeline inspection.
const timeline = sim.state.events
  .filter((e) => !['AGENT_MOVED'].includes(e.type))
  .map((e) => `${String(e.sequence).padStart(3, '0')} ${e.type}${e.entityId ? `@${e.entityId}` : ''}`);
beat(12, 'timeline', `${timeline.length} causal events available for inspection`, { tail: timeline.slice(-14) });

// Optional live model interpretation (one call, honest skip when unavailable).
// Uses a command the deterministic parser cannot handle, so the model path
// is genuinely exercised.
if (LIVE) {
  try {
    const response = await fetch(`${BACKEND}/api/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'stockpile timber for the upcoming build', useModel: true }),
    });
    const data = (await response.json()) as {
      parsed?: { ok?: boolean };
      interpretation?: { ok?: boolean; goal?: unknown; clarify?: string };
    };
    const interpretation = data.interpretation;
    beat(13, 'live interpretation', interpretation?.ok ? 'model interpreted a novel command into a validated goal' : 'model could not interpret; deterministic clarify stood', { interpretation: interpretation ?? null });
  } catch (error) {
    beat(13, 'live interpretation', `inference unavailable (${error instanceof Error ? error.message : String(error)}); no fabrication`, {});
  }
}

const outPath = `artifacts/demo-judge-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(outPath, JSON.stringify({
  at: new Date().toISOString(),
  seed: 'deterministic createWorld()',
  beats,
  rows: [...direct.rows, ...delegated.rows, ...supervised.rows],
  totals: { wood: sim.state.wood, food: sim.state.food, tick: sim.state.tick },
}, null, 2));
console.log(`Wrote ${outPath}`);
console.log('DEMO COMPLETE');
