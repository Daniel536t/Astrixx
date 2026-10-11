import { describe, expect, it } from 'vitest';
import { measureDuel, runDuel } from './secondAgent';

/**
 * Second-agent experiment invariants: two directive drivers (Moss on
 * worker-01/02, Rival on worker-03) racing the same scarce timber with the
 * same policy. Directives bypass claim exclusion, so overlapping targets are
 * guaranteed and the stale-task guards, proposal settlement, and delivery
 * attribution run under genuine contention.
 */
describe('second-agent duel', () => {
  it('races timber without double-felling, leaks, or misattribution', () => {
    const { sim, turns } = runDuel(10);
    expect(turns).toHaveLength(20);
    const m = measureDuel(sim, turns);

    // World progress: every tree felled and delivered.
    expect(m.felledTrees).toBe(6);
    expect(m.wood).toBe(6);

    // No double-fell under contention: one log per felled tree.
    expect(Object.values(m.logsPerFelledTree)).toHaveLength(6);
    for (const [tree, count] of Object.entries(m.logsPerFelledTree)) {
      expect(count, `double-fell on ${tree}`).toBe(1);
    }

    // Contention happened and settled honestly: race losers FAILED, winning
    // crews shared GATHER proposals instead of stacking duplicates.
    expect(m.failedProposals.length).toBeGreaterThan(0);
    expect(m.sharedGatherProposals.length).toBeGreaterThan(0);

    // Both crews participated in deliveries.
    expect(m.deliveriesByWorker['worker-01'] ?? 0).toBeGreaterThan(0);
    expect(m.deliveriesByWorker['worker-03'] ?? 0).toBeGreaterThan(0);

    // Every delivery verified under its own proposal.
    const deliveries = sim.state.proposals.filter((p) => p.actionType === 'DELIVER');
    expect(deliveries.length).toBeGreaterThan(0);
    for (const proposal of deliveries) {
      expect(proposal.status).toBe('VERIFIED');
    }

    // Hygiene: nothing stranded, directives drained, run replays exactly.
    expect(m.proposalsTerminal).toBe(true);
    expect(m.directivesDrained).toBe(true);
    expect(m.replayHashEqual).toBe(true);
  });
});
