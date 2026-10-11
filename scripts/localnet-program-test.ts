#!/usr/bin/env tsx
/**
 * Localnet program execution test (requires solana-test-validator + deploy).
 * Uses raw web3.js instructions (discriminators verified against the IDL) —
 * no Anchor client needed. Exercises REAL on-chain execution of
 * initialize_farm → build_farm, including the unauthorized and replay
 * failure paths. No ER, no Devnet, no funding beyond the local faucet.
 *
 *   solana-test-validator --reset &
 *   anchor deploy --provider.cluster localnet --provider.wallet <keypair>
 *   ASTRIX_TEST_KEYPAIR=~/.config/solana/astrix-deploy.json npx tsx scripts/localnet-program-test.ts
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { decodeFarmState, deriveFarmAddress } from '../src/magicblock/FarmChain';

const RPC = process.env['ASTRIX_TEST_RPC'] ?? 'http://127.0.0.1:8899';
const KEYPAIR_PATH = process.env['ASTRIX_TEST_KEYPAIR'] ?? `${process.env['HOME']}/.config/solana/astrix-deploy.json`;
const PROGRAM_ID = new PublicKey(process.env['ASTRIX_TEST_PROGRAM'] ?? 'Gd5DXjcDxr1jJFS2LBzoLkZvYsHZWhVwbYdQ7eZEKSdP');

const disc = (s: string) => crypto.createHash('sha256').update(s).digest().subarray(0, 8);

async function send(connection: Connection, payer: Keypair, ixs: TransactionInstruction[]): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize());
  const confirmation = await connection.confirmTransaction(sig, 'confirmed');
  if (confirmation.value.err) throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  return sig;
}

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'))));
const stranger = Keypair.generate();
const connection = new Connection(RPC, 'confirmed');
const [farm] = deriveFarmAddress(PROGRAM_ID);
const results: Array<[string, string]> = [];
const check = (ok: boolean, name: string, detail = '') => {
  results.push([ok ? 'OK  ' : 'FAIL', `${name}${detail ? ` — ${detail}` : ''}`]);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

// 1. Program is executable on localnet.
const programAccount = await connection.getAccountInfo(PROGRAM_ID, 'confirmed');
check(Boolean(programAccount?.executable), 'program executable on localnet');

// 2. initialize_farm → unbuilt / nonce 0 / authority = payer.
const initSig = await send(connection, payer, [new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: farm, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.from(disc('global:initialize_farm')),
})]);
const afterInit = decodeFarmState((await connection.getAccountInfo(farm, 'confirmed'))!.data, 'localnet-init');
check(afterInit.state === 'unbuilt' && afterInit.nonce === 0 && afterInit.authority === payer.publicKey.toBase58(), 'initialize_farm state', initSig);

// 3. Unauthorized build (stranger signer) must fail; state unchanged.
let unauthorizedFailed = false;
try {
  await send(connection, stranger, [new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: farm, isSigner: false, isWritable: true },
      { pubkey: stranger.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([disc('global:build_farm'), Buffer.alloc(8), crypto.randomBytes(32), Buffer.from([3])]),
  })]);
} catch {
  unauthorizedFailed = true;
}
const afterUnauthorized = decodeFarmState((await connection.getAccountInfo(farm, 'confirmed'))!.data, 'localnet-unauth');
check(unauthorizedFailed && afterUnauthorized.state === 'unbuilt' && afterUnauthorized.nonce === 0, 'unauthorized build rejected, state untouched');

// 4. Authorized build_farm(nonce 0, wood 3) → built / nonce 1 / wood 3.
const actionId = crypto.randomBytes(32);
const args = Buffer.concat([Buffer.alloc(8), actionId, Buffer.from([3])]);
const buildSig = await send(connection, payer, [new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: farm, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
  ],
  data: Buffer.concat([disc('global:build_farm'), args]),
})]);
const afterBuild = decodeFarmState((await connection.getAccountInfo(farm, 'confirmed'))!.data, 'localnet-build');
check(afterBuild.state === 'built' && afterBuild.nonce === 1 && afterBuild.woodSpent === 3, 'build_farm state', buildSig);

// 5. Replay with stale nonce must fail; state unchanged.
let replayFailed = false;
try {
  await send(connection, payer, [new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: farm, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([disc('global:build_farm'), args]),
  })]);
} catch {
  replayFailed = true;
}
const afterReplay = decodeFarmState((await connection.getAccountInfo(farm, 'confirmed'))!.data, 'localnet-replay');
check(replayFailed && afterReplay.nonce === 1 && afterReplay.state === 'built', 'stale-nonce replay rejected, no duplicate construction');

if (process.exitCode) console.error('LOCALNET PROGRAM TEST FAILURES');
else console.log('LOCALNET PROGRAM TESTS PASSED');
