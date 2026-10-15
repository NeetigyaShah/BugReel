import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
  },
  {
    // No globalName: loader.ts assigns `globalThis.BugReel` itself, which keeps
    // the ~450B esbuild export-interop shim out of the size-budgeted chunk.
    entry: { loader: 'src/loader.ts' },
    format: ['iife'],
    minify: true,
    outExtension: () => ({ js: '.global.js' }),
  },
  {
    // Lazy capture chunk — injected as a classic <script> by the CDN loader
    // (and statically imported by the npm entry) so heavy capture paths stay
    // out of the size-budgeted loader chunk.
    entry: { capture: 'src/capture.ts' },
    format: ['iife'],
    globalName: 'BugReelCapture',
    minify: true,
    outExtension: () => ({ js: '.global.js' }),
  },
  {
    entry: { worker: 'src/worker.ts' },
    format: ['iife'],
    minify: true,
    outExtension: () => ({ js: '.global.js' }),
  },
  {
    // Chunk 3 — the Shadow-DOM modal, injected as a classic sibling <script>
    // on first open (CDN) or resolved via dynamic import (npm).
    entry: { modal: 'src/modal.ts' },
    format: ['iife'],
    globalName: 'BugReelModal',
    minify: true,
    outExtension: () => ({ js: '.global.js' }),
  },
]);
