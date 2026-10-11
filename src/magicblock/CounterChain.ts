/**
 * Minimal delegated-counter client for the consistency experiment.
 *
 * Drives the CounterState PDA (73 bytes) through initialize → delegate →
 * increment* → verify → commit → base-verify, emitting the same
 * MAGICBLOCK_* stage events as the farm slice. Every increment goes through
 * a sim proposal (HIGH) + explicit approval inside the experiment script —
 * the operator is the human in the loop, recorded as such.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ConnectionMagicRouter,
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  GetCommitmentSignature,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import { anchorInstructionDiscriminator, createAnchorInstruction } from './MagicBlockAdapter';
import type { ActionProposal, WorldEventType } from '../world/types';

export interface AuthoritativeCounterState {
  counterId: string;
  count: number;
  nonce: number;
  authority: string;
  reference: string;
}

export interface CounterChainResult {
  signature: string;
  slot: number;
  counter: AuthoritativeCounterState;
  cluster: 'devnet' | 'localnet';
}

export type CounterEventRecorder = (type: WorldEventType, entityId: string, data: Record<string, unknown>) => void;

const COUNTER_SEED = new TextEncoder().encode('counter');
const WORLD_SEED = new TextEncoder().encode('astrix-v1');
const COUNTER_ID_SEED = new TextEncoder().encode('count-01');
const EXPECTED_WORLD_BYTES = new TextEncoder().encode('astrix-v1');
const EXPECTED_COUNTER_BYTES = new TextEncoder().encode('count-01');
const DEVNET_EU_VALIDATOR = new PublicKey('MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e');
const COUNTER_ACCOUNT_BYTES = 8 + 1 + 9 + 8 + 32 + 8 + 8;
export const COUNTER_ACCOUNT_DISCRIMINATOR = new Uint8Array([98, 23, 205, 159, 14, 202, 79, 139]);

export function deriveCounterAddress(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([COUNTER_SEED, WORLD_SEED, COUNTER_ID_SEED], programId);
}

function u64le(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Value must be a non-negative safe integer.');
  const data = new Uint8Array(new ArrayBuffer(8));
  new DataView(data.buffer).setBigUint64(0, BigInt(value), true);
  return data;
}

export function decodeCounterState(data: Uint8Array, reference = 'rpc'): AuthoritativeCounterState {
  if (data.length !== COUNTER_ACCOUNT_BYTES) throw new Error(`Counter account has an invalid size (${data.length} bytes; expected ${COUNTER_ACCOUNT_BYTES}).`);
  const expected = COUNTER_ACCOUNT_DISCRIMINATOR;
  if (!data.subarray(0, 8).every((byte, index) => byte === expected[index])) throw new Error('Account discriminator is not ASTrix CounterState.');
  let offset = 8;
  const schemaVersion = data[offset++]!;
  const worldId = data.subarray(offset, offset + EXPECTED_WORLD_BYTES.length); offset += EXPECTED_WORLD_BYTES.length;
  const counterIdBytes = data.subarray(offset, offset + EXPECTED_COUNTER_BYTES.length); offset += EXPECTED_COUNTER_BYTES.length;
  const authority = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
  const count = Number(new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true)); offset += 8;
  const nonce = Number(new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true)); offset += 8;
  if (schemaVersion !== 1 || !worldId.every((byte, index) => byte === EXPECTED_WORLD_BYTES[index]) || !counterIdBytes.every((byte, index) => byte === EXPECTED_COUNTER_BYTES[index])) {
    throw new Error('Counter account schema or stable ID does not match ASTrix v1/count-01.');
  }
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(nonce)) throw new Error('Counter count/nonce are not safe integers.');
  return { counterId: 'count-01', count, nonce, authority, reference };
}

export interface CounterConnectionConfig {
  solanaRpcUrl: string;
  magicRouterRpcUrl: string;
  ephemeralRpcUrl: string;
  programId: string;
  allowLocal?: boolean;
}

export interface CounterWallet {
  readonly publicKey: PublicKey;
  signTransaction(transaction: Transaction): Promise<Transaction>;
}

export class CounterChainError extends Error {
  constructor(message: string, readonly operation: string) {
    super(message);
    this.name = 'CounterChainError';
  }
}

export class CounterDevnetAdapter {
  readonly baseConnection: Connection;
  readonly routerConnection: ConnectionMagicRouter;
  readonly ephemeralConnection: Connection;
  readonly programId: PublicKey;
  readonly counterAddress: PublicKey;
  private readonly localMode: boolean;

  constructor(
    readonly config: CounterConnectionConfig,
    private readonly wallet: CounterWallet,
    private readonly record?: CounterEventRecorder,
  ) {
    this.programId = new PublicKey(config.programId);
    this.localMode = config.allowLocal === true;
    this.counterAddress = deriveCounterAddress(this.programId)[0];
    this.baseConnection = new Connection(config.solanaRpcUrl, 'confirmed');
    this.routerConnection = new ConnectionMagicRouter(config.magicRouterRpcUrl, { commitment: 'confirmed' });
    this.ephemeralConnection = new Connection(config.ephemeralRpcUrl, 'confirmed');
  }

  private tag(): 'devnet' | 'localnet' {
    return this.localMode ? 'localnet' : 'devnet';
  }

  async connect(): Promise<void> {
    const local = this.localMode
      && this.config.solanaRpcUrl.startsWith('http://127.0.0.1:')
      && this.config.ephemeralRpcUrl.startsWith('http://127.0.0.1:');
    if (!local && (this.config.solanaRpcUrl !== 'https://api.devnet.solana.com'
      || this.config.magicRouterRpcUrl !== 'https://devnet-router.magicblock.app'
      || this.config.ephemeralRpcUrl !== 'https://devnet-eu.magicblock.app')) {
      throw new CounterChainError('This adapter is pinned to the verified Solana Devnet + MagicBlock Devnet EU endpoints.', 'connect');
    }
    const [baseVersion, erVersion] = await Promise.all([
      this.baseConnection.getVersion(),
      this.ephemeralConnection.getVersion(),
    ]);
    if (!erVersion['solana-core']) throw new CounterChainError('Counterparty endpoint did not identify as a Solana RPC.', 'connect');
    this.record?.('INTEGRATION_MODE_SELECTED', 'count-01', { mode: 'magicblock-er', cluster: this.tag(), baseCore: baseVersion['solana-core'], erCore: erVersion['solana-core'], onChain: true });
  }

  async initializeCounter(): Promise<CounterChainResult> {
    await this.assertProgramDeployed();
    const existing = await this.baseConnection.getAccountInfo(this.counterAddress, 'confirmed');
    if (existing) throw new CounterChainError('Counter PDA already exists; refusing to overwrite.', 'initialize');
    const ix = await createAnchorInstruction(this.programId, 'initialize_counter', [
      { pubkey: this.counterAddress, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
    const sent = await this.sendConfirmed(this.baseConnection, ix, 'initialize-counter', 'count-01');
    const counter = await this.readOn(this.baseConnection, sent.signature);
    if (counter.count !== 0 || counter.nonce !== 0) throw new CounterChainError('Initialized counter failed invariant checks.', 'initialize');
    this.record?.('MAGICBLOCK_STATE_VERIFIED', 'count-01', { signature: sent.signature, slot: sent.slot, count: 0, nonce: 0, source: this.tag() });
    return { signature: sent.signature, slot: sent.slot, counter, cluster: this.tag() };
  }

  async delegateCounter(): Promise<CounterChainResult> {
    await this.assertProgramDeployed();
    const counter = await this.readOn(this.baseConnection, 'pre-delegation');
    this.assertAuthority(counter);
    this.record?.('MAGICBLOCK_DELEGATION_REQUESTED', 'count-01', { count: counter.count, nonce: counter.nonce });
    if (await this.routerConnection.getDelegationStatus(this.counterAddress).then((status) => status.isDelegated)) {
      throw new CounterChainError('Counter PDA is already delegated.', 'delegate');
    }
    const buffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(this.counterAddress, this.programId);
    const record = delegationRecordPdaFromDelegatedAccount(this.counterAddress);
    const metadata = delegationMetadataPdaFromDelegatedAccount(this.counterAddress);
    const ix = await createAnchorInstruction(this.programId, 'delegate_counter', [
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: record, isSigner: false, isWritable: true },
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: this.counterAddress, isSigner: false, isWritable: true },
      { pubkey: this.programId, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: DEVNET_EU_VALIDATOR, isSigner: false, isWritable: false },
    ]);
    const sent = await this.sendConfirmed(this.routerConnection, ix, 'delegate-counter', 'count-01');
    const status = await this.routerConnection.getDelegationStatus(this.counterAddress);
    if (!status.isDelegated) throw new CounterChainError('Delegation confirmed but MagicBlock reports PDA is not delegated.', 'delegate');
    this.record?.('MAGICBLOCK_DELEGATION_CONFIRMED', 'count-01', { signature: sent.signature, slot: sent.slot });
    const erCounter = await this.waitForCounter();
    this.record?.('MAGICBLOCK_STATE_VERIFIED', 'count-01', { signature: sent.signature, slot: sent.slot, count: erCounter.count, nonce: erCounter.nonce, source: 'magicblock-er' });
    return { signature: sent.signature, slot: sent.slot, counter: erCounter, cluster: this.tag() };
  }

  /**
   * Increment on the ER. Requires a governance-APPROVED proposal object
   * (created + approved explicitly by the operator in the experiment) and
   * marks it EXECUTED only after verified ER state. No auto-commit here:
   * the experiment commits explicitly to separate the stages.
   */
  async incrementCounter(proposal: ActionProposal, expectedNonce: number): Promise<CounterChainResult> {
    if (proposal.status !== 'APPROVED') throw new CounterChainError('Governance must approve before a transaction is authorized.', 'increment');
    await this.assertProgramDeployed();
    if (!(await this.routerConnection.getDelegationStatus(this.counterAddress)).isDelegated) {
      throw new CounterChainError('Counter must be delegated before ER execution.', 'increment');
    }
    const before = await this.readOn(this.ephemeralConnection, 'pre-increment');
    this.assertAuthority(before);
    if (before.nonce !== expectedNonce) {
      throw new CounterChainError(`Stale view: expected nonce ${expectedNonce}, authoritative nonce is ${before.nonce}. Refusing to submit.`, 'increment');
    }
    const ix = await createAnchorInstruction(this.programId, 'increment_counter', [
      { pubkey: this.counterAddress, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ], u64le(expectedNonce));
    const sent = await this.sendConfirmed(this.ephemeralConnection, ix, 'counter-increment', proposal.id);
    const after = await this.readOn(this.ephemeralConnection, sent.signature);
    if (after.count !== before.count + 1 || after.nonce !== before.nonce + 1) {
      throw new CounterChainError(`ER confirmed increment but state mismatch (count=${after.count}, nonce=${after.nonce}).`, 'increment');
    }
    this.record?.('MAGICBLOCK_STATE_VERIFIED', 'count-01', { signature: sent.signature, slot: sent.slot, count: after.count, nonce: after.nonce, source: 'magicblock-er' });
    proposal.status = 'EXECUTED';
    this.record?.('ACTION_STATUS_CHANGED', proposal.agentId, { proposalId: proposal.id, status: 'EXECUTED', execution: 'magicblock-er', signature: sent.signature });
    return { signature: sent.signature, slot: sent.slot, counter: after, cluster: this.tag() };
  }

  async readCounter(): Promise<AuthoritativeCounterState> {
    await this.assertProgramDeployed();
    if (!(await this.routerConnection.getDelegationStatus(this.counterAddress)).isDelegated) {
      throw new CounterChainError('Counter is not delegated; read base state.', 'read');
    }
    return this.readOn(this.ephemeralConnection, 'er-read');
  }

  async commitCounter(expected: AuthoritativeCounterState): Promise<CounterChainResult> {
    await this.assertProgramDeployed();
    if (!(await this.routerConnection.getDelegationStatus(this.counterAddress)).isDelegated) {
      throw new CounterChainError('Counter is not delegated.', 'commit');
    }
    const ix = await createAnchorInstruction(this.programId, 'commit_counter', [
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: this.counterAddress, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
    ]);
    this.record?.('MAGICBLOCK_COMMIT_REQUESTED', 'count-01', { operation: 'commit' });
    const erSent = await this.sendConfirmed(this.ephemeralConnection, ix, 'commit-counter', 'count-01');
    await this.verifyErTransaction(erSent.signature, 'ER commit transaction is missing or failed.');
    const baseSignature = await GetCommitmentSignature(erSent.signature, this.ephemeralConnection);
    const confirmation = await this.baseConnection.confirmTransaction(baseSignature, 'confirmed');
    if (confirmation.value.err) {
      this.record?.('MAGICBLOCK_OPERATION_FAILED', 'count-01', { signature: baseSignature, error: JSON.stringify(confirmation.value.err) });
      throw new CounterChainError(`Base-layer settlement failed: ${JSON.stringify(confirmation.value.err)}`, 'commit');
    }
    const transaction = await this.baseConnection.getTransaction(baseSignature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!transaction || transaction.meta?.err) throw new CounterChainError('Base-layer commitment transaction is missing or failed.', 'commit');
    const base = await this.readOn(this.baseConnection, baseSignature);
    if (base.count !== expected.count || base.nonce !== expected.nonce) {
      this.record?.('MAGICBLOCK_OPERATION_FAILED', 'count-01', { signature: baseSignature, error: 'base-er-state-mismatch' });
      throw new CounterChainError('Committed base counter does not match the verified ER result.', 'commit');
    }
    this.record?.('MAGICBLOCK_COMMIT_CONFIRMED', 'count-01', { erSignature: erSent.signature, settlementSignature: baseSignature, slot: transaction.slot });
    this.record?.('MAGICBLOCK_BASE_STATE_VERIFIED', 'count-01', { signature: baseSignature, slot: transaction.slot, count: base.count, nonce: base.nonce, source: 'solana-devnet-commit' });
    return { signature: baseSignature, slot: transaction.slot, counter: base, cluster: this.tag() };
  }

  async commitAndUndelegateCounter(expected: AuthoritativeCounterState): Promise<CounterChainResult> {
    await this.assertProgramDeployed();
    if (!(await this.routerConnection.getDelegationStatus(this.counterAddress)).isDelegated) {
      throw new CounterChainError('Counter is not delegated and cannot be undelegated.', 'undelegate');
    }
    const ix = await createAnchorInstruction(this.programId, 'commit_and_undelegate_counter', [
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: this.counterAddress, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
    ]);
    this.record?.('MAGICBLOCK_COMMIT_REQUESTED', 'count-01', { operation: 'commit-and-undelegate' });
    const erSent = await this.sendConfirmed(this.ephemeralConnection, ix, 'commit-and-undelegate', 'count-01');
    await this.verifyErTransaction(erSent.signature, 'ER commit-and-undelegate transaction is missing or failed.');
    const baseSignature = await GetCommitmentSignature(erSent.signature, this.ephemeralConnection);
    const base = await this.readOn(this.baseConnection, baseSignature);
    if (base.count !== expected.count || base.nonce !== expected.nonce) {
      throw new CounterChainError('Undelegated base counter does not match the verified ER result.', 'undelegate');
    }
    const status = await this.routerConnection.getDelegationStatus(this.counterAddress);
    if (status.isDelegated) throw new CounterChainError('Counter still delegated after undelegation.', 'undelegate');
    const owner = (await this.baseConnection.getAccountInfo(this.counterAddress, 'confirmed'))?.owner;
    if (!owner || !owner.equals(this.programId)) throw new CounterChainError('Undelegated counter not owned by the program on base.', 'undelegate');
    this.record?.('MAGICBLOCK_COMMIT_CONFIRMED', 'count-01', { erSignature: erSent.signature, settlementSignature: baseSignature });
    this.record?.('MAGICBLOCK_BASE_STATE_VERIFIED', 'count-01', { signature: baseSignature, count: base.count, nonce: base.nonce, source: 'solana-devnet-undelegate' });
    return { signature: baseSignature, slot: 0, counter: base, cluster: this.tag() };
  }

  disconnect(): void {}

  private async verifyErTransaction(signature: string, errorMessage: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const transaction = await this.ephemeralConnection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (transaction) {
        if (transaction.meta?.err) {
          this.record?.('MAGICBLOCK_OPERATION_FAILED', 'count-01', { signature, error: JSON.stringify(transaction.meta.err) });
          throw new CounterChainError(`${errorMessage} ${JSON.stringify(transaction.meta.err)}`, 'verify');
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    this.record?.('MAGICBLOCK_OPERATION_FAILED', 'count-01', { signature, error: 'confirmation-timeout-status-unknown' });
    throw new CounterChainError(`${errorMessage} confirmation timed out; on-chain status unknown — query before retrying.`, 'verify');
  }

  private async readOn(connection: Connection, reference: string): Promise<AuthoritativeCounterState> {
    const account = await connection.getAccountInfo(this.counterAddress, 'confirmed');
    if (!account) throw new CounterChainError(`Counter PDA ${this.counterAddress.toBase58()} is not available at ${reference}.`, 'read');
    const delegated = connection === this.ephemeralConnection;
    const isExpectedOwner = delegated
      ? account.owner.equals(this.programId)
      : account.owner.equals(this.programId) || account.owner.equals(DELEGATION_PROGRAM_ID);
    if (!isExpectedOwner) throw new CounterChainError(`Counter PDA owner mismatch at ${reference}; got ${account.owner.toBase58()}.`, 'read');
    const counter = decodeCounterState(account.data, `${connection.rpcEndpoint}:${reference}`);
    if (counter.authority !== this.wallet.publicKey.toBase58()) throw new CounterChainError('Connected wallet does not own this counter state.', 'read');
    return counter;
  }

  private async waitForCounter(): Promise<AuthoritativeCounterState> {
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.readOn(this.ephemeralConnection, 'delegation-confirmed');
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new CounterChainError(`Delegated counter did not become readable from the ER: ${String(lastError)}`, 'delegate');
  }

  private async sendConfirmed(
    connection: Connection, ix: TransactionInstruction, operation: string, correlationId: string,
  ): Promise<{ signature: string; slot: number }> {
    let signature = '';
    try {
      const unsigned = new Transaction({ feePayer: this.wallet.publicKey }).add(ix);
      const blockhash = connection instanceof ConnectionMagicRouter
        ? await connection.getLatestBlockhashForTransaction(unsigned, { commitment: 'confirmed' })
        : await connection.getLatestBlockhash('confirmed');
      unsigned.recentBlockhash = blockhash.blockhash;
      const signed = await this.wallet.signTransaction(unsigned);
      if (!signed.signature) throw new CounterChainError('Wallet returned a transaction without its signature.', operation);
      signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: 'confirmed' });
      this.record?.('MAGICBLOCK_EXECUTION_SUBMITTED', 'count-01', { operation, correlationId, signature });
      let confirmation;
      try {
        confirmation = await connection.confirmTransaction({ signature, ...blockhash }, 'confirmed');
      } catch {
        this.record?.('MAGICBLOCK_OPERATION_FAILED', 'count-01', { operation, correlationId, signature, error: 'confirmation-timeout-status-unknown' });
        throw new CounterChainError(`Confirmation timed out for ${signature}; on-chain status unknown — query before retrying.`, operation);
      }
      if (confirmation.value.err) throw new CounterChainError(`Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`, operation);
      const transaction = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!transaction || transaction.meta?.err) throw new CounterChainError(`Confirmed transaction ${signature} could not be verified as successful.`, operation);
      this.record?.('MAGICBLOCK_EXECUTION_CONFIRMED', 'count-01', { operation, correlationId, signature, slot: transaction.slot });
      return { signature, slot: transaction.slot };
    } catch (error) {
      if (error instanceof CounterChainError && signature) {
        if (error.message.includes('status unknown')) throw error;
        this.record?.('MAGICBLOCK_OPERATION_FAILED', 'count-01', { operation, correlationId, signature, error: error.message });
      } else if (!(error instanceof CounterChainError)) {
        this.record?.('MAGICBLOCK_OPERATION_FAILED', 'count-01', { operation, correlationId, signature: signature || undefined, error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  }

  private async assertProgramDeployed(): Promise<void> {
    // Skip on localnet (test validator has no upgrade-authority metadata to check cheaply);
    // the subsequent account reads fail loudly if the program is absent.
    const program = await this.baseConnection.getAccountInfo(this.programId, 'confirmed');
    if (!program || !program.executable) {
      throw new CounterChainError(`ASTrix program ${this.programId.toBase58()} is not executable on the base cluster.`, 'preflight');
    }
  }

  private assertAuthority(counter: AuthoritativeCounterState): void {
    if (counter.authority !== this.wallet.publicKey.toBase58()) throw new CounterChainError('Connected human wallet is not this counter authority.', 'preflight');
  }
}

export { anchorInstructionDiscriminator };
