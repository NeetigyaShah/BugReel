import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
  },
  {
    entry: { loader: 'src/loader.ts' },
    format: ['iife'],
    globalName: 'BugReel',
    minify: true,
    outExtension: () => ({ js: '.global.js' }),
  },
  {
    entry: { worker: 'src/worker.ts', modal: 'src/modal.ts' },
    format: ['iife'],
    minify: true,
    outExtension: () => ({ js: '.global.js' }),
  },
]);
