import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loaderFile = path.join(root, 'packages/sdk/dist/loader.global.js');
const LIMIT = 3.5 * 1024;

let source;
try {
  source = readFileSync(loaderFile);
} catch {
  console.error(`size-check: ${loaderFile} not found — run pnpm build first`);
  process.exit(1);
}

const size = gzipSync(source, { level: 9 }).length;
const kb = (size / 1024).toFixed(2);

if (size >= LIMIT) {
  console.error(`size-check FAIL: loader.global.js is ${kb}KB gzipped (budget 3.5KB)`);
  process.exit(1);
}
console.log(`size-check OK: loader.global.js is ${kb}KB gzipped (budget 3.5KB)`);
