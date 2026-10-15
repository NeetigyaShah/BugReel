import { scheduleIdle } from './util';
import type { ToWorkerMessage } from './types';
import type { RuntimeHandle, WorkerLike } from './transport';

/**
 * Strict-CSP last resort: `createWorkerRuntime` run on the main thread with
 * inbound messages processed inside idle slices so capture never blocks the
 * app. Only the npm entry injects this — the CDN loader relies on the fetched
 * worker source (Blob URL or `self`-shim eval) instead, keeping chunk 1 small.
 */
export function idleWorker(
  runtime: RuntimeHandle,
  schedule: (cb: () => void) => void = scheduleIdle,
): WorkerLike {
  const pending: ToWorkerMessage[] = [];
  let scheduled = false;
  const self: WorkerLike = {
    onmessage: null,
    postMessage(m) {
      pending.push(m as ToWorkerMessage);
      if (!scheduled) {
        scheduled = true;
        schedule(run);
      }
    },
    terminate() {
      pending.length = 0;
    },
  };
  const run = (): void => {
    scheduled = false;
    for (const m of pending.splice(0)) {
      try {
        for (const reply of runtime.handleMessage(m)) self.onmessage?.({ data: reply });
      } catch {
        /* ignore */
      }
    }
  };
  // Announce readiness asynchronously so the transport can install onmessage first.
  void Promise.resolve().then(() => self.onmessage?.({ data: { type: 'bugreel:worker-ready' } }));
  return self;
}
