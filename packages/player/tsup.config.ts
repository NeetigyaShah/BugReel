import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    clean: true,
  },
  {
    entry: { player: 'src/player.ts' },
    format: ['iife'],
    minify: true,
    outExtension: () => ({ js: '.global.js' }),
  },
]);
