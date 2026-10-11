# Phase 6 — Open-ended agency and world building

Everything here is **LOCAL SIMULATION · NOT ONCHAIN**. No chain, wallet,
deploy, or paid-model work was done in this phase.

## Baseline (before changes)

- `main` did not typecheck: `searchNearbySite` was used in
  `WorldSimulation.ts` without being imported, so typecheck/build failed and
  one shelter test failed. One-line fix → 235 tests passing.
- Already in place from earlier work: blueprint registry (`lean-to`,
  `homestead`, `timber-cabin`, `thatched-cottage`), distinct cabin/cottage
  meshes, place-intent parsing ("far east of the camp", `X: 45, Z: -20`),
  missing-capability registry, model interpretation with provenance.

## Gaps found and fixed

1. **Houses silently relocated.** Coordinate-directed houses snapped to the
   nearest of three fixed plots, so "build a cabin at X:-6 Z:0" could land
   somewhere else. Houses with a requested site now use the same placement
   authority as shelters (`startSiteBuild`), sized by the blueprint
   footprint:
   - exact coordinates are built exactly there or refused
     (`CONSTRUCTION_FAILED reason=invalid-placement`, nothing spent);
   - approximate requests (relative/landmark) search within
     `HOUSE_SITE_TOLERANCE` (3.0) and record `{requested, chosen}` as
     `deviation` on the proposal and `CONSTRUCTION_STARTED`;
   - the worker walks first and pays once on arrival (no double spend on
     re-drives); plot houses without a location keep the legacy path.
2. **No footprint validation.** `validateSite(state, x, z, footprint)`
   replaces the shelter-only radius: bounds, camp, pond, trees, berry
   patches, wells, other structures (sum of footprints), loose
   branches/stones, workers. `HouseEntity.footprint` is optional for old saves.
3. **One structure per request.** "build three cottages along the northern
   edge" parses to one goal; `resolvePlaceSites` turns it into spaced
   sites (`edge` intents use the clearing edge, `CLEARING_EDGE = 7`). The
   planner builds the next unclaimed site; completion requires every site
   to be claimed by a distinct finished structure (`claimSites`). Several
   structures on one exact coordinate ask for clarification.
4. **"Cheapest house" asked instead of comparing.** It now picks the
   cheapest residence from real registry costs and explains the comparison.
5. **Capability statuses collapsed into one.** `assessGoal` distinguishes
   `available`, `missing-prerequisites` (e.g. stone axe without the basic
   axe; automatic house plots used up), `temporarily-unavailable` (all trees
   felled), `forbidden` (farm-01 lease held by the rollup) and
   `invalid-location` (exact site not buildable). Not-implemented mechanics
   stay in the existing missing-capability registry. Refusals happen before
   any goal/plan exists, so nothing is spent.
6. **Interpretation provenance.** Every admitted or refused request is
   journaled with its interpreter (`command` = deterministic parser,
   `model-interpretation` = model) and verdict; the Observatory shows the
   latest as `interpretation: …`.
7. **Model could not express location.** The interpretation schema accepts
   an optional `place` (exact / relative / near / edge). It is
   shape-validated (`validatePlaceIntent`) and then resolved by the same
   deterministic resolver and feasibility gate as typed commands; the model
   never supplies trusted coordinates.
8. **House render showed the roof early.** House bodies appear at the walls
   stage (1/3) and roofs at 2/3, driven only by authoritative progress;
   houses now emit `CONSTRUCTION_STAGE` frame/walls events like shelters.

## Verification

| Gate | Result | Kind of proof |
| --- | --- | --- |
| `npm run typecheck` | clean | static |
| `npm test` | 259 passed, 5 skipped | mocked/local simulation |
| `npm run build` | clean | static |
| `npm run verify:phase6` | pass, 0 browser errors | local browser simulation |
| `verify:browser`, `verify:phase3`, `verify:crafting`, `verify:shelter` | pass, 0 browser errors each | local browser simulation |

New tests: `src/simulation/phase6-placement.test.ts` (exact/approximate
placement, invalid sites without spending, unknown blueprint, stages,
replay hash, multi-site governed plan with exact-once spending, cancellation
mid-build, capability statuses, model place schema, footprint differences).

## Not done (out of scope or deferred)

- Free-form settlement layout (roads, zoning) — reported as a missing
  capability with an alternative.
- No live model run was made in this phase; model placement is covered by
  schema tests only.
