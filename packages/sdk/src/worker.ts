/// <reference lib="webworker" />

import { PORT_KEY, type MainThreadPort } from './port';
import { createWorkerRuntime, isToWorkerMessage } from './worker/runtime';
import { detectors } from './worker/detectors';
import { scrubEvent } from './firewall/stage2';
import type { FromWorkerMessage } from './types';

declare const self: DedicatedWorkerGlobalScope;

const runtime = createWorkerRuntime({ detectors, scrubEvent });
const handle = (data: unknown): FromWorkerMessage[] =>
  isToWorkerMessage(data) ? runtime.handleMessage(data) : [];

if (typeof WorkerGlobalScope === 'undefined') {
  // Main-thread <script> fallback: talk through a private port. The transport
  // announces readiness itself once it has attached `reply`.
  const port: MainThreadPort = {
    reply: null,
    receive(data) {
      for (const message of handle(data)) port.reply?.(message);
    },
  };
  (globalThis as Record<string, unknown>)[PORT_KEY] = port;
} else {
  self.postMessage({ type: 'bugreel:worker-ready' } satisfies FromWorkerMessage);
  self.onmessage = (e: MessageEvent<unknown>) => {
    for (const message of handle(e.data)) self.postMessage(message);
  };
}

export {};
