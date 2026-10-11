# Wilderness Foundation — Phase 1 record

## What changed (implementation assignment, stages 1–2 of 7)

Genesis is now wilderness (`src/world/createWorld.ts`, seeded, default
`astrix-wilderness-v1`): one inhabitant (`worker-01`) with a real starting
axe (`equipment.axe = 'basic-axe'`), personal inventory + capacity, six
standing trees, two berry patches, four branches, four stones, one pond
(`pond-01`, harvestable water source with full parity to wells), and one
deer with a deterministic wander/flee loop. No houses, farms, villagers,
wells, or extra workers at genesis. Berry patches regrow after 60 sim-seconds
(renewable forage crank, parallel to farm regrow/sapling maturation).

The browser boots idle: with no goal the sim runs `ManualAgent`, so the
inhabitant waits (`Moss is waiting for your signal`) and no tree-cutting
starts. Goal commands (`gather wood`, `gather food`) drive governed plans
through the existing proposal/approval/verification contracts, unchanged.

Presentation follows authority: camp anchor renders as a fire ring/bedroll/
crate (never a cabin), plot fences appear only while a farm exists, and
branch/stone/pond/animal views track authoritative state.

## Deliberate decisions and deviations

- `settlement-01` still exists as an internal delivery/BUILD anchor and the
  Farm-01 lease target. Removing it now would break delivery attribution,
  BUILD targeting, and the preserved chain integration; Phase 4 replaces it
  with inventory storage. It is documented as a camp, renders as a camp.
- The local agent backend (`:5193`) reports farm-01 built, so browser runs
  reconcile a real farm-01 at boot (chain truth wins; `delegated-harvested`
  branch). Both verifiers cover the local-only and delegated branches.
- `runDuel` builds its 3-worker crew into the duel genesis (pre-snapshot),
  keeping its replay exact; wilderness genesis itself stays single-inhabitant.
- `GoalRunner` no-step turns advance 400 ticks so regrow/maturation cranks
  can unblock waiting goals instead of spinning zero-time turns.

## Governance preserved

Risk ranks, LOW-only auto-approval, HIGH BUILD holds, rejection/cancel
semantics, plan lifecycle/expiry, input-log replay (golden hash regenerated
for the new genesis: `0017f54ad5a13be5`), and local-vs-chain honesty are
untouched. All adapted tests keep their original assertions under the new
genesis; nothing was weakened to pass.

## Not yet built (later phases)

Branch/stone collection, recipe registry, improved-tool crafting, capability
registry, shelter construction, movement obstacles, additional inhabitants,
and Observatory text refreshes (`SETTLEMENT STOCKPILE`, `TREE TO CABIN`).
`WorkerEntity.inventory/equipment` fields exist; no action reads them yet.
