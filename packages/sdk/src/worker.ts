/// <reference lib="webworker" />

import { createWorkerRuntime } from './worker/runtime';
import type { FromWorkerMessage, ToWorkerMessage } from './types';

declare const self: DedicatedWorkerGlobalScope;

const runtime = createWorkerRuntime();

self.postMessage({ type: 'bugreel:worker-ready' } satisfies FromWorkerMessage);
self.onmessage = (e: MessageEvent<ToWorkerMessage>) => {
  for (const message of runtime.handleMessage(e.data)) {
    self.postMessage(message);
  }
};

export {};
