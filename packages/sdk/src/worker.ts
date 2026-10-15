/// <reference lib="webworker" />

declare const self: DedicatedWorkerGlobalScope;

self.postMessage({ type: 'bugreel:worker-ready' });

export {};
