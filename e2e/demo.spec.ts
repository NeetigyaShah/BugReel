import { test, expect, type Page } from '@playwright/test';

/**
 * Demo-app specs — the real built SDK over the real static host
 * (playwright.config.ts boots `node demo/serve.mjs` on :4173). No mocks:
 * every assertion lands on the compiled report the worker actually emits.
 */

const DEMO_URL = 'http://localhost:4173/demo/';

interface DemoFinding {
  detectorId: string;
  severity: string;
  headline: string;
  explanation: string;
  selector?: string;
}
interface DemoStoryStep {
  kind: string;
  text: string;
  severity?: string;
}
interface DemoReport {
  findings?: DemoFinding[];
  storySteps?: DemoStoryStep[];
  events?: Array<{ type: string; [k: string]: unknown }>;
}

const readReport = (page: Page): Promise<DemoReport | undefined> =>
  page.evaluate(() => (window as unknown as { __report?: DemoReport }).__report);

/** Trigger the report flow, then wait for the worker-compiled report event. */
const openAndGetReport = async (page: Page): Promise<DemoReport> => {
  await page.evaluate(() => (window as { BugReel?: { open?: () => void } }).BugReel?.open?.());
  await expect.poll(() => readReport(page), { timeout: 15_000 }).toBeTruthy();
  return (await readReport(page)) as DemoReport;
};

const detectorIds = (report: DemoReport): string[] =>
  (report.findings ?? []).map((f) => f.detectorId);

// The pill is mounted by the lazy capture chunk — its presence proves
// window.fetch is wrapped and no later insertion can pollute error-UI watches.
const loadDemo = async (page: Page): Promise<void> => {
  await page.goto(DEMO_URL);
  await expect(page.locator('bugreel-pill')).toHaveCount(1);
};

test('demo loads the real SDK via script tag: BugReel global, capture chunk, pill', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await loadDemo(page);

  await expect(page).toHaveTitle(/Pulseboard/);
  await expect
    .poll(() => page.evaluate(() => typeof (window as { BugReel?: unknown }).BugReel?.init))
    .toBe('function');
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.scripts].some((s) => s.src.endsWith('capture.global.js')),
      ),
    )
    .toBe(true);
  await expect(page.locator('bugreel-pill')).toHaveCount(1);

  expect(pageErrors).toEqual([]);
});

test('dead-click fixture: Deploy produces a Dead Click finding end-to-end in the modal', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await loadDemo(page);
  await page.click('#deploy-btn');
  // The liveness verdict lands ~400ms post-click; give it margin before open.
  await page.waitForTimeout(800);

  const report = await openAndGetReport(page);
  expect(detectorIds(report)).toContain('dead-click');
  const finding = report.findings!.find((f) => f.detectorId === 'dead-click')!;
  expect(finding.headline).toContain('Deploy');
  expect(finding.selector).toContain('deploy-btn');

  // …and it renders in the modal's "What Happened" section.
  await expect(page.locator('[data-br="preview"]')).toContainText('nothing happened', {
    timeout: 15_000,
  });
  expect(pageErrors).toEqual([]);
});

test('silent-500 fixture: Save changes produces a critical Silent Failure finding', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await loadDemo(page);
  await page.click('#save-btn');
  // The error-UI verdict lands ~2s after the 500 response — wait for it so
  // the finding exists before the report compiles.
  await page.waitForTimeout(2_600);

  const report = await openAndGetReport(page);
  expect(detectorIds(report)).toContain('silent-api-error');
  const finding = report.findings!.find((f) => f.detectorId === 'silent-api-error')!;
  expect(finding.severity).toBe('critical');
  expect(finding.headline).toContain('/api/save');
  expect(finding.headline).toContain('500');

  // The story records the failed request itself too.
  const steps = (report.storySteps ?? []).map((s) => s.text);
  expect(steps).toContain('POST /api/save failed — backend crash (500)');

  await expect(page.locator('[data-br="preview"]')).toContainText('no error UI appeared', {
    timeout: 15_000,
  });
  expect(pageErrors).toEqual([]);
});

test('rage-click bait: Sync now produces a Rage Click finding', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await loadDemo(page);
  // ≥3 clicks on the same element inside the frozen 1s window. The button is
  // aria-disabled (that IS the fixture — Playwright's actionability honors it
  // where a real user just clicks), so force the clicks through.
  for (let i = 0; i < 4; i++) await page.click('#sync-btn', { force: true });
  await page.waitForTimeout(500); // let the finding + annotate dedupe settle

  const report = await openAndGetReport(page);
  expect(detectorIds(report)).toContain('rage-click');
  const finding = report.findings!.find((f) => f.detectorId === 'rage-click')!;
  expect(finding.headline).toContain('Sync now');

  expect(pageErrors).toEqual([]);
});

test('crash trigger: Recalculate usage throws a real error into the story', async ({ page }) => {
  await loadDemo(page);

  const errorPromise = page.waitForEvent('pageerror');
  await page.click('#recalc-btn');
  const crash = await errorPromise;
  expect(String(crash)).toContain('total'); // real TypeError off missing state.usage

  const report = await openAndGetReport(page);
  const errorSteps = (report.storySteps ?? []).filter((s) => s.kind === 'error');
  expect(errorSteps.length).toBeGreaterThan(0);
  expect(errorSteps[0]!.text).toContain("'total'");
  expect(errorSteps[0]!.severity).toBe('critical');

  // The raw event is a window.onerror capture, not a synthesized one.
  expect((report.events ?? []).some((e) => e.type === 'error')).toBe(true);
});

test('promo-code input: typed value lands in the story (not treated as secret)', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await loadDemo(page);
  await page.fill('#promo', 'SAVE20');
  await page.click('#apply-promo'); // blurs the field → change event; applies the code
  await expect(page.locator('#promo-msg')).toContainText('applied');

  const report = await openAndGetReport(page);
  const inputSteps = (report.storySteps ?? []).filter((s) => s.kind === 'input');
  expect(inputSteps.some((s) => s.text === "Typed 'SAVE20' into 'Promo Code'")).toBe(true);

  const inputEvent = (report.events ?? []).find((e) => e.type === 'input');
  expect(inputEvent?.value).toBe('SAVE20'); // literal — the firewall left it alone

  expect(pageErrors).toEqual([]);
});

test('evaluator journey: every planted bug surfaces in a single report', async ({ page }) => {
  await loadDemo(page);

  // Order matters: the dead click's ~400ms verdict must land before the next
  // network/console/error event, and the 500's ~2s error-UI watch must close
  // before any DOM insertion — the demo page stays quiet by design.
  await page.click('#deploy-btn');
  await page.waitForTimeout(800);
  await page.click('#save-btn');
  await page.waitForTimeout(2_600);
  for (let i = 0; i < 4; i++) await page.click('#sync-btn', { force: true }); // aria-disabled fixture
  await page.fill('#promo', 'SAVE20');
  await page.click('#apply-promo');

  const crashPromise = page.waitForEvent('pageerror');
  await page.click('#recalc-btn');
  await crashPromise;

  const report = await openAndGetReport(page);
  const ids = detectorIds(report);
  expect(ids).toContain('dead-click');
  expect(ids).toContain('silent-api-error');
  expect(ids).toContain('rage-click');

  const steps = report.storySteps ?? [];
  expect(steps.some((s) => s.kind === 'error' && s.text.includes("'total'"))).toBe(true);
  expect(steps.some((s) => s.text === "Typed 'SAVE20' into 'Promo Code'")).toBe(true);

  // The modal renders the whole thing for a human reporter.
  const preview = page.locator('[data-br="preview"]');
  await expect(preview).toContainText('What Happened', { timeout: 15_000 });
  await expect(preview).toContainText('nothing happened');
  await expect(preview).toContainText('no error UI appeared');
  await expect(preview).toContainText('rage-clicked');
});

test('triggers: the floating pill opens the report modal', async ({ page }) => {
  await loadDemo(page);

  await page.locator('bugreel-pill').locator('button').click();
  await expect(page.locator('bugreel-modal')).toHaveCount(1);
  await expect(page.locator('[data-br="preview"]')).toContainText('What Happened', {
    timeout: 15_000,
  });
});
