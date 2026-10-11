import { describe, expect, it } from 'vitest';
import { Buffer } from 'buffer';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import type { ActionProposal, WorldEventType } from '../world/types';
import {
  decodeFarmState,
  deriveFarmAddress,
  FARM_ACCOUNT_DISCRIMINATOR,
  type FarmEventRecorder,
  FarmDevnetAdapter,
} from './FarmChain';
import { WorldSimulation } from '../simulation/WorldSimulation';
import { createWorld } from '../world/createWorld';

const PROGRAM_ID = new PublicKey('Gd5DXjcDxr1jJFS2LBzoLkZvYsHZWhVwbYdQ7eZEKSdP');
const ZERO_HASH = '11111111111111111111111111111111';

function testWallet() {
  const keypair = Keypair.generate();
  return {
    keypair,
    wallet: {
      publicKey: keypair.publicKey,
      signTransaction: async (tx: import('@solana/web3.js').Transaction) => {
        tx.partialSign(keypair);
        return tx;
      },
    },
  };
}

function farmBytes(state: number, nonce: bigint, woodSpent: number, authority: PublicKey): Buffer {
  const data = Buffer.alloc(8 + 59);
  Buffer.from(FARM_ACCOUNT_DISCRIMINATOR).copy(data, 0);
  let offset = 8;
  data[offset++] = 1;
  Buffer.from('astrix-v1').copy(data, offset); offset += 9;
  Buffer.from('farm-01').copy(data, offset); offset += 7;
  authority.toBuffer().copy(data, offset); offset += 32;
  data[offset++] = state;
  data.writeBigUInt64LE(nonce, offset); offset += 8;
  data[offset] = woodSpent;
  return data;
}

describe('farm program interface pins', () => {
  it('derives the documented farm-01 PDA and 67-byte layout', () => {
    const [pda, bump] = deriveFarmAddress(PROGRAM_ID);
    expect(pda.toBase58()).toBe('6c4r1tgdCoLw6FosBu9m4MyUmReXUWXKBj9zAvdKp6pq');
    expect(bump).toBe(254);
    expect(Buffer.from(FARM_ACCOUNT_DISCRIMINATOR).toString('hex')).toBe('c666d84a3f42a3be');
  });

  it('decodes valid farm states and rejects malformed accounts', () => {
    const owner = Keypair.generate().publicKey;
    expect(decodeFarmState(farmBytes(0, 5n, 0, owner))).toMatchObject({ farmId: 'farm-01', state: 'unbuilt', nonce: 5, woodSpent: 0, authority: owner.toBase58() });
    expect(decodeFarmState(farmBytes(1, 6n, 3, owner))).toMatchObject({ state: 'built', nonce: 6, woodSpent: 3 });
    expect(() => decodeFarmState(Buffer.alloc(10))).toThrow(/invalid size/);
    const badDisc = farmBytes(0, 0n, 0, owner);
    badDisc[0] = 0;
    expect(() => decodeFarmState(badDisc)).toThrow(/discriminator/);
    expect(() => decodeFarmState(farmBytes(7, 0n, 0, owner))).toThrow(/lifecycle stage/);
    const badWorld = farmBytes(0, 0n, 0, owner);
    badWorld[9] = 'X'.charCodeAt(0);
    expect(() => decodeFarmState(badWorld)).toThrow(/stable ID/);
  });
});

describe('farm governance gating (offline, no RPC)', () => {
  function adapter() {
    const { wallet } = testWallet();
    return new FarmDevnetAdapter(
      { solanaRpcUrl: 'https://api.devnet.solana.com', magicRouterRpcUrl: 'https://devnet-router.magicblock.app', ephemeralRpcUrl: 'https://devnet-eu.magicblock.app', programId: PROGRAM_ID.toBase58() },
      wallet,
    );
  }

  function proposal(overrides: Partial<ActionProposal> = {}): ActionProposal {
    return {
      id: 'proposal-0001', agentId: 'worker-01', actionType: 'BUILD', targetEntityId: 'settlement-01',
      parameters: { structure: 'farm', execution: 'magicblock-er' }, riskLevel: 'HIGH', createdAt: 0, status: 'APPROVED', ...overrides,
    };
  }

  it('refuses unapproved, misrouted, mistargeted, and mispriced proposals before any RPC', async () => {
    const devnet = adapter();
    await expect(devnet.buildFarm(proposal({ status: 'PROPOSED' }), 3)).rejects.toMatchObject({ name: 'FarmChainError' });
    await expect(devnet.buildFarm(proposal({ parameters: { structure: 'farm' } }), 3)).rejects.toThrow(/explicitly request MagicBlock/);
    await expect(devnet.buildFarm(proposal({ actionType: 'GATHER', targetEntityId: 'tree-01' }), 3)).rejects.toThrow(/Only an approved BUILD/);
    await expect(devnet.buildFarm(proposal({ parameters: { structure: 'house', execution: 'magicblock-er' } }), 3)).rejects.toThrow(/builds farms/);
    await expect(devnet.buildFarm(proposal(), 2)).rejects.toThrow(/governed farm cost/);
  });
});

describe('verified farm reconciliation (offline)', () => {
  it('applies verified builds once, refuses duplicates and shortfalls', () => {
    const sim = new WorldSimulation(createWorld());
    sim.state.wood = 5;
    const proposal = sim.proposeAction('BUILD', 'settlement-01', { structure: 'farm', execution: 'magicblock-er' }, 'HIGH');
    expect(sim.approveProposal(proposal.id)).toBe(true);
    expect(sim.applyVerifiedFarmBuild(3, 'sig-abc')).toBe(true);
    expect(sim.state.wood).toBe(2);
    expect(sim.state.entities['farm-01']).toMatchObject({ kind: 'farm', state: 'growing' });
    expect(sim.state.events.some((e) => e.type === 'LOCAL_STATE_RECONCILED' && e.entityId === 'farm-01')).toBe(true);
    expect(sim.state.events.some((e) => e.type === 'CONSTRUCTION_COMPLETED' && e.entityId === 'farm-01')).toBe(true);
    // Duplicate apply refused; shortfall refused.
    expect(sim.applyVerifiedFarmBuild(3, 'sig-abc')).toBe(false);
    expect(sim.state.wood).toBe(2);
    const poor = new WorldSimulation(createWorld());
    poor.state.wood = 1;
    expect(poor.applyVerifiedFarmBuild(3, 'sig-abc')).toBe(false);
    expect(poor.state.entities['farm-01']).toBeUndefined();
    expect(poor.state.events.some((e) => e.type === 'AUTHORITATIVE_STATE_CONFLICT')).toBe(true);
  });

describe('lease-aware farm reconciliation', () => {
  const chainBuilt = { state: 'built' as const, nonce: 1, woodSpent: 3, authority: 'auth-1' };

  it('creates presentation + lease on first verified built read', () => {
    const sim = new WorldSimulation(createWorld());
    expect(sim.reconcileFarmLease(chainBuilt, 100)).toBe('created');
    expect(sim.state.entities['farm-01']).toMatchObject({ kind: 'farm', state: 'growing' });
    expect(sim.state.leases['farm-01']).toMatchObject({ holder: 'er', nonceFloor: 1, lastVerifiedSlot: 100, stale: false });
    expect(sim.state.events.some((e) => e.type === 'LOCAL_STATE_RECONCILED')).toBe(true);
    expect(sim.state.events.some((e) => e.type === 'LEASE_CHANGED')).toBe(true);
  });

  it('adopts an existing local farm without duplicating', () => {
    const sim = new WorldSimulation(createWorld());
    sim.state.entities['farm-01'] = { id: 'farm-01', kind: 'farm', position: { x: 0, z: 0 }, state: 'ready', progress: 1 };
    expect(sim.reconcileFarmLease(chainBuilt, 101)).toBe('adopted');
    expect(Object.values(sim.state.entities).filter((e) => e.kind === 'farm')).toHaveLength(1);
    expect(sim.state.entities['farm-01']).toMatchObject({ state: 'ready' });
    expect(sim.state.leases['farm-01']).toMatchObject({ holder: 'er' });
  });

  it('stays local-only without a chain record, and holds conflicts instead of auto-resolving', () => {
    const sim = new WorldSimulation(createWorld());
    expect(sim.reconcileFarmLease(null, null)).toBe('local-only');
    expect(sim.state.leases['farm-01']).toBeUndefined();
    sim.grantLease('farm-01', 'er', 1);
    expect(sim.reconcileFarmLease({ state: 'unbuilt', nonce: 0, woodSpent: 0, authority: 'auth-1' }, 102)).toBe('conflict-held');
    expect(sim.state.events.some((e) => e.type === 'AUTHORITATIVE_STATE_CONFLICT' && e.entityId === 'farm-01')).toBe(true);
    expect(sim.state.entities['farm-01']).toBeUndefined();
  });

  it('defers local farm construction while the ER lease is held', () => {
    const sim = new WorldSimulation(createWorld());
    sim.state.wood = 9;
    sim.grantLease('farm-01', 'er', 1);
    // An approved local build would collide with the lease holder: it must
    // defer instead of deducting or creating (held PROPOSED builds simply
    // wait for review, which is also correct).
    const local = sim.proposeAction('BUILD', 'settlement-01', { structure: 'farm' }, 'HIGH');
    expect(sim.approveProposal(local.id)).toBe(true);
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'test', parameters: { structure: 'farm' } });
    sim.advanceUntil(() => false, 60);
    expect(sim.state.entities['farm-01']).toBeUndefined();
    expect(sim.state.wood).toBe(9);
    expect(sim.state.events.some((e) => e.type === 'LOCAL_STATE_TRANSITION_DEFERRED' && e.entityId === 'farm-01')).toBe(true);
  });

  it('marks staleness without inventing freshness', () => {
    const sim = new WorldSimulation(createWorld());
    sim.markLeaseStale('farm-01'); // no lease: no-op, no event
    expect(sim.state.events.some((e) => e.type === 'LEASE_CHANGED')).toBe(false);
    sim.grantLease('farm-01', 'er', 1);
    sim.markLeaseVerified('farm-01', 100, 1);
    sim.markLeaseStale('farm-01');
    expect(sim.state.leases['farm-01']).toMatchObject({ stale: true, lastVerifiedSlot: 100 });
  });
});
  it('defers local farm-01 work while a chain build is live, without touching houses', () => {
    const sim = new WorldSimulation(createWorld());
    sim.state.wood = 9;
    const chain = sim.proposeAction('BUILD', 'settlement-01', { structure: 'farm', execution: 'magicblock-er' }, 'HIGH');
    expect(chain.status).toBe('PROPOSED');
    // A human-approved LOCAL farm build would collide on farm-01: it must
    // defer instead of deducting or creating.
    const local = sim.proposeAction('BUILD', 'settlement-01', { structure: 'farm' }, 'HIGH');
    expect(sim.approveProposal(local.id)).toBe(true);
    sim.issueDirective({ actionType: 'BUILD', targetEntityId: 'settlement-01', reason: 'test', parameters: { structure: 'farm' } });
    sim.advanceUntil(() => false, 60);
    expect(sim.state.entities['farm-01']).toBeUndefined();
    expect(sim.state.wood).toBe(9);
    expect(sim.state.events.some((e) => e.type === 'LOCAL_STATE_TRANSITION_DEFERRED' && e.entityId === 'farm-01')).toBe(true);
    expect(chain.parameters['awaitingAuthority']).toBe(true);
  });
});

// ---- Scripted-transport lifecycle tests (no live RPC) ----

interface FakeShape {
  programAccount?: unknown;
  farmAccount?: (pubkey: PublicKey) => unknown;
  tx?: (sig: string) => unknown;
  send?: string;
  confirmErr?: unknown;
  delegation?: boolean;
  blockhash?: { blockhash: string; lastValidBlockHeight: number };
}

function fakeConnection(shape: FakeShape, rpcEndpoint: string, journal: string[]) {
  return {
    rpcEndpoint,
    async getVersion() { journal.push(`${rpcEndpoint}#getVersion`); return { 'solana-core': '3.1.9' }; },
    async getAccountInfo(pubkey: PublicKey) {
      journal.push(`${rpcEndpoint}#getAccountInfo:${pubkey.toBase58().slice(0, 6)}`);
      if (pubkey.equals(PROGRAM_ID)) return shape.programAccount ?? { executable: true, owner: SystemProgram.programId, lamports: 1, data: Buffer.alloc(0) };
      return shape.farmAccount ? shape.farmAccount(pubkey) : null;
    },
    async getTransaction(sig: string) {
      journal.push(`${rpcEndpoint}#getTransaction:${sig.slice(0, 8)}`);
      return shape.tx ? shape.tx(sig) : null;
    },
    async confirmTransaction() {
      journal.push(`${rpcEndpoint}#confirmTransaction`);
      return { value: { err: shape.confirmErr ?? null } };
    },
    async getLatestBlockhash() {
      journal.push(`${rpcEndpoint}#getLatestBlockhash`);
      return shape.blockhash ?? { blockhash: ZERO_HASH, lastValidBlockHeight: 100 };
    },
    async getLatestBlockhashForTransaction() {
      journal.push(`${rpcEndpoint}#getLatestBlockhashForTransaction`);
      return shape.blockhash ?? { blockhash: ZERO_HASH, lastValidBlockHeight: 100 };
    },
    async sendRawTransaction() {
      journal.push(`${rpcEndpoint}#sendRawTransaction`);
      return shape.send ?? 'SIG-DEFAULT';
    },
    async getDelegationStatus() {
      journal.push(`${rpcEndpoint}#getDelegationStatus`);
      return { isDelegated: shape.delegation ?? false };
    },
  };
}

function okTx(slot: number, logMessages: string[] = []) {
  return { slot, meta: { err: null, logMessages }, blockhash: ZERO_HASH, transaction: { message: {} } };
}

function accountInfo(data: Buffer, owner: PublicKey) {
  return { data, executable: false, lamports: 1_000_000, owner };
}

describe('farm chain lifecycle over scripted transport', () => {
  const { keypair: ownerKp, wallet: ownerWallet } = testWallet();
  const owner = ownerKp;
  const events: Array<{ type: WorldEventType; entityId?: string; data: Record<string, unknown> }> = [];
  const record: FarmEventRecorder = (type, entityId, data) => {
    events.push({ type, entityId, data });
  };

  function scriptedAdapter(opts: {
    preState?: { state: number; nonce: bigint };
    postState?: { state: number; nonce: bigint };
    confirmThrows?: boolean;
  } = {}) {
    const journal: string[] = [];
    let reads = 0;
    const pre = opts.preState ?? { state: 0, nonce: 5n };
    const post = opts.postState ?? { state: 1, nonce: 6n };
    const sendQueue = ['SIG-BUILD', 'SIG-COMMIT'];
    const erFarmBytes = () => {
      reads += 1;
      // One pre-build ER read (the pre-build check); everything after
      // submission sees post-build state.
      const current = reads <= 1 ? pre : post;
      return farmBytes(current.state, current.nonce, current.state === 1 ? 3 : 0, owner.publicKey);
    };
    const base = fakeConnection({
      farmAccount: () => accountInfo(farmBytes(post.state, post.nonce, post.state === 1 ? 3 : 0, owner.publicKey), PROGRAM_ID),
      tx: () => okTx(99),
    }, 'https://api.devnet.solana.com', journal);
    const router = fakeConnection({ delegation: true }, 'https://devnet-router.magicblock.app', journal);
    const er = fakeConnection({
      farmAccount: () => accountInfo(erFarmBytes(), PROGRAM_ID),
      tx: (sig) => {
        if (sig === 'SIG-COMMIT') return okTx(12, ['ScheduledCommitSent signature: SIG-SCHED']);
        if (sig === 'SIG-SCHED') return okTx(13, ['ScheduledCommitSent signature[0]: SIG-BASE']);
        if (sig === 'SIG-BUILD') return okTx(11);
        return okTx(10);
      },
    }, 'https://devnet-eu.magicblock.app', journal);
    (er as unknown as { sendRawTransaction: () => Promise<string> }).sendRawTransaction = async () => {
      journal.push('https://devnet-eu.magicblock.app#sendRawTransaction');
      const next = sendQueue.shift();
      if (!next) throw new Error('unexpected extra submission (duplicate suppressed in test)');
      return next;
    };
    if (opts.confirmThrows) {
      (er as unknown as { confirmTransaction: () => Promise<unknown> }).confirmTransaction = async () => {
        journal.push('https://devnet-eu.magicblock.app#confirmTransaction');
        throw new Error('simulated confirmation timeout');
      };
    }
    const adapter = new FarmDevnetAdapter(
      { solanaRpcUrl: 'https://api.devnet.solana.com', magicRouterRpcUrl: 'https://devnet-router.magicblock.app', ephemeralRpcUrl: 'https://devnet-eu.magicblock.app', programId: PROGRAM_ID.toBase58() },
      ownerWallet,
      record,
    );
    (adapter as unknown as { baseConnection: unknown }).baseConnection = base;
    (adapter as unknown as { routerConnection: unknown }).routerConnection = router;
    (adapter as unknown as { ephemeralConnection: unknown }).ephemeralConnection = er;
    return { adapter, journal };
  }

  function approvedProposal(): ActionProposal {
    return {
      id: 'proposal-0007', agentId: 'worker-01', actionType: 'BUILD', targetEntityId: 'settlement-01',
      parameters: { structure: 'farm', execution: 'magicblock-er' }, riskLevel: 'HIGH', createdAt: 0, status: 'APPROVED',
    };
  }

  it('runs build → verify → commit → base-verify with ordered stage events', async () => {
    events.length = 0;
    const { adapter } = scriptedAdapter();
    const proposal = approvedProposal();
    const result = await adapter.buildFarm(proposal, 3);
    expect(result).toMatchObject({ stage: 'verified', cluster: 'devnet', slot: 99 });
    expect(result.farm).toMatchObject({ state: 'built', nonce: 6, woodSpent: 3 });
    expect(proposal.status).toBe('VERIFIED');
    const order = events.map((e) => e.type);
    const chain: WorldEventType[] = ['MAGICBLOCK_EXECUTION_SUBMITTED', 'MAGICBLOCK_EXECUTION_CONFIRMED', 'MAGICBLOCK_STATE_VERIFIED', 'MAGICBLOCK_COMMIT_REQUESTED', 'MAGICBLOCK_COMMIT_CONFIRMED', 'MAGICBLOCK_BASE_STATE_VERIFIED'];
    let cursor = -1;
    for (const stage of chain) {
      cursor = order.indexOf(stage, cursor + 1);
      expect(cursor, `missing/out-of-order ${stage}`).toBeGreaterThan(-1);
    }
    const statusChanges = events.filter((e) => e.type === 'ACTION_STATUS_CHANGED').map((e) => e.data['status']);
    expect(statusChanges).toEqual(['EXECUTED', 'VERIFIED']);
    expect(events.some((e) => e.type === 'MAGICBLOCK_OPERATION_FAILED')).toBe(false);
  });

  it('refuses replay: an already-built farm never resubmits', async () => {
    events.length = 0;
    const { adapter, journal } = scriptedAdapter({ preState: { state: 1, nonce: 6n } });
    await expect(adapter.buildFarm(approvedProposal(), 3)).rejects.toThrow(/already built/);
    expect(journal.filter((c) => c.includes('sendRawTransaction'))).toHaveLength(0);
    expect(events.some((e) => e.type === 'MAGICBLOCK_EXECUTION_SUBMITTED')).toBe(false);
  });

  it('fails loudly on post-execution state mismatch instead of fabricating success', async () => {
    events.length = 0;
    const { adapter } = scriptedAdapter({ postState: { state: 0, nonce: 5n } });
    const proposal = approvedProposal();
    await expect(adapter.buildFarm(proposal, 3)).rejects.toThrow(/state mismatch/);
    expect(proposal.status).toBe('APPROVED');
    expect(events.some((e) => e.type === 'MAGICBLOCK_STATE_VERIFIED')).toBe(false);
  });

  it('records ambiguous confirmation timeouts as unknown, never as failure', async () => {
    events.length = 0;
    const { adapter } = scriptedAdapter({ confirmThrows: true });
    await expect(adapter.buildFarm(approvedProposal(), 3)).rejects.toThrow(/status unknown/);
    const markers = events.filter((e) => e.type === 'MAGICBLOCK_OPERATION_FAILED');
    expect(markers.length).toBe(1);
    expect(markers[0]?.data['error']).toBe('confirmation-timeout-status-unknown');
  });
});
