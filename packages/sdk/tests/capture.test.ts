import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCapture, type CaptureDeps } from '../src/capture';
import type { ModalHandle } from '../src/modal';
import type { ConsoleEvent, ErrorEvent, NetworkEvent } from '../src/types';
import { collect, el, FakeWindow, fakeResponse, FakeXHR } from './fakes';

let win: FakeWindow;
let idCounter: number;
let time: number;

const makeCapture = (deps: Partial<CaptureDeps> = {}) => {
  const sink = collect();
  const capture = installCapture({
    window: win,
    send: sink.emit,
    now: () => time,
    randomId: () => `id-${++idCounter}`,
    ...deps,
  });
  return { capture, sink };
};

beforeEach(() => {
  vi.useFakeTimers();
  win = new FakeWindow();
  idCounter = 0;
  time = 1_700_000_000_000;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('target enrichment hand-off', () => {
  it('registers the rich element describer with the sensor on install', () => {
    const setDescribeTarget = vi.fn();
    makeCapture({ setDescribeTarget });
    expect(setDescribeTarget).toHaveBeenCalledTimes(1);
    const describe = setDescribeTarget.mock.calls[0]![0] as (el: Element) => { selector: string };
    expect(describe(el('BUTTON')).selector).toBe('button');
  });

  it('still installs when the sensor does not offer the hook', () => {
    expect(() => makeCapture()).not.toThrow();
  });
});

describe('pill trigger', () => {
  const mount = () => {
    const remove = vi.fn();
    return { remove, mountPill: vi.fn((_doc: unknown, _onOpen: () => void) => ({ remove })) };
  };

  it('mounts on localhost in auto mode and wires its click to onOpen', () => {
    win.location.hostname = 'localhost';
    const onOpen = vi.fn();
    const { mountPill } = mount();
    makeCapture({ pill: 'auto', onOpen, mountPill });
    expect(mountPill).toHaveBeenCalledTimes(1);
    mountPill.mock.calls[0]![1]();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('stays hidden on production hostnames in auto mode', () => {
    win.location.hostname = 'app.example.com';
    const { mountPill } = mount();
    makeCapture({ pill: 'auto', mountPill });
    expect(mountPill).not.toHaveBeenCalled();
  });

  it('pill:true shows on production and is removed on destroy', () => {
    win.location.hostname = 'app.example.com';
    const { mountPill, remove } = mount();
    const { capture } = makeCapture({ pill: true, mountPill });
    expect(mountPill).toHaveBeenCalledTimes(1);
    capture.destroy();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('fetch interception', () => {
  it('emits a network event with status, headers, bodies and duration', async () => {
    win.fetch = vi.fn(async () => fakeResponse(200, '{"ok":true}'));
    const { sink } = makeCapture();
    time += 40;

    const res = await win.fetch!('/api/items?q=1', {
      method: 'post',
      headers: { 'x-a': 'b' },
      body: '{"q":1}',
    });
    expect(res).toMatchObject({ status: 200 });
    await vi.advanceTimersByTimeAsync(0);

    const event = sink.events.find((e) => e.type === 'fetch') as NetworkEvent;
    expect(event).toMatchObject({
      type: 'fetch',
      method: 'POST',
      url: '/api/items?q=1',
      status: 200,
      ok: true,
      requestHeaders: { 'x-a': 'b' },
      responseHeaders: { 'content-type': 'application/json' },
      requestBody: '{"q":1}',
      responseBody: '{"ok":true}',
    });
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits a failure event on rejection without throwing into the host', async () => {
    win.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { sink } = makeCapture();
    await expect(win.fetch!('/api')).rejects.toThrow('Failed to fetch');
    await vi.advanceTimersByTimeAsync(0);
    const event = sink.events.find((e) => e.type === 'fetch') as NetworkEvent;
    expect(event).toMatchObject({ type: 'fetch', ok: false, corsBlocked: true });
    expect(event.status).toBeUndefined();
  });

  it('truncates oversized bodies to ~4KB', async () => {
    win.fetch = vi.fn(async () => fakeResponse(200, 'x'.repeat(10_000)));
    const { sink } = makeCapture();
    await win.fetch!('/big');
    await vi.advanceTimersByTimeAsync(0);
    const event = sink.events.find((e) => e.type === 'fetch') as NetworkEvent;
    expect(event.responseBody!.length).toBeLessThanOrEqual(4_100);
  });

  it('survives a fetch that throws synchronously', async () => {
    win.fetch = vi.fn(() => {
      throw new TypeError('sync');
    }) as never;
    const { sink } = makeCapture();
    expect(() => win.fetch!('/bad')).toThrow('sync');
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.events.find((e) => e.type === 'fetch')).toMatchObject({ ok: false });
  });
});

describe('XHR interception', () => {
  it('emits an xhr event with method, url, status, headers and bodies', () => {
    win.XMLHttpRequest = FakeXHR;
    const { sink } = makeCapture();
    const xhr = new FakeXHR();
    xhr.open('POST', '/api/save');
    xhr.setRequestHeader('x-token', 'abc');
    xhr.send('payload');
    xhr.status = 201;
    xhr.responseText = '{"done":true}';
    xhr.finish();

    const event = sink.events.find((e) => e.type === 'xhr') as NetworkEvent;
    expect(event).toMatchObject({
      type: 'xhr',
      method: 'POST',
      url: '/api/save',
      status: 201,
      requestHeaders: { 'x-token': 'abc' },
      requestBody: 'payload',
      responseBody: '{"done":true}',
      responseHeaders: { 'content-type': 'application/json' },
    });
  });
});

describe('console and error capture', () => {
  it('wraps console.error/warn, emits console events, and still calls through', () => {
    const origError = win.console.error;
    const origWarn = win.console.warn;
    const { sink } = makeCapture();
    win.console.error('boom', { detail: 1 });
    win.console.warn('careful');
    const [error, warn] = sink.events as ConsoleEvent[];
    expect(error).toMatchObject({ type: 'console', level: 'error' });
    expect(error!.message).toContain('boom');
    expect(error!.message).toContain('"detail":1');
    expect(warn).toMatchObject({ type: 'console', level: 'warn', message: 'careful' });
    expect(origError).toHaveBeenCalled();
    expect(origWarn).toHaveBeenCalled();
  });

  it('captures the stack from Error arguments', () => {
    const { sink } = makeCapture();
    win.console.error(new Error('with stack'));
    const event = sink.events[0] as ConsoleEvent;
    expect(event.message).toContain('with stack');
    expect(event.stack).toBeTruthy();
  });

  it('emits an error event for window script errors', () => {
    const { sink } = makeCapture();
    win.fire('error', {
      message: 'Uncaught TypeError',
      filename: 'app.js',
      lineno: 3,
      colno: 7,
      error: { stack: 'STACK' },
      target: win,
    });
    const event = sink.events[0] as ErrorEvent;
    expect(event).toMatchObject({
      type: 'error',
      source: 'window.onerror',
      message: 'Uncaught TypeError',
      filename: 'app.js',
      lineno: 3,
      colno: 7,
      stack: 'STACK',
    });
  });

  it('ignores resource-load error events bubbling through window', () => {
    const { sink } = makeCapture();
    win.fire('error', { target: el('IMG') });
    expect(sink.events).toHaveLength(0);
  });

  it('emits an error event for unhandled rejections', () => {
    const { sink } = makeCapture();
    win.fire('unhandledrejection', { reason: new Error('promise broke') });
    expect(sink.events[0]).toMatchObject({
      type: 'error',
      source: 'unhandledrejection',
      message: 'promise broke',
    });
  });
});

describe('shake trigger (opt-in)', () => {
  const shake = { accelerationIncludingGravity: { x: 40, y: 0, z: 0 } };

  it('does not listen for devicemotion unless enabled', () => {
    makeCapture();
    expect(win.listensTo('devicemotion')).toBe(false);
  });

  it('fires onShake on a strong motion when enabled, with a cooldown', () => {
    const onShake = vi.fn();
    makeCapture({ shake: true, onShake });
    win.fire('devicemotion', shake);
    win.fire('devicemotion', shake);
    expect(onShake).toHaveBeenCalledTimes(1);
    time += 1_100;
    win.fire('devicemotion', shake);
    expect(onShake).toHaveBeenCalledTimes(2);
  });

  it('ignores gentle motion', () => {
    const onShake = vi.fn();
    makeCapture({ shake: true, onShake });
    win.fire('devicemotion', { accelerationIncludingGravity: { x: 2, y: 2, z: 9 } });
    expect(onShake).not.toHaveBeenCalled();
  });

  it('defers iOS requestPermission to the first user gesture', async () => {
    const requestPermission = vi.fn(async () => 'granted');
    win.DeviceMotionEvent = { requestPermission };
    const onShake = vi.fn();
    makeCapture({ shake: true, onShake });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(win.listensTo('devicemotion')).toBe(false);
    win.fire('pointerdown', { target: el('DIV') });
    await Promise.resolve();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    win.fire('devicemotion', shake);
    expect(onShake).toHaveBeenCalledTimes(1);
  });

  it('never attaches the listener when permission is denied', async () => {
    win.DeviceMotionEvent = { requestPermission: vi.fn(async () => 'denied') };
    const onShake = vi.fn();
    makeCapture({ shake: true, onShake });
    win.fire('pointerdown', {});
    await vi.advanceTimersByTimeAsync(0);
    win.fire('devicemotion', shake);
    expect(onShake).not.toHaveBeenCalled();
  });
});

describe('teardown', () => {
  it('restores wrappers and removes listeners on destroy', () => {
    const origFetch = vi.fn(async () => fakeResponse());
    win.fetch = origFetch;
    win.XMLHttpRequest = FakeXHR;
    const origError = win.console.error;
    const origSend = FakeXHR.prototype.send;
    const { capture } = makeCapture({ shake: true, onShake: () => {} });
    expect(win.fetch).not.toBe(origFetch);
    expect(win.console.error).not.toBe(origError);
    expect(FakeXHR.prototype.send).not.toBe(origSend);
    capture.destroy();
    expect(win.fetch).toBe(origFetch);
    expect(win.console.error).toBe(origError);
    expect(FakeXHR.prototype.send).toBe(origSend);
    expect(win.listeners).toHaveLength(0);
  });
});

describe('modal bootstrap (chunk 3)', () => {
  it('does nothing until the first bugreel:open event', () => {
    const installModal = vi.fn();
    makeCapture({ installModal });
    expect(installModal).not.toHaveBeenCalled();
    win.document.fire('bugreel:open', {});
    expect(installModal).toHaveBeenCalledTimes(1);
  });

  it('hands window + workerSend to the modal deps (npm path)', () => {
    const installModal = vi.fn((_deps: unknown) => ({ el: {} as HTMLElement, open() {}, close() {}, destroy: vi.fn() }));
    const workerSend = vi.fn();
    makeCapture({ installModal, workerSend });
    win.document.fire('bugreel:open', {});
    const deps = installModal.mock.calls[0]![0] as { window?: unknown; send?: unknown };
    expect(deps.window).toBe(win);
    expect(deps.send).toBe(workerSend);
    // Idempotent — a second open does not re-install.
    win.document.fire('bugreel:open', {});
    expect(installModal).toHaveBeenCalledTimes(1);
  });

  it('installs an already-present globalThis.BugReelModal without a script', () => {
    const destroy = vi.fn();
    const installModal = vi.fn(() => ({ el: {} as HTMLElement, open() {}, close() {}, destroy }));
    (globalThis as { BugReelModal?: unknown }).BugReelModal = { installModal };
    try {
      const { capture } = makeCapture();
      win.document.fire('bugreel:open', {});
      expect(installModal).toHaveBeenCalledTimes(1);
      // No sibling <script> needed when the global is already installed.
      expect(win.document.created.filter((e) => e.tag === 'SCRIPT')).toHaveLength(0);
      capture.destroy();
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      delete (globalThis as { BugReelModal?: unknown }).BugReelModal;
    }
  });

  it('CDN path: injects sibling modal.global.js resolved from the capture script', () => {
    const fakeScript = {
      tag: 'SCRIPT',
      src: 'https://cdn.test/lib/capture.global.js',
      listeners: [],
      addEventListener() {},
      removeEventListener() {},
      remove() {},
      load() {},
      innerHTML: '',
      removed: false,
      fire() {},
    };
    win.document.created.push(fakeScript as never);
    try {
      makeCapture();
      win.document.fire('bugreel:open', {});
      const script = win.document.created.find(
        (e) => e.tag === 'SCRIPT' && e.src === 'https://cdn.test/lib/modal.global.js',
      );
      expect(script).toBeTruthy();
      // The chunk lands later — its global installs the modal on script load.
      const installModal = vi.fn((_deps: unknown) => ({ el: {} as HTMLElement, open() {}, close() {}, destroy: vi.fn() }));
      (globalThis as { BugReelModal?: unknown }).BugReelModal = { installModal };
      (script as { onload?: (() => void) | null }).onload?.();
      expect(installModal).toHaveBeenCalledTimes(1);
    } finally {
      delete (globalThis as { BugReelModal?: unknown }).BugReelModal;
    }
  });

  it('forwards data-bugreel-webhook from our own script tag to modal deps (CDN path)', () => {
    const installModal = vi.fn((_deps: unknown) => ({ el: {} as HTMLElement, open() {}, close() {}, destroy: vi.fn() }));
    win.document.created.push(
      { tag: 'SCRIPT', src: 'https://cdn.test/loader.global.js', dataset: { bugreelWebhook: 'https://discord.com/api/webhooks/1/x' } } as never,
      // An unrelated script tag must not win.
      { tag: 'SCRIPT', src: 'https://cdn.test/other.js' } as never,
    );
    makeCapture({ installModal });
    win.document.fire('bugreel:open', {});
    const deps = installModal.mock.calls[0]![0] as { webhook?: string };
    expect(deps.webhook).toBe('https://discord.com/api/webhooks/1/x');
  });

  it('reads the webhook attribute off any script carrying data-bugreel-*', () => {
    const installModal = vi.fn((_deps: unknown) => ({ el: {} as HTMLElement, open() {}, close() {}, destroy: vi.fn() }));
    win.document.created.push(
      { tag: 'SCRIPT', dataset: { bugreelPill: 'true', bugreelWebhook: 'https://hooks.slack.com/services/T/B/x' } } as never,
    );
    makeCapture({ installModal });
    win.document.fire('bugreel:open', {});
    const deps = installModal.mock.calls[0]![0] as { webhook?: string };
    expect(deps.webhook).toBe('https://hooks.slack.com/services/T/B/x');
  });

  it('leaves webhook unset when no script tag carries it', () => {
    const installModal = vi.fn((_deps: unknown) => ({ el: {} as HTMLElement, open() {}, close() {}, destroy: vi.fn() }));
    win.document.created.push({ tag: 'SCRIPT', src: 'https://cdn.test/loader.global.js' } as never);
    makeCapture({ installModal });
    win.document.fire('bugreel:open', {});
    const deps = installModal.mock.calls[0]![0] as { webhook?: string };
    expect(deps.webhook).toBeUndefined();
  });

  it('hands the modal the PRE-wrap fetch so webhook POSTs never self-report', async () => {
    const origFetch = vi.fn(async () => fakeResponse(200));
    win.fetch = origFetch;
    const installModal = vi.fn((_deps: unknown) => ({ el: {} as HTMLElement, open() {}, close() {}, destroy: vi.fn() }));
    const { sink } = makeCapture({ installModal });
    win.document.fire('bugreel:open', {});
    const deps = installModal.mock.calls[0]![0] as {
      fetch?: (url: string, init: unknown) => Promise<unknown>;
    };
    expect(typeof deps.fetch).toBe('function');
    await deps.fetch!('https://discord.com/api/webhooks/1/tok', { method: 'POST' });
    expect(origFetch).toHaveBeenCalledTimes(1);
    // The dispatch bypassed the wrapped fetch — no network event self-reported.
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.events.filter((e) => e.type === 'fetch')).toHaveLength(0);
  });

  it('a failed install does not latch — the next open retries', async () => {
    const installModal = vi.fn().mockReturnValueOnce(undefined).mockReturnValue({ el: {} as HTMLElement, open() {}, close() {}, destroy: vi.fn() });
    makeCapture({ installModal });
    win.document.fire('bugreel:open', {});
    expect(installModal).toHaveBeenCalledTimes(1);
    await Promise.resolve(); // the failed install settles and clears the latch
    await Promise.resolve();
    win.document.fire('bugreel:open', {});
    expect(installModal).toHaveBeenCalledTimes(2);
  });

  it('a modal that installs after destroy() is torn down immediately', async () => {
    const destroy = vi.fn();
    let resolve: ((m: ModalHandle | undefined) => void) | undefined;
    const installModal = vi.fn(
      () => new Promise<ModalHandle | undefined>((r) => (resolve = r)),
    );
    const { capture } = makeCapture({ installModal });
    win.document.fire('bugreel:open', {});
    capture.destroy();
    resolve?.({ el: {} as HTMLElement, open() {}, close() {}, destroy });
    await Promise.resolve();
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
