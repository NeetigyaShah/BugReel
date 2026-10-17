import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/**
 * T13 — the full journey over the real demo app:
 *   Finding (dead-click + silent-500) → modal → compiled report
 *   → webhook mock → "submitted" → .bugpack → <bugreel-player> render.
 *
 * The demo fixture itself stays Mode-1 clean: this spec injects a webhook
 * attribute by intercepting the page HTML (the attribute must exist before
 * the loader script parses it), and answers the POST with a canned 200 —
 * everything else is the real stack.
 */

const WEBHOOK_URL = 'http://localhost:4173/__webhook';

interface CapturedPost {
  body: Buffer;
  contentType: string;
}

/** Minimal STORE-mode ZIP reader — local headers walked sequentially. */
const unzipStore = (bytes: Buffer): Map<string, Buffer> => {
  const out = new Map<string, Buffer>();
  let off = 0;
  while (off + 30 <= bytes.length && bytes.readUInt32LE(off) === 0x04034b50) {
    const csize = bytes.readUInt32LE(off + 18);
    const nlen = bytes.readUInt16LE(off + 26);
    const elen = bytes.readUInt16LE(off + 28);
    const name = bytes.subarray(off + 30, off + 30 + nlen).toString('utf8');
    out.set(
      name,
      bytes.subarray(off + 30 + nlen + elen, off + 30 + nlen + elen + csize),
    );
    off += 30 + nlen + elen + csize;
  }
  return out;
};

test('full journey: demo findings → modal → webhook mock → .bugpack → player render', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  // The webhook capture — multipart body lands here instead of a real endpoint.
  const posts: CapturedPost[] = [];
  await page.route('**/__webhook', async (route) => {
    const req = route.request();
    posts.push({
      body: Buffer.from(req.postDataBuffer() ?? Buffer.alloc(0)),
      contentType: req.headers()['content-type'] ?? '',
    });
    await route.fulfill({ status: 200, body: 'ok' });
  });

  // Inject data-bugreel-webhook into the demo's loader tag at the network
  // layer — the demo fixture stays Mode-1 clean while the capture chunk
  // re-reads the attribute off the script tag at modal-open.
  await page.route('**/demo/index.html', async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace(
      'data-bugreel-app="pulseboard"',
      `data-bugreel-app="pulseboard" data-bugreel-webhook="${WEBHOOK_URL}"`,
    );
    await route.fulfill({ response: res, body: html });
  });

  await page.goto('http://localhost:4173/demo/index.html');
  await expect
    .poll(() => page.evaluate(() => typeof (window as { BugReel?: unknown }).BugReel))
    .toBe('object');
  await expect(page.locator('bugreel-pill')).toHaveCount(1); // capture installed

  // Plant two real findings — staggered so each detector's watch window
  // completes: dead-click verdicts ~400ms after a click, and a second click
  // inside that window would count as activity (suppressing the verdict).
  await page.click('#deploy-btn');
  await page.waitForTimeout(900);
  await page.click('#save-btn');
  // The silent-failure error-UI watch expires ~2s after the 500.
  await page.waitForTimeout(2_800);
  // Third finding: 4 rapid clicks on Sync now → Rage Click (3+ in 1s). The
  // button is aria-disabled by design — force the clicks through like a
  // frustrated user would.
  for (let i = 0; i < 4; i++) await page.click('#sync-btn', { force: true });
  await page.waitForTimeout(400);

  // Open via the real floating pill.
  await page.locator('bugreel-pill').locator('button').click();
  const modal = page.locator('bugreel-modal');
  await expect(modal).toBeAttached();
  await expect(page.locator('[data-br="preview"]')).toContainText('What Happened', {
    timeout: 15_000,
  });
  // All three findings made it into the compiled preview (real finding copy).
  await expect(page.locator('[data-br="preview"]')).toContainText('nothing happened');
  await expect(page.locator('[data-br="preview"]')).toContainText('no error UI appeared');
  await expect(page.locator('[data-br="preview"]')).toContainText('rage-clicked');

  await page.locator('[data-br="trying"]').fill('deploy the release');
  await page.locator('[data-br="wrong"]').fill('nothing happened, then saving failed');

  // Mode 2 submit — the custom-endpoint multipart lands in the mock.
  await page.locator('[data-br="submit"]').click();
  await expect(page.locator('[data-br="status"]')).toContainText('submitted', {
    timeout: 10_000,
  });
  await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1);
  const post = posts[0]!;
  expect(post.contentType).toContain('multipart/form-data');
  const wire = post.body.toString('latin1');
  expect(wire).toContain('name="report"');
  expect(wire).toContain('name="bugpack"');
  // The webhook URL itself never echoes back inside the report body.
  expect(wire).not.toContain('/__webhook');

  // Mode 1 still available post-submit — download the full .bugpack.
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-br="download"]').click();
  const packBytes = await readFile((await (await downloadPromise).path())!);
  const entries = unzipStore(packBytes);
  const reportJson = JSON.parse(entries.get('report.json')!.toString('utf8')) as {
    schemaVersion: string;
    findings: { detectorId: string; severity: string }[];
    storySteps: { text: string }[];
  };
  expect(reportJson.schemaVersion).toBe('1.0');
  expect(reportJson.findings.map((f) => f.detectorId)).toEqual(
    expect.arrayContaining(['dead-click', 'silent-api-error', 'rage-click']),
  );
  expect(entries.get('report.md')).toBeTruthy();

  // Final leg — the SAME archive renders in the standalone player.
  await page.goto('http://localhost:4173/packages/player/player.html');
  const dataTransfer = await page.evaluateHandle((b64) => {
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], 'journey.bugpack', { type: 'application/zip' }));
    return dt;
  }, packBytes.toString('base64'));
  await page.locator('body').dispatchEvent('drop', { dataTransfer });

  // ≥3 findings — the last forced click on the aria-disabled button can
  // legitimately also dead-click; the pack's findings list carries the ids.
  await expect
    .poll(() => page.locator('.br-node.k-finding').count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(3);
  await expect(page.locator('.br-story')).toContainText('Deploy');
  await expect(page.locator('.br-inspector')).toBeVisible();

  expect(pageErrors).toEqual([]);
});
