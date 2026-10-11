/**
 * Movement contract: measured speed, frame-rate independence, convergence.
 *
 * Documented speed: 2.35 world units per sim-second (~2.1 inhabitant-heights
 * per second — a steady walk, not a run). The fixed-step accumulator makes
 * sim time independent of wall-clock frames; replay is step-exact.
 */
import { describe, expect, it } from 'vitest';
import { WorldSimulation } from './WorldSimulation';
import { createWorld } from '../world/createWorld';
import { ManualAgent } from '../agent/ManualAgent';
import { stateHash } from './replay';

function manualSim() {
  return new WorldSimulation(createWorld(), new ManualAgent());
}

describe('movement measurement', () => {
  it('travels at 2.35 units per sim-second toward a distant target', () => {
    const sim = manualSim();
    const worker = sim.state.entities['worker-01'];
    if (!worker || worker.kind !== 'worker') throw new Error('worker-01 missing');
    worker.position = { x: 0, z: 0 };
    const target = sim.state.entities['tree-06'];
    if (!target || target.kind !== 'tree') throw new Error('tree-06 missing');
    const start = Math.hypot(target.position.x, target.position.z);
    expect(start).toBeGreaterThan(3); // far enough to measure cruise speed
    sim.issueDirective({ actionType: 'GATHER', targetEntityId: 'tree-06', reason: 'measure', parameters: {} }, 'worker-01');
    sim.advanceUntil(() => false, 10);
    const end = sim.state.entities['worker-01'];
    if (!end || end.kind !== 'worker') throw new Error('worker-01 missing');
    const travelled = start - Math.hypot(target.position.x - end.position.x, target.position.z - end.position.z);
    const seconds = 10 * 0.16;
    expect(travelled / seconds).toBeCloseTo(2.35, 1);
  });

  it('converges monotonically and arrives without orbiting', () => {
    const sim = manualSim();
    const target = sim.state.entities['tree-06'];
    if (!target || target.kind !== 'tree') throw new Error('tree-06 missing');
    sim.issueDirective({ actionType: 'GATHER', targetEntityId: 'tree-06', reason: 'converge', parameters: {} }, 'worker-01');
    let previous = Infinity;
    let steps = 0;
    const reached = sim.advanceUntil(() => {
      const worker = sim.state.entities['worker-01'];
      if (!worker || worker.kind !== 'worker') return false;
      const d = Math.hypot(target.position.x - worker.position.x, target.position.z - worker.position.z);
      expect(d).toBeLessThanOrEqual(previous + 1e-9);
      previous = d;
      steps += 1;
      return worker.activity === 'chopping';
    }, 600);
    expect(reached).toBe(true);
    expect(steps).toBeLessThan(600);
  });

  it('is frame-rate independent: wall-clock chunking never changes the outcome', () => {
    const direct = manualSim();
    direct.issueDirective({ actionType: 'GATHER', targetEntityId: 'tree-06', reason: 'a', parameters: {} }, 'worker-01');
    direct.advanceUntil(() => false, 200);
    // Same 200 sim-steps delivered as small frames: identical state.
    const stepped = manualSim();
    stepped.issueDirective({ actionType: 'GATHER', targetEntityId: 'tree-06', reason: 'a', parameters: {} }, 'worker-01');
    let guard = 0;
    while (stepped.state.tick < 200 && guard++ < 2000) stepped.tick(0.05);
    expect(stepped.state.tick).toBe(200);
    expect(stateHash(stepped.state)).toBe(stateHash(direct.state));
    // Same 200 sim-steps delivered as 40 oversized frames (each capped at
    // 0.1s by the slow-renderer guard) plus exact top-up: identical state.
    const chunked = manualSim();
    chunked.issueDirective({ actionType: 'GATHER', targetEntityId: 'tree-06', reason: 'a', parameters: {} }, 'worker-01');
    for (let i = 0; i < 40; i += 1) chunked.tick(0.8);
    chunked.advanceUntil(() => chunked.state.tick >= direct.state.tick, 400);
    expect(chunked.state.tick).toBe(direct.state.tick);
    expect(stateHash(chunked.state)).toBe(stateHash(direct.state));
  });

  it('freezes when the loop stops calling tick (pause contract)', () => {
    const sim = manualSim();
    sim.issueDirective({ actionType: 'GATHER', targetEntityId: 'tree-06', reason: 'pause', parameters: {} }, 'worker-01');
    sim.advanceUntil(() => false, 5);
    const frozen = JSON.stringify(sim.state.entities['worker-01']);
    const tick = sim.state.tick;
    // No tick() calls: the authoritative state cannot move on its own.
    expect(JSON.stringify(sim.state.entities['worker-01'])).toBe(frozen);
    expect(sim.state.tick).toBe(tick);
  });
});
