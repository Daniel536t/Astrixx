#!/usr/bin/env tsx
/**
 * Second-agent experiment (OFFLINE, deterministic, no chain, no funds).
 *
 * Moss (worker-01/02) vs Rival (worker-03) race the same scarce timber with
 * the same planner policy. Directives bypass claim exclusion, so overlapping
 * targets produce genuine contention: stale-task guards, proposal
 * settlement, and delivery attribution are stressed and measured.
 *
 * Run: npx tsx scripts/second-agent-experiment.ts [--rounds N]
 * Writes: artifacts/second-agent-<timestamp>.json (the experiment record).
 */
import fs from 'node:fs';
import { runDuel, measureDuel } from '../src/game/secondAgent';

interface Step { step: string; ok: boolean; detail: string }
const steps: Step[] = [];
const recordPath = `artifacts/second-agent-${Date.now()}.json`;
const step = (name: string, ok: boolean, detail: string) => {
  steps.push({ step: name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) {
    fs.writeFileSync(recordPath, JSON.stringify({ at: new Date().toISOString(), steps }, null, 2));
    throw new Error(`Experiment stopped at boundary: ${name} — ${detail}`);
  }
};

const roundsArg = Number(process.argv[3] ?? process.argv[2] ?? 16);
const rounds = Number.isSafeInteger(roundsArg) && roundsArg > 0 ? Math.min(roundsArg, 40) : 16;

const { sim, turns } = runDuel(rounds);
const m = measureDuel(sim, turns);

console.log(`duel: ${rounds} rounds × 2 drivers = ${turns.length} turns, tick ${sim.state.tick}`);
const byOutcome: Record<string, number> = {};
for (const turn of turns) byOutcome[`${turn.driver}:${turn.outcome}`] = (byOutcome[`${turn.driver}:${turn.outcome}`] ?? 0) + 1;
console.log(`turns: ${JSON.stringify(byOutcome)}`);
console.log(`deliveries: ${JSON.stringify(m.deliveriesByWorker)}`);
console.log(`failed proposals: ${m.failedProposals.length > 0 ? m.failedProposals.join(', ') : '(none)'}`);
console.log(`shared GATHER proposals: ${m.sharedGatherProposals.length > 0 ? m.sharedGatherProposals.join(', ') : '(none)'}`);

step('world-progress', m.wood >= 4, `wood=${m.wood} (of 6 standing trees)`);
step('no-double-fell', m.felledTrees > 0 && Object.values(m.logsPerFelledTree).every((count) => count === 1),
  `felled=${m.felledTrees}, logs-per-tree=[${Object.values(m.logsPerFelledTree).join(',')}]`);
step('contention-settled', m.failedProposals.length > 0 || m.sharedGatherProposals.length > 0,
  `failed=[${m.failedProposals.join(',') || 'none'}] shared=[${m.sharedGatherProposals.join(',') || 'none'}]`);
step('delivery-attribution', sim.state.proposals
  .filter((p) => p.actionType === 'DELIVER')
  .every((p) => p.status === 'VERIFIED'),
  'every DELIVER proposal VERIFIED under its own haul');
step('both-crews-delivered', (m.deliveriesByWorker['worker-01'] ?? 0) + (m.deliveriesByWorker['worker-02'] ?? 0) > 0
  && (m.deliveriesByWorker['worker-03'] ?? 0) > 0,
  JSON.stringify(m.deliveriesByWorker));
step('proposal-hygiene', m.proposalsTerminal, 'every proposal terminal');
step('directives-drained', m.directivesDrained, 'no stranded directives');
step('replay-equality', m.replayHashEqual, 'combined multi-driver log replays hash-identical');

fs.writeFileSync(recordPath, JSON.stringify({ at: new Date().toISOString(), rounds, measurements: { ...m, turns: undefined }, turns, steps }, null, 2));
console.log(`record: ${recordPath}`);
