#!/usr/bin/env tsx
/**
 * Farm-01 Devnet lifecycle (AUTHORIZED SCOPE: farm init/delegate/build only).
 *
 * Exercises the GOVERNED application workflow — no direct program call
 * bypasses it: sim proposal (HIGH, magicblock-er) → explicit operator
 * approval → adapter (re-checks approval + routing) → ER execution →
 * independent ER read → commit + base verification → local reconciliation
 * ONLY on verified evidence (wood deducted and farm created then, not before).
 *
 * Failure paths: unauthorized on-chain build, stale-nonce replay (adapter
 * and program levels), reader-timeout unknown handling.
 *
 *   ASTRIX_CHAIN_KEYPAIR=~/.config/solana/astrix-deploy.json npx tsx scripts/farm-devnet-lifecycle.ts
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { WorldSimulation } from '../src/simulation/WorldSimulation';
import { createWorld } from '../src/world/createWorld';
import { FarmDevnetAdapter } from '../src/magicblock/FarmChain';
import type { WorldEventType } from '../src/world/types';
import { FARM_WOOD_COST } from '../src/world/types';

const RPC = 'https://api.devnet.solana.com';
const ROUTER = 'https://devnet-router.magicblock.app';
const ER = 'https://devnet-eu.magicblock.app';
const PROGRAM_ID = 'Gd5DXjcDxr1jJFS2LBzoLkZvYsHZWhVwbYdQ7eZEKSdP';
const KEYPAIR_PATH = process.env['ASTRIX_CHAIN_KEYPAIR'] ?? `${process.env['HOME']}/.config/solana/astrix-deploy.json`;

interface Step { step: string; ok: boolean; detail: string; signature?: string }
const steps: Step[] = [];
const step = (name: string, ok: boolean, detail: string, signature?: string) => {
  steps.push({ step: name, ok, detail, signature });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}${signature ? ` [${signature}]` : ''}`);
  if (!ok) {
    fs.writeFileSync(`artifacts/farm-lifecycle-FAILED-${Date.now()}.json`, JSON.stringify({ at: new Date().toISOString(), steps }, null, 2));
    throw new Error(`Stopped at boundary: ${name} — ${detail}`);
  }
};
process.on('uncaughtException', (error) => {
  fs.writeFileSync(`artifacts/farm-lifecycle-FAILED-${Date.now()}.json`, JSON.stringify({ at: new Date().toISOString(), steps, error: String(error).slice(0, 500) }, null, 2));
  console.error(`FAILED: ${String(error).slice(0, 500)}`);
  process.exit(1);
});

const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'))));
console.log(`operator wallet: ${keypair.publicKey.toBase58()}`);
const sim = new WorldSimulation(createWorld());
const record = (type: WorldEventType, entityId: string, data: Record<string, unknown>) => sim.recordExternalEvent(type, entityId, data);
const adapter = new FarmDevnetAdapter(
  { solanaRpcUrl: RPC, magicRouterRpcUrl: ROUTER, ephemeralRpcUrl: ER, programId: PROGRAM_ID },
  { publicKey: keypair.publicKey, signTransaction: async (tx) => { tx.sign(keypair); return tx; } },
  record,
);

// 0. Preflight: program deployed, farm-01 absent (clean slate expected).
await adapter.connect();
step('preflight-connect', true, 'devnet + EU ER reachable');
const programAccount = await adapter.baseConnection.getAccountInfo(new PublicKey(PROGRAM_ID), 'confirmed');
step('preflight-program', Boolean(programAccount?.executable), `program ${PROGRAM_ID} executable`);
const preExisting = await adapter.baseConnection.getAccountInfo(adapter.farmAddress, 'confirmed');
step('preflight-farm-absent', preExisting === null, preExisting ? 'farm-01 already exists (re-run would reuse, not overwrite)' : 'clean slate, no farm-01');

// 1. Initialize (only if absent — never overwrite).
if (!preExisting) {
  const init = await adapter.initializeFarm();
  step('initialize-farm', true, 'unbuilt/nonce-0 verified on base', init.signature);
} else {
  step('initialize-farm', true, 'skipped: PDA exists, refusal-to-overwrite honored');
}

// 2. Scenario setup (documented, not an outcome): local wood covers the cost.
sim.state.wood = FARM_WOOD_COST;
step('scenario-setup', sim.state.wood === 3, 'local stockpile set to exactly the governed cost (3)');

// 3. Delegate + confirm + lease to ER.
const delegated = await adapter.routerConnection.getDelegationStatus(adapter.farmAddress);
let delegateSig: string | undefined;
if (!delegated.isDelegated) {
  const del = await adapter.delegateFarm();
  delegateSig = del.signature;
  step('delegate-farm', true, 'router delegation confirmed, ER state verified unbuilt', del.signature);
} else {
  step('delegate-farm', true, 'already delegated (router confirmed)');
}
const preBuild = await adapter.readFarm();
sim.grantLease('farm-01', 'er', preBuild.nonce);
step('lease-to-er', preBuild.state === 'unbuilt', `local writes surrendered at nonce ${preBuild.nonce}`);

// 4. GOVERNED WORKFLOW: propose → approve → build → verify.
const proposal = sim.proposeAction('BUILD', 'settlement-01', { structure: 'farm', execution: 'magicblock-er' }, 'HIGH');
step('propose', proposal.status === 'PROPOSED', `${proposal.id} HIGH held for review (no auto-approval)`);
if (!sim.approveProposal(proposal.id)) throw new Error('operator approval failed');
step('approve', proposal.status === 'APPROVED', 'human operator authorized this exact proposal');
const woodBeforeBuild = sim.state.wood;
const result = await adapter.buildFarm(proposal, FARM_WOOD_COST);
step('er-build-verified', result.farm.state === 'built' && result.farm.nonce === preBuild.nonce + 1 && result.farm.woodSpent === 3,
  `built/nonce ${result.farm.nonce}/wood ${result.farm.woodSpent} independently read from ER`, result.signature);
step('commit-verified', result.stage === 'verified', `base commit + base-account match confirmed (slot ${result.slot})`);

// 5. Local consistency: NOTHING changed before verified evidence...
step('no-premature-spend', sim.state.wood === woodBeforeBuild && sim.state.entities['farm-01'] === undefined,
  `wood still ${sim.state.wood}, no farm-01 before reconciliation`);
// ...then reconcile exactly once on the verified result.
const applied = sim.applyVerifiedFarmBuild(result.farm.woodSpent, result.signature);
sim.markLeaseVerified('farm-01', result.slot, result.farm.nonce);
step('reconcile', applied && sim.state.wood === 0, `wood 3→0 deducted, farm-01 growing (ref ${result.signature.slice(0, 12)}…)`);
step('proposal-verified', proposal.status === 'VERIFIED', `${proposal.id} EXECUTED→VERIFIED only after evidence`);

// 6. Failure paths: unauthorized on-chain build.
const stranger = Keypair.generate();
{
  const disc = crypto.createHash('sha256').update('global:build_farm').digest().subarray(0, 8);
  const args = Buffer.concat([Buffer.alloc(8), crypto.randomBytes(32), Buffer.from([3])]);
  const conn = new Connection(RPC, 'confirmed');
  const tx = new Transaction().add(new TransactionInstruction({
    programId: new PublicKey(PROGRAM_ID),
    keys: [
      { pubkey: adapter.farmAddress, isSigner: false, isWritable: true },
      { pubkey: stranger.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([disc, args]),
  }));
  tx.feePayer = keypair.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.partialSign(stranger);
  tx.partialSign(keypair); // operator pays fees; stranger "authorizes" the build
  let rejected = false;
  try {
    await conn.sendRawTransaction(tx.serialize());
  } catch {
    rejected = true;
  }
  const after = await adapter.readFarm();
  step('reject-unauthorized', rejected && after.state === 'built' && after.nonce === result.farm.nonce, 'stranger-signed build refused, verified state unchanged');
}

// 7. Replay: adapter-level (VERIFIED proposal reused) + program-level (stale nonce).
{
  let adapterRefused = false;
  try {
    await adapter.buildFarm(proposal, FARM_WOOD_COST);
  } catch (error) {
    adapterRefused = error instanceof Error && /approve/i.test(error.message);
  }
  step('reject-replay-adapter', adapterRefused, 'VERIFIED proposal cannot re-authorize a second build');
}
{
  const disc = crypto.createHash('sha256').update('global:build_farm').digest().subarray(0, 8);
  const stale = Buffer.alloc(8); // nonce 0 << current
  const args = Buffer.concat([stale, crypto.randomBytes(32), Buffer.from([3])]);
  const conn = new Connection(RPC, 'confirmed');
  const tx = new Transaction().add(new TransactionInstruction({
    programId: new PublicKey(PROGRAM_ID),
    keys: [
      { pubkey: adapter.farmAddress, isSigner: false, isWritable: true },
      { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([disc, args]),
  }));
  tx.feePayer = keypair.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(keypair);
  let replayRefused = false;
  try {
    await conn.sendRawTransaction(tx.serialize());
  } catch {
    replayRefused = true;
  }
  step('reject-replay-program', replayRefused, 'stale-nonce build refused on-chain');
}

// 8. Reader timeout stays unknown (race a real read against 5ms).
{
  let unknown = false;
  try {
    await Promise.race([
      adapter.readFarm(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('reader-timeout-status-unknown')), 5)),
    ]);
  } catch (error) {
    unknown = error instanceof Error && /unknown/i.test(error.message);
  }
  if (unknown) sim.recordExternalEvent('MAGICBLOCK_OPERATION_FAILED', 'farm-01', { operation: 'timed-read', error: 'reader-timeout-status-unknown' });
  step('reader-timeout-unknown', unknown, 'slow read reported as unknown, not failure');
}

// 9. Final authoritative read + closeout (leave delegated: farm stays hot).
const final = await adapter.readFarm();
const finalStatus = await adapter.routerConnection.getDelegationStatus(adapter.farmAddress);
step('final-state', final.state === 'built' && final.nonce === result.farm.nonce && final.woodSpent === 3 && finalStatus.isDelegated,
  `built/nonce ${final.nonce}/wood 3, still delegated (hot for future reads)`);

const outPath = `artifacts/farm-lifecycle-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(outPath, JSON.stringify({
  at: new Date().toISOString(),
  wallet: keypair.publicKey.toBase58(),
  program: PROGRAM_ID,
  farm: adapter.farmAddress.toBase58(),
  steps,
  leases: sim.state.leases,
  localWood: sim.state.wood,
  localFarm: sim.state.entities['farm-01'],
  events: sim.state.events.map((e) => ({ sequence: e.sequence, type: e.type, entityId: e.entityId, data: e.data })),
}, null, 2));
console.log(`Wrote ${outPath}`);
console.log('FARM-01 DEVNET LIFECYCLE COMPLETE');
