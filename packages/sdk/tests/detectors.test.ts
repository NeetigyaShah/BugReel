import { describe, expect, it } from 'vitest';
import type {
  ClickEvent,
  ConsoleEvent,
  ErrorEvent,
  InputEvent,
  NetworkEvent,
  RouteEvent,
  ToWorkerMessage,
} from '../src/types';
import { detectors } from '../src/worker/detectors';
import { DeadClickDetector } from '../src/worker/detectors/deadClick';
import { SilentApiErrorDetector } from '../src/worker/detectors/silentApiError';
import { RageClickDetector } from '../src/worker/detectors/rageClick';
import { createWorkerRuntime } from '../src/worker/runtime';
import { click, meta } from './helpers';

const payClick = (id: string, at: number, extra: Partial<ClickEvent> = {}): ClickEvent =>
  click(id, at, {
    target: { selector: 'button#pay', label: 'Pay Now', headingContext: 'Checkout' },
    ...extra,
  });

const fetchEvent = (id: string, at: number, extra: Partial<NetworkEvent> = {}): NetworkEvent => ({
  id,
  at,
  type: 'fetch',
  method: 'POST',
  url: '/api/pay',
  ...extra,
});

const routeEvent = (id: string, at: number): RouteEvent => ({ id, at, type: 'route', to: '/next' });
const consoleEvent = (id: string, at: number): ConsoleEvent => ({
  id,
  at,
  type: 'console',
  level: 'error',
  message: 'boom',
});
const errorEvent = (id: string, at: number): ErrorEvent => ({
  id,
  at,
  type: 'error',
  source: 'window.onerror',
  message: 'boom',
});
const inputEvent = (id: string, at: number): InputEvent => ({
  id,
  at,
  type: 'input',
  target: { selector: 'input#q', label: 'Search' },
  value: 'x',
});

describe('DeadClickDetector', () => {
  it('flags a click whose verdict says no DOM mutation and nothing followed', () => {
    const c = payClick('c1', 1_000, { domMutatedAfterClick: false });
    const finding = DeadClickDetector.onEvent(c, [c]);

    expect(finding).toMatchObject({
      detectorId: 'dead-click',
      severity: 'warning',
      timestamp: 1_000,
      selector: 'button#pay',
      relatedEventIds: ['c1'],
    });
    expect(finding?.headline).toBe("Clicked 'Pay Now' — nothing happened");
    expect(finding?.explanation).toContain('Pay Now');
    expect(finding?.explanation).toContain('network request');
  });

  it('stays quiet while the verdict is pending or when the DOM did mutate', () => {
    const pending = payClick('c2', 1_000);
    const alive = payClick('c3', 1_000, { domMutatedAfterClick: true });
    expect(DeadClickDetector.onEvent(pending, [pending])).toBeNull();
    expect(DeadClickDetector.onEvent(alive, [alive])).toBeNull();
  });

  it.each([
    ['fetch', fetchEvent('a1', 1_200)],
    ['xhr', fetchEvent('a2', 1_200, { type: 'xhr' })],
    ['route', routeEvent('a3', 1_200)],
    ['console', consoleEvent('a4', 1_200)],
    ['error', errorEvent('a5', 1_200)],
  ])('does not fire when a %s event followed the click', (_kind, after) => {
    const c = payClick('c4', 1_000, { domMutatedAfterClick: false });
    expect(DeadClickDetector.onEvent(c, [c, after])).toBeNull();
  });

  it('ignores activity that happened before the click', () => {
    const c = payClick('c5', 1_000, { domMutatedAfterClick: false });
    const earlierFetch = fetchEvent('b1', 900);
    expect(DeadClickDetector.onEvent(c, [earlierFetch, c])).not.toBeNull();
  });

  it('is not absolved by later inputs or clicks — only real effects count', () => {
    const c = payClick('c6', 1_000, { domMutatedAfterClick: false });
    const laterInput = inputEvent('b2', 1_100);
    const laterClick = payClick('b3', 1_150);
    expect(DeadClickDetector.onEvent(c, [c, laterInput, laterClick])).not.toBeNull();
  });

  it('falls back to the selector when the target has no resolved label', () => {
    const c = click('c7', 1_000, {
      target: { selector: 'form#checkout button.pay' },
      domMutatedAfterClick: false,
    });
    const finding = DeadClickDetector.onEvent(c, [c]);
    expect(finding?.headline).toBe("Clicked 'form#checkout button.pay' — nothing happened");
    expect(finding?.selector).toBe('form#checkout button.pay');
  });
});

describe('SilentApiErrorDetector', () => {
  it('flags a 5xx that rendered no error UI as critical', () => {
    const n = fetchEvent('n1', 1_000, {
      status: 500,
      ok: false,
      durationMs: 230,
      errorUiRendered: false,
    });
    const finding = SilentApiErrorDetector.onEvent(n, [n]);

    expect(finding).toMatchObject({
      detectorId: 'silent-api-error',
      severity: 'critical',
      timestamp: 1_000,
      relatedEventIds: ['n1'],
    });
    expect(finding?.headline).toBe('POST /api/pay failed (500) and no error UI appeared');
    expect(finding?.explanation).toContain('POST');
    expect(finding?.explanation).toContain('/api/pay');
    expect(finding?.explanation).toContain('500');
    expect(finding?.explanation).toContain('230ms');
  });

  it('flags a 4xx as a warning, on xhr as well as fetch', () => {
    const n = fetchEvent('n2', 1_000, { type: 'xhr', status: 404, ok: false, errorUiRendered: false });
    const finding = SilentApiErrorDetector.onEvent(n, [n]);
    expect(finding?.severity).toBe('warning');
    expect(finding?.headline).toContain('404');
    expect(finding?.headline).toContain('no error UI appeared');
  });

  it('flags a CORS-blocked request that never got a status', () => {
    const n = fetchEvent('n3', 1_000, { corsBlocked: true, errorUiRendered: false });
    const finding = SilentApiErrorDetector.onEvent(n, [n]);
    expect(finding?.severity).toBe('warning');
    expect(finding?.headline).toContain('CORS');
  });

  it('stays quiet when error feedback was rendered or the verdict is still pending', () => {
    const rendered = fetchEvent('n4', 1_000, { status: 500, ok: false, errorUiRendered: true });
    const pending = fetchEvent('n5', 1_000, { status: 500, ok: false });
    expect(SilentApiErrorDetector.onEvent(rendered, [rendered])).toBeNull();
    expect(SilentApiErrorDetector.onEvent(pending, [pending])).toBeNull();
  });

  it('ignores successful requests and non-network events', () => {
    const ok = fetchEvent('n6', 1_000, { status: 200, ok: true, errorUiRendered: false });
    const c = payClick('n7', 1_000);
    expect(SilentApiErrorDetector.onEvent(ok, [ok])).toBeNull();
    expect(SilentApiErrorDetector.onEvent(c, [c])).toBeNull();
  });
});

describe('RageClickDetector', () => {
  const burst = (times: number[]): ClickEvent[] => times.map((t, i) => payClick(`r${i + 1}`, t));

  it('flags three clicks on the same element inside 800ms', () => {
    const [c1, c2, c3] = burst([0, 300, 600]);
    const finding = RageClickDetector.onEvent(c3!, [c1!, c2!, c3!]);

    expect(finding).toMatchObject({
      detectorId: 'rage-click',
      severity: 'warning',
      timestamp: 600,
      selector: 'button#pay',
      relatedEventIds: ['r1', 'r2', 'r3'],
    });
    expect(finding?.headline).toBe("User rage-clicked 'Pay Now' (3× in 800ms)");
    expect(finding?.explanation).toContain('unresponsive');
  });

  it('counts the whole burst in the headline and relatedEventIds', () => {
    const cs = burst([0, 200, 400, 600]);
    const finding = RageClickDetector.onEvent(cs[3]!, cs);
    expect(finding?.relatedEventIds).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(finding?.headline).toContain('4×');
  });

  it('needs at least three clicks — two rapid clicks stay quiet', () => {
    const [c1, c2] = burst([0, 200]);
    expect(RageClickDetector.onEvent(c2!, [c1!, c2!])).toBeNull();
  });

  it('requires the burst to fit inside the window', () => {
    const cs = burst([0, 500, 1_300]);
    expect(RageClickDetector.onEvent(cs[2]!, cs)).toBeNull();
  });

  it('fires when the oldest click sits exactly on the 800ms edge', () => {
    const cs = burst([0, 400, 800]);
    expect(RageClickDetector.onEvent(cs[2]!, cs)).not.toBeNull();
  });

  it('ignores rapid clicks spread across different elements', () => {
    const c1 = payClick('x1', 0);
    const c2 = click('x2', 200); // different selector
    const c3 = payClick('x3', 400);
    expect(RageClickDetector.onEvent(c3, [c1, c2, c3])).toBeNull();
  });

  it('only counts clicks up to the evaluated event, so annotate re-runs stay stable', () => {
    const cs = burst([0, 200, 400, 600]);
    const finding = RageClickDetector.onEvent(cs[2]!, cs);
    expect(finding?.relatedEventIds).toEqual(['r1', 'r2', 'r3']);
    expect(finding?.headline).toContain('3×');
  });

  it('ignores non-click events', () => {
    const n = fetchEvent('n9', 0);
    expect(RageClickDetector.onEvent(n, [n])).toBeNull();
  });
});

describe('detector registry', () => {
  it('registers the frozen v1 catalog in order (ADR-0008)', () => {
    expect(detectors.map((d) => d.id)).toEqual(['dead-click', 'silent-api-error', 'rage-click']);
  });
});

describe('detectors inside the worker runtime', () => {
  const compile = (requestId = 'r1'): ToWorkerMessage => ({
    type: 'bugreel:compile',
    requestId,
    meta,
  });

  const findingsOf = (rt: ReturnType<typeof createWorkerRuntime>) => {
    const out = rt.handleMessage(compile());
    if (out[0]?.type !== 'bugreel:report') throw new Error('expected a bugreel:report message');
    return out[0].report.findings;
  };

  it('emits a dead-click finding once the verdict lands — exactly once across re-annotates', () => {
    const rt = createWorkerRuntime({ detectors });
    rt.handleMessage({ type: 'bugreel:event', event: payClick('d1', Date.now() - 500) });
    expect(findingsOf(rt)).toEqual([]);

    rt.handleMessage({ type: 'bugreel:annotate', eventId: 'd1', patch: { domMutatedAfterClick: false } });
    rt.handleMessage({ type: 'bugreel:annotate', eventId: 'd1', patch: { domMutatedAfterClick: false } });

    const findings = findingsOf(rt);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      detectorId: 'dead-click',
      severity: 'warning',
      relatedEventIds: ['d1'],
    });
  });

  it('does not flag a dead click when a request followed it', () => {
    const rt = createWorkerRuntime({ detectors });
    rt.handleMessage({ type: 'bugreel:event', event: payClick('d2', Date.now() - 900) });
    rt.handleMessage({
      type: 'bugreel:event',
      event: fetchEvent('n1', Date.now() - 800, { status: 200, ok: true }),
    });
    rt.handleMessage({ type: 'bugreel:annotate', eventId: 'd2', patch: { domMutatedAfterClick: false } });
    expect(findingsOf(rt)).toEqual([]);
  });

  it('emits a silent-api-error finding once errorUiRendered resolves false', () => {
    const rt = createWorkerRuntime({ detectors });
    rt.handleMessage({
      type: 'bugreel:event',
      event: fetchEvent('n2', Date.now() - 500, { status: 500, ok: false }),
    });
    expect(findingsOf(rt)).toEqual([]);

    rt.handleMessage({ type: 'bugreel:annotate', eventId: 'n2', patch: { errorUiRendered: false } });
    rt.handleMessage({ type: 'bugreel:annotate', eventId: 'n2', patch: { errorUiRendered: false } });

    const findings = findingsOf(rt);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      detectorId: 'silent-api-error',
      severity: 'critical',
      relatedEventIds: ['n2'],
    });
  });

  it('emits a rage-click finding on the third rapid click and dedupes the annotate re-run', () => {
    const rt = createWorkerRuntime({ detectors });
    const now = Date.now();
    rt.handleMessage({
      type: 'bugreel:events',
      events: [payClick('g1', now - 300), payClick('g2', now - 200), payClick('g3', now - 100)],
    });
    rt.handleMessage({ type: 'bugreel:annotate', eventId: 'g3', patch: { domMutatedAfterClick: true } });

    const findings = findingsOf(rt);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      detectorId: 'rage-click',
      severity: 'warning',
      relatedEventIds: ['g1', 'g2', 'g3'],
    });
  });
});
