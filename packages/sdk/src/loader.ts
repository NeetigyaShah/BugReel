import { noopHandle, openActive, startBugReel, version } from './app';
import type { BugReelConfig, BugReelHandle } from './app';

interface ScriptElementLike {
  src?: string;
  dataset?: Record<string, string | undefined>;
}

// document.currentScript is only readable while this script evaluates —
// capture it now so the sibling artifacts (worker/capture .global.js) resolve.
const scriptEl = (
  typeof document !== 'undefined' ? document.currentScript : null
) as ScriptElementLike | null;
const scriptUrl = scriptEl?.src;

/**
 * CDN entry — `BugReel.init({...})`. The worker boots from the sibling
 * `worker.global.js` (fetched to a Blob URL); the heavy capture paths arrive
 * via sibling `capture.global.js`. `config.workerUrl` overrides the worker URL.
 */
function init(config: BugReelConfig = {}): BugReelHandle {
  try {
    return startBugReel(config, { scriptUrl });
  } catch {
    return noopHandle;
  }
}

/** `BugReel.open()` — programmatic trigger for custom entry points. */
function open(): void {
  openActive();
}

// Attach the global namespace manually — this file intentionally has no ESM
// exports so the iife bundle skips esbuild's ~450B export-interop shim.
(globalThis as { BugReel?: unknown }).BugReel = { init, open, version };

// Script-tag auto-init: `data-bugreel-*` attributes become the config.
const attrs = scriptEl?.dataset;
if (scriptEl && attrs) {
  init({
    webhookUrl: attrs.bugreelWebhook,
    workerUrl: attrs.bugreelWorkerUrl,
    hotkey: attrs.bugreelHotkey,
    pill: attrs.bugreelPill === undefined ? 'auto' : attrs.bugreelPill === 'true',
    shake: attrs.bugreelShake === 'true',
    privacyMode: attrs.bugreelPrivacy === 'strict' ? 'strict' : 'standard',
    project: attrs.bugreelProject,
    app: attrs.bugreelApp,
  });
}
