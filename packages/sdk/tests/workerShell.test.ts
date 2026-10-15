import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PORT_KEY, type MainThreadPort } from '../src/port';
import type { FromWorkerMessage } from '../src/types';
import { click, meta } from './helpers';

const globals = globalThis as unknown as Record<string, unknown>;

/** Evaluate worker.ts the way the `<script>` fallback does: on the main thread. */
const loadAsMainThreadScript = async (): Promise<MainThreadPort> => {
  vi.resetModules();
  await import('../src/worker');
  return globals[PORT_KEY] as MainThreadPort;
};

beforeEach(() => {
  delete globals[PORT_KEY];
});

afterEach(() => {
  delete globals[PORT_KEY];
});

describe('worker shell — main-thread <script> fallback', () => {
  it('publishes a private port instead of touching the global message surface', async () => {
    const hostOnMessage = vi.fn();
    globals.onmessage = hostOnMessage;
    globals.postMessage = vi.fn();
    try {
      const port = await loadAsMainThreadScript();
      expect(typeof port.receive).toBe('function');
      expect(globals.onmessage).toBe(hostOnMessage);
      expect(globals.postMessage).not.toHaveBeenCalled();
    } finally {
      delete globals.onmessage;
      delete globals.postMessage;
    }
  });

  it('compiles a report for inbound work and replies through the port', async () => {
    const port = await loadAsMainThreadScript();
    const replies: FromWorkerMessage[] = [];
    port.reply = (message) => replies.push(message as FromWorkerMessage);

    port.receive({ type: 'bugreel:event', event: click('p1', Date.now() - 100) });
    port.receive({ type: 'bugreel:compile', requestId: 'r1', meta });

    expect(replies.map((m) => m.type)).toEqual(['bugreel:report']);
    const report = replies[0];
    if (report?.type === 'bugreel:report') {
      expect(report.requestId).toBe('r1');
      expect(report.report.events.map((e) => e.id)).toEqual(['p1']);
    }
  });

  it('ignores anything that is not inbound work — replies can never loop back as work', async () => {
    const port = await loadAsMainThreadScript();
    const replies: FromWorkerMessage[] = [];
    port.reply = (message) => replies.push(message as FromWorkerMessage);

    for (const junk of [
      { type: 'bugreel:worker-ready' },
      { type: 'bugreel:error', message: 'x' },
      { type: 'bugreel:report' },
      { type: 'bogus' },
      null,
      'bugreel:compile',
    ]) {
      port.receive(junk);
    }
    expect(replies).toEqual([]);
  });
});
