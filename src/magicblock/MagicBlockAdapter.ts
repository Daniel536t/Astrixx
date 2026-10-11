import { Buffer } from 'buffer';
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
import type { ActionProposal, WorldEventType } from '../world/types';

export type IntegrationMode = 'local-mock' | 'magicblock-er';

export interface AuthoritativeTreeState {
  treeId: string;
  health: number;
  maxHealth: number;
  state: 'standing' | 'depleted';
  nonce: number;
  owner: string;
  authorizedAgent: string | null;
  reference: string;
}

export type ChainOperationStage = 'transaction-authorized' | 'submitted' | 'confirmed' | 'verified';

export interface ChainOperationResult {
  signature: string;
  stage: ChainOperationStage;
  slot: number;
  tree: AuthoritativeTreeState;
  cluster: 'devnet' | 'localnet';
}

export interface WorldStateAdapter {
  readonly mode: IntegrationMode;
  connect(): Promise<void>;
  delegateWorldState(treeId: string): Promise<ChainOperationResult>;
  sendRealtimeAction(proposal: ActionProposal): Promise<ChainOperationResult>;
  readRealtimeState(treeId: string): Promise<AuthoritativeTreeState>;
  commitWorldState(treeId: string): Promise<ChainOperationResult>;
  disconnect(): void;
}

export class LocalWorldStateAdapter implements WorldStateAdapter {
  readonly mode = 'local-mock' as const;

  constructor(private readonly record?: (type: WorldEventType, entityId: string, data: Record<string, unknown>) => void) {}

  async connect(): Promise<void> {
    this.record?.('INTEGRATION_MODE_SELECTED', 'world', { mode: this.mode, onChain: false });
  }

  async delegateWorldState(_treeId: string): Promise<ChainOperationResult> {
    throw new Error('MagicBlock ER delegation is not implemented; this world is running locally.');
  }

  async sendRealtimeAction(_proposal: ActionProposal): Promise<ChainOperationResult> {
    throw new Error('No on-chain or ER transaction was sent; actions are simulated locally.');
  }

  async readRealtimeState(_treeId: string): Promise<AuthoritativeTreeState> {
    throw new Error('ER state is unavailable until the MagicBlock program and adapter are integrated.');
  }

  async commitWorldState(_treeId: string): Promise<ChainOperationResult> {
    throw new Error('MagicBlock ER commit is not implemented; this world is running locally.');
  }

  disconnect(): void {}
}

export interface MagicBlockConnectionConfig {
  solanaRpcUrl: string;
  magicRouterRpcUrl: string;
  ephemeralRpcUrl: string;
  programId: string;
  treeId: string;
}

/** Wallet API intentionally contains no secret/export method. The connected human wallet signs. */
export interface TransactionWallet {
  readonly publicKey: PublicKey;
  signTransaction(transaction: Transaction): Promise<Transaction>;
}

export type ChainEventRecorder = (type: WorldEventType, entityId: string, data: Record<string, unknown>) => void;

const WORLD_SEED = new TextEncoder().encode('astrix-v1');
const TREE_SEED = new TextEncoder().encode('tree-01');
const TREE_ACCOUNT_SEED = new TextEncoder().encode('tree');
export const DELEGATE_BUFFER_SEED = new TextEncoder().encode('buffer');
export const DELEGATION_RECORD_SEED = new TextEncoder().encode('delegation');
export const DELEGATION_METADATA_SEED = new TextEncoder().encode('delegation-metadata');
const DEVNET_EU_VALIDATOR = new PublicKey('MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e');
const EXPECTED_WORLD_BYTES = new TextEncoder().encode('astrix-v1');
const EXPECTED_TREE_BYTES = new TextEncoder().encode('tree-01');
const TREE_ACCOUNT_BYTES = 8 + 1 + 9 + 7 + 32 + 1 + 1 + 8 + 1;
export const TREE_ACCOUNT_DISCRIMINATOR = new Uint8Array([251, 163, 240, 50, 165, 217, 193, 100]);

export async function anchorInstructionDiscriminator(name: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`global:${name}`));
  return new Uint8Array(digest).subarray(0, 8);
}

function u64le(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Nonce must be a non-negative safe integer.');
  const data = new Uint8Array(8);
  new DataView(data.buffer).setBigUint64(0, BigInt(value), true);
  return data;
}

export function decodeTreeState(data: Uint8Array, reference = 'rpc'): AuthoritativeTreeState {
  const bytes = data;
  if (bytes.length !== TREE_ACCOUNT_BYTES) throw new Error(`Tree account has an invalid size (${bytes.length} bytes; expected ${TREE_ACCOUNT_BYTES}).`);
  const expected = TREE_ACCOUNT_DISCRIMINATOR;
  if (!bytes.subarray(0, 8).every((byte, index) => byte === expected[index])) throw new Error('Account discriminator is not ASTrix TreeState.');
  let offset = 8;
  const schemaVersion = bytes[offset++]!;
  const worldId = bytes.subarray(offset, offset + EXPECTED_WORLD_BYTES.length); offset += EXPECTED_WORLD_BYTES.length;
  const treeIdBytes = bytes.subarray(offset, offset + EXPECTED_TREE_BYTES.length); offset += EXPECTED_TREE_BYTES.length;
  const owner = new PublicKey(bytes.subarray(offset, offset + 32)).toBase58(); offset += 32;
  const health = bytes[offset++]!;
  const maxHealth = bytes[offset++]!;
  const nonce = Number(new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true)); offset += 8;
  const depletedByte = bytes[offset]!;
  if (depletedByte !== 0 && depletedByte !== 1) throw new Error('Tree depleted flag is not a valid Borsh boolean.');
  const depleted = depletedByte === 1;
  if (schemaVersion !== 1 || !worldId.every((byte, index) => byte === EXPECTED_WORLD_BYTES[index]) || !treeIdBytes.every((byte, index) => byte === EXPECTED_TREE_BYTES[index])) {
    throw new Error('Tree account schema or stable ID does not match ASTrix v1/tree-01.');
  }
  if (!Number.isSafeInteger(nonce) || maxHealth !== 1 || health > maxHealth || depleted !== (health === 0)) throw new Error('Tree account invariants are invalid.');
  return { treeId: 'tree-01', health, maxHealth, state: depleted ? 'depleted' : 'standing', nonce, owner, authorizedAgent: null, reference };
}

export async function createAnchorInstruction(programId: PublicKey, name: string, keys: TransactionInstruction['keys'], args = new Uint8Array()): Promise<TransactionInstruction> {
  const ixDiscriminator = await anchorInstructionDiscriminator(name);
  const data = Buffer.alloc(ixDiscriminator.length + args.length);
  data.set(ixDiscriminator);
  data.set(args, ixDiscriminator.length);
  return new TransactionInstruction({ programId, keys, data });
}

export function deriveTreeAddress(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TREE_ACCOUNT_SEED, WORLD_SEED, TREE_SEED], programId);
}

/**
 * Real devnet adapter. It implements only the narrow tree-v1 slice and requires
 * a connected human-wallet signer; no local fallback or secret-bearing keypair.
 * Use `sendRealtimeAction` only after governance has marked a GATHER proposal APPROVED.
 */
export class MagicBlockDevnetAdapter implements WorldStateAdapter {
  readonly mode = 'magicblock-er' as const;
  readonly baseConnection: Connection;
  readonly routerConnection: ConnectionMagicRouter;
  readonly ephemeralConnection: Connection;
  readonly programId: PublicKey;
  readonly treeAddress: PublicKey;

  constructor(
    readonly config: MagicBlockConnectionConfig,
    private readonly wallet: TransactionWallet,
    private readonly record?: ChainEventRecorder,
  ) {
    this.programId = new PublicKey(config.programId);
    this.treeAddress = deriveTreeAddress(this.programId)[0];
    this.baseConnection = new Connection(config.solanaRpcUrl, 'confirmed');
    this.routerConnection = new ConnectionMagicRouter(config.magicRouterRpcUrl, { commitment: 'confirmed' });
    this.ephemeralConnection = new Connection(config.ephemeralRpcUrl, 'confirmed');
  }

  async connect(): Promise<void> {
    if (this.config.solanaRpcUrl !== 'https://api.devnet.solana.com'
      || this.config.magicRouterRpcUrl !== 'https://devnet-router.magicblock.app'
      || this.config.ephemeralRpcUrl !== 'https://devnet-eu.magicblock.app') {
      throw new Error('This adapter is pinned to the verified Solana Devnet + MagicBlock Devnet EU endpoints.');
    }
    const [baseVersion, erVersion] = await Promise.all([
      this.baseConnection.getVersion(),
      this.ephemeralConnection.getVersion(),
    ]);
    if (!erVersion['solana-core']) throw new Error('MagicBlock EU endpoint did not identify as a Solana RPC.');
    this.record?.('INTEGRATION_MODE_SELECTED', 'world', {
      mode: this.mode,
      cluster: 'devnet',
      baseRpc: this.config.solanaRpcUrl,
      magicRouterRpc: this.config.magicRouterRpcUrl,
      ephemeralRpc: this.config.ephemeralRpcUrl,
      validator: DEVNET_EU_VALIDATOR.toBase58(),
      solanaCore: baseVersion['solana-core'],
      erCore: erVersion['solana-core'],
      onChain: true,
    });
  }

  async initializeTree(): Promise<ChainOperationResult> {
    await this.assertProgramDeployed();
    const existing = await this.baseConnection.getAccountInfo(this.treeAddress, 'confirmed');
    if (existing) throw new Error('Tree PDA already exists; refusing to overwrite its authority/state.');
    const ix = await createAnchorInstruction(this.programId, 'initialize_tree', [
      { pubkey: this.treeAddress, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
    const sent = await this.sendConfirmed(this.baseConnection, ix, 'initialize-tree', this.wallet.publicKey.toBase58());
    const tree = await this.readOn(this.baseConnection, sent.signature, this.wallet.publicKey);
    this.record?.('AUTHORITATIVE_STATE_VERIFIED', 'tree-01', { signature: sent.signature, slot: sent.slot, nonce: tree.nonce, health: tree.health, source: 'solana-devnet' });
    return { signature: sent.signature, stage: 'verified', slot: sent.slot, tree, cluster: 'devnet' };
  }

  async delegateWorldState(treeId: string): Promise<ChainOperationResult> {
    this.assertTreeId(treeId);
    await this.assertProgramDeployed();
    const tree = await this.readOn(this.baseConnection, 'pre-delegation', this.wallet.publicKey);
    this.assertOwner(tree);
    if (await this.routerConnection.getDelegationStatus(this.treeAddress).then((status) => status.isDelegated)) {
      throw new Error('Tree PDA is already delegated.');
    }
    const buffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(this.treeAddress, this.programId);
    const record = delegationRecordPdaFromDelegatedAccount(this.treeAddress);
    const metadata = delegationMetadataPdaFromDelegatedAccount(this.treeAddress);
    const ix = await createAnchorInstruction(this.programId, 'delegate_tree', [
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: record, isSigner: false, isWritable: true },
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: this.treeAddress, isSigner: false, isWritable: true },
      { pubkey: this.programId, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: DEVNET_EU_VALIDATOR, isSigner: false, isWritable: false },
    ]);
    const sent = await this.sendConfirmed(this.routerConnection, ix, 'delegate-tree', this.wallet.publicKey.toBase58());
    const status = await this.routerConnection.getDelegationStatus(this.treeAddress);
    if (!status.isDelegated) throw new Error('Delegation transaction confirmed but MagicBlock reports PDA is not delegated.');
    const erTree = await this.waitForTree(this.ephemeralConnection, this.wallet.publicKey);
    this.record?.('WORLD_STATE_DELEGATED', 'tree-01', { signature: sent.signature, slot: sent.slot, erRpc: this.config.ephemeralRpcUrl, validator: DEVNET_EU_VALIDATOR.toBase58() });
    this.record?.('AUTHORITATIVE_STATE_VERIFIED', 'tree-01', { signature: sent.signature, slot: sent.slot, health: erTree.health, nonce: erTree.nonce, source: 'magicblock-er' });
    return { signature: sent.signature, stage: 'verified', slot: sent.slot, tree: erTree, cluster: 'devnet' };
  }

  async sendRealtimeAction(proposal: ActionProposal): Promise<ChainOperationResult> {
    if (proposal.status !== 'APPROVED') throw new Error('Governance must approve this proposal before a transaction is authorized.');
    if (proposal.parameters['execution'] !== 'magicblock-er') throw new Error('The proposal must explicitly request MagicBlock execution and must not reuse local approval authority.');
    if (proposal.actionType !== 'GATHER' || proposal.targetEntityId !== 'tree-01') throw new Error('Only an approved GATHER proposal targeting tree-01 is supported by this slice.');
    await this.assertProgramDeployed();
    const delegated = await this.routerConnection.getDelegationStatus(this.treeAddress);
    if (!delegated.isDelegated) throw new Error('Tree must be explicitly delegated before an ER chop.');
    const before = await this.readOn(this.ephemeralConnection, 'pre-chop', this.wallet.publicKey);
    this.assertOwner(before);
    if (before.state !== 'standing' || before.health < 1) throw new Error('Authoritative ER state says the tree has already been felled.');

    const actionId = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${proposal.id}:${this.treeAddress.toBase58()}:${before.nonce}`)));
    const args = new Uint8Array(40);
    args.set(u64le(before.nonce));
    args.set(actionId, 8);
    const chop = await createAnchorInstruction(this.programId, 'chop_tree', [
      { pubkey: this.treeAddress, isSigner: false, isWritable: true },
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
    ], args);
    const sent = await this.sendConfirmed(this.ephemeralConnection, chop, 'tree-chop', proposal.id, proposal.id);
    const erTree = await this.readOn(this.ephemeralConnection, sent.signature, this.wallet.publicKey);
    if (erTree.health !== 0 || erTree.state !== 'depleted' || erTree.nonce !== before.nonce + 1) {
      throw new Error(`ER confirmed chop but authoritative state mismatch (health=${erTree.health}, nonce=${erTree.nonce}).`);
    }
    const actionIdHex = [...actionId].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    this.record?.('TREE_CHOPPED', 'tree-01', { actionId: actionIdHex, signature: sent.signature, slot: sent.slot, health: erTree.health, nonce: erTree.nonce, source: 'magicblock-er' });
    this.record?.('AUTHORITATIVE_STATE_VERIFIED', 'tree-01', { actionId: actionIdHex, signature: sent.signature, slot: sent.slot, health: erTree.health, nonce: erTree.nonce, source: 'magicblock-er' });

    proposal.status = 'EXECUTED';
    this.record?.('ACTION_STATUS_CHANGED', proposal.agentId, { proposalId: proposal.id, status: 'EXECUTED', execution: 'magicblock-er', signature: sent.signature });
    const commitResult = await this.commitAndVerifyBase(proposal.id, erTree);
    proposal.status = 'VERIFIED';
    this.record?.('ACTION_STATUS_CHANGED', proposal.agentId, { proposalId: proposal.id, status: 'VERIFIED', execution: 'magicblock-er', signature: sent.signature, commitSignature: commitResult.signature });
    return { signature: sent.signature, stage: 'verified', slot: commitResult.slot, tree: commitResult.tree, cluster: 'devnet' };
  }

  async readRealtimeState(treeId: string): Promise<AuthoritativeTreeState> {
    this.assertTreeId(treeId);
    await this.assertProgramDeployed();
    if (!(await this.routerConnection.getDelegationStatus(this.treeAddress)).isDelegated) {
      throw new Error('Tree is not delegated; read its base Solana state before ER access.');
    }
    return this.readOn(this.ephemeralConnection, 'er-read', this.wallet.publicKey);
  }

  async commitWorldState(treeId: string): Promise<ChainOperationResult> {
    this.assertTreeId(treeId);
    await this.assertProgramDeployed();
    if (!(await this.routerConnection.getDelegationStatus(this.treeAddress)).isDelegated) {
      throw new Error('Tree is already committed or has not been delegated.');
    }
    const tree = await this.readOn(this.ephemeralConnection, 'commit-read', this.wallet.publicKey);
    this.assertOwner(tree);
    const result = await this.commitAndVerifyBase('manual-commit', tree);
    return { signature: result.signature, stage: 'verified', slot: result.slot, tree: result.tree, cluster: 'devnet' };
  }

  async commitAndUndelegate(treeId: string): Promise<ChainOperationResult> {
    this.assertTreeId(treeId);
    await this.assertProgramDeployed();
    if (!(await this.routerConnection.getDelegationStatus(this.treeAddress)).isDelegated) {
      throw new Error('Tree is not delegated and cannot be undelegated.');
    }
    const tree = await this.readOn(this.ephemeralConnection, 'undelegate-read', this.wallet.publicKey);
    this.assertOwner(tree);
    const ix = await this.commitInstruction('commit_and_undelegate_tree');
    const erSent = await this.sendConfirmed(this.ephemeralConnection, ix, 'commit-and-undelegate', treeId);
    await this.verifyErTransaction(erSent.signature, 'ER commit-and-undelegate transaction is missing or failed.');
    const baseSignature = await GetCommitmentSignature(erSent.signature, this.ephemeralConnection);
    const baseResult = await this.verifyBaseCommit(baseSignature, tree, true);
    this.record?.('WORLD_STATE_COMMITTED', treeId, { erSignature: erSent.signature, settlementSignature: baseSignature, health: baseResult.tree.health, nonce: baseResult.tree.nonce, slot: baseResult.slot });
    this.record?.('WORLD_STATE_UNDELEGATED', treeId, { signature: erSent.signature, settlementSignature: baseSignature, slot: baseResult.slot });
    return { signature: erSent.signature, stage: 'verified', slot: baseResult.slot, tree: baseResult.tree, cluster: 'devnet' };
  }

  disconnect(): void {}

  private async commitAndVerifyBase(actionId: string, expected: AuthoritativeTreeState): Promise<{ signature: string; slot: number; tree: AuthoritativeTreeState }> {
    const ix = await this.commitInstruction('commit_tree');
    const erSent = await this.sendConfirmed(this.ephemeralConnection, ix, 'commit-tree', actionId, actionId);
    await this.verifyErTransaction(erSent.signature, 'ER commit transaction is missing or failed.');
    const baseSignature = await GetCommitmentSignature(erSent.signature, this.ephemeralConnection);
    const result = await this.verifyBaseCommit(baseSignature, expected, false);
    this.record?.('WORLD_STATE_COMMITTED', 'tree-01', { erSignature: erSent.signature, settlementSignature: baseSignature, slot: result.slot, health: result.tree.health, nonce: result.tree.nonce });
    this.record?.('AUTHORITATIVE_STATE_VERIFIED', 'tree-01', { signature: baseSignature, slot: result.slot, health: result.tree.health, nonce: result.tree.nonce, source: 'solana-devnet-commit' });
    return { signature: baseSignature, ...result };
  }

  private async commitInstruction(name: 'commit_tree' | 'commit_and_undelegate_tree'): Promise<TransactionInstruction> {
    const keys: TransactionInstruction['keys'] = [
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: this.treeAddress, isSigner: false, isWritable: true },
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
        if (transaction.meta?.err) throw new Error(`${errorMessage} ${JSON.stringify(transaction.meta.err)}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(errorMessage);
  }

  private async verifyBaseCommit(signature: string, expected: AuthoritativeTreeState, expectUndelegated: boolean): Promise<{ slot: number; tree: AuthoritativeTreeState }> {
    const confirmation = await this.baseConnection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) throw new Error(`Base-layer settlement failed: ${JSON.stringify(confirmation.value.err)}`);
    const transaction = await this.baseConnection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!transaction || transaction.meta?.err) throw new Error('Base-layer commitment transaction is missing or failed.');
    const treeAccount = await this.baseConnection.getAccountInfo(this.treeAddress, 'confirmed');
    if (!treeAccount) throw new Error('Committed tree account is not available on base Solana.');
    if (expectUndelegated && !treeAccount.owner.equals(this.programId)) throw new Error('Undelegated tree PDA is not owned by the ASTrix program on base Solana.');
    const tree = await this.readOn(this.baseConnection, signature, this.wallet.publicKey);
    const delegationStatus = await this.routerConnection.getDelegationStatus(this.treeAddress);
    if (delegationStatus.isDelegated === expectUndelegated) throw new Error(`Tree delegation status mismatch after ${expectUndelegated ? 'undelegation' : 'commit'}.`);
    if (tree.health !== expected.health || tree.nonce !== expected.nonce || tree.state !== expected.state || tree.owner !== expected.owner) {
      throw new Error('Committed Solana tree account does not match the confirmed ER result.');
    }
    return { slot: transaction.slot, tree };
  }

  private async readOn(connection: Connection, reference: string, owner: PublicKey): Promise<AuthoritativeTreeState> {
    const account = await connection.getAccountInfo(this.treeAddress, 'confirmed');
    if (!account) throw new Error(`Tree PDA ${this.treeAddress.toBase58()} is not available at ${reference}.`);
    const delegated = connection === this.ephemeralConnection;
    const isExpectedOwner = delegated
      ? account.owner.equals(this.programId)
      : account.owner.equals(this.programId) || account.owner.equals(DELEGATION_PROGRAM_ID);
    if (!isExpectedOwner) throw new Error(`Tree PDA owner mismatch at ${reference}; got ${account.owner.toBase58()}.`);
    const tree = decodeTreeState(account.data, `${connection.rpcEndpoint}:${reference}`);
    if (tree.owner !== owner.toBase58()) throw new Error('Connected wallet does not own this tree state.');
    return tree;
  }

  private async waitForTree(connection: Connection, owner: PublicKey): Promise<AuthoritativeTreeState> {
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try { return await this.readOn(connection, 'delegation-confirmed', owner); } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error(`Delegated tree did not become readable from the ER: ${String(lastError)}`);
  }

  private async sendConfirmed(connection: Connection, ix: TransactionInstruction, operation: string, correlationId: string, proposalId?: string): Promise<{ signature: string; slot: number }> {
    let signature = '';
    try {
      const unsigned = new Transaction({ feePayer: this.wallet.publicKey }).add(ix);
      const blockhash = connection instanceof ConnectionMagicRouter
        ? await connection.getLatestBlockhashForTransaction(unsigned, { commitment: 'confirmed' })
        : await connection.getLatestBlockhash('confirmed');
      unsigned.recentBlockhash = blockhash.blockhash;
      this.record?.('TRANSACTION_AUTHORIZED', proposalId ?? 'tree-01', { operation, correlationId, proposalId, signer: this.wallet.publicKey.toBase58() });
      const signed = await this.wallet.signTransaction(unsigned);
      if (!signed.signature) throw new Error('Wallet returned a transaction without its signature.');
      signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: 'confirmed' });
      this.record?.('TRANSACTION_SUBMITTED', proposalId ?? 'tree-01', { operation, correlationId, proposalId, signature });
      const confirmation = await connection.confirmTransaction({ signature, ...blockhash }, 'confirmed');
      if (confirmation.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
      const transaction = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!transaction || transaction.meta?.err) throw new Error(`Confirmed transaction ${signature} could not be verified as successful.`);
      this.record?.('TRANSACTION_CONFIRMED', proposalId ?? 'tree-01', { operation, correlationId, proposalId, signature, slot: transaction.slot });
      return { signature, slot: transaction.slot };
    } catch (error) {
      this.record?.('CHAIN_OPERATION_FAILED', proposalId ?? 'tree-01', { operation, correlationId, proposalId, signature: signature || undefined, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async assertProgramDeployed(): Promise<void> {
    const program = await this.baseConnection.getAccountInfo(this.programId, 'confirmed');
    if (!program || !program.executable) {
      throw new Error(`ASTrix program ${this.programId.toBase58()} is not executable on Solana Devnet.`);
    }
  }

  private assertTreeId(treeId: string): void {
    if (treeId !== 'tree-01' || treeId !== this.config.treeId) throw new Error(`This deployed slice only supports configured tree-01 (received ${treeId}).`);
  }

  private assertOwner(tree: AuthoritativeTreeState): void {
    if (tree.owner !== this.wallet.publicKey.toBase58()) throw new Error('Connected human wallet is not this tree account owner.');
  }
}
