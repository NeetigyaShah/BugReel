import { test, expect } from '@playwright/test';
import { packBugpack } from '@bugreel/sdk';
import type { BugReelReport } from '@bugreel/sdk';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const playerUrl = pathToFileURL(path.join(__dirname, '../packages/player/player.html')).href;

const t0 = 1_700_000_000_000;

// 1×1 transparent PNG — a real PNG header so the evidence pane treats it as an image.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const report: BugReelReport = {
  schemaVersion: '1.0',
  meta: {
    url: 'https://app.test/checkout',
    userAgent: 'playwright-e2e',
    viewport: { width: 1000, height: 600 },
    capturedAt: t0 + 30_000,
    sdkVersion: '0.1.0',
    sessionId: 'e2e-sess',
    app: 'shop',
  },
  reporterAnswers: { tryingToDo: 'Pay for my order', wentWrong: 'Pay button did nothing' },
  findings: [
    {
      detectorId: 'dead-click',
      severity: 'critical',
      timestamp: t0 + 6_000,
      headline: 'Click on Pay Now did nothing',
      explanation: 'No DOM change, route, or network activity followed the click.',
      selector: 'button#pay',
      relatedEventIds: ['c1'],
    },
  ],
  storySteps: [
    { at: t0 + 5_000, eventId: 'c1', kind: 'click', text: "Clicked 'Pay Now' button inside 'Checkout'" },
    { at: t0 + 6_000, eventId: 'c1', kind: 'finding', text: 'Click on Pay Now did nothing', severity: 'critical' },
    { at: t0 + 12_000, eventId: 'n1', kind: 'network', text: 'POST /api/pay failed — backend crash (500)', severity: 'warning' },
    { at: t0 + 12_500, eventId: 'k1', kind: 'console', text: 'Console error: "payment request failed"', severity: 'warning' },
    { at: t0 + 13_000, eventId: 'e1', kind: 'error', text: "Crash — missing wiring: 'total' is not a function", severity: 'critical' },
  ],
  events: [
    {
      id: 'c1',
      at: t0 + 5_000,
      type: 'click',
      target: {
        selector: 'button#pay',
        label: 'Pay Now',
        tagName: 'button',
        headingContext: 'Checkout',
        rect: { x: 90, y: 40, width: 120, height: 40 },
      },
      x: 100,
      y: 60,
    },
    {
      id: 'n1',
      at: t0 + 12_000,
      type: 'fetch',
      method: 'POST',
      url: 'https://app.test/api/pay',
      status: 500,
      ok: false,
      durationMs: 240,
    },
    { id: 'k1', at: t0 + 12_500, type: 'console', level: 'error', message: 'payment request failed' },
    {
      id: 'e1',
      at: t0 + 13_000,
      type: 'error',
      source: 'window.onerror',
      message: 'Uncaught TypeError: total is not a function',
    },
  ],
  network: [
    {
      id: 'n1',
      at: t0 + 12_000,
      type: 'fetch',
      method: 'POST',
      url: 'https://app.test/api/pay',
      status: 500,
      ok: false,
      durationMs: 240,
    },
  ],
  console: [
    { id: 'k1', at: t0 + 12_500, type: 'console', level: 'error', message: 'payment request failed' },
  ],
  media: ['snapshot-annotated.png'],
  outputs: {
    markdown: '# BugReel report\n\ntest markdown',
    curl: 'curl -X POST https://app.test/api/pay',
    playwright: "await page.click('button#pay')",
    cursorPrompt: 'Fix the dead click on button#pay',
  },
};

const bugpack = packBugpack(report, { 'snapshot-annotated.png': PNG_1PX });

/** Synthesize a DataTransfer carrying the bugpack as a File and dispatch a drop. */
const dropBugpack = async (page: import('@playwright/test').Page): Promise<void> => {
  const dataTransfer = await page.evaluateHandle((b64) => {
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], 'sample.bugpack', { type: 'application/zip' }));
    return dt;
  }, Buffer.from(bugpack).toString('base64'));
  await page.locator('body').dispatchEvent('drop', { dataTransfer });
};

test('player.html: dropping a .bugpack renders evidence, scrubber, story + inspector', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto(playerUrl);
  await dropBugpack(page);

  // Three panes (Playwright CSS pierces the open shadow root).
  await expect(page.locator('.br-evidence')).toBeVisible();
  await expect(page.locator('.br-timeline')).toBeVisible();
  await expect(page.locator('.br-story')).toBeVisible();
  await expect(page.locator('.br-inspector')).toBeVisible();

  // Evidence pane shows the snapshot, tabs carry the media name.
  await expect(page.locator('.br-stage img')).toBeVisible();
  await expect(page.locator('.br-tab').first()).toHaveText('snapshot-annotated.png');

  // Scrubber: 4 events + 1 finding = 5 nodes; the first finding is pre-selected.
  await expect(page.locator('.br-node')).toHaveCount(5);
  await expect(page.locator('.br-node.sel.k-finding')).toHaveCount(1);

  // Select the error node → inspector shows the moment + synchronized context.
  await page.locator('.br-node.k-error').click();
  const inspector = page.locator('.br-inspector');
  await expect(inspector).toContainText('not a function');
  await expect(inspector).toContainText('/api/pay'); // failed request ±2s
  await expect(inspector).toContainText('payment request failed'); // console error ±2s
  await expect(page.locator('.br-step.sel')).toContainText('missing wiring');

  // Select the click node → beacon pulses at the event's x/y.
  await page.locator('.br-node.k-click').click();
  const beacon = page.locator('.br-beacon');
  await expect(beacon).toBeVisible();
  await expect(beacon).toHaveCSS('left', /\d+px/); // positioned, not hidden
  await expect(inspector).toContainText('Pay Now');
  await expect(inspector).toContainText('button#pay');

  // Copy buttons for all compiled outputs.
  await expect(page.locator('[data-copy="cursorPrompt"]')).toBeVisible();
  await expect(page.locator('[data-copy="curl"]')).toBeVisible();
  await expect(page.locator('[data-copy="playwright"]')).toBeVisible();
  await expect(page.locator('[data-copy="markdown"]')).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('player.html: file input fallback loads a bugpack', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bugreel-')), 'sample.bugpack');
  fs.writeFileSync(tmp, bugpack);
  try {
    await page.goto(playerUrl);
    await page.setInputFiles('#file', tmp);
    await expect(page.locator('.br-player')).toBeVisible();
    await expect(page.locator('.br-node')).toHaveCount(5);
    expect(pageErrors).toEqual([]);
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
});

test('player.html: a malformed file renders the error pane, not a crash', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto(playerUrl);
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'junk.bugpack'));
    return dt;
  });
  await page.locator('body').dispatchEvent('drop', { dataTransfer });
  await expect(page.locator('.br-error')).toBeVisible();
  expect(pageErrors).toEqual([]);
});
