import { describe, expect, it } from 'vitest';
import {
  buildDecisionPrompt,
  parseStructuredDecision,
  validateDecisionAgainstWorld,
} from './DecisionSchema';
import { createWorld } from '../../world/createWorld';
import type { AgentObservation } from '../Agent';

const OBS: AgentObservation = {
  tick: 0, wood: 0, food: 0, water: 0,
  worker: { id: 'worker-01', x: 2.4, z: -1.0, carrying: null },
  workers: [{ id: 'worker-01', x: 2.4, z: -1.0, carrying: null, activity: 'idle' }],
  claimedTargetIds: [],
  settlement: { id: 'settlement-01', x: 0, z: 0 },
  trees: [{ id: 'tree-01', x: -4.7, z: -2.6, available: true }],
  logs: [], berryPatches: [], farms: [], foodResources: [],
  branches: [], stones: [], shelters: [], houses: [],
  inventory: {}, equipment: { axe: 'basic-axe', basket: false }, capacity: 10,
};

describe('parseStructuredDecision', () => {
  it('parses a plain JSON decision', () => {
    const parsed = parseStructuredDecision(
      '{"action": {"actionType": "GATHER", "targetEntityId": "tree-01"}, "intent": "Get wood", "expectation": "A log appears"}',
    );
    expect(parsed).toMatchObject({ action: { actionType: 'GATHER', targetEntityId: 'tree-01' }, intent: 'Get wood' });
  });

  it('extracts JSON from fenced code blocks', () => {
    const parsed = parseStructuredDecision(
      'Here is my move:\n```json\n{"action": null, "intent": "Wait", "expectation": "Nothing changes"}\n```',
    );
    expect(parsed).toMatchObject({ action: null, intent: 'Wait' });
  });

  it('rejects prose, malformed JSON, and missing fields', () => {
    expect(parseStructuredDecision('I will chop the tree now')).toBeNull();
    expect(parseStructuredDecision('{"action": {"actionType": "GATHER"')).toBeNull();
    expect(parseStructuredDecision('{"action": null, "intent": "x"}')).toBeNull();
    expect(parseStructuredDecision('{"action": {"actionType": 42, "targetEntityId": "t"}, "intent": "x", "expectation": "y"}')).toBeNull();
  });
});

describe('validateDecisionAgainstWorld', () => {
  it('accepts a legal gather and an explicit no-op', () => {
    const world = createWorld();
    expect(
      validateDecisionAgainstWorld(
        { action: { actionType: 'GATHER', targetEntityId: 'tree-01' }, intent: 'i', expectation: 'e' },
        world,
      ).ok,
    ).toBe(true);
    expect(validateDecisionAgainstWorld({ action: null, intent: 'i', expectation: 'e' }, world).ok).toBe(true);
  });

  it('rejects unknown actions, targets, illegal states, and forbidden parameters', () => {
    const world = createWorld();
    expect(
      validateDecisionAgainstWorld(
        { action: { actionType: 'BUILD_HOUSE' as never, targetEntityId: 'tree-01' }, intent: 'i', expectation: 'e' },
        world,
      ),
    ).toMatchObject({ ok: false, reason: 'unknown-action' });
    expect(
      validateDecisionAgainstWorld(
        { action: { actionType: 'GATHER', targetEntityId: 'tree-99' }, intent: 'i', expectation: 'e' },
        world,
      ),
    ).toMatchObject({ ok: false, reason: 'unknown-target' });
    expect(
      validateDecisionAgainstWorld(
        { action: { actionType: 'GATHER', targetEntityId: 'settlement-01' }, intent: 'i', expectation: 'e' },
        world,
      ),
    ).toMatchObject({ ok: false, reason: 'illegal-target-state' });
    expect(
      validateDecisionAgainstWorld(
        { action: { actionType: 'GATHER', targetEntityId: 'tree-01', parameters: { execution: 'magicblock-er' } }, intent: 'i', expectation: 'e' },
        world,
      ),
    ).toMatchObject({ ok: false, reason: 'forbidden-parameter' });
  });

  it('rejects gathering an already-depleted tree', () => {
    const world = createWorld();
    const tree = world.entities['tree-01'];
    if (tree?.kind === 'tree') { tree.health = 0; tree.state = 'depleted'; }
    expect(
      validateDecisionAgainstWorld(
        { action: { actionType: 'GATHER', targetEntityId: 'tree-01' }, intent: 'i', expectation: 'e' },
        world,
      ),
    ).toMatchObject({ ok: false, reason: 'illegal-target-state' });
  });

  it('allows planting only on depleted stumps', () => {
    const world = createWorld();
    const stump = world.entities['tree-01'];
    if (stump?.kind === 'tree') { stump.health = 0; stump.state = 'depleted'; }
    expect(
      validateDecisionAgainstWorld(
        { action: { actionType: 'PLANT', targetEntityId: 'tree-01' }, intent: 'i', expectation: 'e' },
        world,
      ),
    ).toMatchObject({ ok: true });
    expect(
      validateDecisionAgainstWorld(
        { action: { actionType: 'PLANT', targetEntityId: 'tree-04' }, intent: 'i', expectation: 'e' },
        world,
      ),
    ).toMatchObject({ ok: false, reason: 'illegal-target-state' });
  });

  it('allows drawing water from the wilderness pond (and a built well)', () => {
    const world = createWorld();
    expect(
      validateDecisionAgainstWorld(
        { action: { actionType: 'HARVEST', targetEntityId: 'pond-01' }, intent: 'i', expectation: 'e' },
        world,
      ),
    ).toMatchObject({ ok: true });
    world.entities['well-01'] = { id: 'well-01', kind: 'well', position: { x: -1.9, z: -2.9 } };
    expect(
      validateDecisionAgainstWorld(
        { action: { actionType: 'HARVEST', targetEntityId: 'well-01' }, intent: 'i', expectation: 'e' },
        world,
      ),
    ).toMatchObject({ ok: true });
    expect(
      validateDecisionAgainstWorld(
        { action: { actionType: 'PICK_UP', targetEntityId: 'well-01' }, intent: 'i', expectation: 'e' },
        world,
      ),
    ).toMatchObject({ ok: false, reason: 'illegal-target-state' });
    world.entities['water-01'] = { id: 'water-01', kind: 'water', position: { x: 0, z: 0 }, state: 'ground' };
    expect(
      validateDecisionAgainstWorld(
        { action: { actionType: 'PICK_UP', targetEntityId: 'water-01' }, intent: 'i', expectation: 'e' },
        world,
      ),
    ).toMatchObject({ ok: true });
  });
});

describe('buildDecisionPrompt', () => {
  it('grounds the prompt in the supplied observation only', () => {
    const prompt = buildDecisionPrompt(OBS, 'Secure wood first', ['t1: verified proposal-0001']);
    expect(prompt).toContain('wood=0');
    expect(prompt).toContain('tree-01');
    expect(prompt).toContain('Secure wood first');
    expect(prompt).not.toContain('granary');
    expect(prompt).not.toContain('NVIDIA_NIM_API_KEY');
  });
});
