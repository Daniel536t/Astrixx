/**
 * Phase 6 placement authority: player-directed houses use blueprint
 * footprints, exact requests never relocate, approximate requests record
 * deviations, multi-site goals place distinct structures, and refusals
 * spend nothing. Everything here is local simulation (no chain claims).
 */
import { describe, expect, it } from 'vitest';
import { WorldSimulation } from './WorldSimulation';
import { createWorld } from '../world/createWorld';
import { ManualAgent } from '../agent/ManualAgent';
import { GoalTracker, parseCommand, isGoalComplete } from '../game/goals';
import { GoalRunner, plannerDecide } from '../game/runner';
import { replayLog, stateHash } from './replay';
import { claimSites, parsePlaceIntent, resolvePlaceSites, validatePlaceIntent } from '../game/placement';
import { validateSite } from '../game/shelter';
import { assessGoal } from '../game/capabilities';
import { validateInterpretedGoal } from '../game/interpret';
import { validateDecisionAgainstWorld } from '../agent/nvidia/DecisionSchema';

function manualSim() {
  return new WorldSimulation(createWorld(), new ManualAgent());
}

function workerOf(sim: WorldSimulation, id = 'worker-01') {
  const worker = sim.state.entities[id];
  if (!worker || worker.kind !== 'worker') throw new Error(`${id} missing`);
  return worker;
}

function directBuild(sim: WorldSimulation, parameters: Record<string, unknown>) {
  const proposal = sim.proposeAction('BUILD', 'settlement-01', { ...parameters }, 'HIGH');
  expect(sim.approveProposal(proposal.id)).toBe(true);
  sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'phase6', parameters: { ...parameters } }, 'worker-01');
  return proposal;
}

const houses = (sim: WorldSimulation) => Object.values(sim.state.entities).filter((e) => e.kind === 'house');

describe('player-directed house placement', () => {
  it('builds an exact-coordinate cabin exactly where requested, paying on arrival', () => {
    const sim = manualSim();
    sim.state.wood = 4;
    const proposal = directBuild(sim, { structure: 'house', blueprint: 'timber-cabin', x: -6, z: 0, exact: true });
    sim.advanceUntil(() => false, 5);
    expect(sim.state.wood).toBe(4); // still walking: nothing spent yet
    expect(sim.advanceUntil(() => proposal.status === 'VERIFIED', 3000)).toBe(true);
    expect(sim.state.wood).toBe(0);
    const [cabin] = houses(sim);
    expect(cabin).toMatchObject({ blueprint: 'timber-cabin', state: 'complete', position: { x: -6, z: 0 }, footprint: 1.4 });
    const started = sim.state.events.find((e) => e.type === 'CONSTRUCTION_STARTED');
    expect(started?.data).toMatchObject({ structureType: 'house', blueprint: 'timber-cabin', exact: true, site: { x: -6, z: 0 } });
    expect(started?.data['deviation']).toBeUndefined();
  });

  it.each([
    ['inside the camp', 0, 0],
    ['outside the clearing', 45, -20],
    ['on a tree', 3.4, -1.2],
  ])('refuses an exact site %s without spending or relocating', (_label, x, z) => {
    const sim = manualSim();
    sim.state.wood = 4;
    workerOf(sim).inventory = { branch: 2 };
    const proposal = directBuild(sim, { structure: 'house', blueprint: 'thatched-cottage', x, z, exact: true });
    sim.advanceUntil(() => proposal.status === 'FAILED', 400);
    expect(proposal.status).toBe('FAILED');
    const failed = sim.state.events.find((e) => e.type === 'CONSTRUCTION_FAILED');
    expect(failed?.data).toMatchObject({ reason: 'invalid-placement', exact: true, blueprint: 'thatched-cottage' });
    expect(sim.state.wood).toBe(4);
    expect(workerOf(sim).inventory).toMatchObject({ branch: 2 });
    expect(houses(sim)).toHaveLength(0);
  });

  it('refuses the pond for an exact site', () => {
    const sim = manualSim();
    const pond = sim.state.entities['pond-01'];
    if (!pond || pond.kind !== 'pond') throw new Error('pond missing');
    sim.state.wood = 2;
    const proposal = directBuild(sim, { structure: 'house', x: pond.position.x, z: pond.position.z, exact: true });
    sim.advanceUntil(() => proposal.status === 'FAILED', 400);
    expect(proposal.status).toBe('FAILED');
    expect(sim.state.events.find((e) => e.type === 'CONSTRUCTION_FAILED')?.data['siteReason']).toMatch(/water/);
    expect(sim.state.wood).toBe(2);
  });

  it('shifts an approximate request within tolerance and records requested vs chosen', () => {
    const sim = manualSim();
    sim.state.wood = 2;
    const proposal = directBuild(sim, { structure: 'house', x: 3.4, z: -1.2 }); // overlaps tree-01
    expect(sim.advanceUntil(() => proposal.status === 'VERIFIED', 3000)).toBe(true);
    const deviation = proposal.parameters['deviation'] as { requested: { x: number; z: number }; chosen: { x: number; z: number } };
    expect(deviation.requested).toEqual({ x: 3.4, z: -1.2 });
    const [house] = houses(sim);
    expect(house?.position).toEqual(deviation.chosen);
    expect(Math.hypot(deviation.chosen.x - 3.4, deviation.chosen.z + 1.2)).toBeLessThanOrEqual(3.0001);
    expect(sim.state.events.find((e) => e.type === 'CONSTRUCTION_STARTED')?.data['deviation']).toEqual(deviation);
  });

  it('fails an unknown blueprint at a valid site without spending', () => {
    const sim = manualSim();
    sim.state.wood = 9;
    const proposal = directBuild(sim, { structure: 'house', blueprint: 'castle', x: -6, z: 0, exact: true });
    sim.advanceUntil(() => proposal.status === 'FAILED', 200);
    expect(proposal.status).toBe('FAILED');
    expect(sim.state.events.some((e) => e.type === 'CONSTRUCTION_FAILED' && e.data['reason'] === 'unknown-blueprint')).toBe(true);
    expect(sim.state.wood).toBe(9);
  });

  it('emits frame and walls stages for houses, like shelters', () => {
    const sim = manualSim();
    sim.state.wood = 4;
    const proposal = directBuild(sim, { structure: 'house', blueprint: 'timber-cabin', x: -6, z: 0, exact: true });
    expect(sim.advanceUntil(() => proposal.status === 'VERIFIED', 3000)).toBe(true);
    const stages = sim.state.events.filter((e) => e.type === 'CONSTRUCTION_STAGE').map((e) => e.data['stage']);
    expect(stages).toEqual(['frame', 'walls']);
  });

  it('does not consume an automatic plot, and plot houses avoid free-placed ones', () => {
    const sim = manualSim();
    sim.state.wood = 2 * 4;
    const free = directBuild(sim, { structure: 'house', x: -6, z: 0, exact: true });
    expect(sim.advanceUntil(() => free.status === 'VERIFIED', 3000)).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      const plot = directBuild(sim, { structure: 'house' });
      expect(sim.advanceUntil(() => plot.status === 'VERIFIED' || plot.status === 'FAILED', 3000)).toBe(true);
    }
    const all = houses(sim);
    expect(new Set(all.map((h) => h.id)).size).toBe(all.length);
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const a of all) for (const b of all) {
      if (a.id < b.id) expect(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z)).toBeGreaterThan(1.5);
    }
  });

  it('decision validator applies exact vs approximate rules for house sites', () => {
    const state = createWorld();
    state.wood = 4;
    const check = (parameters: Record<string, unknown>) => validateDecisionAgainstWorld({ action: { actionType: 'BUILD', targetEntityId: 'settlement-01', parameters }, intent: 'x', expectation: 'y' }, state).ok;
    expect(check({ structure: 'house', x: 0, z: 0, exact: true })).toBe(false);
    expect(check({ structure: 'house', x: -6, z: 0, exact: true })).toBe(true);
    expect(check({ structure: 'house', x: 3.4, z: -1.2 })).toBe(true); // tolerance finds ground
    expect(check({ structure: 'house', x: 3.4, z: -1.2, exact: true })).toBe(false);
  });

  it('validator lets the builder re-drive its own exact site (worker adjacent, structure underway)', () => {
    const state = createWorld();
    state.wood = 4;
    const check = () => validateDecisionAgainstWorld({ action: { actionType: 'BUILD', targetEntityId: 'settlement-01', parameters: { structure: 'house', blueprint: 'timber-cabin', x: -6, z: 0, exact: true } }, intent: 'x', expectation: 'y' }, state).ok;
    const worker = state.entities['worker-01'];
    if (worker?.kind !== 'worker') throw new Error('worker missing');
    worker.position = { x: -4.8, z: 0.1 };
    expect(check()).toBe(true);
    state.entities['house-01'] = { id: 'house-01', kind: 'house', position: { x: -6, z: 0 }, state: 'construction', progress: 0.2, blueprint: 'timber-cabin', footprint: 1.4 };
    expect(check()).toBe(true);
    state.entities['house-01'].state = 'complete';
    expect(check()).toBe(false);
  });

  it('replays free-placed construction to the same state hash', () => {
    // Wood is part of genesis (direct state edits after construction are not logged inputs).
    const world = createWorld();
    world.wood = 4;
    const live = new WorldSimulation(world, new ManualAgent());
    const p = directBuild(live, { structure: 'house', blueprint: 'timber-cabin', x: 3.4, z: -1.2 });
    expect(live.advanceUntil(() => p.status === 'VERIFIED', 3000)).toBe(true);
    const replayed = replayLog(live.exportLog());
    expect(replayed.finalHash).toBe(stateHash(live.state));
  });
});

describe('multi-structure placement', () => {
  it('parses a row along the northern edge as one goal with three sites', () => {
    const parsed = parseCommand('build three houses along the northern edge of the clearing');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('should parse');
    expect(parsed.goal).toMatchObject({ kind: 'construct-house', quantity: 3, place: { kind: 'edge', dir: 'north' } });
    const sites = resolvePlaceSites(createWorld(), parsed.goal.place!, 3, { x: 0, z: 0 }, 1.2);
    if (!sites.ok) throw new Error(sites.clarify);
    expect(sites.sites).toHaveLength(3);
    for (const s of sites.sites) expect(s.z).toBeCloseTo(-7, 5); // north edge = -Z
    expect(new Set(sites.sites.map((s) => s.x)).size).toBe(3);
  });

  it('refuses multiple structures on one exact coordinate', () => {
    const result = resolvePlaceSites(createWorld(), { kind: 'exact', x: -6, z: 0 }, 2, { x: 0, z: 0 }, 1.2);
    expect(result.ok).toBe(false);
  });

  it('claims each site with at most one structure', () => {
    const claims = claimSites([{ x: 0, z: 0 }, { x: 4, z: 0 }], [{ x: 0.2, z: 0 }], 3);
    expect(claims[0]).toEqual({ x: 0.2, z: 0 });
    expect(claims[1]).toBeNull();
  });

  it('runs a two-site homestead goal through the governed planner without double spending', async () => {
    const sim = new WorldSimulation(createWorld());
    const tracker = new GoalTracker();
    const runner = new GoalRunner(sim, tracker, 'delegated');
    const sitesResult = resolvePlaceSites(sim.state, { kind: 'relative', from: { kind: 'camp' }, dir: 'west', dist: 'far' }, 2, { x: 0, z: 0 }, 1.2);
    if (!sitesResult.ok) throw new Error(sitesResult.clarify);
    tracker.setGoal({ kind: 'construct-house', quantity: 2, blueprint: 'homestead', sites: sitesResult.sites, note: 'two west' }, 0);
    let guard = 0;
    while (tracker.active && guard++ < 80) {
      await runner.runTurn(plannerDecide);
      for (const plan of Object.values(sim.state.plans)) {
        const proposal = plan.proposalId ? sim.state.proposals.find((p) => p.id === plan.proposalId) : undefined;
        if (proposal?.status === 'PROPOSED') sim.approveProposal(proposal.id);
      }
    }
    expect(tracker.active).toBeNull();
    const built = houses(sim).filter((h) => h.state === 'complete');
    expect(built).toHaveLength(2);
    const spent = sim.state.events.filter((e) => e.type === 'CONSTRUCTION_STARTED').reduce((sum, e) => sum + Number(e.data['woodSpent'] ?? 0), 0);
    expect(spent).toBe(4);
    expect(claimSites(sitesResult.sites, built.map((h) => h.position), 3).every((c) => c !== null)).toBe(true);
  });

  it('multi-site completion ignores pre-existing houses elsewhere', () => {
    const state = createWorld();
    state.entities['house-01'] = { id: 'house-01', kind: 'house', position: { x: 3.6, z: -1.2 }, state: 'complete', progress: 1 };
    const goal = { id: 'g', status: 'active' as const, createdAt: 0, kind: 'construct-house' as const, quantity: 1, blueprint: 'homestead', sites: [{ x: -6, z: 0 }], note: '' };
    expect(isGoalComplete(goal, state)).toBe(false);
  });
});

describe('construction cancellation', () => {
  it('cancelling a governed house plan mid-build strands no proposal or worker', async () => {
    const sim = new WorldSimulation(createWorld());
    sim.state.wood = 4;
    const tracker = new GoalTracker();
    const runner = new GoalRunner(sim, tracker, 'delegated');
    tracker.setGoal({ kind: 'construct-house', quantity: 1, blueprint: 'timber-cabin', site: { x: -6, z: 0 }, exactSite: true, note: 'cancel me' }, 0);
    let guard = 0;
    // Short turns (few sim steps each) so the build is still underway when cancelled.
    while (guard++ < 400 && !houses(sim).some((h) => h.state === 'construction')) {
      await runner.runTurn(plannerDecide, 5);
      for (const proposal of sim.state.proposals) if (proposal.status === 'PROPOSED') sim.approveProposal(proposal.id);
    }
    expect(houses(sim).some((h) => h.state === 'construction')).toBe(true);
    const plan = Object.values(sim.state.plans).find((p) => p.status === 'active');
    expect(plan).toBeDefined();
    expect(sim.cancelPlan(plan!.id)).toBe(true);
    tracker.cancel();
    sim.clearDirectives();
    sim.advanceUntil(() => false, 10);
    expect(sim.state.plans[plan!.id]?.status).toBe('cancelled');
    expect(sim.state.proposals.filter((p) => p.status === 'EXECUTING' || p.status === 'APPROVED' || p.status === 'PROPOSED')).toHaveLength(0);
    expect(workerOf(sim).task).toBeNull();
    expect(sim.state.wood).toBe(0); // paid once at start; never refunded or re-spent
  });
});

describe('capability status and model place schema', () => {
  it('distinguishes invalid location, missing prerequisites, unavailability, governance refusal, and availability', () => {
    const state = createWorld();
    state.wood = 4;
    const base = { quantity: 1, note: '' };
    expect(assessGoal({ ...base, kind: 'construct-house', blueprint: 'timber-cabin', site: { x: 0, z: 0 }, exactSite: true }, state).status).toBe('invalid-location');
    expect(assessGoal({ ...base, kind: 'construct-house', blueprint: 'timber-cabin', site: { x: -6, z: 0 }, exactSite: true }, state).status).toBe('available');
    const worker = state.entities['worker-01'];
    if (worker?.kind === 'worker') worker.equipment.axe = null;
    expect(assessGoal({ ...base, kind: 'craft', recipe: 'stone-axe' }, state).status).toBe('missing-prerequisites');
    for (const e of Object.values(state.entities)) if (e.kind === 'tree') e.state = 'depleted';
    state.wood = 0;
    expect(assessGoal({ ...base, kind: 'construct-house', blueprint: 'homestead' }, state).status).toBe('temporarily-unavailable');
    state.leases['farm-01'] = { entityId: 'farm-01', holder: 'er', epoch: 1, nonceFloor: 0, lastVerifiedSlot: null, stale: false };
    expect(assessGoal({ ...base, kind: 'construct-farm' }, state).status).toBe('forbidden');
  });

  it('asks for a location once automatic house plots run out', () => {
    const state = createWorld();
    state.wood = 10;
    expect(assessGoal({ kind: 'construct-house', quantity: 3, blueprint: 'homestead', note: '' }, state).status).toBe('available');
    expect(assessGoal({ kind: 'construct-house', quantity: 3, blueprint: 'homestead', note: '' , sites: [{ x: 0, z: -7 }, { x: 3, z: -7 }, { x: -3, z: -7 }] }, state).status).toBe('available');
    state.entities['house-01'] = { id: 'house-01', kind: 'house', position: { x: 3.6, z: -1.2 }, state: 'complete', progress: 1 };
    expect(assessGoal({ kind: 'construct-house', quantity: 3, blueprint: 'homestead', note: '' }, state).status).toBe('missing-prerequisites');
  });

  it('validates model-supplied place intents and rejects malformed ones', () => {
    expect(validatePlaceIntent({ kind: 'relative', from: { kind: 'camp' }, dir: 'east', dist: 'far' })).toEqual({ kind: 'relative', from: { kind: 'camp' }, dir: 'east', dist: 'far' });
    expect(validatePlaceIntent({ kind: 'exact', x: 'ten', z: 0 })).toBeNull();
    expect(validatePlaceIntent({ kind: 'relative', from: { kind: 'castle' }, dir: 'east', dist: 'far' })).toBeNull();
    expect(validateInterpretedGoal({ kind: 'construct-house', quantity: 1, blueprint: 'thatched-cottage', place: { kind: 'edge', dir: 'north' }, note: 'row' })?.place).toEqual({ kind: 'edge', dir: 'north' });
    expect(validateInterpretedGoal({ kind: 'gather-wood', quantity: 2, place: { kind: 'edge', dir: 'north' }, note: 'no' })).toBeNull();
    expect(validateInterpretedGoal({ kind: 'construct-house', quantity: 1, place: { kind: 'teleport' }, note: 'no' })).toBeNull();
  });

  it('never reads coordinates as a quantity', () => {
    for (const text of ['build a timber cabin at X: -6, Z: 0', 'build a house at x 45 z -20', 'build a cottage at (4, -2)']) {
      const parsed = parseCommand(text);
      expect(parsed.ok && parsed.goal.quantity).toBe(1);
    }
    const two = parseCommand('build 2 shelters near the pond');
    expect(two.ok && two.goal.quantity).toBe(2);
  });

  it('parses plural designs and edge intents', () => {
    expect(parsePlaceIntent('along the eastern edge').intent).toEqual({ kind: 'edge', dir: 'east' });
    const cabins = parseCommand('build two cabins far east of the camp');
    expect(cabins.ok && cabins.goal).toMatchObject({ kind: 'construct-house', blueprint: 'timber-cabin', quantity: 2 });
    const cottages = parseCommand('build 2 cottages near the pond');
    expect(cottages.ok && cottages.goal).toMatchObject({ blueprint: 'thatched-cottage', quantity: 2, place: { kind: 'near', entity: { kind: 'pond' } } });
  });

  it('distinct residential footprints change what fits', () => {
    const state = createWorld();
    // A spot that fits a homestead-sized footprint but not the wide cottage.
    let found: { x: number; z: number } | null = null;
    for (let x = -8; x <= 8 && !found; x += 0.5) for (let z = -8; z <= 8 && !found; z += 0.5) {
      if (validateSite(state, x, z, 1.2).ok && !validateSite(state, x, z, 1.6).ok) found = { x, z };
    }
    expect(found).not.toBeNull();
  });
});
