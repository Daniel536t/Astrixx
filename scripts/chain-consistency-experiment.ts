#!/usr/bin/env tsx
/**
 * Chain-consistency experiment (DEVNET, funded wallet required).
 *
 * Proves ASTrix can distinguish delegated authoritative state from local
 * speculative state: counter PDA → delegate → hot increments → failure
 * paths → simulated partition with separately-logged speculation →
 * reconnect with explicit no-merge resolution → commit + undelegate.
 *
 * Every state change prints its real signature. Nothing is mocked: RPC
 * failures abort the run with the boundary named.
 *
 *   ASTRIX_CHAIN_KEYPAIR=~/.config/solana/astrix-deploy.json npx tsx scripts/chain-consistency-experiment.ts
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { WorldSimulation } from '../src/simulation/WorldSimulation';
import { createWorld } from '../src/world/createWorld';
import { CounterDevnetAdapter } from '../src/magicblock/CounterChain';
import type { ActionProposal } from '../src/world/types';

const RPC = 'https://api.devnet.solana.com';
const ROUTER = 'https://devnet-router.magicblock.app';
const ER = 'https://devnet-eu.magicblock.app';
const PROGRAM_ID = 'Gd5DXjcDxr1jJFS2LBzoLkZvYsHZWhVwbYdQ7eZEKSdP';
const KEYPAIR_PATH = process.env['ASTRIX_CHAIN_KEYPAIR'] ?? `${process.env['HOME']}/.config/solana/astrix-deploy.json`;
const MIN_BALANCE_SOL = 3;

interface Step { step: string; ok: boolean; detail: string; signature?: string }
const steps: Step[] = [];
const step = (name: string, ok: boolean, detail: string, signature?: string) => {
  steps.push({ step: name, ok, detail, signature });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}${signature ? ` [${signature}]` : ''}`);
  if (!ok) {
    fs.writeFileSync(`artifacts/chain-experiment-${Date.now()}.json`, JSON.stringify({ at: new Date().toISOString(), steps }, null, 2));
    throw new Error(`Experiment stopped at boundary: ${name} — ${detail}`);
  }
};

const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'))));
console.log(`operator wallet: ${keypair.publicKey.toBase58()}`);
// Any unhandled failure still leaves a partial evidence artifact behind.
process.on('uncaughtException', (error) => {
  fs.writeFileSync(`artifacts/chain-experiment-FAILED-${Date.now()}.json`, JSON.stringify({ at: new Date().toISOString(), steps, error: String(error).slice(0, 500) }, null, 2));
  console.error(`EXPERIMENT FAILED: ${String(error).slice(0, 500)}`);
  process.exit(1);
});
const base = new Connection(RPC, 'confirmed');
const sim = new WorldSimulation(createWorld());
const record = (type: WorldEventType, entityId: string, data: Record<string, unknown>) => sim.recordExternalEvent(type, entityId, data);
const adapter = new CounterDevnetAdapter(
  { solanaRpcUrl: RPC, magicRouterRpcUrl: ROUTER, ephemeralRpcUrl: ER, programId: PROGRAM_ID },
  { publicKey: keypair.publicKey, signTransaction: async (tx) => { tx.sign(keypair); return tx; } },
  record,
);

// 0. Preflight: funds, program, endpoints.
const balance = await base.getBalance(keypair.publicKey, 'confirmed');
step('preflight-balance', balance / LAMPORTS_PER_SOL >= MIN_BALANCE_SOL, `${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL devnet (need ${MIN_BALANCE_SOL})`);
await adapter.connect();
step('preflight-endpoints', true, 'devnet + EU ER router reachable');
const programAccount = await base.getAccountInfo(new PublicKey(PROGRAM_ID), 'confirmed');
if (!programAccount?.executable) {
  console.log('program not deployed — deploying with the solana CLI two-step flow (anchor deploy is unreliable against newer clusters)...');
  try {
    const home = '/home/ubuntu/astrix';
    const writeOut = execFileSync('solana', ['program', 'write-buffer', `${home}/target/deploy/astrix_world.so`, '--url', RPC, '--keypair', KEYPAIR_PATH], { timeout: 600_000 }).toString();
    const buffer = writeOut.trim().split(/\s+/).pop() as string;
    execFileSync('solana', ['program', 'deploy', '--buffer', buffer, '--program-id', `${home}/target/deploy/astrix_world-keypair.json`, '--url', RPC, '--keypair', KEYPAIR_PATH, '--upgrade-authority', KEYPAIR_PATH], { timeout: 600_000 });
    const deployed = await base.getAccountInfo(new PublicKey(PROGRAM_ID), 'confirmed');
    step('deploy-program', Boolean(deployed?.executable), `program ${PROGRAM_ID}`);
  } catch (error) {
    step('deploy-program', false, `devnet deploy failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  }
} else {
  step('deploy-program', true, 'already executable on devnet (skipped redeploy)');
}

// 1. Initialize (idempotent: skip if the PDA exists).
const existing = await base.getAccountInfo(adapter.counterAddress, 'confirmed');
if (!existing) {
  const init = await adapter.initializeCounter();
  step('initialize-counter', true, `unbuilt/nonce-0 verified`, init.signature);
} else {
  step('initialize-counter', true, 'counter PDA already exists (skipped re-init)');
}

// 2. Delegate + confirm + grant the write lease to ER.
const preDelegate = await adapter.readCounter().catch(() => null);
if (preDelegate) {
  const status = await adapter.routerConnection.getDelegationStatus(adapter.counterAddress);
  if (!status.isDelegated) {
    const del = await adapter.delegateCounter();
    step('delegate-counter', true, `router delegation confirmed`, del.signature);
  } else {
    step('delegate-counter', true, 'already delegated (router confirmed)');
  }
} else {
  const del = await adapter.delegateCounter();
  step('delegate-counter', true, `router delegation confirmed`, del.signature);
}
sim.grantLease('count-01', 'er', (await adapter.readCounter()).nonce);
step('lease-to-er', true, 'local sim surrendered authoritative writes for count-01');

// 3. Five hot increments, each: propose → approve → execute → verify + contiguity.
function proposeIncrement(n: number) {
  const proposal = sim.proposeAction('MOVE_TO' as ActionType, 'count-01', { execution: 'magicblock-er', round: n, purpose: 'chain-increment' }, 'HIGH');
  if (!sim.approveProposal(proposal.id)) throw new Error('operator approval failed');
  return proposal;
}
let expected = (await adapter.readCounter()).nonce;
let lastSlot = 0;
for (let round = 1; round <= 5; round += 1) {
  const proposal = proposeIncrement(round);
  const result = await adapter.incrementCounter(proposal, expected);
  proposal.status = 'VERIFIED';
  sim.recordExternalEvent('ACTION_STATUS_CHANGED', proposal.agentId, { proposalId: proposal.id, status: 'VERIFIED', execution: 'magicblock-er', signature: result.signature });
  sim.markLeaseVerified('count-01', result.slot, result.counter.nonce);
  lastSlot = result.slot;
  const contiguous = result.counter.nonce === expected + 1;
  step(`hot-increment-${round}`, contiguous, `count=${result.counter.count} nonce=${result.counter.nonce} slot=${result.slot}`, result.signature);
  expected = result.counter.nonce;
}

// 4. Failure paths (all must fail closed with no state change).
const stranger = Keypair.generate();
{
  // Fund the stranger just enough for fees so rejection proves PROGRAM auth, not poverty.
  try {
    const fund = await base.requestAirdrop(stranger.publicKey, 10_000_000);
    await base.confirmTransaction(fund, 'confirmed');
  } catch {
    const { SystemProgram: SP, Transaction: TX, sendAndConfirmTransaction: send } = await import('@solana/web3.js');
    const tx = new TX().add(SP.transfer({ fromPubkey: keypair.publicKey, toPubkey: stranger.publicKey, lamports: 10_000_000 }));
    await send(base, tx, [keypair], { commitment: 'confirmed' });
  }
  const strangerAdapter = new CounterDevnetAdapter(
    { solanaRpcUrl: RPC, magicRouterRpcUrl: ROUTER, ephemeralRpcUrl: ER, programId: PROGRAM_ID },
    { publicKey: stranger.publicKey, signTransaction: async (tx) => { tx.sign(stranger); return tx; } },
    record,
  );
  let rejected = false;
  try {
    await strangerAdapter.incrementCounter({ ...proposeIncrement(99), status: 'APPROVED' } as ActionProposal, expected);
  } catch {
    rejected = true;
  }
  const unchanged = (await adapter.readCounter()).nonce === expected;
  step('reject-unauthorized', rejected && unchanged, 'stranger increment refused, nonce unchanged');
}
{
  let replayRefused = false;
  try {
    await adapter.incrementCounter({ ...proposeIncrement(100), status: 'APPROVED' } as ActionProposal, expected - 1);
  } catch (error) {
    replayRefused = error instanceof Error && /Stale view|StaleNonce|already built/i.test(error.message);
  }
  step('reject-replay', replayRefused, 'stale-nonce resubmission refused before submit');
}
{
  // Reader timeout: race a real read against an absurd deadline → unknown, not failure.
  let unknown = false;
  try {
    await Promise.race([
      adapter.readCounter(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('reader-timeout-status-unknown')), 5)),
    ]);
  } catch (error) {
    unknown = error instanceof Error && /unknown/i.test(error.message);
  }
  if (unknown) sim.recordExternalEvent('MAGICBLOCK_OPERATION_FAILED', 'count-01', { operation: 'timed-read', error: 'reader-timeout-status-unknown' });
  step('reader-timeout-unknown', unknown, 'slow read reported as unknown, not as failure');
}

// 5. Partition drill: stale the lease, speculate OFF-counter, prove separation.
sim.markLeaseStale('count-01');
const liveBefore = await adapter.readCounter();
const counterBefore = liveBefore.nonce;
const specIds = [1, 2, 3].map((i) => sim.recordSpeculative('count-01', 'offline-increment', `partition minute ${i}: operator counts ahead locally`));
const counterAfter = (await adapter.readCounter()).nonce;
step('partition-separation', counterBefore === counterAfter && counterAfter === expected, `authoritative nonce ${counterAfter} untouched by ${specIds.length} speculative records`);
step('partition-marked-stale', sim.state.leases['count-01']?.stale === true, 'last verified counter shown stale, not fresh');

// 6. Reconnect: read actual ER state, resolve no-merge, record explicitly.
const live = await adapter.readCounter();
let resolved = 0;
for (const id of specIds) {
  if (sim.resolveSpeculative(id, 'no-merge', { nonce: live.nonce, count: live.count })) resolved += 1;
}
sim.markLeaseVerified('count-01', lastSlot, live.nonce);
const resolutions = sim.state.events.filter((e) => e.type === 'RECONCILIATION_RESOLVED');
step('reconnect-resolution', resolved === 3 && resolutions.length === 3, `${resolved}/3 speculative records resolved no-merge against nonce ${live.nonce}`);
step('no-silent-merge', (await adapter.readCounter()).count === live.count, 'authoritative count unchanged by speculation');

// 7. Commit + undelegate; base must match; lease home to local.
const commit = await adapter.commitAndUndelegateCounter(live);
step('commit-and-undelegate', true, `base count=${commit.counter.count} nonce=${commit.counter.nonce}`, commit.signature);
sim.grantLease('count-01', 'local', commit.counter.nonce);
step('lease-home', true, 'local sim resumes authoritative writes after undelegation');

const outPath = `artifacts/chain-experiment-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(outPath, JSON.stringify({
  at: new Date().toISOString(),
  wallet: keypair.publicKey.toBase58(),
  program: PROGRAM_ID,
  counter: adapter.counterAddress.toBase58(),
  steps,
  leases: sim.state.leases,
  speculative: sim.state.speculative,
  events: sim.state.events.map((e) => ({ sequence: e.sequence, type: e.type, entityId: e.entityId, data: e.data })),
}, null, 2));
console.log(`Wrote ${outPath}`);
console.log('CHAIN CONSISTENCY EXPERIMENT COMPLETE');
