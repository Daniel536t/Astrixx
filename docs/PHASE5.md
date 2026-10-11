# Phase 5 — Wilderness to Shelter

## Baseline (before changes)

- `typecheck` clean, 175 tests passing, build clean, no git repo.
- Browser gates passing from the prior phase.

## Diagnosis: the three demonstrated problems

1. **Pause did not freeze the picture.** `frame()` in `main.ts` called
   `renderer.updatePresentation()` outside the pause guard, so smoke,
   shimmer, and limb oscillation kept moving while the sim was frozen.
   Simulation state was already pause-clean (fixed-step accumulator,
   capped at 0.1s/frame — frame-rate independent by construction).
2. **Scale incoherence.** Trees (~2.5u) barely exceeded the inhabitant
   (~1.1u); decorative rocks (0.26u) were indistinguishable from
   collectible stones; the deer stood as tall as the worker. Movement
   itself measured correctly: **2.35 units/sim-second**, monotonic
   convergence, step-exact replay — speed was never the defect (answer B,
   with a little D), so speed was documented, not multiplied.
3. **No shelter loop.** Houses built on fixed slots with slot-count-only
   validation, no collision, no benefit beyond a housing counter the
   single-inhabitant world never reads. Animal commands fell through to a
   generic "did not understand" clarification.

Two deeper defects found while implementing (both fixed, both tested):

4. **The builder invalidated its own site.** Walk steps of 0.376u can jump
   over the [1.2, 1.5] arrival window straight into the worker-exclusion
   radius; every later drive then failed validation against the builder
   itself, forever. Fix: `validateShelterSite(..., ignoreId)` — execution
   ignores the claimant; planning-time validation stays strict.
5. **Pay-on-first-drive double-spends.** Creation-time deduction re-ran on
   every walking re-entry. Fix: walk-first shape (like houses) — arrive,
   then deduct once; proposal- and plan-pinned sites keep every re-drive
   converging on the same ground.

## Changes

- `src/world/types.ts` — `ShelterEntity`, `REST` action, `resting`
  activity, `restedUntilTick`, `CONSTRUCTION_STAGE`/`REST_COMPLETED`
  events, shelter/rest constants.
- `src/game/shelter.ts` (new) — single placement authority:
  `validateShelterSite` (bounds, camp, pond, trees, patches, structures,
  materials, occupants) + deterministic `findShelterSite`.
- `src/simulation/WorldSimulation.ts` — `startShelterBuild` (walk-first,
  mixed purse deducted once on arrival, resume without re-pay,
  double-build refused), `stepRest` + rest buff (`workRate` 1.5× on all
  timed tasks), shelter stages in `stepBuildProgress`, `REST` execution,
  `construct-shelter` plan authority/risk/spend-cap.
- `src/game/goals.ts`, `planner.ts`, `interpret.ts` — `construct-shelter`
  goal, `build a shelter` parsing (before house rules), deficit-driven
  steps (wood → branches → build at sim-picked site), honest animal
  clarification (deer named, hunting/taming listed as unimplemented).
- `src/agent/*` — `REST` + shelter-BUILD registered in the decision
  contract, guide, prompt (shelters, wildlife, pack/equipment lines),
  JSON schema; observations gain `shelters` + optional `animals`.
- `src/mcp/astrixTools.ts` — `REST` in tool args and action list.
- `src/ui/Observatory.ts` — stage/rest labels and events, shelter count,
  `RESTED` marker, pack/axe line, shelter-aware build/rest text, chain
  visuals skip material/craft/shelter/rest events.
- `src/rendering/*` — lean-to shelter with progress-staged
  frame/roof/body, shelter dispatch, `RESTING` badge, worker facing
  eased toward travel (presentation only), stone-axe tint kept.
- Scale (presentation only, no sim/positions): trunks ×~1.3 thicker and
  taller, canopies larger, per-tree 0.9–1.2 id-hashed variation, boulders
  ×2.4 and bedded, deer ×0.8.
- `src/main.ts` — cosmetics frozen on pause; `BUILD N SHELTER` goal text;
  E2E `direct()` governed-directive hook for actions without command
  mapping (used by the shelter verifier for REST).
- `scripts/verify-shelter-browser.mjs` (new) + `verify:shelter` script.

## Shelter recipe and benefit

**2 stockpiled wood + 2 pocketed branches**, deducted once on arrival at
a validated site (2.8u from camp, clear of water/trees/structures, inside
9u bounds). Six sim-seconds of staged work (frame → walls → roof events),
verified completion. Benefit: **rest** — 4s at a complete shelter grants
1200 ticks of 1.5× timed-work speed, shown as `RESTED`, proven faster by
measurement (rested chop < unrested chop, same tree/axe/positions).

## Safety evidence

- Invalid sites (camp, water, trees, bounds, NaN, double-build) fail with
  `CONSTRUCTION_FAILED` and spend nothing (unit).
- Cancel mid-build keeps the site at partial progress; resume spends
  nothing further and completes (unit).
- Rest at a construction site or with full hands is refused (unit).
- Inputs-only gather→collect→build→rest run replays hash-exact (unit).
- Browser: fresh world has no shelter; invalid build spends no wood;
  rest grants the buff visibly; no console errors.

## Known limitations / next

- No obstacle avoidance: movement is straight-line and always converges,
  but walks through trees. Steering is the next movement item.
- `worker-02+` test spawns and duel crews predate shelters; multi-worker
  shelter races share proposals but were not contention-tested.
- Rest has no command mapping (E2E/model/MCP only); a `rest` goal can
  follow if survival pressure needs it.
- Observatory copy still says settlement/cabin in places; terrain is
  still visual-only for placement beyond bounds/water.
