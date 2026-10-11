import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  anchorInstructionDiscriminator,
  createAnchorInstruction,
  DELEGATE_BUFFER_SEED,
  DELEGATION_METADATA_SEED,
  DELEGATION_RECORD_SEED,
  decodeTreeState,
  deriveTreeAddress,
  LocalWorldStateAdapter,
  TREE_ACCOUNT_DISCRIMINATOR,
} from './MagicBlockAdapter';
import { WorldSimulation } from '../simulation/WorldSimulation';

describe('MagicBlock adapter primitives', () => {
  it('matches Anchor instruction/account discriminators and derives stable tree PDA', async () => {
    expect(Buffer.from(await anchorInstructionDiscriminator('chop_tree')).toString('hex')).toBe('7838c45bd5b6241c');
    expect(Buffer.from(await anchorInstructionDiscriminator('delegate_tree')).toString('hex')).toBe('a1b647579021e1c6');
    expect(Buffer.from(await anchorInstructionDiscriminator('commit_tree')).toString('hex')).toBe('9630cda874279387');
    expect(Buffer.from(await anchorInstructionDiscriminator('commit_and_undelegate_tree')).toString('hex')).toBe('8cf41bda4a138661');
    expect(Buffer.from(TREE_ACCOUNT_DISCRIMINATOR).toString('hex')).toBe('fba3f032a5d9c164');
    const programId = new PublicKey('Gd5DXjcDxr1jJFS2LBzoLkZvYsHZWhVwbYdQ7eZEKSdP');
    const [tree, bump] = deriveTreeAddress(programId);
    expect(PublicKey.findProgramAddressSync([Buffer.from('tree'), Buffer.from('astrix-v1'), Buffer.from('tree-01')], programId)).toEqual([tree, bump]);
    expect(Buffer.from(DELEGATE_BUFFER_SEED).toString()).toBe('buffer');
    expect(Buffer.from(DELEGATION_RECORD_SEED).toString()).toBe('delegation');
    expect(Buffer.from(DELEGATION_METADATA_SEED).toString()).toBe('delegation-metadata');

    const ix = await createAnchorInstruction(programId, 'chop_tree', [{ pubkey: tree, isSigner: false, isWritable: true }], new Uint8Array([7]));
    expect(ix.programId.equals(programId)).toBe(true);
    expect(ix.keys).toHaveLength(1);
    expect(ix.data.subarray(0, 8).toString('hex')).toBe('7838c45bd5b6241c');
    expect(ix.data[8]).toBe(7);
  });

  it('encodes fixed Anchor argument widths and preserves tree account invariants', async () => {
    const tree = new PublicKey('11111111111111111111111111111111');
    const owner = new PublicKey('Vote111111111111111111111111111111111111111');
    const actionId = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));
    const args = new Uint8Array(40);
    new DataView(args.buffer).setBigUint64(0, 0x0102030405060708n, true);
    args.set(actionId, 8);
    const ix = await createAnchorInstruction(
      new PublicKey('Gd5DXjcDxr1jJFS2LBzoLkZvYsHZWhVwbYdQ7eZEKSdP'),
      'chop_tree',
      [{ pubkey: tree, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }],
      args,
    );
    expect(ix.data).toHaveLength(48);
    expect(ix.data.readBigUInt64LE(8)).toBe(0x0102030405060708n);
    expect(ix.data.subarray(16)).toEqual(Buffer.from(actionId));
    expect(ix.keys.map(({ isSigner }) => isSigner)).toEqual([false, true]);
  });

  it('derives delegation PDAs using the same official SDK seeds', async () => {
    const { delegateBufferPdaFromDelegatedAccountAndOwnerProgram, delegationRecordPdaFromDelegatedAccount, delegationMetadataPdaFromDelegatedAccount, DELEGATION_PROGRAM_ID } = await import('@magicblock-labs/ephemeral-rollups-sdk');
    const programId = new PublicKey('Gd5DXjcDxr1jJFS2LBzoLkZvYsHZWhVwbYdQ7eZEKSdP');
    const [tree] = deriveTreeAddress(programId);
    const [buffer] = PublicKey.findProgramAddressSync([DELEGATE_BUFFER_SEED, tree.toBytes()], programId);
    const [record] = PublicKey.findProgramAddressSync([DELEGATION_RECORD_SEED, tree.toBytes()], DELEGATION_PROGRAM_ID);
    const [metadata] = PublicKey.findProgramAddressSync([DELEGATION_METADATA_SEED, tree.toBytes()], DELEGATION_PROGRAM_ID);
    expect(buffer.equals(delegateBufferPdaFromDelegatedAccountAndOwnerProgram(tree, programId))).toBe(true);
    expect(record.equals(delegationRecordPdaFromDelegatedAccount(tree))).toBe(true);
    expect(metadata.equals(delegationMetadataPdaFromDelegatedAccount(tree))).toBe(true);
  });

  it('decodes the exact TreeState Borsh layout and rejects invalid account bytes', () => {
    const owner = new PublicKey('11111111111111111111111111111111');
    const data = Buffer.alloc(8 + 60);
    Buffer.from(TREE_ACCOUNT_DISCRIMINATOR).copy(data, 0);
    let offset = 8;
    data[offset++] = 1;
    Buffer.from('astrix-v1').copy(data, offset); offset += 9;
    Buffer.from('tree-01').copy(data, offset); offset += 7;
    owner.toBuffer().copy(data, offset); offset += 32;
    data[offset++] = 1;
    data[offset++] = 1;
    data.writeBigUInt64LE(0n, offset); offset += 8;
    data[offset] = 0;
    expect(decodeTreeState(data)).toMatchObject({ treeId: 'tree-01', health: 1, maxHealth: 1, state: 'standing', nonce: 0, owner: owner.toBase58() });
    data[8 + 1 + 9 + 7 + 32 + 1 + 1 + 8] = 1;
    expect(() => decodeTreeState(data)).toThrow(/invariants/);
    expect(() => decodeTreeState(Buffer.alloc(3))).toThrow(/invalid size/);
    expect(() => decodeTreeState(new Uint8Array(68))).toThrow(/discriminator/);
    data[8 + 1 + 9 + 7 + 32 + 1 + 1 + 8] = 2;
    expect(() => decodeTreeState(data)).toThrow(/Borsh boolean/);
    data[8 + 1 + 9 + 7 + 32 + 1 + 1 + 8] = 0;
    data[8 + 1 + 9 + 7 + 32 + 1] = 2;
    expect(() => decodeTreeState(data)).toThrow(/invariants/);
  });
});

describe('LocalWorldStateAdapter', () => {
  it('remains explicitly local and never fabricates transaction progress', async () => {
    const simulation = new WorldSimulation();
    const adapter = new LocalWorldStateAdapter((type, entityId, data) => simulation.recordExternalEvent(type, entityId, data));
    await adapter.connect();
    expect(adapter.mode).toBe('local-mock');
    await expect(adapter.delegateWorldState('tree-01')).rejects.toThrow(/not implemented/);
    const proposal = simulation.proposeAction('GATHER', 'tree-01');
    await expect(adapter.sendRealtimeAction(proposal)).rejects.toThrow(/No on-chain or ER transaction/);
    await expect(adapter.readRealtimeState('tree-01')).rejects.toThrow(/ER state is unavailable/);
    await expect(adapter.commitWorldState('tree-01')).rejects.toThrow(/not implemented/);

    const types = simulation.state.events.map((event) => event.type);
    expect(types).toContain('INTEGRATION_MODE_SELECTED');
    expect(types).not.toContain('CHAIN_OPERATION_FAILED');
    expect(types).not.toContain('WORLD_STATE_DELEGATED');
    expect(types).not.toContain('TRANSACTION_AUTHORIZED');
    expect(types).not.toContain('TRANSACTION_SUBMITTED');
    expect(types).not.toContain('TRANSACTION_CONFIRMED');
    expect(types).not.toContain('AUTHORITATIVE_STATE_VERIFIED');
  });

  it('refuses unverified, invalid, and conflicting state rather than overwriting newer local state', () => {
    const simulation = new WorldSimulation();
    const tree = simulation.state.entities['tree-01'];
    expect(tree?.kind).toBe('tree');
    if (!tree || tree.kind !== 'tree') throw new Error('tree-01 missing');

    expect(simulation.reconcileTreeFromAuthority(tree.id, 1, false, 'unverified')).toBe(false);
    expect(tree.health).toBe(2);
    expect(simulation.reconcileTreeFromAuthority(tree.id, -1, true, 'invalid')).toBe(false);
    expect(tree.health).toBe(2);

    tree.health = 0;
    tree.state = 'depleted';
    expect(simulation.reconcileTreeFromAuthority(tree.id, 1, true, 'older-state')).toBe(false);
    expect(tree).toMatchObject({ health: 0, state: 'depleted' });
    expect(simulation.state.events.filter((event) => event.type === 'AUTHORITATIVE_STATE_CONFLICT')).toHaveLength(3);
  });

  it('defers local chops for explicit chain proposals until confirmed state is reconciled', () => {
    const simulation = new WorldSimulation();
    const worker = simulation.state.entities['worker-01'];
    if (!worker || worker.kind !== 'worker') throw new Error('worker-01 missing');
    const tree = simulation.state.entities['tree-01'];
    if (!tree || tree.kind !== 'tree') throw new Error('tree-01 missing');
    worker.position = { ...tree.position };
    const proposal = simulation.proposeAction('GATHER', 'tree-01', { execution: 'magicblock-er' }, 'HIGH');
    expect(simulation.approveProposal(proposal.id)).toBe(true);
    expect(simulation.advanceUntil((state) => state.events.some((event) => event.type === 'LOCAL_STATE_TRANSITION_DEFERRED'), 1800)).toBe(true);
    expect(simulation.state.entities['tree-01']).toMatchObject({ kind: 'tree', health: 2, state: 'standing' });
    expect(proposal.status).toBe('APPROVED');
    expect(simulation.reconcileTreeFromAuthority('tree-01', 0, true, 'confirmed-er-account')).toBe(true);
    expect(simulation.state.entities['tree-01']).toMatchObject({ kind: 'tree', health: 0, state: 'depleted' });
    expect(proposal.status).toBe('VERIFIED');
    expect(simulation.state.entities['log-01']).toBeUndefined();
  });

  it('applies only verified monotonic authority to the local presentation projection', () => {
    const simulation = new WorldSimulation();
    expect(simulation.reconcileTreeFromAuthority('tree-01', 1, true, 'confirmed-account-read')).toBe(true);
    expect(simulation.state.entities['tree-01']).toMatchObject({ kind: 'tree', health: 1, state: 'standing' });
    expect(simulation.state.events.at(-1)).toMatchObject({ type: 'LOCAL_STATE_RECONCILED', entityId: 'tree-01', data: { health: 1, reference: 'confirmed-account-read' } });
    expect(simulation.reconcileTreeFromAuthority('tree-01', 0, true, 'confirmed-account-read-2')).toBe(true);
    expect(simulation.state.entities['tree-01']).toMatchObject({ kind: 'tree', health: 0, state: 'depleted' });
  });
});
