import { describe, expect, it, vi } from 'vitest';
import { PORT_KEY, type MainThreadPort } from '../src/port';
import { createTransport, scriptTagWorker } from '../src/transport';
import { idleWorker } from '../src/localWorker';
import { createWorkerRuntime } from '../src/worker/runtime';
import type { ToWorkerMessage } from '../src/types';
import { click, meta } from './helpers';
import { fakeWorker, FakeWindow } from './fakes';

const eventMsg = (id: string): ToWorkerMessage => ({
  type: 'bugreel:event',
  event: click(id, Date.now()),
});

const syncIdle = (cb: () => void) => cb();

describe('pre-worker queue', () => {
  it('queues messages until the worker posts bugreel:worker-ready, then drains in order', () => {
    const worker = fakeWorker();
    const t = createTransport({ makeWorker: () => worker, scheduleIdle: syncIdle, autoStart: false });
    t.send(eventMsg('a'));
    t.send(eventMsg('b'));
    expect(worker.posted).toHaveLength(0);
    t.start();
    worker.ready();
    expect(worker.posted.map((m) => (m as { event: { id: string } }).event.id)).toEqual(['a', 'b']);
  });

  it('posts directly once the worker is ready', () => {
    const worker = fakeWorker();
    const t = createTransport({ makeWorker: () => worker, scheduleIdle: syncIdle, autoStart: false });
    t.start();
    worker.ready();
    t.send(eventMsg('late'));
    expect(worker.posted).toHaveLength(1);
  });

  it('bounds the queue, dropping oldest first', () => {
    const worker = fakeWorker();
    const t = createTransport({
      makeWorker: () => worker,
      scheduleIdle: syncIdle,
      queueLimit: 3,
      autoStart: false,
    });
    for (const id of ['1', '2', '3', '4', '5']) t.send(eventMsg(id));
    t.start();
    worker.ready();
    expect(worker.posted.map((m) => (m as { event: { id: string } }).event.id)).toEqual(['3', '4', '5']);
  });

  it('preserves annotate ordering relative to events', () => {
    const worker = fakeWorker();
    const t = createTransport({ makeWorker: () => worker, scheduleIdle: syncIdle, autoStart: false });
    t.send(eventMsg('c1'));
    t.send({ type: 'bugreel:annotate', eventId: 'c1', patch: { domMutatedAfterClick: false } });
    t.start();
    worker.ready();
    expect(worker.posted.map((m) => m.type)).toEqual(['bugreel:event', 'bugreel:annotate']);
  });

  it('forwards non-ready worker messages to onMessage', () => {
    const worker = fakeWorker();
    const onMessage = vi.fn();
    const t = createTransport({ makeWorker: () => worker, scheduleIdle: syncIdle, onMessage, autoStart: false });
    t.start();
    worker.deliver({ type: 'bugreel:error', message: 'oops' });
    expect(onMessage).toHaveBeenCalledWith({ type: 'bugreel:error', message: 'oops' });
  });
});

describe('worker bootstrap', () => {
  it('uses workerUrl override when configured', () => {
    const worker = fakeWorker();
    const startWorker = vi.fn(() => worker);
    const t = createTransport({ workerUrl: 'https://cdn.test/w.js', startWorker, scheduleIdle: syncIdle, autoStart: false });
    t.start();
    expect(startWorker).toHaveBeenCalledWith('https://cdn.test/w.js');
  });

  it('fetches sibling worker source and runs it through a blob worker', async () => {
    const worker = fakeWorker();
    const fetchText = vi.fn(async () => 'worker-source');
    const urls: unknown[] = [];
    const t = createTransport({
      resolveWorkerUrl: () => 'https://cdn.test/worker.global.js',
      fetchText,
      startWorker: (url) => {
        urls.push(url);
        return worker;
      },
      scheduleIdle: syncIdle,
      autoStart: false,
    });
    t.start();
    await Promise.resolve();
    expect(fetchText).toHaveBeenCalledWith('https://cdn.test/worker.global.js');
    expect(urls).toHaveLength(1);
    expect(String(urls[0])).toMatch(/^(blob|data):/);
  });

  it('falls back to a same-origin <script> bridge when workers are blocked', async () => {
    const win = new FakeWindow();
    const hostOnMessage = vi.fn();
    win.onmessage = hostOnMessage;
    const onMessage = vi.fn();
    const t = createTransport({
      makeWorker: () => {
        throw new Error('csp');
      },
      resolveWorkerUrl: () => 'https://cdn.test/worker.global.js',
      fetchText: async () => {
        throw new Error('fetch blocked');
      },
      fallback: () =>
        scriptTagWorker(win as never, 'https://cdn.test/worker.global.js', syncIdle),
      scheduleIdle: syncIdle,
      onMessage,
      autoStart: false,
    });
    t.send(eventMsg('pre'));
    t.start();
    await Promise.resolve();
    // The sibling worker source is injected as a classic <script>.
    const script = win.document.created.find((e) => e.tag === 'SCRIPT');
    expect(script?.src).toBe('https://cdn.test/worker.global.js');

    // Simulate worker.global.js evaluating: it publishes a private port...
    const inbox: unknown[] = [];
    const port: MainThreadPort = {
      reply: null,
      receive: (data) => {
        inbox.push(data);
      },
    };
    (win as unknown as Record<string, unknown>)[PORT_KEY] = port;
    // ...and the transport announces readiness once the script has loaded.
    (script as { onload?: (() => void) | null }).onload?.();
    expect(inbox.map((m) => (m as ToWorkerMessage).type)).toEqual(['bugreel:event']);

    // Worker -> transport replies travel through the port, not window messages.
    port.reply?.({ type: 'bugreel:report', report: { ok: true } });
    expect(onMessage).toHaveBeenCalledWith({ type: 'bugreel:report', report: { ok: true } });

    // The host page's own message handler is never touched or invoked.
    expect(win.onmessage).toBe(hostOnMessage);
    expect(hostOnMessage).not.toHaveBeenCalled();
  });

  it('abandons a worker that never reports ready and falls back', async () => {
    vi.useFakeTimers();
    try {
      const terminate = vi.fn();
      const stuck = { onmessage: null, postMessage: vi.fn(), terminate };
      const local = fakeWorker();
      const t = createTransport({
        makeWorker: () => stuck,
        fallback: () => local,
        scheduleIdle: syncIdle,
        autoStart: false,
      });
      t.send(eventMsg('pre'));
      t.start();
      await Promise.resolve();
      expect(stuck.postMessage).not.toHaveBeenCalled();

      vi.advanceTimersByTime(4_001);
      expect(terminate).toHaveBeenCalledTimes(1);
      local.ready();
      expect(local.posted.map((m) => m.type)).toEqual(['bugreel:event']);
      t.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fall back when the worker reports ready in time', async () => {
    vi.useFakeTimers();
    try {
      const worker = fakeWorker();
      const fallback = vi.fn(() => fakeWorker());
      const t = createTransport({
        makeWorker: () => worker,
        fallback,
        scheduleIdle: syncIdle,
        autoStart: false,
      });
      t.start();
      await Promise.resolve();
      worker.ready();
      vi.advanceTimersByTime(10_000);
      expect(fallback).not.toHaveBeenCalled();
      t.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the injected runtime on the main thread in idle slices as the last resort', async () => {
    const onMessage = vi.fn();
    const t = createTransport({
      makeWorker: () => {
        throw new Error('csp');
      },
      fallback: () => idleWorker(createWorkerRuntime(), syncIdle),
      scheduleIdle: syncIdle,
      onMessage,
      autoStart: false,
    });
    t.send(eventMsg('pre'));
    t.start();
    await Promise.resolve(); // local worker announces readiness on a microtask
    t.send({ type: 'bugreel:compile', requestId: 'r1', meta });
    const report = onMessage.mock.calls.map((c) => c[0]).find((m) => m.type === 'bugreel:report');
    expect(report?.requestId).toBe('r1');
    expect(report?.report.events.map((e: { id: string }) => e.id)).toEqual(['pre']);
  });

  it('stays inert but fail-safe when every bootstrap path fails', () => {
    const t = createTransport({
      makeWorker: () => {
        throw new Error('csp');
      },
      fallback: () => {
        throw new Error('no runtime');
      },
      scheduleIdle: syncIdle,
      autoStart: false,
    });
    expect(() => {
      t.start();
      t.send(eventMsg('x'));
    }).not.toThrow();
  });
});

describe('destroy', () => {
  it('terminates the worker and drops later sends', () => {
    const worker = fakeWorker();
    const t = createTransport({ makeWorker: () => worker, scheduleIdle: syncIdle, autoStart: false });
    t.start();
    worker.ready();
    t.destroy();
    expect(worker.terminated).toBe(true);
    t.send(eventMsg('gone'));
    expect(worker.posted).toHaveLength(0);
  });
});
