# Crafting slice — raw materials to changed capability

## What it is

Branches and stones are collectible (`COLLECT` → personal inventory,
capacity-enforced), and two recipes execute end-to-end through governed
proposals (`CRAFT` at the camp):

- **Stone axe** — 3 branches + 2 stones, requires the basic axe. Fells trees
  in one blow instead of two (chop damage 1 → 2; no `TREE_DAMAGED`).
- **Carrying basket** — 4 branches. Raises pack capacity 10 → 15. One per
  inhabitant; re-weaving is refused.

Recipes live in `src/game/recipes.ts` and are DATA: the engine, the planner,
the validators, and the model prompt all read the same registry.

## Resource policy (tested)

- Collection removes the world object (`ground` → `collected`) only on
  successful arrival; a full pack or a taken branch fails the proposal and
  consumes nothing.
- Crafting consumes inputs **exactly once at completion**, after re-validating
  prerequisites (the world may change mid-work). Cancelling or interruption
  before completion costs nothing. Losing materials mid-craft fails honestly
  (`CRAFTING_FAILED`) with the remainder untouched.
- A rejected or held craft executes nothing and consumes nothing.

## Planning

`craft` goals carry a recipe id. The planner closes the material deficit
first (nearest available branch/stone, pack space respected), crafts only
when inputs are satisfied, stops when the output is owned, and reports
blocked (never spins) when nothing remains to collect. Different seeds and
depletion states produce different collection routes for the same goal.
`make a bow / granary / knife` answers honestly: those mechanics do not
exist yet — only stone axe and basket are offered.

## Governance (unchanged contracts)

`COLLECT`/`CRAFT` are registered action types everywhere `GATHER` is:
`ActionType`, `SUPPORTED_ACTION_TYPES`, TrueForge JSON schema, MCP
`ProposeActionArgs`/`listActions`, plan authority (`craft` plans allow
`COLLECT, CRAFT, DELIVER, MOVE_TO`), execution-time validation, and
`verifyAction` postconditions. Both are LOW risk (personal inventory, never
shared stockpiles or plots); only `BUILD` forces HIGH. Refusals settle
explicitly (`refuseAction`) so no adopted or directive proposal strands
`EXECUTING`. Replay covers the new state (inventory, equipment, collected
flags) through the existing input log — no new input kinds were needed.

## Acceptance

`npm run verify:crafting` loads a real wilderness, asserts the idle boot,
issues **make a better axe** through the command UI, and proves: 5
`MATERIAL_COLLECTED` events, empty pack, equipped stone axe, completed craft
plan with verified steps, only LOW terminal proposals — then a one-blow fell
(`TREE_CHOPPED` with no `TREE_DAMAGED`). Screenshots in
`artifacts/astrix-craft-*.png`, report in `artifacts/crafting-browser-report.json`.

## Deferred (explicitly not claimed)

Knife, arrows, bows, granaries, binding materials, durability, skill trees.
Weapons wait on hunting mechanics; the registry refuses decorative outputs.
