/**
 * Phase 6 acceptance (LOCAL SIMULATION · NOT ONCHAIN): player-directed,
 * blueprint-driven construction through the real command box.
 *
 * 1. "build the cheapest house" resolves by comparing real costs.
 * 2. An invalid exact site (inside the camp) is refused with nothing spent.
 * 3. A timber cabin at an exact coordinate is built exactly there.
 * 4. A thatched cottage far east of the camp is built nearby (deviation recorded if any).
 * 5. An unsupported request reports the missing capability.
 * Screenshots show two visibly distinct residential designs.
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
  await page.screenshot({ path: path.join(output, filename), timeout: 30000 });
  shots[key] = `artifacts/${filename}`;
};
const snapshot = () => page.evaluate(() => {
  const state = window.__ASTRIX_E2E__?.state;
  if (!state) throw new Error('Local E2E state is not available');
  const worker = state.entities['worker-01'];
  return {
    tick: state.tick,
    wood: state.wood,
    branches: worker?.kind === 'worker' ? (worker.inventory.branch ?? 0) : 0,
    houses: Object.values(state.entities).filter((e) => e.kind === 'house').map((e) => ({ id: e.id, blueprint: e.blueprint, state: e.state, pos: e.position, footprint: e.footprint })),
    events: state.events.filter((e) => e.type.startsWith('CONSTRUCTION')).map((e) => ({ type: e.type, entity: e.entityId, data: e.data })),
    proposals: state.proposals.map((p) => ({ id: p.id, actionType: p.actionType, status: p.status, parameters: p.parameters })),
    journal: state.journal.map((j) => ({ source: j.source, verdict: j.verdict, candidates: j.candidates })),
  };
});
// Feedback is overwritten by later plan/approval notices, so collect every
// message shown after the submit.
const submit = async (text) => {
  await page.evaluate(() => {
    const el = document.querySelector('[data-command-feedback]');
    window.__phase6Feedback = [];
    window.__phase6Observer?.disconnect();
    window.__phase6Observer = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) window.__phase6Feedback.push(n.textContent ?? '');
    });
    window.__phase6Observer.observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.locator('[data-command-input]').fill(text);
  await page.locator('[data-command-form]').evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(600);
  return page.evaluate(() => window.__phase6Feedback.join(' | '));
};
const approveAllPending = async () => {
  const buttons = page.locator('[data-approval-action="approve"]');
  while ((await buttons.count()) > 0) {
    await buttons.nth(0).click();
    await page.waitForTimeout(150);
  }
};
// Stock materials through the E2E harness so the run focuses on placement.
const stock = (wood, branches) => page.evaluate(([w, b]) => {
  const state = window.__ASTRIX_E2E__.state;
  state.wood = w;
  const worker = state.entities['worker-01'];
  if (worker?.kind === 'worker') worker.inventory = b > 0 ? { branch: b } : {};
}, [wood, branches]);
const waitHouse = async (pred, timeout = 240000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    await approveAllPending();
    const s = await snapshot();
    if (pred(s)) return s;
    await page.waitForTimeout(500);
  }
  const s = await snapshot();
  const extra = await page.evaluate(() => ({
    goal: document.querySelector('[data-goal]')?.textContent,
    feedback: document.querySelector('[data-command-feedback]')?.textContent,
    plans: Object.values(window.__ASTRIX_E2E__.state.plans).map((p) => ({ id: p.id, kind: p.kind, status: p.status, steps: p.steps.slice(-3) })),
    worker: window.__ASTRIX_E2E__.state.entities['worker-01'],
  }));
  throw new Error(`Timed out waiting for house condition: ${JSON.stringify({ tick: s.tick, wood: s.wood, houses: s.houses, proposals: s.proposals.slice(-4), events: s.events.slice(-4), journal: s.journal.slice(-4), ...extra }).slice(0, 4000)}`);
};
const goalActive = () => page.locator('[data-goal]').textContent();

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('canvas')?.width > 0 && Boolean(window.__ASTRIX_E2E__));
  await page.waitForTimeout(1500);
  await page.locator('[data-mode-button="delegated"]').click().catch(() => {});
  await capture('initial', 'astrix-phase6-initial.png');

  // 1. Cheapest compares real costs.
  const cheapest = await submit('build the cheapest house');
  if (!/homestead/i.test(cheapest ?? '') || !/cabin.*4 wood/i.test(cheapest ?? '')) throw new Error(`Cheapest did not compare costs: ${cheapest}`);
  await submit('cancel goal');

  // 2. Invalid exact site: refused at interpretation, nothing spent.
  await stock(4, 0);
  const refused = await submit('build a timber cabin at X: 0, Z: 0');
  if (!/invalid location/i.test(refused ?? '')) throw new Error(`Invalid exact site was not refused: ${refused}`);
  const afterRefusal = await snapshot();
  if (afterRefusal.wood !== 4 || afterRefusal.houses.length !== 0) throw new Error('Invalid exact site spent or built');
  if (!afterRefusal.journal.some((j) => j.verdict === 'capability-invalid-location')) throw new Error('Refusal not journaled');

  // 3. Exact cabin, built exactly there.
  const cabinFeedback = await submit('build a timber cabin at X: -6, Z: 0');
  if (!(await goalActive())?.includes('ACTIVE')) throw new Error(`Cabin goal not active: ${cabinFeedback}`);
  await waitHouse((s) => s.houses.some((h) => h.blueprint === 'timber-cabin' && h.state === 'construction'));
  await capture('cabinConstruction', 'astrix-phase6-cabin-construction.png');
  const cabinDone = await waitHouse((s) => s.houses.some((h) => h.blueprint === 'timber-cabin' && h.state === 'complete'));
  const cabin = cabinDone.houses.find((h) => h.blueprint === 'timber-cabin');
  if (cabin.pos.x !== -6 || cabin.pos.z !== 0) throw new Error(`Exact cabin relocated: ${JSON.stringify(cabin.pos)}`);
  if (cabinDone.wood !== 0) throw new Error(`Cabin spend wrong: wood=${cabinDone.wood}`);

  // 4. Approximate cottage far east of camp.
  await stock(2, 2);
  await submit('build a thatched cottage far east of the camp');
  const cottageDone = await waitHouse((s) => s.houses.some((h) => h.blueprint === 'thatched-cottage' && h.state === 'complete'));
  const cottage = cottageDone.houses.find((h) => h.blueprint === 'thatched-cottage');
  if (cottage.pos.x < 3) throw new Error(`Cottage not east of camp: ${JSON.stringify(cottage.pos)}`);
  const cottageStart = cottageDone.events.find((e) => e.type === 'CONSTRUCTION_STARTED' && e.entity === cottage.id);
  if (cottageStart?.data.woodSpent !== 2 || cottageStart?.data.branchSpent !== 2) throw new Error(`Cottage recipe not honored: ${JSON.stringify(cottageStart?.data)}`);
  await page.waitForTimeout(800);
  await capture('twoDesigns', 'astrix-phase6-two-designs.png');

  // 5. Missing capability is explained, not guessed.
  const bridge = await submit('build a bridge over the river');
  if (!/not implemented|no river|river/i.test(bridge ?? '')) throw new Error(`Bridge not explained: ${bridge}`);

  const done = await snapshot();
  const live = done.proposals.filter((p) => ['PROPOSED', 'APPROVED', 'EXECUTING'].includes(p.status));
  if (live.length) throw new Error(`Stranded proposals: ${JSON.stringify(live)}`);
  const report = {
    url: base,
    mode: 'LOCAL SIMULATION · NOT ONCHAIN — Phase 6 placement & blueprints',
    cheapestFeedback: cheapest,
    refusedFeedback: refused,
    houses: done.houses,
    cottageDeviation: cottageStart?.data.deviation ?? null,
    interpretationJournal: done.journal.filter((j) => j.verdict.startsWith('interpreted') || j.verdict.startsWith('capability-') || j.verdict.startsWith('missing-capability')),
    browserErrors: errors,
    screenshots: shots,
  };
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  await fs.writeFile(path.join(output, 'phase6-browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
