import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const fixture = pathToFileURL(path.join(__dirname, 'fixtures/modal.html')).href;

const openModal = async (page: import('@playwright/test').Page) => {
  await expect
    .poll(() => page.evaluate(() => typeof (window as { BugReel?: { open?: unknown } }).BugReel?.open))
    .toBe('function');
  await page.click('#btn'); // seed telemetry so the report has a story
  await page.evaluate(() => (window as { BugReel?: { open?: () => void } }).BugReel?.open?.());
};

test('BugReel.open() mounts <bugreel-modal> with a Shadow DOM isolated from host CSS', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto(fixture);
  await openModal(page);

  const host = page.locator('bugreel-modal');
  await expect(host).toHaveCount(1);
  await expect
    .poll(() => host.evaluate((el) => !!el.shadowRoot))
    .toBe(true);

  // The two-question form gates every action until both answers are filled.
  for (const sel of ['copy-md', 'copy-prompt', 'download', 'submit']) {
    await expect(page.locator(`[data-br="${sel}"]`)).toBeDisabled();
  }
  await page.locator('[data-br="trying"]').fill('check out');
  await expect(page.locator('[data-br="copy-md"]')).toBeDisabled();
  await page.locator('[data-br="wrong"]').fill('the pay button did nothing');
  for (const sel of ['copy-md', 'copy-prompt', 'download', 'submit']) {
    await expect(page.locator(`[data-br="${sel}"]`)).toBeEnabled();
  }

  // Live preview renders the compiled four-part report (worker round-trip on
  // file:// goes through the script-tag fallback — allow generous time).
  const preview = page.locator('[data-br="preview"]');
  await expect(preview).toContainText('What Happened', { timeout: 15_000 });
  await expect(preview).toContainText('Story');
  await expect(preview).toContainText('check out');
  await expect(preview).toContainText('the pay button did nothing');

  // Host-page CSS must not reach into the shadow tree.
  const styles = await host.evaluate((el) => {
    const btn = el.shadowRoot!.querySelector('[data-br="copy-md"]')!;
    const area = el.shadowRoot!.querySelector('[data-br="trying"]')!;
    const bs = getComputedStyle(btn);
    const ts = getComputedStyle(area);
    return {
      bg: bs.backgroundColor,
      color: bs.color,
      border: ts.borderTopWidth,
      font: bs.fontFamily,
    };
  });
  expect(styles.bg).not.toBe('rgb(255, 0, 0)');
  expect(styles.color).not.toBe('rgb(255, 255, 0)');
  expect(styles.border).not.toBe('12px');
  expect(styles.font).not.toContain('cursive');

  expect(pageErrors).toEqual([]);
});

test('download produces a valid .bugpack blob', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto(fixture);
  await openModal(page);

  await expect(page.locator('[data-br="preview"]')).toContainText('What Happened', {
    timeout: 15_000,
  });
  await page.locator('[data-br="trying"]').fill('download the pack');
  await page.locator('[data-br="wrong"]').fill('it was missing');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-br="download"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.bugpack$/);
  // Assert the status BEFORE awaiting the file read — the status auto-clears
  // after ~4s and a slow readFile under parallel load can race past it.
  await expect(page.locator('[data-br="status"]')).toContainText('Downloaded');

  // STORE-mode ZIP — local file header signature 'PK\x03\x04'.
  const file = await download.path();
  const bytes = await readFile(file!);
  expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);

  expect(pageErrors).toEqual([]);
});

test('close hides the modal; the hotkey re-opens it; submit reaches a terminal state', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto(fixture);
  await openModal(page);

  const host = page.locator('bugreel-modal');
  await expect(page.locator('[data-br="trying"]')).toHaveCount(1);

  await page.locator('[data-br="close"]').click();
  await expect.poll(() => host.evaluate((el) => getComputedStyle(el).display)).toBe('none');

  // The real trigger path: Ctrl+Shift+B re-opens.
  await page.keyboard.press('Control+Shift+B');
  await expect.poll(() => host.evaluate((el) => getComputedStyle(el).display)).not.toBe('none');

  await page.locator('[data-br="trying"]').fill('submit a report');
  await page.locator('[data-br="wrong"]').fill('submit failed before');
  await page.locator('[data-br="submit"]').click();
  await expect(page.locator('[data-br="status"]')).toContainText(/saved|submitted/i, {
    timeout: 10_000,
  });

  expect(pageErrors).toEqual([]);
});
