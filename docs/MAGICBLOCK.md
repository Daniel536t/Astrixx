# MagicBlock integration plan and status

## Farm-construction slice (active work)

**Status: program COMPILES (`anchor build` green, `.so` + IDL generated, IDL↔client compatibility verified); DEPLOYED to Devnet (`Gd5DX…`, upgradeable); LOCALNET EXECUTION PROVEN (initialize → unbuilt, unauthorized build rejected, authorized build → built/nonce+1, stale-nonce replay rejected); CONSISTENCY EXPERIMENT COMPLETE ON DEVNET (counter delegated to EU ER, 5 hot increments with contiguous nonces, unauthorized/replay/timeout failure paths proven, partition drill with 3 no-merge resolutions, commit + undelegate with base verification — see `artifacts/chain-experiment-2026-10-10T14-12-27-658Z.json`); farm-01 PDA not yet initialized/delegated/built (next authorized step).** The wallet `2Rfq4UWFLmPhcKFbob1K2MbSCd4FkdwEnD7ycPM9HpR9` (deployment/owner key at `~/.config/solana/astrix-deploy.json`, chmod 600, outside the repo) is FUNDED (was 10 SOL devnet; deploys + experiment spend accounted).

### Local ER boundary (attempted, blocked)

A local Ephemeral Rollup replica cannot execute the delegation lifecycle: the MagicBlock delegation program (`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`) exists only on Devnet/Mainnet, and delegation transactions must land on a base layer that hosts it. Cloning it locally is impossible without its upgrade keypair. The `ephemeral-validator` binary (v0.14.10) was installed and probed, but exits without serving in this environment. Delegation/ER/commit coverage therefore rests on scripted-transport tests plus the real Devnet run once funded — never on a mock labeled as chain proof.

### Devnet funding required

- **Address:** `2Rfq4UWFLmPhcKFbob1K2MbSCd4FkdwEnD7ycPM9HpR9` (Devnet only — never mainnet, never real funds)
- **Purpose:** program deploy (payer) + farm/tree PDA rent + initialize/delegate/build/commit transaction fees. This wallet becomes the on-chain authority (owner) of farm-01.
- **Measured costs:** program deploy (366,312 bytes) = 2.5504224 SOL rent; farm PDA (75 bytes) = 0.00103124 SOL; tree PDA (76 bytes) = 0.00141984 SOL; ~8 transactions ≈ 0.00004 SOL fees.
- **Ask: 3 Devnet SOL** (≈2.553 measured + retry headroom), via Alchemy/faucet to the address above. After confirmation: `anchor deploy` → initialize → delegate → build → commit → verify, each signature recorded.

### Game integration (live)

Farm-01's delegated state is part of the running game: the backend serves keyless ER reads at `GET /api/farm/state`; the browser polls every 30s, grants the write lease to ER on verified reads, and shows `FARM · ER-BUILT #nonce · SLOT s` (or honest `STALE`/`LOCAL-ONLY`/`CONFLICT`). Construction status, nonce, wood cost, and authority are authoritative from ER; growth timing, harvest, positions, and stockpiles stay local. Harvest was deliberately kept local (per-minute frequency vs transaction cost; reversible +1 food vs irreversible construction) — no harvest instruction exists on-chain, and none is needed. Local farm BUILD defers while the ER lease is held.

### On-chain boundary

`FarmState` PDA `[b"farm", b"astrix-v1", b"farm-01"]` (67 bytes: discriminator 8 + schema 1 + world 9 + farm 7 + authority 32 + state 1 + nonce 8 + wood_spent 1):

- **On-chain enforces:** PDA seeds/world/farm identity, authority-only transitions, single construction (UNBUILT → BUILT once), nonce replay protection. It does NOT know the local wood balance.
- **Local enforces:** wood balance (3), plot availability (2 plots), worker presence, growth timing, harvest. The local deduction and farm creation happen only in `applyVerifiedFarmBuild`, which runs exclusively on signature-verified chain evidence.
- **Reconciliation:** verified chain BUILT ⇒ local farm-01 exists (growing). A verified chain result never fabricates local growth/harvest history.

Lifecycle: `initialize_farm` → `delegate_farm` (EU validator) → `build_farm(nonce, action_id, wood_spent)` → ER verify → `commit_farm` → base verify (`commit_and_undelegate_farm` supported). Stages emit `MAGICBLOCK_*` events only after the corresponding RPC fact; ambiguous confirmation timeouts record `confirmation-timeout-status-unknown`, never failure.

### Tree slice (prior work, preserved)

**Implementation status: testable MagicBlock/devnet slice added; no deployment or live chain proof.** Local simulation remains the default and `LocalWorldStateAdapter` continues to reject network operations without fabricating receipts. `MagicBlockDevnetAdapter` builds Anchor instructions with a human wallet, verifies Solana/ER RPC responses, and scopes functionality to an owner-controlled `tree-01` PDA. The Anchor program source defines initialization, owner-only delegation/chop/commit, replay-resistant nonce handling, and a fixed `TreeState` layout. Neither this program nor an IDL is deployed/generated in this environment; no wallet signature, transaction, delegation, or ER result has been produced. Offline program/client interface pins (program id, PDA seeds, 68-byte layout, local two-hit vs chain felling-blow alignment) are covered by `src/magicblock/ProgramInterface.test.ts`; live-devnet tests are gated behind `ASTRIX_LIVE_DEVNET=1` and stay skipped otherwise.

API/layout research checked 2026-10-09 against the installed TypeScript package and unpacked Rust SDK 0.17.3 proc-macros/CPI source plus the official docs/repositories below. The target Rust/Anchor/Solana toolchain is absent, so compiler/API compatibility and all live transaction semantics remain unverified.

## Current official integration path

- [MagicBlock ER Quickstart](https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/quickstart) describes a conventional Solana program upgraded with the Rust `ephemeral-rollups-sdk` Anchor integration. Its current program-side API includes `#[ephemeral]`, `#[delegate]`, `DelegateConfig`, and `MagicIntentBundleBuilder`; the builder's `commit`, `commit_and_undelegate`, and post-commit actions replace older commit helpers. A PDA is initialized/owned on base Solana, delegated through the delegation program to a chosen ER validator, executed/read through the selected ER RPC, then committed or committed-and-undelegated from the ER. Current public devnet endpoints include base RPC `https://api.devnet.solana.com`, Router `https://devnet-router.magicblock.app`, and ERs such as `https://devnet-eu.magicblock.app`.
- The official [`ephemeral-rollups-sdk` repository](https://github.com/magicblock-labs/ephemeral-rollups-sdk) distinguishes its Rust program SDK from two TypeScript clients: `@magicblock-labs/ephemeral-rollups-sdk` for `@solana/web3.js` and `@magicblock-labs/ephemeral-rollups-kit` for `@solana/kit`. This implementation uses the former for its browser client; the Rust program source depends on the official Rust SDK.
- The official [MagicBlock Engine Examples](https://github.com/magicblock-labs/magicblock-engine-examples) now lists the active Anchor counter and session-key programs; older pre-Anchor-1.0 programs are clearly in `00-LEGACY_EXAMPLES`. The examples document local integration testing with `@magicblock-labs/ephemeral-validator` (base validator + ER), then program-specific build and tests.
- [Official Session Keys docs](https://docs.magicblock.gg/pages/tools/session-keys/introduction) describe temporary keys scoped by instruction and program-defined limits (e.g. expiry/transaction limits). The maintained [Session Keys Anchor example](https://github.com/magicblock-labs/magicblock-engine-examples/tree/main/session-keys/anchor) uses `session_keys::session_auth_or` and `SessionTokenManager` from `@magicblock-labs/gum-sdk`. Session Keys are not part of this slice; any future agent session needs separate authorization and strict program-defined limits. A browser agent key must never be the owner wallet.

## Implemented minimum slice: one tree chop

### Program and state

The Anchor program source uses a PDA with fixed seeds `[b"tree", b"astrix-v1", b"tree-01"]`. Its `TreeState` contains schema `u8`, fixed world/tree identifiers `[u8; 9]` and `[u8; 7]`, owner `Pubkey`, health/max-health `u8`, action nonce `u64`, depleted `bool` (68 bytes including the Anchor discriminator). Initialization sets health/max-health to 1. Owner-signed `chop_tree(expected_nonce, action_id)` validates PDA/IDs, owner, standing state and nonce, then sets health to 0, marks depleted and increments the nonce. No Session Key path exists; the connected human owner signs directly. This transition does not move the worker, create a local log or update unrelated simulation entities.

The browser adapter uses installed `@solana/web3.js` and `@magicblock-labs/ephemeral-rollups-sdk`, derives delegation PDAs with SDK helpers, builds Anchor instructions and decodes the fixed account layout. Local simulation remains default; network use requires a connected human wallet and deployed executable program.

### Chop lifecycle alignment (local two-hit vs on-chain felling blow)

Local trees take **two** chop hits: the first emits `TREE_DAMAGED` (health
2→1) and keeps the GATHER proposal executing; only the felling blow emits
`TREE_CHOPPED` (health 1→0) and creates the log. The on-chain `chop_tree`
models exactly the felling blow (health 1→0, depleted, nonce+1). Reconciling
a verified chain felling over a fresh local tree therefore transitions local
presentation 2→0 directly via `LOCAL_STATE_RECONCILED` without fabricating a
local log. See `src/magicblock/ProgramInterface.test.ts`.

### End-to-end path

1. Human wallet initializes the tree PDA on **Solana devnet**, pays rent/deployment fees, and remains the owner.
2. This prototype uses the connected human owner's wallet signer for the chop; there is no agent/session-key path. Do not give the browser agent owner-wallet secrets.
3. Owner delegates that program-owned PDA from base devnet to the pinned EU validator using the official Anchor `#[delegate]` macro and generated accounts. Wait for Router confirmation and fetch the account through the ER RPC, checking owner/schema/nonce.
4. A governance-permitted `GATHER` proposal targeting `tree-01` is mapped to `chop_tree`. Permission and wallet authorization are separate. Submit to the ER RPC using the TypeScript adapter and human signer. Record only an RPC-returned signature, confirm it and inspect the transaction result.
5. Read the tree account back from the ER at the confirmed slot, decode with the program IDL, and verify expected `health`, owner, and incremented nonce. Only then emit `AUTHORITATIVE_STATE_VERIFIED` and apply monotonic local presentation reconciliation. Never let conflicting local ticks erase confirmed chain state.
6. Commit from the ER with the documented `MagicIntentBundleBuilder` API; use commit-and-undelegate when returning authority to base Solana. Verify the real ER transaction and subsequent base account ownership/data/commit status separately. Do not call this settled merely because delegation or an ER transaction succeeded.

### Client boundary, events, and failure behavior

Keep `WorldStateAdapter` independent from renderer/simulation. The adapter returns typed real transaction results and decoded account state or throws. Stage events are distinct: proposal, governance permission, transaction authorization, submission, confirmation, authoritative account verification, commit/undelegation, and local reconciliation. Failures get a truthful failure event and must not synthesize a local successful chop. Use a stable nonce/action id for replay resistance; on an ambiguous timeout, query the signature and authoritative account before deciding to retry. If the client goes offline, retain confirmed chain state and mark pending local presentation as pending/conflicted rather than silently replacing authority. Keep current `LocalWorldStateAdapter` for fully working local demo mode.

## Deployment and decisions still open

- This checkout has `Anchor.toml`, Cargo manifests and a Devnet adapter, but the environment has no `rustc`, `cargo`, `anchor` or `solana` executable. No wallet was created/funded or used. We did not install the toolchain, generate an IDL, build/deploy the program, or send transactions.
- Before any deployment, a project operator must select/confirm the devnet wallet and RPC/ER region, make available a funded devnet deployer/owner wallet and explicitly approve program deployment/fee spend. If agent Session Keys are added later, separately approve creation of a narrowly scoped temporary session. Never paste secrets into project files, browser code, logs, or screenshots.
- Before rollout: validate the exact Anchor 1.0.2/Rust 1.89/Solana 3.1.9 compatibility in a real build; generate and check in a matching IDL; exercise the program and delegation macro against an ephemeral-validator integration environment; review/confirm the pinned devnet validator; decide whether a future agent Session Key is needed. The current one-hit chop is intentionally terminal for this prototype.
- The client/account tests and source program are an uncompiled implementation checkpoint—not genuine chain proof. End-to-end proof remains blocked until Rust/Anchor/Solana tools are present, the program builds and is deployed to Devnet, and a funded owner wallet performs initialize → delegate → chop → verify ER account/nonce → commit → verify base account and delegation status (or commit-and-undelegate). Preserve actual signatures and decoded states as evidence. No live results are claimed.
