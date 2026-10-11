/**
 * Farm construction slice for MagicBlock Ephemeral Rollups.
 *
 * The local game builds farms through the normal governed BUILD path. This
 * module implements the SEPARATE verifiable path: a program-owned farm-01
 * PDA transitions UNBUILT → BUILT on-chain (initialize → delegate → build →
 * verify → commit → base-verify), and only a verified chain result is ever
 * reconciled into local presentation. The tree slice in MagicBlockAdapter.ts
 * is untouched.
 *
 * Authority split (documented, enforced):
 * - ON-CHAIN enforces: PDA seeds/world/farm identity, owner-only
 *   transitions, single construction (UNBUILT → BUILT once), nonce replay
 *   protection. It does NOT know the local wood balance.
 * - LOCAL enforces: wood balance, plot availability, worker presence, growth
 *   timing, harvest. `WorldSimulation.applyVerifiedFarmBuild` deducts and
 *   creates locally, and only runs on verified chain evidence.
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
import { FARM_WOOD_COST } from '../world/types';

export interface AuthoritativeFarmState {
  farmId: string;
  state: 'unbuilt' | 'built';
  nonce: number;
  woodSpent: number;
  authority: string;
  reference: string;
}

export type FarmChainStage = 'delegation-requested' | 'delegated' | 'submitted' | 'confirmed' | 'verified' | 'commit-requested' | 'committed' | 'base-verified';

export interface FarmChainResult {
  signature: string;
  stage: FarmChainStage;
  slot: number;
  farm: AuthoritativeFarmState;
  cluster: 'devnet' | 'localnet';
}

export type FarmEventRecorder = (type: WorldEventType, entityId: string, data: Record<string, unknown>) => void;

const FARM_SEED = new TextEncoder().encode('farm');
const WORLD_SEED = new TextEncoder().encode('astrix-v1');
const FARM_ID_SEED = new TextEncoder().encode('farm-01');
const EXPECTED_WORLD_BYTES = new TextEncoder().encode('astrix-v1');
const EXPECTED_FARM_BYTES = new TextEncoder().encode('farm-01');
const DEVNET_EU_VALIDATOR = new PublicKey('MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e');
const FARM_ACCOUNT_BYTES = 8 + 1 + 9 + 7 + 32 + 1 + 8 + 1;
export const FARM_ACCOUNT_DISCRIMINATOR = new Uint8Array([198, 102, 216, 74, 63, 66, 163, 190]);
export const FARM_UNBUILT = 0;
export const FARM_BUILT = 1;

export function deriveFarmAddress(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([FARM_SEED, WORLD_SEED, FARM_ID_SEED], programId);
}

function u64le(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Nonce must be a non-negative safe integer.');
  const data = new Uint8Array(8);
  new DataView(data.buffer).setBigUint64(0, BigInt(value), true);
  return data;
}

export function decodeFarmState(data: Uint8Array, reference = 'rpc'): AuthoritativeFarmState {
  if (data.length !== FARM_ACCOUNT_BYTES) throw new Error(`Farm account has an invalid size (${data.length} bytes; expected ${FARM_ACCOUNT_BYTES}).`);
  const expected = FARM_ACCOUNT_DISCRIMINATOR;
  if (!data.subarray(0, 8).every((byte, index) => byte === expected[index])) throw new Error('Account discriminator is not ASTrix FarmState.');
  let offset = 8;
  const schemaVersion = data[offset++]!;
  const worldId = data.subarray(offset, offset + EXPECTED_WORLD_BYTES.length); offset += EXPECTED_WORLD_BYTES.length;
  const farmIdBytes = data.subarray(offset, offset + EXPECTED_FARM_BYTES.length); offset += EXPECTED_FARM_BYTES.length;
  const authority = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
  const stateByte = data[offset++]!;
  const nonce = Number(new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true)); offset += 8;
  const woodSpent = data[offset]!;
  if (schemaVersion !== 1 || !worldId.every((byte, index) => byte === EXPECTED_WORLD_BYTES[index]) || !farmIdBytes.every((byte, index) => byte === EXPECTED_FARM_BYTES[index])) {
    throw new Error('Farm account schema or stable ID does not match ASTrix v1/farm-01.');
  }
  if (stateByte !== FARM_UNBUILT && stateByte !== FARM_BUILT) throw new Error('Farm state byte is not a known lifecycle stage.');
  if (!Number.isSafeInteger(nonce)) throw new Error('Farm nonce is not a safe integer.');
  return { farmId: 'farm-01', state: stateByte === FARM_BUILT ? 'built' : 'unbuilt', nonce, woodSpent, authority, reference };
}

export interface FarmConnectionConfig {
  solanaRpcUrl: string;
  magicRouterRpcUrl: string;
  ephemeralRpcUrl: string;
  programId: string;
  /** Explicit local-stack opt-in. Never set for Devnet; only for
   * 127.0.0.1/localhost endpoints in tests. Labeled in every result. */
  allowLocal?: boolean;
}

export interface FarmWallet {
  readonly publicKey: PublicKey;
  signTransaction(transaction: Transaction): Promise<Transaction>;
}

export class FarmChainError extends Error {
  constructor(message: string, readonly operation: string) {
    super(message);
    this.name = 'FarmChainError';
  }
}

/**
 * Devnet farm adapter. Requires governance APPROVED + explicit
 * `execution: 'magicblock-er'` on the proposal, plus a human-wallet signer.
 * Every stage emits its event only after the corresponding RPC fact.
 */
export class FarmDevnetAdapter {
  readonly baseConnection: Connection;
  readonly routerConnection: ConnectionMagicRouter;
  readonly ephemeralConnection: Connection;
  readonly programId: PublicKey;
  readonly farmAddress: PublicKey;
  private readonly localMode: boolean;

  constructor(
    readonly config: FarmConnectionConfig,
    private readonly wallet: FarmWallet,
    private readonly record?: FarmEventRecorder,
  ) {
    this.programId = new PublicKey(config.programId);
    this.localMode = config.allowLocal === true;
    this.farmAddress = deriveFarmAddress(this.programId)[0];
    this.baseConnection = new Connection(config.solanaRpcUrl, 'confirmed');
    this.routerConnection = new ConnectionMagicRouter(config.magicRouterRpcUrl, { commitment: 'confirmed' });
    this.ephemeralConnection = new Connection(config.ephemeralRpcUrl, 'confirmed');
  }

  async connect(): Promise<void> {
    const local = this.config.allowLocal === true
      && this.config.solanaRpcUrl.startsWith('http://127.0.0.1:')
      && this.config.ephemeralRpcUrl.startsWith('http://127.0.0.1:');
    if (!local && (this.config.solanaRpcUrl !== 'https://api.devnet.solana.com'
      || this.config.magicRouterRpcUrl !== 'https://devnet-router.magicblock.app'
      || this.config.ephemeralRpcUrl !== 'https://devnet-eu.magicblock.app')) {
      throw new FarmChainError('This adapter is pinned to the verified Solana Devnet + MagicBlock Devnet EU endpoints.', 'connect');
    }
    const [baseVersion, erVersion] = await Promise.all([
      this.baseConnection.getVersion(),
      this.ephemeralConnection.getVersion(),
    ]);
    if (!erVersion['solana-core']) throw new FarmChainError('MagicBlock EU endpoint did not identify as a Solana RPC.', 'connect');
    this.record?.('INTEGRATION_MODE_SELECTED', 'farm-01', {
      mode: 'magicblock-er', cluster: local ? 'localnet' : 'devnet', solanaCore: baseVersion['solana-core'], erCore: erVersion['solana-core'], onChain: true,
    });

  }

  async initializeFarm(): Promise<FarmChainResult> {
    await this.assertProgramDeployed();
    const existing = await this.baseConnection.getAccountInfo(this.farmAddress, 'confirmed');
    if (existing) throw new FarmChainError('Farm PDA already exists; refusing to overwrite its authority/state.', 'initialize');
    const ix = await createAnchorInstruction(this.programId, 'initialize_farm', [
      { pubkey: this.farmAddress, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
    const sent = await this.sendConfirmed(this.baseConnection, ix, 'initialize-farm', 'farm-01', 'MAGICBLOCK_EXECUTION_SUBMITTED', 'MAGICBLOCK_EXECUTION_CONFIRMED');
    const farm = await this.readOn(this.baseConnection, sent.signature, 'initialize');
    if (farm.state !== 'unbuilt' || farm.nonce !== 0) throw new FarmChainError('Initialized farm account failed invariant checks.', 'initialize');
    this.record?.('MAGICBLOCK_STATE_VERIFIED', 'farm-01', { signature: sent.signature, slot: sent.slot, state: farm.state, nonce: farm.nonce, source: 'solana-devnet' });
    return { signature: sent.signature, stage: 'verified', slot: sent.slot, farm, cluster: this.localMode ? 'localnet' : 'devnet' };
  }

  async delegateFarm(): Promise<FarmChainResult> {
    await this.assertProgramDeployed();
    const farm = await this.readOn(this.baseConnection, 'pre-delegation', 'delegate');
    this.assertAuthority(farm);
    if (farm.state !== 'unbuilt') throw new FarmChainError('Only an unbuilt farm is delegated in this slice.', 'delegate');
    this.record?.('MAGICBLOCK_DELEGATION_REQUESTED', 'farm-01', { state: farm.state, nonce: farm.nonce });
    if (await this.routerConnection.getDelegationStatus(this.farmAddress).then((status) => status.isDelegated)) {
      throw new FarmChainError('Farm PDA is already delegated.', 'delegate');
    }
    const buffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(this.farmAddress, this.programId);
    const record = delegationRecordPdaFromDelegatedAccount(this.farmAddress);
    const metadata = delegationMetadataPdaFromDelegatedAccount(this.farmAddress);
    const ix = await createAnchorInstruction(this.programId, 'delegate_farm', [
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: record, isSigner: false, isWritable: true },
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: this.farmAddress, isSigner: false, isWritable: true },
      { pubkey: this.programId, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: DEVNET_EU_VALIDATOR, isSigner: false, isWritable: false },
    ]);
    const sent = await this.sendConfirmed(this.routerConnection, ix, 'delegate-farm', 'farm-01', 'MAGICBLOCK_DELEGATION_REQUESTED', 'MAGICBLOCK_DELEGATION_CONFIRMED');
    const status = await this.routerConnection.getDelegationStatus(this.farmAddress);
    if (!status.isDelegated) throw new FarmChainError('Delegation transaction confirmed but MagicBlock reports PDA is not delegated.', 'delegate');
    const erFarm = await this.waitForFarm(this.ephemeralConnection);
    this.record?.('MAGICBLOCK_STATE_VERIFIED', 'farm-01', { signature: sent.signature, slot: sent.slot, state: erFarm.state, nonce: erFarm.nonce, source: 'magicblock-er' });
    return { signature: sent.signature, stage: 'delegated', slot: sent.slot, farm: erFarm, cluster: this.localMode ? 'localnet' : 'devnet' };
  }

  async buildFarm(proposal: ActionProposal, woodSpent: number): Promise<FarmChainResult> {
    if (proposal.status !== 'APPROVED') throw new FarmChainError('Governance must approve this proposal before a transaction is authorized.', 'build');
    if (proposal.parameters['execution'] !== 'magicblock-er') throw new FarmChainError('The proposal must explicitly request MagicBlock execution.', 'build');
    if (proposal.actionType !== 'BUILD' || proposal.targetEntityId !== 'settlement-01') throw new FarmChainError('Only an approved BUILD proposal targeting the settlement is supported by this slice.', 'build');
    if ((proposal.parameters['structure'] ?? 'house') !== 'farm') throw new FarmChainError('This slice builds farms; house construction stays local.', 'build');
    if (woodSpent !== FARM_WOOD_COST) throw new FarmChainError(`Wood commitment must equal the governed farm cost (${FARM_WOOD_COST}).`, 'build');
    await this.assertProgramDeployed();
    const delegated = await this.routerConnection.getDelegationStatus(this.farmAddress);
    if (!delegated.isDelegated) throw new FarmChainError('Farm must be explicitly delegated before an ER build.', 'build');
    const before = await this.readOn(this.ephemeralConnection, 'pre-build', 'build');
    this.assertAuthority(before);
    if (before.state !== 'unbuilt') throw new FarmChainError('Authoritative ER state says the farm is already built (replay refused).', 'build');

    const actionId = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${proposal.id}:${this.farmAddress.toBase58()}:${before.nonce}`)));
    const args = new Uint8Array(8 + 32 + 1);
    args.set(u64le(before.nonce));
    args.set(actionId, 8);
    args[40] = woodSpent;
    const build = await createAnchorInstruction(this.programId, 'build_farm', [
      { pubkey: this.farmAddress, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ], args);
    const sent = await this.sendConfirmed(this.ephemeralConnection, build, 'farm-build', proposal.id, 'MAGICBLOCK_EXECUTION_SUBMITTED', 'MAGICBLOCK_EXECUTION_CONFIRMED');
    const erFarm = await this.readOn(this.ephemeralConnection, sent.signature, 'build');
    if (erFarm.state !== 'built' || erFarm.nonce !== before.nonce + 1 || erFarm.woodSpent !== woodSpent) {
      throw new FarmChainError(`ER confirmed build but authoritative state mismatch (state=${erFarm.state}, nonce=${erFarm.nonce}, wood=${erFarm.woodSpent}).`, 'build');
    }
    this.record?.('MAGICBLOCK_STATE_VERIFIED', 'farm-01', { signature: sent.signature, slot: sent.slot, state: erFarm.state, nonce: erFarm.nonce, woodSpent: erFarm.woodSpent, source: 'magicblock-er' });
    proposal.status = 'EXECUTED';
    this.record?.('ACTION_STATUS_CHANGED', proposal.agentId, { proposalId: proposal.id, status: 'EXECUTED', execution: 'magicblock-er', signature: sent.signature });
    const commitResult = await this.commitAndVerifyBase(proposal.id, erFarm);
    proposal.status = 'VERIFIED';
    this.record?.('ACTION_STATUS_CHANGED', proposal.agentId, { proposalId: proposal.id, status: 'VERIFIED', execution: 'magicblock-er', signature: sent.signature, commitSignature: commitResult.signature });
    return { signature: sent.signature, stage: 'verified', slot: commitResult.slot, farm: commitResult.farm, cluster: this.localMode ? 'localnet' : 'devnet' };
  }

  async readFarm(): Promise<AuthoritativeFarmState> {
    await this.assertProgramDeployed();
    if (!(await this.routerConnection.getDelegationStatus(this.farmAddress)).isDelegated) {
      throw new FarmChainError('Farm is not delegated; read its base Solana state before ER access.', 'read');
    }
    return this.readOn(this.ephemeralConnection, 'er-read', 'read');
  }

  async commitFarm(): Promise<FarmChainResult> {
    await this.assertProgramDeployed();
    if (!(await this.routerConnection.getDelegationStatus(this.farmAddress)).isDelegated) {
      throw new FarmChainError('Farm is already committed or has not been delegated.', 'commit');
    }
    const farm = await this.readOn(this.ephemeralConnection, 'commit-read', 'commit');
    this.assertAuthority(farm);
    const result = await this.commitAndVerifyBase('manual-commit', farm);
    return { signature: result.signature, stage: 'base-verified', slot: result.slot, farm: result.farm, cluster: this.localMode ? 'localnet' : 'devnet' };
  }

  async commitAndUndelegateFarm(): Promise<FarmChainResult> {
    await this.assertProgramDeployed();
    if (!(await this.routerConnection.getDelegationStatus(this.farmAddress)).isDelegated) {
      throw new FarmChainError('Farm is not delegated and cannot be undelegated.', 'undelegate');
    }
    const farm = await this.readOn(this.ephemeralConnection, 'undelegate-read', 'undelegate');
    this.assertAuthority(farm);
    const ix = await this.commitInstruction('commit_and_undelegate_farm');
    this.record?.('MAGICBLOCK_COMMIT_REQUESTED', 'farm-01', { operation: 'commit-and-undelegate' });
    const erSent = await this.sendConfirmed(this.ephemeralConnection, ix, 'commit-and-undelegate', 'farm-01', 'MAGICBLOCK_EXECUTION_SUBMITTED', 'MAGICBLOCK_EXECUTION_CONFIRMED');
    await this.verifyErTransaction(erSent.signature, 'ER commit-and-undelegate transaction is missing or failed.');
    const baseSignature = await GetCommitmentSignature(erSent.signature, this.ephemeralConnection);
    const baseResult = await this.verifyBaseCommit(baseSignature, farm, true);
    this.record?.('MAGICBLOCK_COMMIT_CONFIRMED', 'farm-01', { erSignature: erSent.signature, settlementSignature: baseSignature, slot: baseResult.slot });
    return { signature: erSent.signature, stage: 'base-verified', slot: baseResult.slot, farm: baseResult.farm, cluster: this.localMode ? 'localnet' : 'devnet' };
  }

  disconnect(): void {}

  private async commitAndVerifyBase(actionId: string, expected: AuthoritativeFarmState): Promise<{ signature: string; slot: number; farm: AuthoritativeFarmState }> {
    const ix = await this.commitInstruction('commit_farm');
    this.record?.('MAGICBLOCK_COMMIT_REQUESTED', 'farm-01', { operation: 'commit', actionId });
    const erSent = await this.sendConfirmed(this.ephemeralConnection, ix, 'commit-farm', actionId, 'MAGICBLOCK_EXECUTION_SUBMITTED', 'MAGICBLOCK_EXECUTION_CONFIRMED');
    await this.verifyErTransaction(erSent.signature, 'ER commit transaction is missing or failed.');
    const baseSignature = await GetCommitmentSignature(erSent.signature, this.ephemeralConnection);
    const result = await this.verifyBaseCommit(baseSignature, expected, false);
    this.record?.('MAGICBLOCK_COMMIT_CONFIRMED', 'farm-01', { erSignature: erSent.signature, settlementSignature: baseSignature, slot: result.slot });
    this.record?.('MAGICBLOCK_BASE_STATE_VERIFIED', 'farm-01', { signature: baseSignature, slot: result.slot, state: result.farm.state, nonce: result.farm.nonce, source: 'solana-devnet-commit' });
    return { signature: baseSignature, ...result };
  }

  private async commitInstruction(name: 'commit_farm' | 'commit_and_undelegate_farm'): Promise<TransactionInstruction> {
    const keys: TransactionInstruction['keys'] = [
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: this.farmAddress, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
    ];
    return createAnchorInstruction(this.programId, name, keys);
  }

  private async verifyErTransaction(signature: string, errorMessage: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const transaction = await this.ephemeralConnection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (transaction) {
        if (transaction.meta?.err) {
          this.record?.('MAGICBLOCK_OPERATION_FAILED', 'farm-01', { signature, error: JSON.stringify(transaction.meta.err) });
          throw new FarmChainError(`${errorMessage} ${JSON.stringify(transaction.meta.err)}`, 'verify');
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // Ambiguous timeout: do NOT declare failure. Report unknown status so the
    // caller queries the signature and account before any retry.
    this.record?.('MAGICBLOCK_OPERATION_FAILED', 'farm-01', { signature, error: 'confirmation-timeout-status-unknown' });
    throw new FarmChainError(`${errorMessage} confirmation timed out; on-chain status unknown — query before retrying.`, 'verify');
  }

  private async verifyBaseCommit(signature: string, expected: AuthoritativeFarmState, expectUndelegated: boolean): Promise<{ slot: number; farm: AuthoritativeFarmState }> {
    const confirmation = await this.baseConnection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      this.record?.('MAGICBLOCK_OPERATION_FAILED', 'farm-01', { signature, error: JSON.stringify(confirmation.value.err) });
      throw new FarmChainError(`Base-layer settlement failed: ${JSON.stringify(confirmation.value.err)}`, 'commit');
    }
    const transaction = await this.baseConnection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!transaction || transaction.meta?.err) {
      this.record?.('MAGICBLOCK_OPERATION_FAILED', 'farm-01', { signature, error: 'base-commit-missing-or-failed' });
      throw new FarmChainError('Base-layer commitment transaction is missing or failed.', 'commit');
    }
    const farmAccount = await this.baseConnection.getAccountInfo(this.farmAddress, 'confirmed');
    if (!farmAccount) throw new FarmChainError('Committed farm account is not available on base Solana.', 'commit');
    if (expectUndelegated && !farmAccount.owner.equals(this.programId)) throw new FarmChainError('Undelegated farm PDA is not owned by the ASTrix program on base Solana.', 'commit');
    const farm = await this.readOn(this.baseConnection, signature, 'commit');
    const delegationStatus = await this.routerConnection.getDelegationStatus(this.farmAddress);
    if (delegationStatus.isDelegated === expectUndelegated) throw new FarmChainError(`Farm delegation status mismatch after ${expectUndelegated ? 'undelegation' : 'commit'}.`, 'commit');
    if (farm.state !== expected.state || farm.nonce !== expected.nonce || farm.woodSpent !== expected.woodSpent || farm.authority !== expected.authority) {
      this.record?.('MAGICBLOCK_OPERATION_FAILED', 'farm-01', { signature, error: 'base-er-state-mismatch' });
      throw new FarmChainError('Committed Solana farm account does not match the confirmed ER result.', 'commit');
    }
    return { slot: transaction.slot, farm };
  }

  private async readOn(connection: Connection, reference: string, operation: string): Promise<AuthoritativeFarmState> {
    const account = await connection.getAccountInfo(this.farmAddress, 'confirmed');
    if (!account) throw new FarmChainError(`Farm PDA ${this.farmAddress.toBase58()} is not available at ${reference}.`, operation);
    const delegated = connection === this.ephemeralConnection;
    const isExpectedOwner = delegated
      ? account.owner.equals(this.programId)
      : account.owner.equals(this.programId) || account.owner.equals(DELEGATION_PROGRAM_ID);
    if (!isExpectedOwner) throw new FarmChainError(`Farm PDA owner mismatch at ${reference}; got ${account.owner.toBase58()}.`, operation);
    const farm = decodeFarmState(account.data, `${connection.rpcEndpoint}:${reference}`);
    if (farm.authority !== this.wallet.publicKey.toBase58()) throw new FarmChainError('Connected wallet does not own this farm state.', operation);
    return farm;
  }

  private async waitForFarm(connection: Connection): Promise<AuthoritativeFarmState> {
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.readOn(connection, 'delegation-confirmed', 'delegate');
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new FarmChainError(`Delegated farm did not become readable from the ER: ${String(lastError)}`, 'delegate');
  }

  private async sendConfirmed(
    connection: Connection, ix: TransactionInstruction, operation: string, correlationId: string,
    submittedEvent: WorldEventType, confirmedEvent: WorldEventType,
  ): Promise<{ signature: string; slot: number }> {
    let signature = '';
    try {
      const unsigned = new Transaction({ feePayer: this.wallet.publicKey }).add(ix);
      const blockhash = connection instanceof ConnectionMagicRouter
        ? await connection.getLatestBlockhashForTransaction(unsigned, { commitment: 'confirmed' })
        : await connection.getLatestBlockhash('confirmed');
      unsigned.recentBlockhash = blockhash.blockhash;
      const signed = await this.wallet.signTransaction(unsigned);
      if (!signed.signature) throw new FarmChainError('Wallet returned a transaction without its signature.', operation);
      signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: 'confirmed' });
      this.record?.(submittedEvent, 'farm-01', { operation, correlationId, signature });
      let confirmation;
      try {
        confirmation = await connection.confirmTransaction({ signature, ...blockhash }, 'confirmed');
      } catch (error) {
        // Ambiguous timeout on confirmation: the transaction may still land.
        // Record unknown status; callers must query before retrying.
        this.record?.('MAGICBLOCK_OPERATION_FAILED', 'farm-01', { operation, correlationId, signature, error: 'confirmation-timeout-status-unknown' });
        throw new FarmChainError(`Confirmation timed out for ${signature}; on-chain status unknown — query before retrying.`, operation);
      }
      if (confirmation.value.err) throw new FarmChainError(`Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`, operation);
      const transaction = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!transaction || transaction.meta?.err) throw new FarmChainError(`Confirmed transaction ${signature} could not be verified as successful.`, operation);
      this.record?.(confirmedEvent, 'farm-01', { operation, correlationId, signature, slot: transaction.slot });
      return { signature, slot: transaction.slot };
    } catch (error) {
      if (!(error instanceof FarmChainError)) {
        this.record?.('MAGICBLOCK_OPERATION_FAILED', 'farm-01', { operation, correlationId, signature: signature || undefined, error: error instanceof Error ? error.message : String(error) });
      } else if (!signature) {
        this.record?.('MAGICBLOCK_OPERATION_FAILED', 'farm-01', { operation, correlationId, error: error.message });
      }
      throw error;
    }
  }

  private async assertProgramDeployed(): Promise<void> {
    const program = await this.baseConnection.getAccountInfo(this.programId, 'confirmed');
    if (!program || !program.executable) {
      throw new FarmChainError(`ASTrix program ${this.programId.toBase58()} is not executable on Solana Devnet.`, 'preflight');
    }
  }

  private assertAuthority(farm: AuthoritativeFarmState): void {
    if (farm.authority !== this.wallet.publicKey.toBase58()) throw new FarmChainError('Connected human wallet is not this farm account authority.', 'preflight');
  }
}

export { anchorInstructionDiscriminator };
