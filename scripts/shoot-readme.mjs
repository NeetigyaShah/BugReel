/**
 * README screenshot shooter — drives the real demo app through the real
 * BugReel flow and saves PNGs into docs/screenshots/.
 *
 * Usage: node demo/serve.mjs is already running (or start it) then:
 *   node scripts/shoot-readme.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'docs', 'screenshots');
mkdirSync(shots, { recursive: true });

const DEMO = 'http://localhost:4173/demo/';
const PLAYER = 'http://localhost:4173/packages/player/player.html';
const UPLOAD_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('pageerror:', String(e)));

// 1 — the demo app itself, pill visible bottom-right.
await page.goto(DEMO, { waitUntil: 'networkidle' });
// The host element is zero-size — the shadow button inside it is visible.
await page.locator('bugreel-pill').waitFor({ state: 'attached' });
await page.locator('bugreel-pill').locator('button').waitFor();
await page.screenshot({ path: path.join(shots, '01-demo-app.png') });
console.log('shot 1: demo app');

// 2 — plant the planted bugs, open the modal, report compiles.
await page.click('#deploy-btn');
await page.waitForTimeout(900);
await page.click('#save-btn');
await page.waitForTimeout(2800);
await page.locator('bugreel-pill').locator('button').click();
await page.locator('[data-br="preview"] h3').getByText('What Happened').waitFor({ timeout: 15_000 });

// Fill the two required answers so the shot looks like a real report.
await page.locator('[data-br="trying"]').fill('deploy the release');
await page.locator('[data-br="wrong"]').fill('deploy did nothing, then save failed silently');
await page.waitForTimeout(600); // preview recompile
await page.screenshot({ path: path.join(shots, '02-report-modal.png') });
console.log('shot 2: modal + compiled report');

// 3 — annotator open (upload fallback path in headless). Feed it a real
// screenshot of the page so the shot shows a real annotated UI, not a
// placeholder square.
const host = page.locator('[data-br="annotator"]');
const realShot = await page.screenshot();
const chooser = page.waitForEvent('filechooser', { timeout: 20_000 }).catch(() => null);
await page.locator('[data-br="annotate"]').click();
const fc = await Promise.race([chooser, host.waitFor({ state: 'visible', timeout: 20_000 }).then(() => null)]);
if (fc) await fc.setFiles({ name: 'screen.png', mimeType: 'image/png', buffer: realShot });
await host.waitFor({ state: 'visible', timeout: 20_000 });
const ink = page.locator('[data-br="anno-ink"]');
const box = await ink.boundingBox();
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.25);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.7, { steps: 8 });
await page.mouse.up();
await page.screenshot({ path: path.join(shots, '03-annotator.png') });
console.log('shot 3: annotator');
await page.locator('[data-br="anno-done"]').click();

// 4 — download the .bugpack for the player shot.
const downloadPromise = page.waitForEvent('download');
await page.locator('[data-br="download"]').click();
const packPath = path.join(shots, 'sample.bugpack');
await (await downloadPromise).saveAs(packPath);
console.log('saved sample.bugpack for player shot');

// 5 — player.html with the real archive.
await page.goto(PLAYER, { waitUntil: 'networkidle' });
await page.locator('#file').setInputFiles(packPath);
// First finding is auto-selected; the mini drop-zone sits over the rail.
await page.locator('.br-node.k-finding.sel').first().waitFor({ timeout: 15_000 });
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(shots, '04-player.png') });
console.log('shot 4: player');

await browser.close();
console.log('done — docs/screenshots/{01-demo-app,02-report-modal,03-annotator,04-player}.png');
