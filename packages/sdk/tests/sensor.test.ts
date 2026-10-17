import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLICK_WATCH_MS,
  createSensor,
  ERROR_UI_WATCH_MS,
  type SensorOptions,
} from '../src/sensor';
import type { ClickEvent, InputEvent, NetworkEvent, RouteEvent } from '../src/types';
import { collect, domEl, el, FakeMutationObserver, FakeWindow } from './fakes';

let win: FakeWindow;
let idCounter: number;
let time: number;

const makeSensor = (options: Partial<SensorOptions> = {}) => {
  const sink = collect();
  const sensor = createSensor({
    emit: sink.emit,
    annotate: sink.annotate,
    window: win,
    now: () => time,
    randomId: () => `id-${++idCounter}`,
    ...options,
  });
  return { sensor, sink };
};

beforeEach(() => {
  vi.useFakeTimers();
  win = new FakeWindow();
  win.MutationObserver = FakeMutationObserver;
  FakeMutationObserver.instances = [];
  idCounter = 0;
  time = 1_700_000_000_000;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('click capture', () => {
  it("produces no events for BugReel's own chrome (modal/pill hosts)", () => {
    const { sink } = makeSensor();
    // Composed shadow events retarget to the host element — clicking Submit
    // inside <bugreel-modal> must not become a user click (or a phantom
    // dead-click finding when its liveness watch closes).
    // element.closest() includes the element itself for matching selectors.
    const selfChrome = (tag: string) => ({
      closest: (sel: string) => (sel.toLowerCase().includes(tag) ? {} : null),
    });
    win.fire('click', {
      target: el('BUGREEL-MODAL', selfChrome('bugreel-modal')),
      clientX: 1,
      clientY: 1,
    });
    win.fire('click', {
      target: el('bugreel-pill', selfChrome('bugreel-pill')),
      clientX: 1,
      clientY: 1,
    });
    // A light-DOM child inside the host is self-chrome too (closest match).
    win.fire('click', {
      target: el('BUTTON', selfChrome('bugreel-modal')),
    });
    expect(sink.events).toHaveLength(0);
    vi.advanceTimersByTime(CLICK_WATCH_MS + 100);
    expect(sink.events).toHaveLength(0); // no pending annotate either
  });

  it('emits a click event with id, timestamp, resolved target and coordinates', () => {
    const { sink } = makeSensor();
    win.fire('click', { target: el('BUTTON'), clientX: 12, clientY: 34 });

    const event = sink.events[0] as ClickEvent;
    expect(event).toMatchObject({
      type: 'click',
      id: 'id-1',
      at: time,
      target: { selector: 'button' },
      x: 12,
      y: 34,
    });
  });

  it('annotates domMutatedAfterClick:false when nothing happens within the watch window', () => {
    const { sink } = makeSensor();
    win.fire('click', { target: el('BUTTON') });
    vi.advanceTimersByTime(CLICK_WATCH_MS + 1);
    expect(sink.annotations).toEqual([{ id: 'id-1', patch: { domMutatedAfterClick: false } }]);
  });

  it('annotates domMutatedAfterClick:true when the DOM mutates inside the window', () => {
    const { sink } = makeSensor();
    win.fire('click', { target: el('BUTTON') });
    FakeMutationObserver.latest().trigger([{ type: 'childList', addedNodes: [{}] }]);
    expect(sink.annotations).toEqual([{ id: 'id-1', patch: { domMutatedAfterClick: true } }]);
    vi.advanceTimersByTime(CLICK_WATCH_MS + 1);
    expect(sink.annotations).toHaveLength(1);
  });

  it('counts a following network or route event as the click being alive', () => {
    const { sink } = makeSensor();
    win.fire('click', { target: el('A') });
    win.history.pushState({}, '', '/next');
    expect(sink.annotations).toEqual([{ id: 'id-1', patch: { domMutatedAfterClick: true } }]);
    expect(sink.events[1]).toMatchObject({ type: 'route' });
  });

  it('counts a bridged capture event (e.g. fetch) as the click being alive', () => {
    const { sink, sensor } = makeSensor();
    win.fire('click', { target: el('BUTTON') });
    // The lazy capture chunk reports through sensor.bridge.send.
    sensor.bridge.send({
      id: 'net-1',
      at: time,
      type: 'fetch',
      method: 'GET',
      url: '/api',
      status: 200,
    } as NetworkEvent);
    expect(sink.annotations).toEqual([{ id: 'id-1', patch: { domMutatedAfterClick: true } }]);
    expect(sink.events[1]).toMatchObject({ type: 'fetch', url: '/api' });
  });

  it('emits nothing when the stage-1 gate blocks the element', () => {
    const { sink } = makeSensor({ blocked: () => true });
    win.fire('click', { target: el('INPUT') });
    expect(sink.events).toHaveLength(0);
    expect(sink.annotations).toHaveLength(0);
  });

  it('runs the real stage-1 gate by default — password fields never produce events', () => {
    const { sink } = makeSensor();
    const password = domEl('input', { attrs: { type: 'password' } });
    win.fire('click', { target: password });
    win.fire('change', { target: password });
    expect(sink.events).toHaveLength(0);
  });

  it('uses a bare selector until the capture chunk registers the rich describer', () => {
    const { sink, sensor } = makeSensor();
    win.fire('click', { target: el('BUTTON', { id: 'pay' }) });
    expect((sink.events[0] as ClickEvent).target).toEqual({ selector: 'button#pay' });

    sensor.bridge.setDescribeTarget(() => ({ selector: 'form > button', label: 'Pay Now' }));
    win.fire('click', { target: el('BUTTON') });
    expect((sink.events[1] as ClickEvent).target).toEqual({ selector: 'form > button', label: 'Pay Now' });
  });
});

describe('input capture', () => {
  it('emits a scrubbed input event when a field commits (change)', () => {
    const { sink } = makeSensor();
    const field = el('INPUT', { value: 'SAVE20' });
    win.fire('change', { target: field });
    const event = sink.events[0] as InputEvent;
    expect(event).toMatchObject({ type: 'input', value: 'SAVE20', target: { selector: 'input' } });
  });

  it('does not spam events on raw keystrokes (input events are not emitted)', () => {
    const { sink } = makeSensor();
    const field = el('INPUT', { value: 'typing...' });
    win.fire('input', { target: field });
    win.fire('input', { target: field });
    expect(sink.events).toHaveLength(0);
  });

  it('records only the length in strict privacy mode', () => {
    const { sink } = makeSensor({ strict: true });
    win.fire('change', { target: el('INPUT', { value: 'SAVE20' }) });
    expect((sink.events[0] as InputEvent).value).toBe('[6 chars]');
  });

  it('records nothing when the value scrubber withholds it', () => {
    const { sink } = makeSensor({ scrubInputValue: () => undefined });
    win.fire('change', { target: el('INPUT', { value: 'sk-123' }) });
    expect(sink.events).toHaveLength(0);
  });
});

describe('route capture', () => {
  it('emits a route event when pushState changes the URL', () => {
    const { sink } = makeSensor();
    win.history.pushState({}, '', 'https://app.test/away');
    const event = sink.events[0] as RouteEvent;
    expect(event).toMatchObject({
      type: 'route',
      from: 'https://app.test/home',
      to: 'https://app.test/away',
    });
  });

  it('emits on popstate and replaceState too', () => {
    const { sink } = makeSensor();
    win.history.replaceState({}, '', 'https://app.test/r');
    win.location.href = 'https://app.test/back';
    win.fire('popstate', {});
    const routes = sink.events.filter((e) => e.type === 'route') as RouteEvent[];
    expect(routes.map((r) => r.to)).toEqual(['https://app.test/r', 'https://app.test/back']);
  });

  it('does not emit when the URL is unchanged', () => {
    const { sink } = makeSensor();
    win.fire('popstate', {});
    expect(sink.events).toHaveLength(0);
  });
});

describe('error-UI observation window (armed by bridged network events)', () => {
  const failedResponse = (sensor: { bridge: { send(e: unknown): void } }, sink: ReturnType<typeof collect>) => {
    sensor.bridge.send({
      id: 'net-500',
      at: time,
      type: 'fetch',
      method: 'GET',
      url: '/api',
      status: 500,
    } as NetworkEvent);
    return sink.events[0] as NetworkEvent;
  };

  it('annotates errorUiRendered:true when a DOM insertion follows a failed response', () => {
    const { sensor, sink } = makeSensor();
    const net = failedResponse(sensor, sink);
    FakeMutationObserver.latest().trigger([{ type: 'childList', addedNodes: [{}] }]);
    expect(sink.annotations).toEqual([{ id: net.id, patch: { errorUiRendered: true } }]);
  });

  it('annotates errorUiRendered:false when the window elapses quietly', () => {
    const { sensor, sink } = makeSensor();
    const net = failedResponse(sensor, sink);
    vi.advanceTimersByTime(ERROR_UI_WATCH_MS + 1);
    expect(sink.annotations).toEqual([{ id: net.id, patch: { errorUiRendered: false } }]);
  });

  it('ignores attribute-only mutations for the error-UI verdict', () => {
    const { sensor, sink } = makeSensor();
    const net = failedResponse(sensor, sink);
    FakeMutationObserver.latest().trigger([{ type: 'attributes' }]);
    expect(sink.annotations).toHaveLength(0);
    vi.advanceTimersByTime(ERROR_UI_WATCH_MS + 1);
    expect(sink.annotations).toEqual([{ id: net.id, patch: { errorUiRendered: false } }]);
  });

  it('also watches requests that never got a response (CORS / network failure)', () => {
    const { sensor, sink } = makeSensor();
    sensor.bridge.send({
      id: 'net-cors',
      at: time,
      type: 'fetch',
      method: 'POST',
      url: '/api',
      corsBlocked: true,
    } as NetworkEvent);
    vi.advanceTimersByTime(ERROR_UI_WATCH_MS + 1);
    expect(sink.annotations).toEqual([{ id: 'net-cors', patch: { errorUiRendered: false } }]);
  });

  it('does not watch successful responses', () => {
    const { sensor, sink } = makeSensor();
    sensor.bridge.send({
      id: 'net-200',
      at: time,
      type: 'fetch',
      method: 'GET',
      url: '/api',
      status: 200,
    } as NetworkEvent);
    vi.advanceTimersByTime(ERROR_UI_WATCH_MS + 1);
    expect(sink.annotations).toHaveLength(0);
  });
});

describe('host safety + teardown', () => {
  it('never propagates a throwing emit into the host handler', () => {
    createSensor({
      emit: () => {
        throw new Error('bad');
      },
      annotate: () => {},
      window: win,
    });
    expect(() => win.fire('click', { target: el('BUTTON') })).not.toThrow();
    expect(() => win.fire('change', { target: el('INPUT', { value: 'x' }) })).not.toThrow();
  });

  it('destroy restores wrappers and removes listeners', () => {
    const origPushState = win.history.pushState;
    const { sensor } = makeSensor();
    expect(win.history.pushState).not.toBe(origPushState);
    const count = win.listeners.length;
    expect(count).toBeGreaterThan(0);
    sensor.destroy();
    expect(win.history.pushState).toBe(origPushState);
    expect(win.listeners).toHaveLength(0);
  });

  it('destroy stops pending watches', () => {
    const { sink, sensor } = makeSensor();
    win.fire('click', { target: el('BUTTON') });
    sensor.destroy();
    vi.advanceTimersByTime(10_000);
    expect(sink.annotations).toHaveLength(0);
  });
});
