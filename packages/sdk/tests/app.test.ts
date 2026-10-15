import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBugReel, openActive, type BugReelEnv } from '../src/app';
import type { ToWorkerMessage } from '../src/types';
import { el, FakeMutationObserver, FakeWindow, fakeWorker } from './fakes';

let win: FakeWindow;
const syncIdle = (cb: () => void) => cb();

const makeEnv = (worker = fakeWorker()): { env: BugReelEnv; worker: ReturnType<typeof fakeWorker> } => ({
  env: {
    window: win,
    scheduleIdle: syncIdle,
    makeWorker: () => worker,
  },
  worker,
});

beforeEach(() => {
  vi.useFakeTimers();
  win = new FakeWindow();
  win.MutationObserver = FakeMutationObserver;
  FakeMutationObserver.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startBugReel wiring', () => {
  it('routes sensor events into the worker transport', () => {
    const { env, worker } = makeEnv();
    const handle = startBugReel({}, env);
    win.fire('click', { target: el('BUTTON') });
    worker.ready();
    const event = worker.posted.find((m) => m.type === 'bugreel:event');
    expect(event).toMatchObject({ type: 'bugreel:event', event: { type: 'click' } });
    handle.destroy();
  });

  it('Ctrl+Shift+B dispatches bugreel:open on document and compiles a report', () => {
    const { env, worker } = makeEnv();
    const handle = startBugReel({}, env);
    worker.ready();
    win.fire('keydown', { key: 'b', ctrlKey: true, shiftKey: true, preventDefault: vi.fn() });
    expect(win.document.dispatched.map((e) => e.type)).toContain('bugreel:open');
    const compile = worker.posted.find((m: ToWorkerMessage) => m.type === 'bugreel:compile');
    expect(compile).toBeTruthy();
    if (compile?.type === 'bugreel:compile') {
      expect(compile.meta?.url).toBe('https://app.test/home');
      expect(compile.meta?.userAgent).toBe('fake-agent/1.0');
      expect(compile.meta?.viewport).toEqual({ width: 1280, height: 800 });
      expect(compile.meta?.sdkVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(compile.meta?.sessionId).toBeTruthy();
      expect(compile.requestId).toBeTruthy();
    }
    handle.destroy();
  });

  it('Cmd+Shift+B also opens (macOS)', () => {
    const { env } = makeEnv();
    const handle = startBugReel({}, env);
    win.fire('keydown', { key: 'b', metaKey: true, shiftKey: true });
    expect(win.document.dispatched.map((e) => e.type)).toContain('bugreel:open');
    handle.destroy();
  });

  it('a custom hotkey rebinds the trigger', () => {
    const { env } = makeEnv();
    const handle = startBugReel({ hotkey: 'alt+k' }, env);
    win.fire('keydown', { key: 'b', ctrlKey: true, shiftKey: true });
    win.fire('keydown', { key: 'k', altKey: true });
    expect(win.document.dispatched.map((e) => e.type)).toEqual(['bugreel:open']);
    handle.destroy();
  });

  it('never hijacks the hotkey inside editable focus (input/textarea/select/contentEditable)', () => {
    const { env } = makeEnv();
    const handle = startBugReel({}, env);
    for (const active of [
      el('INPUT'),
      el('TEXTAREA'),
      el('SELECT'),
      el('DIV', { isContentEditable: true }),
    ]) {
      win.document.activeElement = active;
      win.fire('keydown', { key: 'b', ctrlKey: true, shiftKey: true });
    }
    expect(win.document.dispatched).toHaveLength(0);
    win.document.activeElement = el('BUTTON');
    win.fire('keydown', { key: 'b', ctrlKey: true, shiftKey: true });
    expect(win.document.dispatched.map((e) => e.type)).toEqual(['bugreel:open']);
    handle.destroy();
  });

  it('handle.open() fires the open flow for custom entry points', () => {
    const { env } = makeEnv();
    const handle = startBugReel({}, env);
    handle.open();
    expect(win.document.dispatched.map((e) => e.type)).toEqual(['bugreel:open']);
    handle.destroy();
  });

  it('openActive() drives the singleton and is safe before init', () => {
    expect(() => openActive()).not.toThrow();
    const { env } = makeEnv();
    const handle = startBugReel({}, env);
    openActive();
    expect(win.document.dispatched.map((e) => e.type)).toEqual(['bugreel:open']);
    handle.destroy();
  });

  it('installs the lazy capture chunk through the env seam (npm path)', () => {
    const installCapture = vi.fn((_deps: unknown) => ({ destroy: vi.fn() }));
    const { env } = makeEnv();
    const handle = startBugReel({ shake: true }, { ...env, installCapture });
    expect(installCapture).toHaveBeenCalledTimes(1);
    const deps = installCapture.mock.calls[0]![0] as {
      shake?: boolean;
      onShake?: () => void;
      send: (e: unknown) => void;
    };
    expect(deps.shake).toBe(true);
    // The shake trigger must reach the same open flow as the hotkey.
    deps.onShake!();
    expect(win.document.dispatched.map((e) => e.type)).toEqual(['bugreel:open']);
    handle.destroy();
    expect((installCapture.mock.results[0]!.value as { destroy: () => void }).destroy).toHaveBeenCalled();
  });

  it('injects sibling capture.global.js as a classic script on the CDN path', () => {
    const { env } = makeEnv();
    const handle = startBugReel({}, { ...env, scriptUrl: 'https://cdn.test/loader.global.js' });
    const script = win.document.created.find((e) => e.tag === 'SCRIPT');
    expect(script?.src).toBe('https://cdn.test/capture.global.js');
    handle.destroy();
  });

  it('does not install the capture chunk if destroy() ran before its script loaded', () => {
    const installCapture = vi.fn((_deps: unknown) => ({ destroy: vi.fn() }));
    (globalThis as { BugReelCapture?: unknown }).BugReelCapture = { installCapture };
    try {
      const { env } = makeEnv();
      const handle = startBugReel({}, { ...env, scriptUrl: 'https://cdn.test/loader.global.js' });
      const script = win.document.created.find((e) => e.tag === 'SCRIPT');
      handle.destroy();
      (script as { onload?: (() => void) | null }).onload?.();
      expect(installCapture).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as { BugReelCapture?: unknown }).BugReelCapture;
    }
  });

  it('hands the pill policy and open flow to the lazy capture chunk', () => {
    const installCapture = vi.fn((_deps: unknown) => ({ destroy: vi.fn() }));
    const { env } = makeEnv();
    const handle = startBugReel({ pill: 'auto' }, { ...env, installCapture });
    const deps = installCapture.mock.calls[0]![0] as { pill?: unknown; onOpen?: () => void };
    expect(deps.pill).toBe('auto');
    deps.onOpen!();
    expect(win.document.dispatched.map((e) => e.type)).toEqual(['bugreel:open']);
    handle.destroy();
  });

  it('hands the worker channel to the capture chunk for the modal (workerSend)', () => {
    const installCapture = vi.fn((_deps: unknown) => ({ destroy: vi.fn() }));
    const { env, worker } = makeEnv();
    const handle = startBugReel({}, { ...env, installCapture });
    worker.ready();
    const deps = installCapture.mock.calls[0]![0] as { workerSend?: (m: ToWorkerMessage) => void };
    expect(typeof deps.workerSend).toBe('function');
    deps.workerSend!({ type: 'bugreel:pack', requestId: 'r1' });
    expect(worker.posted.at(-1)).toMatchObject({ type: 'bugreel:pack', requestId: 'r1' });
    handle.destroy();
  });

  it('forwards bugreel:bugpack and bugreel:error replies to document listeners', () => {
    const { env, worker } = makeEnv();
    const handle = startBugReel({}, env);
    worker.ready();
    worker.deliver({ type: 'bugreel:bugpack', requestId: 'p1', bugpack: new Uint8Array([1]) });
    worker.deliver({ type: 'bugreel:error', requestId: 'p1', message: 'boom' });
    const types = win.document.dispatched.map((e) => e.type);
    expect(types).toContain('bugreel:bugpack');
    expect(types).toContain('bugreel:error');
    const bugpack = win.document.dispatched.find((e) => e.type === 'bugreel:bugpack');
    expect(bugpack?.detail).toMatchObject({ requestId: 'p1' });
    handle.destroy();
  });

  it('re-init destroys the previous handle instead of double-subscribing', () => {
    const { env } = makeEnv();
    const first = startBugReel({}, env);
    const listenersBefore = win.listeners.length;
    const second = startBugReel({}, env);
    expect(win.listeners.length).toBe(listenersBefore);
    first.destroy();
    win.fire('keydown', { key: 'b', ctrlKey: true, shiftKey: true });
    expect(win.document.dispatched.map((e) => e.type)).toEqual(['bugreel:open']);
    second.destroy();
  });

  it('returns a no-op handle outside a browser environment', () => {
    const handle = startBugReel({}, { window: undefined });
    expect(() => {
      handle.open();
      handle.destroy();
    }).not.toThrow();
  });

  it('survives a completely hostile environment without throwing', () => {
    const hostile = {
      addEventListener() {
        throw new Error('nope');
      },
      removeEventListener() {},
      location: {},
    };
    expect(() => startBugReel({}, { window: hostile as never })).not.toThrow();
  });
});
