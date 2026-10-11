# AGENTS.md — ASTrix durable project instructions

## Thesis

An AI agent manages a living simulated world while staying observable,
verifiable, interruptible, and under meaningful human control. A model
claiming an outcome never constitutes the outcome; only an authoritative
state transition does.

## Architecture boundaries (load-bearing)

- The model proposes; the simulation disposes. Model output reaches world
  state only through `proposeAction → approve → execute → verify`.
- TrueForge runs the agent loop (sessions, streaming turns, cancellation).
  It is never the world authority and never mutates state directly.
- Authorization is separate from decision-making. LOW auto-executes under
  standing local policy; MEDIUM/HIGH stay PROPOSED until explicit human
  approval. A rejected or cancelled proposal must not produce its mutation.
- Renderer and Observatory are read-only views. No game state in meshes/DOM.
- Events are the audit trail: monotonic sequences, tick timestamps, bounded
  in-memory tail. Never fabricate chain receipts in local mode.

## Local vs. on-chain (no faking)

- Default is `LOCAL SIMULATION · NOT ONCHAIN`.
- The chain slice is one owner-signed `tree-01` PDA chop with real
  signatures and independent account verification. Local tests never count
  as chain evidence. No wallet creation, funding, deploys, or spends
  without explicit user approval.

## Secrets

- NVIDIA keys live only in `NVIDIA_NIM_API_KEY_A/B` environment variables;
  Gemini/OpenRouter keys only in `GEMINI_API_KEY` / `OPENROUTER_API_KEY`
  (see `.env.example`). Never hard-code, log, commit, or bundle them for
  the browser. Model reasoning traces are never logged or displayed.

## Verification before claiming

- Required gates: `npm run typecheck`, `npm test`, `npm run build`.
- Back up `artifacts/` before running browser verifiers that overwrite it.
- Distinguish mocked proof from live proof: mocked tests, live model
  replies, local actions, and on-chain transactions are four different
  claims. Report which one each result supports.
