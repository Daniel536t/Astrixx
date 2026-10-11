import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const base = 'http://127.0.0.1:5173/?e2e=1';
const output = path.resolve('artifacts');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
page.setDefaultTimeout(45000);
const quietLoops = [];
page.on('console', (message) => { if (message.text().includes('WebGL')) console.log('webgl-console', message.text()); });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
const shots = {};
const capture = async (key, filename) => {
  const file = path.join(output, filename);
  await page.screenshot({ path: file, timeout: 45000 });
  shots[key] = `artifacts/${filename}`;
};
const waitForAction = async (pattern) => page.waitForFunction((value) => new RegExp(value, 'i').test(document.querySelector('[data-agent-action]')?.textContent ?? ''), pattern.source, { timeout: 45000 });
// Crew-aware waits: any worker's activity counts, not just Moss's subtitle.
// Generous timeouts: headless software rendering advances the sim slowly,
// especially under machine load; the game logic is unaffected.
const waitForWorkers = async (mode, timeout = 150000) => page.waitForFunction((want) => {
  const state = window.__ASTRIX_E2E__.state;
  const workers = Object.values(state.entities).filter((e) => e.kind === 'worker');
  const carryingFood = (id) => {
    const resource = state.entities[id];
    return Boolean(resource && resource.kind === 'food');
  };
  if (want === 'moving') return workers.some((w) => w.activity === 'moving' && w.targetId !== null);
  if (want === 'chopping') return workers.some((w) => w.activity === 'chopping');
  if (want === 'gathering') return workers.some((w) => w.activity === 'gathering');
  if (want === 'foodcarry') return workers.some((w) => w.activity === 'carrying' && w.carrying !== null && carryingFood(w.carrying));
  return false;
}, mode, { timeout });
const waitForEvent = async (name) => page.waitForFunction((value) => [...document.querySelectorAll('.event-name')].some((element) => element.textContent?.includes(value)), name, { timeout: 45000 });
const captureWhilePaused = async (key, filename) => {
  const isPaused = await page.getByRole('button', { name: /RESUME AGENT/ }).count();
  if (!isPaused) await page.getByRole('button', { name: /PAUSE AGENT/ }).click();
  await page.waitForTimeout(80);
  await capture(key, filename);
  if (!isPaused) await page.getByRole('button', { name: /RESUME AGENT/ }).click();
};

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('canvas')?.width > 0);
  await page.waitForFunction(() => Boolean(window.__ASTRIX_E2E__));
  // Deterministic scenario: start both stockpiles empty so the need-driven
  // loops run their full course (the shipped scenario starts food at 3).
  await page.evaluate(() => { window.__ASTRIX_E2E__.state.food = 0; });
  const canvas = await page.locator('canvas').evaluate((element) => {
    const gl = element.getContext('webgl2') || element.getContext('webgl');
    return { width: element.width, height: element.height, webgl: gl ? gl.getParameter(0x1f02) : null };
  });
  if (!canvas.webgl?.includes('WebGL')) throw new Error('WebGL context unavailable');
  await page.waitForTimeout(120);
  await capture('initial', 'astrix-phase2-initial.png');

  await page.getByRole('button', { name: /PAUSE AGENT/ }).click();
  const pauseTick = await page.locator('[data-tick]').textContent();
  await page.waitForTimeout(500);
  if (pauseTick !== await page.locator('[data-tick]').textContent()) throw new Error('Pause did not freeze simulation time');
  await capture('paused', 'astrix-phase2-paused.png');
  const beforeCamera = await page.locator('canvas').screenshot({ timeout: 30000 });
  const box = await page.locator('canvas').boundingBox();
  if (!box) throw new Error('Canvas has no visible bounds');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.61, box.y + box.height * 0.45, { steps: 4 });
  await page.mouse.up();
  await page.mouse.wheel(0, -80);
  await page.waitForTimeout(100);
  const afterCamera = await page.locator('canvas').screenshot({ timeout: 30000 });
  if (createHash('sha256').update(beforeCamera).digest('hex') === createHash('sha256').update(afterCamera).digest('hex')) throw new Error('Camera drag/zoom did not change the rendered scene');
  await page.getByRole('button', { name: /RESUME AGENT/ }).click();

  // Wilderness boots idle by design: no ambient work loop runs without a
  // goal. Drive the loops the product way — explicit goals via the command
  // interface — then verify the same causal chains as before.
  const issueGoal = async (text) => {
    await page.locator('[data-command-input]').fill(text);
    await page.locator('[data-command-form]').evaluate((form) => form.requestSubmit());
    await page.waitForFunction((want) => (document.querySelector('[data-goal]')?.textContent ?? '').includes('ACTIVE'), text, { timeout: 15000 });
  };
  await issueGoal('gather 1 wood');
  await waitForWorkers('moving');
  await captureWhilePaused('approach', 'astrix-phase2-approach.png');
  await waitForWorkers('chopping');
  await captureWhilePaused('woodProgress', 'astrix-phase2-wood-in-progress.png');
  await waitForEvent('Wood added');
  await page.waitForFunction(() => document.querySelector('[data-wood]')?.textContent?.trim() === '01');
  await captureWhilePaused('woodDelivered', 'astrix-phase2-wood-delivered.png');

  await issueGoal('gather 1 food');
  await waitForWorkers('gathering');
  await captureWhilePaused('foodProgress', 'astrix-phase2-food-in-progress.png');
  await captureWhilePaused('foodTransport', 'astrix-phase2-food-transport.png');
  await waitForWorkers('foodcarry');
  await captureWhilePaused('foodTransport', 'astrix-phase2-food-transport.png');
  await waitForEvent('Food added');
  await page.waitForFunction(() => Number(document.querySelector('[data-food]')?.textContent) >= 1, null, { timeout: 240000 });
  await page.getByRole('button', { name: /PAUSE AGENT/ }).click();
  await page.waitForTimeout(80);
  await capture('finalSettlement', 'astrix-phase2-final-settlement.png');

  await page.locator('[data-control="events"]').evaluate((button) => button.click());
  await page.locator('[data-json]').waitFor({ state: 'visible' });
  const structured = await page.locator('[data-json]').evaluate((element) => JSON.parse(element.textContent));
  await page.locator('[data-json]').evaluate((element) => { element.hidden = true; });
  const events = structured.events;
  const woodChain = ['RESOURCE_TARGETED', 'GATHER_ACTION_STARTED', 'TREE_CHOPPED', 'RESOURCE_CREATED', 'RESOURCE_PICKED_UP', 'RESOURCE_DELIVERED', 'RESOURCE_ADDED'];
  // Goal-driven path: one governed PLAN authorizes virtual steps, so there
  // are no per-step AGENT_OBSERVED/AGENT_DECIDED/ACTION_PROPOSED events —
  // the causal resource chain is the evidence. (foodChain built below,
  // branched on the delegated-farm harvest.)
  const ordered = (types, predicate) => {
    const matched = events.filter(predicate).map((event) => event.type);
    let cursor = -1;
    for (const type of types) {
      cursor = matched.indexOf(type, cursor + 1);
      if (cursor < 0) throw new Error(`Missing/out-of-order event ${type}`);
    }
    return matched;
  };
  const woodEvents = ordered(woodChain, (event) => event.data.resource === 'wood' || (typeof event.entityId === 'string' && event.entityId.startsWith('log-')));
  // The delegated farm-01 (live backend) may be ready before the berries are
  // reached: the crew harvests whichever is nearest, so expect the harvest
  // event the run actually produced — same branch pattern as phase3.
  const foodFilter = (event) => event.data.resource === 'food' || (typeof event.entityId === 'string' && event.entityId.startsWith('berry-patch-')) || (typeof event.entityId === 'string' && event.entityId.startsWith('food-')) || event.entityId === 'farm-01' && (event.type === 'FARM_HARVESTED' || event.type === 'RESOURCE_TARGETED' || event.type === 'GATHER_ACTION_STARTED');
  const foodHarvest = events.some((event) => event.type === 'FARM_HARVESTED') ? 'FARM_HARVESTED' : 'BERRY_PATCH_HARVESTED';
  const foodChain = ['RESOURCE_TARGETED', 'GATHER_ACTION_STARTED', foodHarvest, 'RESOURCE_CREATED', 'RESOURCE_PICKED_UP', 'RESOURCE_DELIVERED', 'RESOURCE_ADDED'];
  const foodEvents = ordered(foodChain, foodFilter);
  if (await page.getByRole('button', { name: /RESUME AGENT/ }).count() !== 1) throw new Error('Final state was not paused');
  const proposalStatuses = structured.proposals.map((proposal) => ({ actionType: proposal.actionType, status: proposal.status, parameters: proposal.parameters }));
  // Goal-driven path verifies PLAN proposals (virtual steps), not per-step
  // HARVEST/DELIVER proposals — the RESOURCE_DELIVERED/RESOURCE_ADDED events
  // plus stockpiles are the delivery evidence.
  if (!proposalStatuses.some((proposal) => proposal.actionType === 'PLAN' && proposal.status === 'VERIFIED')) throw new Error('No goal plan was verified');
  if (!events.some((event) => event.type === 'RESOURCE_DELIVERED' && event.data.resource === 'food')) throw new Error('No food delivery was recorded');
  if (structured.wood < 1) throw new Error('No wood was produced by the crew');
  if (structured.food < 1) throw new Error('No food was produced by the crew');
  await capture('finalSettlement', 'astrix-phase2-final-settlement.png');
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);

  const report = { url: base, browser: 'Playwright Chromium + SwiftShader WebGL', canvas, cameraInteraction: 'drag and wheel changed paused canvas image', pauseTick, totals: { wood: structured.wood, food: structured.food }, woodEvents, foodEvents, verifiedProposals: proposalStatuses.filter((proposal) => proposal.status === 'VERIFIED'), browserErrors: errors, screenshots: shots };
  await fs.writeFile(path.join(output, 'phase2-browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
