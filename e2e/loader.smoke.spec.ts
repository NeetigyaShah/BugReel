import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const fixture = pathToFileURL(path.join(__dirname, 'fixtures/loader.html')).href;

test('script-tag loader exposes window.BugReel and never throws into the host', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto(fixture);

  await expect
    .poll(() => page.evaluate(() => typeof (window as { BugReel?: { init?: unknown } }).BugReel?.init))
    .toBe('function');
  expect(pageErrors).toEqual([]);
});

test('auto-init: pill mounts, capture chunk loads, click→fetch→open→report round-trips', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto(fixture);

  // The capture chunk is injected as a sibling classic <script>.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!document.querySelector('script[src$="capture.global.js"]') ||
          [...document.scripts].some((s) => s.src.endsWith('capture.global.js')),
      ),
    )
    .toBe(true);

  // pill:true → the element mounts.
  await expect(page.locator('bugreel-pill')).toHaveCount(1);

  // Click → DOM mutation + failed fetch + console.error get captured.
  await page.click('#btn');
  await page.type('#field', 'hello@example.com');
  await page.locator('#field').blur(); // commits the input → change event

  // Report: open() → compile → worker (main-thread <script> fallback on file://) → bugreel:report.
  await page.evaluate(() => (window as { BugReel?: { open?: () => void } }).BugReel?.open?.());
  await expect.poll(() => page.evaluate(() => window.__opened)).toBe(true);
  // Worker startup under file:// goes through the full fallback chain —
  // allow generous time under loaded CI.
  await expect
    .poll(() => page.evaluate(() => !!window.__report), { timeout: 15_000 })
    .toBe(true);

  const report = await page.evaluate(
    () => window.__report as { events?: { type: string }[] },
  );
  const types = (report?.events ?? []).map((e) => e.type);
  expect(types).toContain('click');
  expect(types).toContain('input');
  expect(types).toContain('console');
  // The failed fetch is captured (status undefined, cors/network failure tolerated).
  expect(types).toContain('fetch');

  expect(pageErrors).toEqual([]);
});
