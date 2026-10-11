/**
 * Shelter-slice acceptance: the visible civilization step.
 *
 * Loads a real wilderness, asserts no prebuilt shelter, issues
 * "build a shelter" through the product command interface, approves the
 * HIGH plan like a human would, watches staged construction in authoritative
 * state, proves invalid placement spends nothing, then rests in the finished
 * shelter through the governed directive path. Asserts the paper trail —
 * proposals, events, exact-once spending — never just the end state.
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
const shelterState = () => page.evaluate(() => {
  const state = window.__ASTRIX_E2E__?.state;
  if (!state) throw new Error('Local E2E state is not available');
  const worker = state.entities['worker-01'];
  return {
    tick: state.tick,
    wood: state.wood,
    proposals: state.proposals.map((p) => ({ id: p.id, actionType: p.actionType, target: p.targetEntityId, status: p.status, risk: p.riskLevel, parameters: p.parameters })),
    events: state.events.map((e) => ({ type: e.type, entity: e.entityId, data: e.data })),
    worker: worker?.kind === 'worker'
      ? { activity: worker.activity, carrying: worker.carrying, inventory: worker.inventory, restedUntilTick: worker.restedUntilTick, pos: worker.position }
      : null,
    shelters: Object.values(state.entities).filter((e) => e.kind === 'shelter').map((e) => ({ id: e.id, state: e.state, progress: e.progress, pos: e.position })),
    plans: Object.values(state.plans).map((p) => ({ id: p.id, kind: p.kind, status: p.status, steps: p.steps })),
    camp: state.entities['settlement-01']?.position,
    pond: (() => { const p = state.entities['pond-01']; return p?.kind === 'pond' ? { pos: p.position, radius: p.radius } : null; })(),
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
// HIGH proposals hold for a human in every mode: approve like one.
const approvePending = async () => {
  await page.waitForFunction(
    () => document.querySelectorAll('[data-approval-action="approve"]').length > 0,
    null,
    { timeout: 120000 },
  );
  await page.locator('[data-approval-action="approve"]').nth(0).click();
};

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('canvas')?.width > 0 && Boolean(window.__ASTRIX_E2E__));
  await page.waitForTimeout(2000);
  const boot = await shelterState();
  if (boot.shelters.length !== 0) throw new Error('Fresh wilderness begins with a shelter');
  await capture('initial', 'astrix-shelter-initial.png');

  // --- "Build a shelter." through the real command interface.
  await issueGoal('build a shelter');
  const goalLine = await page.locator('[data-goal]').textContent();
  if (!goalLine?.includes('BUILD 1 SHELTER')) throw new Error(`Goal line did not name the shelter: ${goalLine}`);
  await approvePending();

  // Best-effort mid-construction capture (6 sim-seconds of work).
  await page.waitForFunction(() => {
    const state = window.__ASTRIX_E2E__?.state;
    return Object.values(state.entities).some((e) => e.kind === 'shelter');
  }, null, { timeout: 420000 });
  await capture('construction', 'astrix-shelter-construction.png');
  await page.waitForFunction(() => {
    const state = window.__ASTRIX_E2E__?.state;
    return Object.values(state.entities).some((e) => e.kind === 'shelter' && e.state === 'complete');
  }, null, { timeout: 240000 });
  await capture('complete', 'astrix-shelter-complete.png');
  const done = await shelterState();

  // One shelter, staged honestly, spent exactly once.
  if (done.shelters.length !== 1 || done.shelters[0].state !== 'complete') {
    throw new Error(`Expected one complete shelter: ${JSON.stringify(done.shelters)}`);
  }
  const started = done.events.find((e) => e.type === 'CONSTRUCTION_STARTED' && e.data.structureType === 'shelter');
  if (!started || started.data.woodSpent !== 2 || started.data.branchSpent !== 2) {
    throw new Error(`Shelter recipe not honored: ${JSON.stringify(started?.data)}`);
  }
  const stages = done.events.filter((e) => e.type === 'CONSTRUCTION_STAGE');
  if (stages.length !== 2) throw new Error(`Expected 2 construction stages, saw ${stages.length}`);
  if (!done.events.some((e) => e.type === 'CONSTRUCTION_COMPLETED' && e.entity === done.shelters[0].id)) {
    throw new Error('No verified CONSTRUCTION_COMPLETED for the shelter');
  }
  const plan = done.plans.find((p) => p.kind === 'construct-shelter');
  if (!plan || plan.status !== 'completed') throw new Error(`Shelter plan not completed: ${JSON.stringify(done.plans)}`);
  const live = done.proposals.filter((p) => ['PROPOSED', 'APPROVED', 'EXECUTING'].includes(p.status));
  if (live.length !== 0) throw new Error(`Stranded live proposals: ${JSON.stringify(live)}`);

  // Footprint honesty, checked against the world the sim actually holds.
  const site = done.shelters[0];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  if (dist(site.pos, done.camp) < 2.8) throw new Error('Shelter overlaps the camp');
  if (done.pond && dist(site.pos, done.pond.pos) < done.pond.radius + 1.4) throw new Error('Shelter stands in the water');

  // --- Invalid placement spends nothing (governed directive path).
  // Directives do not wait for approval: issue, approve the held HIGH
  // proposal like a human, then drive again so the approved attempt executes.
  const woodBefore = done.wood;
  await page.evaluate(() => window.__ASTRIX_E2E__?.direct('BUILD', 'settlement-01', 'shelter-verify-bad-site', { structure: 'shelter', x: 0, z: 0 }));
  await approvePending();
  await page.evaluate(() => window.__ASTRIX_E2E__?.direct('BUILD', 'settlement-01', 'shelter-verify-bad-site', { structure: 'shelter', x: 0, z: 0 }));
  await page.waitForFunction(() => {
    const state = window.__ASTRIX_E2E__?.state;
    return state.events.some((e) => e.type === 'CONSTRUCTION_FAILED' && e.data?.structureType === 'shelter' && e.data?.reason === 'invalid-placement');
  }, null, { timeout: 120000 });
  const afterBad = await shelterState();
  if (afterBad.wood !== woodBefore) throw new Error(`Invalid build spent wood: ${woodBefore} → ${afterBad.wood}`);
  if (afterBad.shelters.length !== 1) throw new Error('Invalid build created a shelter');

  // --- Rest in the finished shelter: the promised benefit works.
  await page.evaluate((id) => window.__ASTRIX_E2E__?.direct('REST', id, 'shelter-verify-rest'), site.id);
  await page.waitForFunction(() => {
    const state = window.__ASTRIX_E2E__?.state;
    return state.events.some((e) => e.type === 'REST_COMPLETED');
  }, null, { timeout: 180000 });
  await capture('rest', 'astrix-shelter-rest.png');
  const rested = await shelterState();
  if (!((rested.worker?.restedUntilTick ?? 0) > rested.tick)) throw new Error('Rest did not grant the buff');
  const badge = await page.locator('[data-settlement]').textContent();
  if (!badge?.includes('RESTED')) throw new Error(`Observatory does not show the rested state: ${badge}`);

  const report = {
    url: base,
    mode: 'LOCAL SIMULATION — shelter slice acceptance',
    goal: goalLine,
    shelter: site,
    plan,
    restedUntilTick: rested.worker?.restedUntilTick,
    browserErrors: errors,
    screenshots: shots,
  };
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  await fs.writeFile(path.join(output, 'shelter-browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
