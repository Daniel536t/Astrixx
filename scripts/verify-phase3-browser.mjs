import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const base = process.env.ASTRIX_BROWSER_URL ?? 'http://127.0.0.1:5173/?e2e=1';
const output = path.resolve('artifacts');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(30000);
const errors = [];
const assets = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
page.on('response', (response) => {
  if (response.url().includes('/assets/kenney-')) assets.push({ url: new URL(response.url()).pathname, status: response.status() });
});
const screenshots = {};
const progressPath = path.join(output, 'phase3-browser-progress.json');
const failurePath = path.join(output, 'phase3-browser-failure.json');
const capture = async (key, filename) => {
  const file = path.join(output, filename);
  await page.screenshot({ path: file, timeout: 30000, animations: 'disabled', fullPage: key === 'tablet' });
  screenshots[key] = `artifacts/${filename}`;
  await fs.writeFile(progressPath, JSON.stringify({ stage: key, screenshots }, null, 2));
};
const pauseUi = () => page.evaluate(() => window.__ASTRIX_E2E__?.setPaused(true));
const setStage = async (target) => {
  const result = await page.evaluate((stage) => window.__ASTRIX_E2E__?.advanceTo(stage) ?? false, target);
  if (!result) throw new Error(`Local simulation could not reach ${target}`);
  await page.waitForTimeout(150);
};
const snapshot = async () => page.evaluate(() => {
  const state = window.__ASTRIX_E2E__?.state;
  if (!state) throw new Error('Local E2E state is not available');
  return {
    tick: state.tick,
    wood: state.wood,
    food: state.food,
    events: state.events.filter((event) => event.type !== 'AGENT_MOVED'),
    proposals: state.proposals,
  };
});

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('canvas')?.width > 0 && Boolean(window.__ASTRIX_E2E__));
  const canvas = await page.locator('canvas').evaluate((element) => {
    const gl = element.getContext('webgl2') || element.getContext('webgl');
    return { width: element.width, height: element.height, webgl: gl?.getParameter(0x1f02) ?? null };
  });
  if (!canvas.webgl?.includes('WebGL')) throw new Error('WebGL context unavailable');
  await pauseUi();
  await capture('initial', 'astrix-phase3-initial.png');
  await capture('fullSettlement', 'astrix-phase3-full-settlement.png');

  const beforeCamera = await page.locator('canvas').screenshot({ timeout: 20000 });
  const bounds = await page.locator('canvas').boundingBox();
  if (!bounds) throw new Error('Canvas has no visible bounds');
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.58, bounds.y + bounds.height * 0.46, { steps: 4 });
  await page.mouse.up();
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(120);
  const afterCamera = await page.locator('canvas').screenshot({ timeout: 20000 });
  const cameraInteraction = createHash('sha256').update(beforeCamera).digest('hex') !== createHash('sha256').update(afterCamera).digest('hex');
  if (!cameraInteraction) throw new Error('Camera drag/zoom did not alter the rendered world');
  await page.mouse.wheel(0, -400);
  await capture('forest', 'astrix-phase3-forest.png');
  const pausedTick = await page.locator('[data-tick]').textContent();
  await page.waitForTimeout(350);
  if (pausedTick !== await page.locator('[data-tick]').textContent()) throw new Error('Pause did not freeze local time');

  await setStage('chopping');
  await capture('chopping', 'astrix-phase3-chopping.png');
  await setStage('woodCarrying');
  await page.mouse.wheel(0, 300);
  await capture('treeAfterChopping', 'astrix-phase3-tree-after-chopping.png');
  await capture('carryingWood', 'astrix-phase3-carrying-wood.png');
  await setStage('berryHarvesting');
  await capture('berryHarvesting', 'astrix-phase3-berry-harvesting.png');
  await setStage('foodCarrying');
  await capture('carryingFood', 'astrix-phase3-carrying-food.png');
  await setStage('finalSettlement');
  await pauseUi();
  await capture('finalSettlement', 'astrix-phase3-final-settlement.png');
  const structured = await snapshot();
  if (structured.wood < 1) throw new Error(`No wood was produced ${structured.wood}/${structured.food}`);

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(200);
  await capture('tablet', 'astrix-phase3-tablet.png');

  const orderedTypes = (events, expected, filter) => {
    const types = events.filter(filter).map((event) => event.type);
    let cursor = -1;
    for (const type of expected) {
      cursor = types.indexOf(type, cursor + 1);
      if (cursor < 0) throw new Error(`Missing/out-of-order ${type}`);
    }
    return types;
  };
  const woodFilter = (event) => event.data.resource === 'wood'
    || event.entityId === 'log-01'
    || event.type === 'AGENT_OBSERVED' && Array.isArray(event.data.availableTrees)
    || ['AGENT_DECIDED', 'ACTION_PROPOSED', 'GOVERNANCE_PERMISSION_GRANTED'].includes(event.type) && event.data.actionType === 'GATHER';
  const foodFilter = (event) => event.data.resource === 'food'
    || typeof event.entityId === 'string' && event.entityId.startsWith('berry-patch-')
    || typeof event.entityId === 'string' && event.entityId.startsWith('food-')
    || event.entityId === 'farm-01' && (event.type === 'FARM_HARVESTED' || event.type === 'RESOURCE_TARGETED' || event.type === 'GATHER_ACTION_STARTED')
    || event.type === 'AGENT_OBSERVED' && Array.isArray(event.data.availableBerryPatches)
    || ['AGENT_DECIDED', 'ACTION_PROPOSED', 'GOVERNANCE_PERMISSION_GRANTED'].includes(event.type) && event.data.actionType === 'HARVEST';
  const woodEvents = orderedTypes(structured.events, ['AGENT_OBSERVED', 'AGENT_DECIDED', 'ACTION_PROPOSED', 'GOVERNANCE_PERMISSION_GRANTED', 'RESOURCE_TARGETED', 'GATHER_ACTION_STARTED', 'TREE_CHOPPED', 'RESOURCE_CREATED', 'RESOURCE_PICKED_UP', 'RESOURCE_DELIVERED', 'RESOURCE_ADDED'], woodFilter);
  // Delegated-farm runs harvest farm-01 instead of berries (the documented
  // chain-farm branch): expect FARM_HARVESTED there, BERRY_PATCH_HARVESTED
  // in local-only runs. Neither branch resets or spends.
  const farmDelegatedEarly = structured.events.some((event) => event.type === 'LEASE_CHANGED' && event.entityId === 'farm-01' && event.data?.holder === 'er');
  const foodHarvestEvent = farmDelegatedEarly ? 'FARM_HARVESTED' : 'BERRY_PATCH_HARVESTED';
  const foodEvents = orderedTypes(structured.events, ['AGENT_OBSERVED', 'AGENT_DECIDED', 'ACTION_PROPOSED', 'GOVERNANCE_PERMISSION_GRANTED', 'RESOURCE_TARGETED', 'GATHER_ACTION_STARTED', foodHarvestEvent, 'RESOURCE_CREATED', 'RESOURCE_PICKED_UP', 'RESOURCE_DELIVERED', 'RESOURCE_ADDED'], foodFilter);
  const proposalStatuses = structured.proposals.map(({ actionType, status }) => ({ actionType, status }));
  if (!proposalStatuses.some((proposal) => proposal.actionType === 'HARVEST' && proposal.status === 'VERIFIED')) throw new Error('Harvest proposal was not verified in local mode');  if (await page.getByRole('button', { name: /RESUME AGENT/ }).count() !== 1) throw new Error('Final simulation state is not paused');
  // Chain-farm scenario, asserted against the real reconciled state rather
  // than a fixed chain expectation: when the run reconciled a delegated
  // farm-01 (live Devnet reports it built), the crew must actually harvest
  // it; when the chain reports unbuilt, the world must stay local-only with
  // no farm presentation and no ER lease. Neither branch resets or spends.
  const farmDelegated = structured.events.some((event) => event.type === 'LEASE_CHANGED' && event.entityId === 'farm-01' && event.data?.holder === 'er');
  const farmHarvested = structured.events.some((event) => event.type === 'FARM_HARVESTED');
  if (farmDelegated && !farmHarvested) throw new Error('Delegated chain farm-01 was reconciled but never harvested');
  const chainFarm = farmDelegated ? 'delegated-harvested' : 'local-only';
  if (!assets.length || assets.some((asset) => asset.status !== 200)) throw new Error(`Licensed GLB load failures: ${JSON.stringify(assets)}`);
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);

  const report = {
    url: base,
    mode: 'LOCAL SIMULATION — no chain transactions',
    browser: 'Playwright Chromium + SwiftShader WebGL',
    viewport: { desktop: { width: 1024, height: 768 }, tablet: { width: 768, height: 1024 } },
    canvas,
    cameraInteraction,
    pauseTick: pausedTick,
    totals: { wood: structured.wood, food: structured.food },
    chainFarm,
    woodEvents,
    foodEvents,
    verifiedLocalProposals: proposalStatuses.filter((proposal) => proposal.status === 'VERIFIED'),
    assetResponses: assets,
    browserErrors: errors,
    screenshots,
  };
  await fs.writeFile(path.join(output, 'phase3-browser-report.json'), JSON.stringify(report, null, 2));
  await fs.rm(failurePath, { force: true });
  await fs.writeFile(progressPath, JSON.stringify({ stage: 'verified', screenshots }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await fs.writeFile(failurePath, JSON.stringify({ error: error instanceof Error ? error.stack : String(error), screenshots, browserErrors: errors }, null, 2));
  throw error;
} finally {
  await browser.close();
}
