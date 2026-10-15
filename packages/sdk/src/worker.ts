/// <reference lib="webworker" />

import { createWorkerRuntime, isToWorkerMessage } from './worker/runtime';
import { detectors } from './worker/detectors';
import { scrubEvent } from './firewall/stage2';
import type { FromWorkerMessage } from './types';

declare const self: DedicatedWorkerGlobalScope;

const runtime = createWorkerRuntime({ detectors, scrubEvent });

self.postMessage({ type: 'bugreel:worker-ready' } satisfies FromWorkerMessage);
self.onmessage = (e: MessageEvent<unknown>) => {
  if (!isToWorkerMessage(e.data)) return;
  for (const message of runtime.handleMessage(e.data)) {
    self.postMessage(message);
  }
};

export {};
