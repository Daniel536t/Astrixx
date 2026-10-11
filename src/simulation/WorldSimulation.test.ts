import { describe, expect, it } from 'vitest';
import { WorldSimulation } from './WorldSimulation';
import { createWorld } from '../world/createWorld';
import { LocalGathererAgent } from '../agent/LocalGathererAgent';
import { ManualAgent } from '../agent/ManualAgent';
import type { WorldEventType } from '../world/types';

describe('WorldSimulation', () => {
  it('completes the visible tree → log → settlement causal loop with ordered events', () => {
    const world = createWorld();
    const simulation = new WorldSimulation(world);
    const complete = simulation.advanceUntil((state) => state.wood === 1, 1800);

    expect(complete).toBe(true);
    expect(world.wood).toBe(1);
    expect(Object.values(world.entities).some((entity) => entity.kind === 'tree' && entity.state === 'depleted')).toBe(true);
    expect(Object.values(world.entities).some((entity) => entity.kind === 'log' && entity.state === 'delivered')).toBe(true);

    const types: WorldEventType[] = world.events.map((event) => event.type);
    const sequence: WorldEventType[] = ['RESOURCE_TARGETED', 'GATHER_ACTION_STARTED', 'TREE_CHOPPED', 'RESOURCE_CREATED', 'RESOURCE_PICKED_UP', 'RESOURCE_DELIVERED', 'RESOURCE_ADDED'];
    let previous = -1;
    for (const type of sequence) {
      const index = types.indexOf(type, previous + 1);
      expect(index, `missing or out-of-order event ${type}`).toBeGreaterThan(previous);
      previous = index;
    }
    expect(world.events.every((event, index, events) => index === 0 || event.sequence > events[index - 1]!.sequence)).toBe(true);
    // With a multi-worker crew, other proposals may still be in flight when
    // the first delivery lands; the causal chain itself must be verified.
    const delivered = Object.values(world.entities).find((entity) => entity.kind === 'log' && entity.state === 'delivered');
    expect(delivered?.kind).toBe('log');
    const created = world.events.find((event) => event.type === 'RESOURCE_CREATED' && event.entityId === delivered?.id);
    const sourceTree = created?.data['sourceTreeId'] as string | undefined;
    expect(sourceTree).toBeTruthy();
    expect(world.proposals.some((proposal) => proposal.actionType === 'GATHER' && proposal.targetEntityId === sourceTree && proposal.status === 'VERIFIED')).toBe(true);
    expect(world.proposals.some((proposal) => proposal.actionType === 'DELIVER' && proposal.status === 'VERIFIED')).toBe(true);
  });

  it('completes the berry → food → settlement loop through observation, decision, proposal, and verified delivery', () => {
    const world = createWorld();
    world.food = 0; // exercise the loop from an empty stockpile
    expect(world.entities['berry-patch-01']).toMatchObject({ kind: 'berry-patch', state: 'available' });
    const agent = new LocalGathererAgent();
    const observation = agent.observe(world);
    expect(observation.berryPatches).toContainEqual(expect.objectContaining({ id: 'berry-patch-01', available: true }));
    world.wood = 1;
    const decision = agent.decide(agent.observe(world));
    expect(decision).toMatchObject({ actionType: 'HARVEST' });
    // Nearest available patch wins (world has two; the agent distance-sorts).
    const patchId = (decision as { targetEntityId: string }).targetEntityId;
    expect(observation.berryPatches.map((p) => p.id)).toContain(patchId);

    const simulation = new WorldSimulation(world);
    expect(simulation.advanceUntil((state) => state.food === 1, 2400)).toBe(true);
    expect(world.food).toBe(1);
    expect(world.entities[patchId]).toMatchObject({ kind: 'berry-patch', state: 'harvested' });
    expect(Object.values(world.entities).some((entity) => entity.kind === 'food' && entity.state === 'delivered')).toBe(true);
    expect(world.proposals.some((proposal) => proposal.actionType === 'HARVEST' && proposal.status === 'VERIFIED')).toBe(true);
    expect(world.proposals.some((proposal) => proposal.actionType === 'DELIVER' && proposal.parameters['resource'] === 'food' && proposal.status === 'VERIFIED')).toBe(true);

    const orderedFoodMilestones: Array<[string, (event: (typeof world.events)[number]) => boolean]> = [
      ['observation', (event) => event.type === 'AGENT_OBSERVED' && Array.isArray(event.data['availableBerryPatches']) && event.data['availableBerryPatches'].includes(patchId)],
      ['decision', (event) => event.type === 'AGENT_DECIDED' && event.data['actionType'] === 'HARVEST' && event.data['targetEntityId'] === patchId],
      ['proposal', (event) => event.type === 'ACTION_PROPOSED' && event.data['actionType'] === 'HARVEST' && event.data['targetEntityId'] === patchId],
      ['target', (event) => event.type === 'RESOURCE_TARGETED' && event.entityId === patchId && event.data['resource'] === 'food'],
      ['harvest started', (event) => event.type === 'GATHER_ACTION_STARTED' && event.entityId === patchId && event.data['resource'] === 'food'],
      ['patch harvested', (event) => event.type === 'BERRY_PATCH_HARVESTED' && event.entityId === patchId],
      ['food created', (event) => event.type === 'RESOURCE_CREATED' && event.entityId === 'food-01' && event.data['resource'] === 'food'],
      ['food picked up', (event) => event.type === 'RESOURCE_PICKED_UP' && event.entityId === 'food-01' && event.data['resource'] === 'food'],
      ['food delivered', (event) => event.type === 'RESOURCE_DELIVERED' && event.entityId === 'food-01' && event.data['resource'] === 'food'],
      ['food added', (event) => event.type === 'RESOURCE_ADDED' && event.data['resource'] === 'food'],
    ];
    let previous = -1;
    for (const [milestone, matches] of orderedFoodMilestones) {
      const index = world.events.findIndex((event, eventIndex) => eventIndex > previous && matches(event));
      expect(index, `missing or out-of-order food ${milestone}`).toBeGreaterThan(previous);
      previous = index;
    }
    const addEvent = world.events[previous];
    expect(addEvent?.data).toMatchObject({ resource: 'food', amount: 1, total: 1 });
    expect(world.events.every((event, index, events) => index === 0 || event.sequence > events[index - 1]!.sequence)).toBe(true);
  });

  it('does not execute high-risk proposals without explicit human approval', () => {
    const simulation = new WorldSimulation();
    const proposal = simulation.proposeAction('GATHER', 'tree-01', {}, 'HIGH');
    expect(proposal.status).toBe('PROPOSED');
    expect(simulation.approveProposal(proposal.id)).toBe(true);
    expect(proposal.status).toBe('APPROVED');
    expect(simulation.rejectProposal(proposal.id)).toBe(false);
  });

  it('generates stable initial entity identifiers and monotonically sequenced events', () => {
    const first = createWorld();
    const second = createWorld();
    expect(Object.keys(first.entities)).toEqual(Object.keys(second.entities));
    expect(first.events.map((event) => event.id)).toEqual(second.events.map((event) => event.id));
  });

  it('fells an already-depleted tree at most once: no duplicate event, no duplicate log', () => {
    const simulation = new WorldSimulation(createWorld(), new ManualAgent());
    const treeId = 'tree-04';
    const gather = { actionType: 'GATHER' as const, targetEntityId: treeId, reason: 'regression probe', parameters: {} };
    expect(simulation.advanceUntil(() => {
      const tree = simulation.state.entities[treeId];
      if (tree?.kind === 'tree' && tree.state === 'depleted') return true;
      if (simulation.directives.length === 0) simulation.issueDirective({ ...gather }, 'worker-01');
      return false;
    }, 1500)).toBe(true);
    expect(simulation.state.entities[treeId]).toMatchObject({ kind: 'tree', state: 'depleted', health: 0 });
    expect(simulation.state.events.filter((event) => event.type === 'TREE_CHOPPED' && event.entityId === treeId)).toHaveLength(1);
    expect(Object.values(simulation.state.entities).filter((entity) => entity.kind === 'log')).toHaveLength(1);

    // A second worker mid-swing on the same tree is stale: its completion
    // must clear the task without re-felling (no second event, no second log).
    // Wilderness ships one inhabitant; spawn the second worker for this race.
    simulation.state.entities['worker-02'] = { id: 'worker-02', kind: 'worker', position: { x: 1.5, z: 0.5 }, carrying: null, activity: 'idle', targetId: null, task: null, inventory: {}, capacity: 10, restedUntilTick: 0, equipment: { axe: 'basic-axe', basket: false } };
    const worker = simulation.state.entities['worker-02'];
    if (!worker || worker.kind !== 'worker') throw new Error('worker-02 missing');
    worker.task = { kind: 'chop', targetId: treeId, elapsed: 999 };
    worker.activity = 'chopping';
    simulation.advanceUntil(() => false, 5);
    expect(simulation.state.events.filter((event) => event.type === 'TREE_CHOPPED' && event.entityId === treeId)).toHaveLength(1);
    expect(Object.values(simulation.state.entities).filter((entity) => entity.kind === 'log')).toHaveLength(1);
    expect(simulation.state.entities[treeId]).toMatchObject({ kind: 'tree', state: 'depleted', health: 0 });
    expect(worker.task).toBeNull();
  });

  it('terminates a stale harvest task explicitly: failed proposal, blocked plan step, no phantom food', () => {
    // Legacy path: the authorizing proposal must reach FAILED, not leak EXECUTING.
    const legacy = new WorldSimulation(createWorld(), new ManualAgent());
    const stalePatch = legacy.state.entities['berry-patch-01'];
    if (!stalePatch || stalePatch.kind !== 'berry-patch') throw new Error('berry-patch-01 missing');
    stalePatch.state = 'harvested'; // depleted by another worker first
    const proposal = legacy.proposeAction('HARVEST', 'berry-patch-01', {}, 'LOW');
    expect(proposal.status).toBe('EXECUTING');
    const legacyWorker = legacy.state.entities['worker-01'];
    if (!legacyWorker || legacyWorker.kind !== 'worker') throw new Error('worker-01 missing');
    legacyWorker.task = { kind: 'harvest', targetId: 'berry-patch-01', elapsed: 999, proposalId: proposal.id };
    legacyWorker.activity = 'gathering';
    legacy.advanceUntil(() => false, 3);
    expect(proposal.status).toBe('FAILED');
    expect(legacyWorker.task).toBeNull();
    expect(legacyWorker.activity).toBe('idle');
    expect(Object.values(legacy.state.entities).some((entity) => entity.kind === 'food')).toBe(false);
    expect(legacy.state.events.some((event) => event.type === 'BERRY_PATCH_HARVESTED' && event.entityId === 'berry-patch-01')).toBe(false);

    // Plan path: a blocked step is recorded instead of stalling silently.
    const planned = new WorldSimulation(createWorld(), new ManualAgent());
    const plannedPatch = planned.state.entities['berry-patch-01'];
    if (!plannedPatch || plannedPatch.kind !== 'berry-patch') throw new Error('berry-patch-01 missing');
    plannedPatch.state = 'harvested';
    const { plan } = planned.submitPlan('gather-food', 1);
    expect(plan.status).toBe('active');
    const planWorker = planned.state.entities['worker-01'];
    if (!planWorker || planWorker.kind !== 'worker') throw new Error('worker-01 missing');
    planWorker.task = { kind: 'harvest', targetId: 'berry-patch-01', elapsed: 999, planId: plan.id };
    planWorker.activity = 'gathering';
    planned.advanceUntil(() => false, 3);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ actionType: 'HARVEST', status: 'blocked' });
    expect(String(plan.steps[0]?.note)).toMatch(/already harvested/);
    expect(planWorker.task).toBeNull();
    expect(Object.values(planned.state.entities).some((entity) => entity.kind === 'food')).toBe(false);
    expect(planned.state.proposals).toHaveLength(1); // only the PLAN proposal; no per-step proposal minted
  });
});

describe('action settlement', () => {
  function workerOf(sim: WorldSimulation, id: string) {
    let worker = sim.state.entities[id];
    if (!worker || worker.kind !== 'worker') {
      // Wilderness genesis ships one inhabitant; multi-worker race tests
      // spawn the extra crew they need (with real inventory/equipment).
      worker = { id, kind: 'worker', position: { x: 1.5, z: 0.5 }, carrying: null, activity: 'idle', targetId: null, task: null, inventory: {}, capacity: 10, restedUntilTick: 0, equipment: { axe: 'basic-axe', basket: false } };
      sim.state.entities[id] = worker;
    }
    if (worker.kind !== 'worker') throw new Error(`${id} missing`);
    return worker;
  }

  it('fails a stale chop legacy proposal without double-felling', () => {
    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    const tree = sim.state.entities['tree-04'];
    if (!tree || tree.kind !== 'tree') throw new Error('tree-04 missing');
    tree.health = 0;
    tree.state = 'depleted'; // felled by another worker first
    const proposal = sim.proposeAction('GATHER', 'tree-04', {}, 'LOW');
    expect(proposal.status).toBe('EXECUTING');
    const worker = workerOf(sim, 'worker-02');
    worker.task = { kind: 'chop', targetId: 'tree-04', elapsed: 999, proposalId: proposal.id };
    worker.activity = 'chopping';
    sim.advanceUntil(() => false, 3);
    expect(proposal.status).toBe('FAILED');
    expect(worker.task).toBeNull();
    expect(worker.activity).toBe('idle');
    expect(sim.state.events.filter((event) => event.type === 'TREE_CHOPPED' && event.entityId === 'tree-04')).toHaveLength(0);
    expect(Object.values(sim.state.entities).some((entity) => entity.kind === 'log')).toBe(false);
  });

  it('never re-settles a shared chop proposal the race winner already verified', () => {
    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    const gather = { actionType: 'GATHER' as const, targetEntityId: 'tree-04', reason: 'race', parameters: {} };
    expect(sim.advanceUntil(() => {
      const tree = sim.state.entities['tree-04'];
      if (tree?.kind === 'tree' && tree.state === 'depleted') return true;
      if (sim.directives.length === 0) sim.issueDirective({ ...gather }, 'worker-01');
      return false;
    }, 1500)).toBe(true);
    const winner = sim.state.proposals.find((p) => p.actionType === 'GATHER' && p.targetEntityId === 'tree-04');
    expect(winner?.status).toBe('VERIFIED');
    const worker = workerOf(sim, 'worker-02');
    worker.task = { kind: 'chop', targetId: 'tree-04', elapsed: 999, proposalId: winner!.id };
    worker.activity = 'chopping';
    sim.advanceUntil(() => false, 3);
    expect(winner!.status).toBe('VERIFIED');
    expect(worker.task).toBeNull();
    expect(sim.state.events.filter((event) => event.type === 'TREE_CHOPPED' && event.entityId === 'tree-04')).toHaveLength(1);
    expect(Object.values(sim.state.entities).filter((entity) => entity.kind === 'log')).toHaveLength(1);
  });

  it('settles a stale build attempt but protects a shared cooperative proposal', () => {
    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    const proposal = sim.proposeAction('BUILD', 'settlement-01', { structure: 'house' }, 'HIGH');
    expect(sim.approveProposal(proposal.id)).toBe(true);
    // Cooperative join in progress: worker-02 actively building a real structure.
    sim.state.entities['house-01'] = { id: 'house-01', kind: 'house', position: { x: -1.6, z: -1.4 }, state: 'construction', progress: 0.1 };
    const builder = workerOf(sim, 'worker-02');
    builder.task = { kind: 'build', targetId: 'house-01', elapsed: 0.5, proposalId: proposal.id };
    builder.activity = 'building';
    // Worker-01's build task points at a structure that no longer exists.
    const stale = workerOf(sim, 'worker-01');
    stale.task = { kind: 'build', targetId: 'house-99', elapsed: 999, proposalId: proposal.id };
    stale.activity = 'building';
    sim.advanceUntil(() => false, 3);
    expect(stale.task).toBeNull();
    expect(proposal.status).toBe('APPROVED'); // shared live proposal untouched
    expect(builder.task).not.toBeNull();
    expect(sim.state.events.some((event) => event.type === 'CONSTRUCTION_COMPLETED' && event.entityId === 'house-99')).toBe(false);
  });

  it('fails a lone stale build attempt and records plan-build blocks', () => {
    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    const proposal = sim.proposeAction('BUILD', 'settlement-01', { structure: 'house' }, 'HIGH');
    expect(sim.approveProposal(proposal.id)).toBe(true);
    const worker = workerOf(sim, 'worker-01');
    worker.task = { kind: 'build', targetId: 'house-99', elapsed: 999, proposalId: proposal.id };
    worker.activity = 'building';
    sim.advanceUntil(() => false, 3);
    expect(proposal.status).toBe('FAILED');
    expect(worker.task).toBeNull();

    const planned = new WorldSimulation(createWorld(), new ManualAgent());
    const submitted = planned.submitPlan('construct-house', 1);
    expect(planned.approveProposal(submitted.proposal.id)).toBe(true);
    expect(submitted.plan.status).toBe('active');
    const planWorker = workerOf(planned, 'worker-01');
    planWorker.task = { kind: 'build', targetId: 'house-99', elapsed: 999, planId: submitted.plan.id };
    planWorker.activity = 'building';
    planned.advanceUntil(() => false, 3);
    expect(submitted.plan.steps).toHaveLength(1);
    expect(submitted.plan.steps[0]).toMatchObject({ actionType: 'BUILD', status: 'blocked' });
    expect(planWorker.task).toBeNull();
  });

  it('frees a ghost haul and fails only its matched delivery', () => {
    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    sim.state.entities['log-99'] = { id: 'log-99', kind: 'log', position: { x: 0, z: 0 }, state: 'carried' };
    sim.state.entities['log-98'] = { id: 'log-98', kind: 'log', position: { x: 1, z: 1 }, state: 'carried' };
    const hauler = workerOf(sim, 'worker-01');
    hauler.carrying = 'log-99';
    hauler.activity = 'carrying';
    const other = workerOf(sim, 'worker-02');
    other.carrying = 'log-98';
    other.activity = 'carrying';
    const doomed = sim.proposeAction('DELIVER', 'settlement-01', { resourceId: 'log-99', resource: 'wood' });
    const live = sim.proposeAction('DELIVER', 'settlement-01', { resourceId: 'log-98', resource: 'wood' });
    expect(doomed.status).toBe('EXECUTING');
    delete sim.state.entities['log-99']; // resource vanished mid-haul
    sim.advanceUntil(() => false, 3);
    expect(doomed.status).toBe('FAILED');
    expect(live.status).toBe('EXECUTING');
    expect(hauler.carrying).toBeNull();
    expect(hauler.activity).toBe('idle');
    expect(other.carrying).toBe('log-98');
  });

  it('records a blocked plan step for a ghost plan haul without minting proposals', () => {
    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    const { plan } = sim.submitPlan('gather-wood', 1);
    expect(plan.status).toBe('active');
    const hauler = workerOf(sim, 'worker-01');
    hauler.carrying = 'log-99'; // no such entity: ghost load
    hauler.activity = 'carrying';
    hauler.deliveryPlanId = plan.id;
    sim.advanceUntil(() => false, 3);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ actionType: 'DELIVER', status: 'blocked' });
    expect(hauler.carrying).toBeNull();
    expect(hauler.deliveryPlanId).toBeUndefined();
    expect(sim.state.proposals).toHaveLength(1); // only the PLAN proposal
  });

  it('fails the matched haul when the settlement itself is gone', () => {
    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    sim.state.entities['log-99'] = { id: 'log-99', kind: 'log', position: { x: 0, z: 0 }, state: 'carried' };
    const hauler = workerOf(sim, 'worker-01');
    hauler.carrying = 'log-99';
    hauler.activity = 'carrying';
    const delivery = sim.proposeAction('DELIVER', 'settlement-01', { resourceId: 'log-99', resource: 'wood' });
    delete sim.state.entities['settlement-01'];
    sim.advanceUntil(() => false, 2);
    expect(delivery.status).toBe('FAILED');
  });

  it('settles each concurrent delivery against its own proposal', () => {
    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    // Two real pickups, back to back: DELIVER-A is minted before DELIVER-B,
    // so newest-live lookup would attribute A's delivery to B's proposal.
    sim.state.entities['log-A'] = { id: 'log-A', kind: 'log', position: { x: 1, z: 0 }, state: 'ground' };
    sim.state.entities['log-B'] = { id: 'log-B', kind: 'log', position: { x: -1, z: 0 }, state: 'ground' };
    const haulerA = workerOf(sim, 'worker-01');
    haulerA.position = { x: 1, z: 0 };
    const haulerB = workerOf(sim, 'worker-02');
    haulerB.position = { x: -1, z: 0 };
    sim.issueDirective({ actionType: 'PICK_UP', targetEntityId: 'log-A', reason: 'haul A', parameters: {} }, 'worker-01');
    sim.issueDirective({ actionType: 'PICK_UP', targetEntityId: 'log-B', reason: 'haul B', parameters: {} }, 'worker-02');
    expect(sim.advanceUntil((state) => {
      const a = state.entities['worker-01'];
      const b = state.entities['worker-02'];
      return a?.kind === 'worker' && a.carrying === 'log-A' && b?.kind === 'worker' && b.carrying === 'log-B';
    }, 20)).toBe(true);
    const deliverA = sim.state.proposals.find((p) => p.parameters['resourceId'] === 'log-A');
    const deliverB = sim.state.proposals.find((p) => p.parameters['resourceId'] === 'log-B');
    expect(deliverA?.status).toBe('EXECUTING');
    expect(deliverB?.status).toBe('EXECUTING');
    expect(haulerA.deliveryProposalId).toBe(deliverA!.id);
    expect(haulerB.deliveryProposalId).toBe(deliverB!.id);
    // A delivers first while B is still far away.
    haulerA.position = { x: 0.3, z: 0 };
    haulerB.position = { x: 5, z: 5 };
    expect(sim.advanceUntil((state) => state.events.some((e) => e.type === 'RESOURCE_DELIVERED'), 5)).toBe(true);
    expect(sim.state.events.filter((e) => e.type === 'RESOURCE_DELIVERED')).toHaveLength(1);
    expect(deliverA!.status).toBe('VERIFIED');
    expect(deliverB!.status).toBe('EXECUTING');
    expect(sim.state.wood).toBe(1);
    // B delivers next; both proposals end VERIFIED exactly once each.
    haulerB.position = { x: 0.3, z: 0 };
    expect(sim.advanceUntil((state) => state.wood === 2, 30)).toBe(true);
    expect(deliverA!.status).toBe('VERIFIED');
    expect(deliverB!.status).toBe('VERIFIED');
    const verifiedEvents = sim.state.events.filter((e) =>
      e.type === 'ACTION_STATUS_CHANGED' && e.data['status'] === 'VERIFIED'
      && (e.data['proposalId'] === deliverA!.id || e.data['proposalId'] === deliverB!.id));
    expect(verifiedEvents).toHaveLength(2);
  });

  it('closes the plan authorization record on cancel and expiry', () => {
    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    const submitted = sim.submitPlan('gather-wood', 1);
    expect(submitted.plan.status).toBe('active');
    expect(submitted.proposal.status).toBe('EXECUTING');
    expect(sim.cancelPlan(submitted.plan.id)).toBe(true);
    expect(submitted.plan.status).toBe('cancelled');
    expect(submitted.proposal.status).toBe('CANCELLED');

    const sim2 = new WorldSimulation(createWorld(), new ManualAgent());
    const submitted2 = sim2.submitPlan('gather-wood', 1);
    expect(submitted2.proposal.status).toBe('EXECUTING');
    submitted2.plan.constraints.expiresTick = -1;
    sim2.advanceUntil(() => false, 3);
    expect(submitted2.plan.status).toBe('expired');
    expect(submitted2.proposal.status).toBe('CANCELLED');
  });
});

describe('reforestation', () => {
  function workerOf(sim: WorldSimulation, id: string) {
    let worker = sim.state.entities[id];
    if (!worker || worker.kind !== 'worker') {
      // Wilderness genesis ships one inhabitant; multi-worker race tests
      // spawn the extra crew they need (with real inventory/equipment).
      worker = { id, kind: 'worker', position: { x: 1.5, z: 0.5 }, carrying: null, activity: 'idle', targetId: null, task: null, inventory: {}, capacity: 10, restedUntilTick: 0, equipment: { axe: 'basic-axe', basket: false } };
      sim.state.entities[id] = worker;
    }
    if (worker.kind !== 'worker') throw new Error(`${id} missing`);
    return worker;
  }

  it('plants a sapling on a stump and matures it into standing timber', () => {
    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    const tree = sim.state.entities['tree-04'];
    if (!tree || tree.kind !== 'tree') throw new Error('tree-04 missing');
    tree.health = 0;
    tree.state = 'depleted';
    const proposal = sim.proposeAction('PLANT', 'tree-04', {}, 'LOW');
    expect(proposal.status).toBe('EXECUTING');
    const worker = workerOf(sim, 'worker-01');
    worker.position = { ...tree.position };
    sim.issueDirective({ actionType: 'PLANT', targetEntityId: 'tree-04', reason: 'replant', parameters: {} }, 'worker-01');
    expect(sim.advanceUntil((state) => {
      const t = state.entities['tree-04'];
      return t?.kind === 'tree' && t.state === 'sapling';
    }, 1500)).toBe(true);
    expect(tree).toMatchObject({ state: 'sapling', health: 1 });
    expect(sim.state.events.some((e) => e.type === 'TREE_PLANTED' && e.entityId === 'tree-04')).toBe(true);
    expect(proposal.status).toBe('VERIFIED');
    // Saplings are not standing timber and not stumps: a second planting
    // attempt fails terminally instead of stacking.
    const second = sim.proposeAction('PLANT', 'tree-04', {}, 'LOW');
    sim.issueDirective({ actionType: 'PLANT', targetEntityId: 'tree-04', reason: 'double plant', parameters: {} }, 'worker-01');
    sim.advanceUntil(() => false, 30);
    expect(second.status).toBe('FAILED');
    expect(tree.state).toBe('sapling');
    // Maturity restores full health timber that chops normally.
    expect(sim.advanceUntil((state) => {
      const t = state.entities['tree-04'];
      return t?.kind === 'tree' && t.state === 'standing';
    }, 4000)).toBe(true);
    expect(tree).toMatchObject({ state: 'standing', health: 2 });
    expect(sim.state.events.some((e) => e.type === 'TREE_MATURED' && e.entityId === 'tree-04')).toBe(true);
  });

  it('rejects planting on standing timber and keeps authority reads sapling-safe', () => {    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    // Standing timber is not a planting site: the attempt fails terminally.
    const bad = sim.proposeAction('PLANT', 'tree-01', {}, 'LOW');
    const worker = workerOf(sim, 'worker-01');
    const standing = sim.state.entities['tree-01'];
    if (!standing || standing.kind !== 'tree') throw new Error('tree-01 missing');
    worker.position = { ...standing.position };
    sim.issueDirective({ actionType: 'PLANT', targetEntityId: 'tree-01', reason: 'bad site', parameters: {} }, 'worker-01');
    sim.advanceUntil(() => false, 30);
    expect(bad.status).toBe('FAILED');
    const tree = sim.state.entities['tree-01'];
    expect(tree).toMatchObject({ kind: 'tree', state: 'standing' });
    // A matching authority read preserves a sapling instead of flipping it.
    const sapling = sim.state.entities['tree-02'];
    if (!sapling || sapling.kind !== 'tree') throw new Error('tree-02 missing');
    sapling.health = 1;
    sapling.state = 'sapling';
    expect(sim.reconcileTreeFromAuthority('tree-02', 1, true, 'replay-test')).toBe(true);
    expect(sapling).toMatchObject({ state: 'sapling', health: 1 });
  });
});

describe('water loop', () => {
  function workerOf(sim: WorldSimulation, id: string) {
    let worker = sim.state.entities[id];
    if (!worker || worker.kind !== 'worker') {
      // Wilderness genesis ships one inhabitant; multi-worker race tests
      // spawn the extra crew they need (with real inventory/equipment).
      worker = { id, kind: 'worker', position: { x: 1.5, z: 0.5 }, carrying: null, activity: 'idle', targetId: null, task: null, inventory: {}, capacity: 10, restedUntilTick: 0, equipment: { axe: 'basic-axe', basket: false } };
      sim.state.entities[id] = worker;
    }
    if (worker.kind !== 'worker') throw new Error(`${id} missing`);
    return worker;
  }

  it('draws, hauls, and delivers water through the governed loop', () => {
    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    expect(sim.state.water).toBe(1);
    const proposal = sim.proposeAction('HARVEST', 'pond-01', {}, 'LOW');
    expect(proposal.status).toBe('EXECUTING');
    const worker = workerOf(sim, 'worker-01');
    const pond = sim.state.entities['pond-01'];
    if (!pond) throw new Error('pond-01 missing');
    worker.position = { x: pond.position.x, z: pond.position.z + 0.5 };
    sim.issueDirective({ actionType: 'HARVEST', targetEntityId: 'pond-01', reason: 'fetch water', parameters: {} }, 'worker-01');
    expect(sim.advanceUntil(() => proposal.status === 'VERIFIED', 1500)).toBe(true);
    const created = sim.state.events.find((e) => e.type === 'RESOURCE_CREATED' && e.data['resource'] === 'water');
    expect(created?.data['sourceWellId']).toBe('pond-01');
    expect(sim.state.events.some((e) => e.type === 'WATER_DRAWN' && e.entityId === 'pond-01')).toBe(true);
    // Haul the filled waterskin home through the standard carry branch.
    sim.issueDirective({ actionType: 'PICK_UP', targetEntityId: created!.entityId!, reason: 'haul water', parameters: {} }, 'worker-01');
    expect(sim.advanceUntil((state) => state.water === 2, 1500)).toBe(true);
    // The pond never depletes: drawing again is still legal.
    expect(sim.proposeAction('HARVEST', 'pond-01', {}, 'LOW').status).toBe('EXECUTING');
  });

  it('consumes water and reports thirst without fatalities', () => {
    const sim = new WorldSimulation(createWorld(), new ManualAgent());
    sim.state.water = 1;
    sim.advanceUntil(() => false, 1200);
    expect(sim.state.water).toBe(0);
    expect(sim.state.events.some((e) => e.type === 'WATER_LOW')).toBe(true);
    expect(sim.state.events.some((e) => e.type === 'POPULATION_THIRSTY')).toBe(true);
    expect(Object.values(sim.state.entities).filter((e) => e.kind === 'worker')).toHaveLength(1);
  });
});
