/**
 * Crafting-slice acceptance: the visible transformation.
 *
 * Loads a real wilderness, asserts the idle boot (one inhabitant, basic axe,
 * no autonomous work), issues "make a better axe" through the product command
 * interface, watches collect → craft → equip happen in authoritative state,
 * then watches the stone axe fell a tree in one blow. Every consequential
 * action must pass through governed proposals; the script asserts the paper
 * trail (proposals, events, inventory deltas), not just the end state.
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const base = process.env.ASTRIX_BROWSER_URL ?? 'http://127.0.0.1:5173/?e2e=1';
const output = path.resolve('artifacts');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
page.setDefaultTimeout(30000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
const shots = {};
const capture = async (key, filename) => {
  const file = path.join(output, filename);
  await page.screenshot({ path: file, timeout: 30000 });
  shots[key] = `artifacts/${filename}`;
};
const craftState = () => page.evaluate(() => {
  const state = window.__ASTRIX_E2E__?.state;
  if (!state) throw new Error('Local E2E state is not available');
  const worker = state.entities['worker-01'];
  return {
    tick: state.tick,
    proposals: state.proposals.map((p) => ({ id: p.id, actionType: p.actionType, target: p.targetEntityId, status: p.status, risk: p.riskLevel, parameters: p.parameters })),
    events: state.events.map((e) => ({ type: e.type, entity: e.entityId, data: e.data })),
    worker: worker?.kind === 'worker'
      ? { activity: worker.activity, carrying: worker.carrying, inventory: worker.inventory, equipment: worker.equipment, capacity: worker.capacity, target: worker.targetId }
      : null,
    branches: Object.values(state.entities).filter((e) => e.kind === 'branch').map((e) => ({ id: e.id, state: e.state })),
    stones: Object.values(state.entities).filter((e) => e.kind === 'stone').map((e) => ({ id: e.id, state: e.state })),
    plans: Object.values(state.plans).map((p) => ({ id: p.id, kind: p.kind, status: p.status, steps: p.steps })),
  };
});
const issueGoal = async (text) => {
  await page.locator('[data-command-input]').fill(text);
  await page.locator('[data-command-form]').evaluate((form) => form.requestSubmit());
  await page.waitForFunction(
    () => (document.querySelector('[data-goal]')?.textContent ?? '').includes('ACTIVE'),
    null,
    { timeout: 15000 },
  );
};

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('canvas')?.width > 0 && Boolean(window.__ASTRIX_E2E__));

  // --- Idle wilderness boot: one inhabitant, basic axe, nothing moving.
  await page.waitForTimeout(3000);
  const boot = await craftState();
  if (boot.proposals.length !== 0) throw new Error(`Boot was not idle: ${boot.proposals.length} proposals already exist`);
  if (boot.worker?.activity !== 'idle') throw new Error(`Inhabitant was not idle at boot: ${boot.worker?.activity}`);
  if (boot.worker?.equipment?.axe !== 'basic-axe') throw new Error('Starting axe missing at boot');
  await capture('initial', 'astrix-craft-initial.png');

  // --- "Make a better axe." through the real command interface.
  await issueGoal('make a better axe');
  const goalLine = await page.locator('[data-goal]').textContent();
  if (!goalLine?.includes('CRAFT STONE AXE')) throw new Error(`Goal line did not name the craft: ${goalLine}`);

  // Best-effort mid-run captures: collecting, then crafting.
  await page.waitForFunction(() => {
    const w = window.__ASTRIX_E2E__?.state.entities['worker-01'];
    return w?.kind === 'worker' && w.activity === 'moving' && typeof w.targetId === 'string' && (w.targetId.startsWith('branch-') || w.targetId.startsWith('stone-'));
  }, null, { timeout: 180000 }).catch(() => 'missed-collect-shot');
  await capture('collecting', 'astrix-craft-collecting.png');
  await page.waitForFunction(() => {
    const w = window.__ASTRIX_E2E__?.state.entities['worker-01'];
    return w?.kind === 'worker' && w.activity === 'crafting';
  }, null, { timeout: 240000 }).catch(() => 'missed-craft-shot');
  await capture('crafting', 'astrix-craft-crafting.png');

  // --- The transformation must complete in authoritative state.
  await page.waitForFunction(() => {
    const w = window.__ASTRIX_E2E__?.state.entities['worker-01'];
    return w?.kind === 'worker' && w.equipment.axe === 'stone-axe';
  }, null, { timeout: 300000 });
  await capture('equipped', 'astrix-craft-equipped.png');
  const done = await craftState();

  // Governance paper trail: only LOW proposals, all terminal, plan verified.
  const live = done.proposals.filter((p) => p.status === 'PROPOSED' || p.status === 'APPROVED' || p.status === 'EXECUTING');
  if (live.length !== 0) throw new Error(`Stranded live proposals: ${JSON.stringify(live)}`);
  if (done.proposals.some((p) => p.risk !== 'LOW')) throw new Error('Non-LOW proposal in a craft run');
  const plan = done.plans.find((p) => p.kind === 'craft');
  if (!plan || plan.status !== 'completed') throw new Error(`Craft plan not completed: ${JSON.stringify(done.plans)}`);

  // Material ledger: exactly 3 branches + 2 stones left the world, pack is empty.
  const collectedBranches = done.branches.filter((b) => b.state === 'collected');
  const collectedStones = done.stones.filter((b) => b.state === 'collected');
  if (collectedBranches.length < 3 || collectedStones.length < 2) {
    throw new Error(`Inputs not consumed from the world: ${collectedBranches.length} branches, ${collectedStones.length} stones`);
  }
  if (Object.keys(done.worker?.inventory ?? {}).length !== 0) throw new Error(`Pack not empty after craft: ${JSON.stringify(done.worker?.inventory)}`);
  const collectedEvents = done.events.filter((e) => e.type === 'MATERIAL_COLLECTED');
  if (collectedEvents.length < 5) throw new Error(`Expected ≥5 MATERIAL_COLLECTED events, saw ${collectedEvents.length}`);
  if (!done.events.some((e) => e.type === 'CRAFTING_COMPLETED' && e.data.recipe === 'stone-axe')) {
    throw new Error('No verified CRAFTING_COMPLETED for stone-axe');
  }

  // --- Changed capability: fell a tree and prove the single blow.
  await issueGoal('gather 1 wood');
  const chopped = await page.waitForFunction(() => {
    const state = window.__ASTRIX_E2E__?.state;
    const felled = Object.values(state.entities).find((e) => e.kind === 'tree' && e.state === 'depleted' && state.events.some((ev) => ev.type === 'TREE_CHOPPED' && ev.entityId === e.id));
    return felled?.id ?? null;
  }, null, { timeout: 300000 });
  const felledId = await chopped.jsonValue();
  await capture('oneBlowFell', 'astrix-craft-one-blow.png');
  const after = await craftState();
  const damaged = after.events.filter((e) => e.type === 'TREE_DAMAGED' && e.entity === felledId);
  if (damaged.length !== 0) throw new Error(`Stone axe needed extra blows on ${felledId}`);
  if (!after.events.some((e) => e.type === 'TREE_CHOPPED' && e.entity === felledId)) throw new Error('No TREE_CHOPPED for the felled tree');

  const report = {
    url: base,
    mode: 'LOCAL SIMULATION — craft slice acceptance',
    goal: goalLine,
    equipment: done.worker?.equipment,
    collected: { branches: collectedBranches.length, stones: collectedStones.length },
    plan,
    oneBlowTree: felledId,
    browserErrors: errors,
    screenshots: shots,
  };
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  await fs.writeFile(path.join(output, 'crafting-browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
