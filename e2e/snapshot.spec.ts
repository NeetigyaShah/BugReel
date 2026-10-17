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

test('T09b: dropzone attaches a file → .bugpack carries media/<name>', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto(fixture);
  await openModal(page);
  await expect(page.locator('[data-br="preview"]')).toContainText('What Happened', {
    timeout: 15_000,
  });

  // Two files land via the picker input (same code path as a drop).
  await page.locator('[data-br="file-input"]').setInputFiles([
    { name: 'shot.png', mimeType: 'image/png', buffer: UPLOAD_PNG },
    { name: 'capture.webm', mimeType: 'video/webm', buffer: Buffer.from([0x1a, 0x45]) },
  ]);

  await expect(page.locator('[data-br="media-item"]')).toHaveCount(2);
  await expect(page.locator('[data-br="media-list"]')).toContainText('shot.png');
  await expect(page.locator('[data-br="media-list"]')).toContainText('capture.webm');
  // Aggregate size readout — "2 files · …".
  await expect(page.locator('[data-br="media-size"]')).toContainText('2 files');
  // The video attachment previews through a <video> element.
  await expect(page.locator('[data-br="media-item"] video')).toHaveCount(1);

  await page.locator('[data-br="trying"]').fill('attach files');
  await page.locator('[data-br="wrong"]').fill('needed context');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-br="download"]').click();
  const entries = unzipStore(await readFile((await (await downloadPromise).path())!));

  expect(entries.get('media/shot.png')?.subarray(0, 4)).toEqual(Buffer.from(UPLOAD_PNG.subarray(0, 4)));
  expect(entries.has('media/capture.webm')).toBe(true);
  const report = JSON.parse(entries.get('report.json')!.toString('utf8')) as { media?: string[] };
  expect(report.media).toEqual(expect.arrayContaining(['shot.png', 'capture.webm']));
  expect(pageErrors).toEqual([]);
});

test('T09b: record button exists when MediaRecorder is present, hidden when absent', async ({
  page,
}) => {
  await page.goto(fixture);
  await openModal(page);
  await expect(page.locator('[data-br="preview"]')).toContainText('What Happened', {
    timeout: 15_000,
  });
  // Chromium headless ships both APIs → the button is offered.
  await expect(page.locator('[data-br="record"]')).toBeVisible();
});

test('T09b: no MediaRecorder → record button omitted, dropzone remains', async ({ page }) => {
  await page.addInitScript(() => {
    // Simulate the iOS-Safari shape: no MediaRecorder at all.
    (window as unknown as { MediaRecorder?: unknown }).MediaRecorder = undefined;
  });
  await page.goto(fixture);
  await openModal(page);
  await expect(page.locator('[data-br="preview"]')).toContainText('What Happened', {
    timeout: 15_000,
  });
  await expect(page.locator('[data-br="record"]')).toBeHidden();
  await expect(page.locator('[data-br="dropzone"]')).toBeVisible();
});

test('T09b: stubbed screen recorder produces media/screen-recording.webm', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  // Spec-faithful stubs — dataavailable/stop fire as queued TASKS, matching
  // real MediaRecorder behavior (this is the ordering that regressed once).
  await page.addInitScript(() => {
    const CHUNK = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0xde, 0xad]);
    class FakeMR {
      static isTypeSupported(): boolean {
        return true;
      }
      mimeType = 'video/webm';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      constructor(_stream: unknown, _opts?: unknown) {}
      start(): void {}
      stop(): void {
        setTimeout(() => {
          this.ondataavailable?.({ data: new Blob([CHUNK]) });
          this.onstop?.();
        }, 20);
      }
    }
    const w = window as unknown as { MediaRecorder?: unknown; navigator: Navigator };
    w.MediaRecorder = FakeMR;
    // navigator.mediaDevices is a getter-only property — assignment is a
    // silent no-op; defineProperty is the only way to stub it.
    Object.defineProperty(w.navigator, 'mediaDevices', {
      value: { getDisplayMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      configurable: true,
    });
  });

  await page.goto(fixture);
  await openModal(page);
  await expect(page.locator('[data-br="preview"]')).toContainText('What Happened', {
    timeout: 15_000,
  });

  const record = page.locator('[data-br="record"]');
  await expect(record).toBeVisible();
  await record.click();
  await expect(record).toContainText('Stop');
  // Let the stub's async getDisplayMedia grant deliver the recorder instance
  // — clicking Stop in that window resolves with no clip (honest cancel).
  await page.waitForTimeout(200);
  await record.click(); // early stop — async stop path resolves the clip

  await expect(page.locator('[data-br="media-list"]')).toContainText('screen-recording.webm', {
    timeout: 10_000,
  });

  await page.locator('[data-br="trying"]').fill('record the screen');
  await page.locator('[data-br="wrong"]').fill('video evidence needed');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-br="download"]').click();
  const entries = unzipStore(await readFile((await (await downloadPromise).path())!));
  const webm = entries.get('media/screen-recording.webm');
  expect(webm).toBeTruthy();
  expect([...webm!.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // EBML magic
  expect(pageErrors).toEqual([]);
});
