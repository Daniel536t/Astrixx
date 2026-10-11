import { describe, expect, it } from 'vitest';
import { Buffer } from 'buffer';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  COUNTER_ACCOUNT_DISCRIMINATOR,
  CounterDevnetAdapter,
  decodeCounterState,
  deriveCounterAddress,
} from './CounterChain';
import type { ActionProposal } from '../world/types';

const PROGRAM_ID = new PublicKey('Gd5DXjcDxr1jJFS2LBzoLkZvYsHZWhVwbYdQ7eZEKSdP');

function counterBytes(count: bigint, nonce: bigint, authority: PublicKey): Buffer {
  const data = Buffer.alloc(8 + 66);
  Buffer.from(COUNTER_ACCOUNT_DISCRIMINATOR).copy(data, 0);
  let offset = 8;
  data[offset++] = 1;
  Buffer.from('astrix-v1').copy(data, offset); offset += 9;
  Buffer.from('count-01').copy(data, offset); offset += 8;
  authority.toBuffer().copy(data, offset); offset += 32;
  data.writeBigUInt64LE(count, offset); offset += 8;
  data.writeBigUInt64LE(nonce, offset); offset += 8;
  return data;
}

describe('counter program interface pins', () => {
  it('derives the documented count-01 PDA and 73-byte layout', () => {
    const [pda, bump] = deriveCounterAddress(PROGRAM_ID);
    expect(pda.toBase58()).toBe('Hp2RDjpe3b7xKqEUWtNJNMsUVzTnRQUep57VaLixjarM');
    expect(bump).toBe(254);
    expect(Buffer.from(COUNTER_ACCOUNT_DISCRIMINATOR).toString('hex')).toBe('6217cd9f0eca4f8b');
  });

  it('decodes valid counters and rejects malformed accounts', () => {
    const owner = Keypair.generate().publicKey;
    expect(decodeCounterState(counterBytes(4n, 4n, owner))).toMatchObject({ counterId: 'count-01', count: 4, nonce: 4, authority: owner.toBase58() });
    expect(() => decodeCounterState(Buffer.alloc(5))).toThrow(/invalid size/);
    const bad = counterBytes(0n, 0n, owner);
    bad[0] = 0;
    expect(() => decodeCounterState(bad)).toThrow(/discriminator/);
  });
});

describe('counter governance gating (offline, no RPC)', () => {
  function adapter() {
    const kp = Keypair.generate();
    return new CounterDevnetAdapter(
      { solanaRpcUrl: 'https://api.devnet.solana.com', magicRouterRpcUrl: 'https://devnet-router.magicblock.app', ephemeralRpcUrl: 'https://devnet-eu.magicblock.app', programId: PROGRAM_ID.toBase58() },
      { publicKey: kp.publicKey, signTransaction: async (tx) => { tx.partialSign(kp); return tx; } },
    );
  }

  function approved(): ActionProposal {
    return {
      id: 'proposal-0001', agentId: 'worker-01', actionType: 'MOVE_TO', targetEntityId: 'count-01',
      parameters: { execution: 'magicblock-er', purpose: 'chain-increment' }, riskLevel: 'HIGH', createdAt: 0, status: 'APPROVED',
    };
  }

  it('refuses unapproved increments before any RPC', async () => {
    await expect(adapter().incrementCounter({ ...approved(), status: 'PROPOSED' }, 0)).rejects.toThrow(/approve/);
  });
});

describe('lease and speculation bookkeeping (offline)', () => {
  it('grants, stales, verifies, and resolves with recorded outcomes', async () => {
    const { WorldSimulation } = await import('../simulation/WorldSimulation');
    const { createWorld } = await import('../world/createWorld');
    const sim = new WorldSimulation(createWorld());
    expect(sim.state.leases['count-01']).toBeUndefined();
    sim.grantLease('count-01', 'er', 0);
    expect(sim.state.leases['count-01']).toMatchObject({ holder: 'er', epoch: 1, nonceFloor: 0, stale: true });
    sim.markLeaseVerified('count-01', 42, 5);
    expect(sim.state.leases['count-01']).toMatchObject({ stale: false, lastVerifiedSlot: 42, nonceFloor: 5 });
    sim.markLeaseStale('count-01');
    expect(sim.state.leases['count-01']).toMatchObject({ stale: true });
    const id = sim.recordSpeculative('count-01', 'offline-increment', 'test');
    expect(sim.state.speculative).toHaveLength(1);
    expect(sim.resolveSpeculative(id, 'no-merge', { nonce: 5, count: 5 })).toBe(true);
    const record = sim.state.speculative.find((item) => item.id === id);
    expect(record?.resolution).toBe('discarded-held-for-review');
    expect(sim.state.events.some((e) => e.type === 'LEASE_CHANGED')).toBe(true);
    expect(sim.state.events.some((e) => e.type === 'SPECULATIVE_NOTED')).toBe(true);
    expect(sim.state.events.some((e) => e.type === 'RECONCILIATION_RESOLVED')).toBe(true);
    // Double resolution refused.
    expect(sim.resolveSpeculative(id, 'no-merge', { nonce: 5, count: 5 })).toBe(false);
  });
});
