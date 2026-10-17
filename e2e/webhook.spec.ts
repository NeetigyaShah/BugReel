import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const fixture = pathToFileURL(path.join(__dirname, 'fixtures/webhook.html')).href;

/** Split a raw multipart body into its parts (headers + body text). */
const multipartParts = (contentType: string, body: Buffer) => {
  const boundary = /boundary=([^\s;]+)/.exec(contentType)?.[1] ?? '';
  return body
    .toString('binary')
    .split(`--${boundary}`)
    .filter((p) => p.includes('name="'));
};

const openAndSubmit = async (
  page: import('@playwright/test').Page,
  webhook: string,
  beforeSubmit?: () => void,
) => {
  await page.goto(`${fixture}?webhook=${encodeURIComponent(webhook)}`);
  await expect
    .poll(() => page.evaluate(() => typeof (window as { BugReel?: { open?: unknown } }).BugReel?.open))
    .toBe('function');
  await page.click('#btn'); // seed telemetry so the report has a story
  await page.evaluate(() => (window as { BugReel?: { open?: () => void } }).BugReel?.open?.());
  await page.locator('[data-br="trying"]').fill('check out');
  await page.locator('[data-br="wrong"]').fill('the pay button did nothing');
  // The worker round-trip compiles the report — submit is a no-op until it lands.
  await expect(page.locator('[data-br="preview"]')).toContainText('What Happened', {
    timeout: 15_000,
  });
  beforeSubmit?.();
  await page.locator('[data-br="submit"]').click();
};

test('Discord webhook receives the rich embed + .bugpack as multipart', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  let captured: { contentType: string; body: Buffer } | undefined;
  await page.route('**/discord.com/api/webhooks/**', async (route) => {
    const req = route.request();
    captured = {
      contentType: req.headers()['content-type'] ?? '',
      body: req.postDataBuffer() ?? Buffer.alloc(0),
    };
    await route.fulfill({
      status: 200,
      json: { ok: true },
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });

  await openAndSubmit(page, 'https://discord.com/api/webhooks/123/abc');
  await expect(page.locator('[data-br="status"]')).toContainText('Report submitted', {
    timeout: 15_000,
  });

  expect(captured).toBeTruthy();
  expect(captured!.contentType).toContain('multipart/form-data');
  const parts = multipartParts(captured!.contentType, captured!.body);
  const payloadPart = parts.find((p) => p.includes('name="payload_json"'));
  expect(payloadPart).toBeTruthy();
  const payloadJson = JSON.parse(
    payloadPart!.slice(payloadPart!.indexOf('\r\n\r\n')).replace(/[\r\n]/g, ' ').trim(),
  );
  expect(payloadJson.embeds).toHaveLength(1);
  expect(payloadJson.embeds[0].footer.text).toContain('BugReel');

  // No annotation was made in this spec — files[0] is the .bugpack itself.
  const filePart = parts.find((p) => p.includes('name="files[0]"'));
  expect(filePart).toBeTruthy();
  expect(filePart).toContain('.bugpack');
  const pk = filePart!.indexOf('PK\x03\x04');
  expect(pk).toBeGreaterThan(-1);

  expect(pageErrors).toEqual([]);
});

test('Slack webhook receives CORS-safe text/plain Block Kit and the bugpack downloads locally', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  let captured: { contentType: string; body: string } | undefined;
  await page.route('**/hooks.slack.com/**', async (route) => {
    const req = route.request();
    captured = { contentType: req.headers()['content-type'] ?? '', body: req.postData() ?? '' };
    await route.fulfill({
      status: 200,
      body: 'ok',
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });

  // The local download fires inside dispatch — arm the listener before submit.
  let downloadPromise: Promise<import('@playwright/test').Download> | undefined;
  await openAndSubmit(page, 'https://hooks.slack.com/services/T00000/B00000/xxx', () => {
    downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
  });

  // Slack gets no file — the full .bugpack must land locally.
  const download = await downloadPromise!;
  expect(download.suggestedFilename()).toMatch(/\.bugpack$/);
  await expect(page.locator('[data-br="status"]')).toContainText('downloaded locally', {
    timeout: 15_000,
  });

  expect(captured).toBeTruthy();
  // text/plain only — no preflight-triggering headers.
  expect(captured!.contentType).toContain('text/plain');
  const body = JSON.parse(captured!.body);
  expect(body.text).toBeTruthy();
  expect(body.blocks.map((b: { type: string }) => b.type)).toContain('section');
  const context = body.blocks.find((b: { type: string }) => b.type === 'context');
  expect(context.elements[0].text).toContain('downloaded locally');

  expect(pageErrors).toEqual([]);
});

test('custom webhook receives multipart report + bugpack', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  let captured: { contentType: string; body: Buffer } | undefined;
  await page.route('**/hooks.example.test/**', async (route) => {
    const req = route.request();
    captured = {
      contentType: req.headers()['content-type'] ?? '',
      body: req.postDataBuffer() ?? Buffer.alloc(0),
    };
    await route.fulfill({
      status: 200,
      json: { ok: true },
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });

  await openAndSubmit(page, 'https://hooks.example.test/bugreel');
  await expect(page.locator('[data-br="status"]')).toContainText('Report submitted', {
    timeout: 15_000,
  });

  expect(captured).toBeTruthy();
  const parts = multipartParts(captured!.contentType, captured!.body);
  const reportPart = parts.find((p) => p.includes('name="report"'));
  const bugpackPart = parts.find((p) => p.includes('name="bugpack"'));
  expect(reportPart).toBeTruthy();
  expect(bugpackPart).toBeTruthy();
  expect(reportPart).toContain('"schemaVersion":"1.0"');
  expect(bugpackPart).toContain('.bugpack');

  expect(pageErrors).toEqual([]);
});

test('a non-2xx webhook response surfaces an honest error and retry stays possible', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.route('**/hooks.slack.com/**', async (route) => {
    await route.fulfill({
      status: 500,
      body: 'server error',
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });

  await openAndSubmit(page, 'https://hooks.slack.com/services/T00000/B00000/xxx');
  await expect(page.locator('[data-br="status"]')).toContainText('Submit failed', {
    timeout: 15_000,
  });
  await expect(page.locator('[data-br="status"]')).toContainText('500');
  // Retry is possible — the submit button is usable again.
  await expect(page.locator('[data-br="submit"]')).toBeEnabled();

  expect(pageErrors).toEqual([]);
});
