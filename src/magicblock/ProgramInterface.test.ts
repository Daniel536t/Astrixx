import { describe, expect, it } from 'vitest';
import { deriveTreeAddress, TREE_ACCOUNT_DISCRIMINATOR } from './MagicBlockAdapter';
import { WorldSimulation } from '../simulation/WorldSimulation';
import { PublicKey } from '@solana/web3.js';

/**
 * Offline program/client interface compatibility. These pin the values that
 * MUST match programs/astrix-world/src/lib.rs; any drift fails here before
 * it can reach a live RPC. They do not prove deployment or execution.
 */
describe('program/client interface compatibility', () => {
  it('pins the program id, PDA seeds, and TreeState layout', () => {
    // declare_id! in lib.rs
    const programId = new PublicKey('Gd5DXjcDxr1jJFS2LBzoLkZvYsHZWhVwbYdQ7eZEKSdP');
    // TREE_PDA_SEEDS = [b"tree", b"astrix-v1", b"tree-01"]
    const [tree, bump] = deriveTreeAddress(programId);
    expect(PublicKey.findProgramAddressSync(
      [Buffer.from('tree'), Buffer.from('astrix-v1'), Buffer.from('tree-01')],
      programId,
    )).toEqual([tree, bump]);
    // TreeState Borsh: discriminator 8 + schema 1 + world 9 + tree 7 +
    // owner 32 + health 1 + max_health 1 + nonce 8 + depleted 1 = 68.
    // decodeTreeState enforces exactly 68 bytes; the const below pins the
    // account discriminator recorded from the Anchor program.
    expect(Buffer.from(TREE_ACCOUNT_DISCRIMINATOR).toString('hex')).toBe('fba3f032a5d9c164');
  });

  it('documents the local/chain chop lifecycle alignment', () => {
    // Local trees take TWO hits: TREE_DAMAGED (2→1) then TREE_CHOPPED (1→0,
    // the felling blow that creates the log). The on-chain chop_tree models
    // exactly the felling blow (health 1→0, depleted, nonce+1). Reconciling
    // a verified chain felling over a fresh local tree must therefore move
    // local state 2→0 directly — no local log is fabricated.
    const sim = new WorldSimulation();
    expect(sim.state.entities['tree-01']).toMatchObject({ kind: 'tree', health: 2, state: 'standing' });
    expect(sim.reconcileTreeFromAuthority('tree-01', 0, true, 'confirmed-er-felling-blow')).toBe(true);
    expect(sim.state.entities['tree-01']).toMatchObject({ kind: 'tree', health: 0, state: 'depleted' });
    expect(sim.state.entities['log-01']).toBeUndefined();
    expect(
      sim.state.events.some((e) => e.type === 'LOCAL_STATE_RECONCILED' && e.entityId === 'tree-01'),
    ).toBe(true);
  });
});
