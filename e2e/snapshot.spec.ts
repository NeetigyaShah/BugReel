import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const fixture = pathToFileURL(path.join(__dirname, 'fixtures/modal.html')).href;

// A tiny valid PNG the upload-picker fallback can be fed in headless runs —
// Playwright's filechooser interception sets it straight on the input.
const UPLOAD_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const openModal = async (page: import('@playwright/test').Page) => {
  await expect
    .poll(() => page.evaluate(() => typeof (window as { BugReel?: { open?: unknown } }).BugReel?.open))
    .toBe('function');
  await page.click('#btn'); // seed telemetry so the report has a story
  await page.evaluate(() => (window as { BugReel?: { open?: () => void } }).BugReel?.open?.());
};

/** Minimal STORE-mode ZIP reader — walks local file headers sequentially. */
const unzipStore = (bytes: Buffer): Map<string, Buffer> => {
  const out = new Map<string, Buffer>();
  let off = 0;
  while (off + 30 <= bytes.length && bytes.readUInt32LE(off) === 0x04034b50) {
    const csize = bytes.readUInt32LE(off + 18);
    const nlen = bytes.readUInt16LE(off + 26);
    const elen = bytes.readUInt16LE(off + 28);
    const name = bytes.subarray(off + 30, off + 30 + nlen).toString('utf8');
    const data = bytes.subarray(off + 30 + nlen + elen, off + 30 + nlen + elen + csize);
    out.set(name, data);
    off += 30 + nlen + elen + csize;
  }
  return out;
};

test('annotate snapshot → media attachment → .bugpack carries media/snapshot-annotated.png', async ({
  page,
}) => {
  test.setTimeout(90_000); // the fallback chain can take image/display timeouts first
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto(fixture);
  await openModal(page);

  // The report must land first — the media section lives inside the ready view.
  await expect(page.locator('[data-br="preview"]')).toContainText('What Happened', {
    timeout: 15_000,
  });
  const annotate = page.locator('[data-br="annotate"]');
  await expect(annotate).toBeVisible();

  // The capture chain races: silent DOM rasterization may succeed outright, or
  // fall through getDisplayMedia to the manual upload picker. Arm the chooser
  // listener *before* clicking so the picker can't resolve unhandled.
  const host = page.locator('[data-br="annotator"]');
  const chooser = page.waitForEvent('filechooser', { timeout: 45_000 }).catch(() => null);
  const annotatorUp = host
    .waitFor({ state: 'visible', timeout: 45_000 })
    .then(() => 'annotator' as const)
    .catch(() => 'timeout' as const);
  await annotate.click();

  const first = await Promise.race([chooser.then((fc) => (fc ? 'chooser' : 'none')), annotatorUp]);
  if (first === 'chooser') {
    const fc = await chooser;
    await fc!.setFiles({ name: 'screen.png', mimeType: 'image/png', buffer: UPLOAD_PNG });
  }
  await host.waitFor({ state: 'visible', timeout: 20_000 });

  // The annotator toolbar + ink canvas are live in the modal overlay.
  for (const br of [
    'anno-pen',
    'anno-box',
    'anno-highlight',
    'anno-redact',
    'anno-undo',
    'anno-done',
    'anno-cancel',
  ]) {
    await expect(page.locator(`[data-br="${br}"]`)).toBeAttached();
  }

  // Draw a pen stroke across the ink canvas.
  const ink = page.locator('[data-br="anno-ink"]');
  const box = await ink.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width * 0.25, box!.y + box!.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.65, { steps: 6 });
  await page.mouse.up();

  await page.locator('[data-br="anno-done"]').click();

  // The annotated PNG shows as an attachment; the annotator overlay is gone.
  await expect(page.locator('[data-br="media-item"]')).toHaveCount(1);
  await expect(page.locator('[data-br="media-item"]')).toContainText('snapshot-annotated.png');
  await expect(host).toBeHidden();

  // Download the .bugpack and assert the media entry made it into the archive.
  await page.locator('[data-br="trying"]').fill('attach an annotated snapshot');
  await page.locator('[data-br="wrong"]').fill('needed markup');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-br="download"]').click();
  const download = await downloadPromise;
  const bytes = await readFile((await download.path())!);

  const entries = unzipStore(bytes);
  const snap = entries.get('media/snapshot-annotated.png');
  expect(snap).toBeTruthy();
  // PNG signature — pixel content is irrelevant in a headless capture.
  expect([...snap!.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

  const report = JSON.parse(entries.get('report.json')!.toString('utf8')) as {
    media?: string[];
  };
  expect(report.media).toContain('snapshot-annotated.png');

  expect(pageErrors).toEqual([]);
});
