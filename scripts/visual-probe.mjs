import { chromium } from 'playwright';

const base = process.env.ASTRIX_BROWSER_URL ?? 'http://127.0.0.1:5173/?e2e=1';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
page.setDefaultTimeout(30000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

const state = (fn) => page.evaluate(fn);
const snap = () => state(() => {
  const st = window.__ASTRIX_E2E__.state;
  return {
    wood: st.wood,
    houses: Object.values(st.entities).filter((e) => e.kind === 'house'),
    trees: Object.values(st.entities).filter((e) => e.kind === 'tree').map((t) => `${t.id}:${t.state}`),
    events: st.events.map((e) => e.type),
  };
});

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('canvas')?.width > 0 && Boolean(window.__ASTRIX_E2E__));
  // Fell one tree through the real loop so a stump site exists.
  await page.evaluate(() => { window.__ASTRIX_E2E__.setPaused(true); return window.__ASTRIX_E2E__.advanceTo('woodDelivered'); });
  await page.evaluate(() => window.__ASTRIX_E2E__.setPaused(false));

  // 1. Fetch water via the real command box (goal above stockpile forces draws).
  await page.locator('[data-command-input]').fill('fetch 5 water');
  await page.locator('.command-send').click();
  await page.waitForFunction(() => window.__ASTRIX_E2E__.state.water >= 5, null, { timeout: 180000 });
  console.log('water:', await state(() => window.__ASTRIX_E2E__.state.water));
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'artifacts/visual-water.png' });

  // 2. Plant trees via the real command box.
  await page.locator('[data-command-input]').fill('plant trees');
  await page.locator('.command-send').click();
  await page.waitForFunction(() => window.__ASTRIX_E2E__.state.events.some((e) => e.type === 'TREE_PLANTED'), null, { timeout: 90000 });
  console.log('planted:', JSON.stringify((await snap()).trees));
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'artifacts/visual-sapling.png' });

  // 2. Build a house via the real command box + approval button.
  await page.locator('[data-command-input]').fill('build a house');
  await page.locator('.command-send').click();
  await page.waitForFunction(
    () => [...document.querySelectorAll('.approval-button.approval-approve')].length > 0,
    null, { timeout: 60000 },
  );
  await page.locator('.approval-button.approval-approve').first().click();
  await page.waitForFunction(
    () => Object.values(window.__ASTRIX_E2E__.state.entities).some((e) => e.kind === 'house' && e.state === 'complete'),
    null, { timeout: 120000 },
  );
  const after = await snap();
  console.log('houses:', JSON.stringify(after.houses.map((h) => ({ id: h.id, pos: h.position }))));
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'artifacts/visual-house.png' });
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  console.log('VISUAL PROBE OK');
} finally {
  await browser.close();
}
