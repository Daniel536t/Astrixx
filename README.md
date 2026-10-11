# ASTrix — The Living Clearing

A small, playable autonomous-world experiment for the MagicBlock real-time Solana hackathon. One deterministic local worker turns trees into delivered wood and gathers berries into settlement food. The proof is visual: the worker walks, chops, harvests, carries resources home, and the observatory records the causal event stream.

**Chain status: program compiles, no deployment or live transaction proof.** The local simulation remains the default (`LOCAL SIMULATION`) and makes no fabricated receipts. A narrow, human-wallet-signed MagicBlock Devnet farm-construction adapter and Anchor program (tree + farm slices, `anchor build` green) are present. The program is not deployed and no live transaction has occurred. See [MagicBlock status and proof criteria](docs/MAGICBLOCK.md).

## Run it

Requirements: Node.js 20.19+ (or 22.12+) and npm.

```sh
npm install
npm run dev
```

Open the local Vite URL printed by the command. Use **PAUSE AGENT** / **RESUME AGENT** to interrupt the policy. Choose **VIEW STRUCTURED EVENTS** to inspect recent JSON events and proposals. Build and checks:

```sh
npm run typecheck
npm test
npm run build
npm run verify:browser # Chromium/WebGL interaction and screenshot capture (with Vite running)
```

## Model-driven agent loop (server-side)

Copy `.env.example` to `.env` and fill in the two NVIDIA NIM credentials
(they never leave the server process). Start a local TrueForge server, then
the agent backend:

```sh
npx -y @truefoundry/trueforge --port 8790
npm run agent:server        # headless model loop on :5193 (labels runs trueforge|direct-nim)
npm run eval:models -- --models=poolside/laguna-xs-2.1   # repeatable model evaluation
npx tsx scripts/trueforge-smoke.ts <model-id>            # one live TrueForge turn
```

`npm run mcp:server` exposes the governed world tools (observe + propose
only) over MCP stdio for harness attachment. See
[architecture](docs/ARCHITECTURE.md) for the authority boundaries.

## Play the settlement

The browser game at the Vite URL has a command bar, Direct / Delegated /
Supervised mode buttons, a goal line, an approvals panel, and provider
status. Try:

- `gather food` — workers harvest and deliver; the stockpile changes.
- `build a house` — wood is gathered, then a HIGH-risk proposal holds for
  your APPROVE/REJECT click in the approvals panel.
- `build a bridge across the river` — honestly refused (no river exists).
- `cancel goal` — revoke delegation and resume ambient life.

Headless judge demo (all beats executed against the real sim, transcript in
`artifacts/`):

```sh
npx tsx scripts/demo-judge.ts [--live-interpret]
```

## Current vertical slice

- Stylized isometric woodland clearing with rolling ground, an organic clearing edge, an instanced meadow, winding worn path, original detailed cabin/worker, and Kenney CC0 broadleaf/oak/pine and stump GLBs.
- Fixed-step local simulation, stable entity IDs, typed ordered events, nearest-tree gathering policy, visible tree depletion, log creation/carry/delivery, berry harvesting/food transport, and settlement wood/food counters.
- `Agent` boundary (`observe`, `decide`, `proposeAction`, `executeAction`) supports replacement by a remote or model-backed agent later; observation/decision/proposal IDs are correlated in the event log.
- `ActionProposal` lifecycle and automatic approval **only** for `LOW` risk. Higher-risk proposals stay `PROPOSED` until `approveProposal()` is called; optional rejection is available.
- Three.js reads world state but never owns it. The replaceable catalog asynchronously loads four compact licensed GLBs with procedural fallback; repeated meadow details are instanced. See [asset provenance](docs/ASSET_PIPELINE.md).

See [architecture](docs/ARCHITECTURE.md), [MagicBlock implementation and proof plan](docs/MAGICBLOCK.md), and [asset pipeline](docs/ASSET_PIPELINE.md). `npm run verify:phase3` (start Vite first) captures the visual stages at desktop/tablet sizes and checks both local causal loops. The MagicBlock slice is source/client implemented but **not compiled or deployed** here because no Rust/Anchor/Solana binaries or owner wallet are available. The docs identify live deployment blockers and genuine end-to-end acceptance criteria.
