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
