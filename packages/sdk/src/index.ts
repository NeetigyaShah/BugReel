import { noopHandle, openActive, startBugReel, version } from './app';
import { createWorkerRuntime } from './worker/runtime';
import { detectors } from './worker/detectors';
import { scrubEvent } from './firewall/stage2';
import { idleWorker } from './localWorker';
import { installCapture } from './capture';
import type { BugReelConfig, BugReelHandle } from './app';
import type { WorkerLike } from './transport';

export * from './types';
export { packBugpack } from './worker/bugpack';
export { version };
export type { BugReelConfig, BugReelHandle };

/** The sibling worker bundle emitted next to this module (bundlers rebase it). */
const workerUrl = () => new URL('worker.global.js', import.meta.url);

/**
 * npm entry — `initBugReel({...})` from a bundler app. The npm chunk is not
 * size-budgeted, so it carries the full CSP fallback chain: direct Worker →
 * fetched source (blob/eval) → the real runtime in idle slices.
 */
export function initBugReel(config: BugReelConfig = {}): BugReelHandle {
  try {
    return startBugReel(config, {
      scriptUrl: import.meta.url,
      makeWorker: () => new Worker(workerUrl()) as unknown as WorkerLike,
      fallback: () => idleWorker(createWorkerRuntime({ detectors, scrubEvent })),
      installCapture, // static import — installs synchronously, no capture gap
    });
  } catch {
    return noopHandle;
  }
}

/** `BugReel.open()` — programmatic trigger for custom entry points. */
export function openBugReel(): void {
  openActive();
}
