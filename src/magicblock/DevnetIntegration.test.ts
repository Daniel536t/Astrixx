import { describe, expect, it } from 'vitest';

/**
 * Live Devnet lifecycle test — SKIPPED unless explicitly enabled.
 *
 * Enable only with a funded devnet deployer/owner wallet and separate
 * authorization:
 *   ASTRIX_LIVE_DEVNET=1 npm test -- src/magicblock/DevnetIntegration.test.ts
 *
 * The live path must produce, in order, real evidence for each step and fail
 * loudly otherwise:
 *   initialize (base) → delegate (router) → chop (ER) → verify ER
 *   account/nonce → commit → verify base account and delegation status.
 * Local simulation success is never accepted as chain evidence.
 */
const LIVE = process.env['ASTRIX_LIVE_DEVNET'] === '1';

describe.skipIf(!LIVE)('magicblock devnet lifecycle (LIVE)', () => {
  it('performs initialize → delegate → chop → commit with verified evidence', async () => {
    expect(process.env['ASTRIX_LIVE_DEVNET']).toBe('1');
    // Implemented in the operator-runbook step, not in CI: this placeholder
    // fails if reached without the required wallet/toolchain so a silent
    // pass can never be mistaken for chain proof.
    throw new Error(
      'Live devnet run requested but no funded owner wallet/toolchain is configured in this environment.',
    );
  });

  it('performs farm initialize → delegate → build → commit with verified evidence', async () => {
    // Farm slice live order with evidence checkpoints:
    //   1. initializeFarm() → signature + unbuilt/nonce-0 account read.
    //   2. delegateFarm() → router delegation TRUE + ER-readable unbuilt state.
    //   3. propose (HIGH, magicblock-er) → human approve → buildFarm() →
    //      ER signature + built/nonce+1/wood-3 account read.
    //   4. commit verified inside buildFarm (commit-tx + base account match).
    //   5. applyVerifiedFarmBuild() → local wood −3, farm-01 growing.
    // Each step throws (no silent pass) until a funded wallet is attached.
    throw new Error(
      'Live farm run requested but no funded authority wallet is configured in this environment.',
    );
  });
});

describe('magicblock devnet lifecycle (gate)', () => {
  it('documents the explicit opt-in gate', () => {
    expect(LIVE).toBe(process.env['ASTRIX_LIVE_DEVNET'] === '1');
  });
});
