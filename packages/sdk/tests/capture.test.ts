import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCapture, type CaptureDeps } from '../src/capture';
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
    const { capture } = makeCapture({ shake: true, onShake: () => {} });
    expect(win.fetch).not.toBe(origFetch);
    expect(win.console.error).not.toBe(origError);
    expect(FakeXHR.prototype.send).not.toBeUndefined();
    capture.destroy();
    expect(win.fetch).toBe(origFetch);
    expect(win.console.error).toBe(origError);
    expect(win.listeners).toHaveLength(0);
  });
});
