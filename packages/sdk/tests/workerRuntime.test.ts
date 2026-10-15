import { describe, expect, it } from 'vitest';
import { createWorkerRuntime, isToWorkerMessage } from '../src/worker/runtime';
import type {
  BugDetector,
  ClickEvent,
  DiagnosticFinding,
  ReportMeta,
  ToWorkerMessage,
} from '../src/types';
import { click, meta } from './helpers';

const compile = (requestId = 'r1'): ToWorkerMessage => ({ type: 'bugreel:compile', requestId, meta });

const T = () => Date.now();

const deadClickDetector = (finding: DiagnosticFinding): BugDetector => ({
  id: 'dead-click',
  onEvent: (e) => (e.type === 'click' && e.domMutatedAfterClick === false ? finding : null),
});

describe('worker runtime', () => {
  it('buffers events and returns them inside a compiled report', () => {
    const rt = createWorkerRuntime();
    rt.handleMessage({ type: 'bugreel:event', event: click('a', T() - 1_000) });
    rt.handleMessage({ type: 'bugreel:event', event: click('b', T() - 500) });
    const out = rt.handleMessage(compile());
    expect(out).toHaveLength(1);
    const msg = out[0]!;
    expect(msg.type).toBe('bugreel:report');
    if (msg.type === 'bugreel:report') {
      expect(msg.requestId).toBe('r1');
      expect(msg.report.schemaVersion).toBe('1.0');
      expect(msg.report.events.map((e) => e.id)).toEqual(['a', 'b']);
    }
  });

  it('drains a batch of queued events in one message', () => {
    const rt = createWorkerRuntime();
    rt.handleMessage({ type: 'bugreel:events', events: [click('x', T() - 1_000), click('y', T() - 500)] });
    const out = rt.handleMessage(compile());
    if (out[0]?.type === 'bugreel:report') {
      expect(out[0].report.events.map((e) => e.id)).toEqual(['x', 'y']);
    } else {
      expect.unreachable('expected a bugreel:report message');
    }
  });

  it('a late verdict via annotate fires the detector — the dead-click path end to end', () => {
    const finding: DiagnosticFinding = {
      detectorId: 'dead-click',
      severity: 'warning',
      timestamp: T(),
      headline: "Clicked 'Pay Now', but nothing happened",
      explanation: 'No network, route, console, or DOM change followed the click.',
      relatedEventIds: ['d1'],
    };
    const rt = createWorkerRuntime({ detectors: [deadClickDetector(finding)] });

    rt.handleMessage({ type: 'bugreel:event', event: click('d1', T() - 500) });
    let out = rt.handleMessage(compile());
    if (out[0]?.type === 'bugreel:report') {
      expect(out[0].report.findings).toEqual([]);
    }

    rt.handleMessage({ type: 'bugreel:annotate', eventId: 'd1', patch: { domMutatedAfterClick: false } });
    out = rt.handleMessage(compile());
    if (out[0]?.type === 'bugreel:report') {
      expect(out[0].report.findings).toEqual([finding]);
    } else {
      expect.unreachable('expected a bugreel:report message');
    }
  });

  it('does not duplicate a finding when annotate re-runs detectors', () => {
    const finding: DiagnosticFinding = {
      detectorId: 'dead-click',
      severity: 'warning',
      timestamp: T(),
      headline: 'dead',
      explanation: 'nothing happened',
      relatedEventIds: ['d2'],
    };
    const rt = createWorkerRuntime({ detectors: [deadClickDetector(finding)] });
    rt.handleMessage({ type: 'bugreel:event', event: click('d2', T() - 500) });
    rt.handleMessage({ type: 'bugreel:annotate', eventId: 'd2', patch: { domMutatedAfterClick: false } });
    rt.handleMessage({ type: 'bugreel:annotate', eventId: 'd2', patch: { domMutatedAfterClick: false } });
    const out = rt.handleMessage(compile());
    if (out[0]?.type === 'bugreel:report') {
      expect(out[0].report.findings).toHaveLength(1);
    } else {
      expect.unreachable('expected a bugreel:report message');
    }
  });

  it('scrubEvent transforms events before they enter the window', () => {
    const rt = createWorkerRuntime({
      scrubEvent: (e) => ({ ...e, target: { selector: '[scrubbed]' } }) as ClickEvent,
    });
    rt.handleMessage({ type: 'bugreel:event', event: click('s1', T() - 100) });
    const out = rt.handleMessage(compile());
    if (out[0]?.type === 'bugreel:report') {
      expect(out[0].report.events[0]).toMatchObject({ target: { selector: '[scrubbed]' } });
    } else {
      expect.unreachable('expected a bugreel:report message');
    }
  });

  it('isToWorkerMessage accepts inbound types only — worker replies must not re-enter as work', () => {
    const rt = createWorkerRuntime();
    rt.handleMessage({ type: 'bugreel:event', event: click('r1', T() - 100) });
    const replies = [
      { type: 'bugreel:worker-ready' },
      ...rt.handleMessage(compile()),
      ...rt.handleMessage({ type: 'bogus' } as unknown as ToWorkerMessage),
    ];
    expect(replies.map((m) => m.type)).toEqual(['bugreel:worker-ready', 'bugreel:report', 'bugreel:error']);
    for (const reply of replies) expect(isToWorkerMessage(reply), reply.type).toBe(false);

    for (const inbound of [compile(), { type: 'bugreel:event', event: click('x', 1) }]) {
      expect(isToWorkerMessage(inbound), inbound.type).toBe(true);
    }
    for (const junk of [null, undefined, 'bugreel:compile', 42, {}, { type: 7 }]) {
      expect(isToWorkerMessage(junk)).toBe(false);
    }
  });

  it('an unknown message type yields an error, not a crash', () => {
    const rt = createWorkerRuntime();
    const out = rt.handleMessage({ type: 'bogus' } as unknown as ToWorkerMessage);
    expect(out[0]?.type).toBe('bugreel:error');
  });

  it('a malformed compile returns an error carrying the requestId', () => {
    const rt = createWorkerRuntime();
    const out = rt.handleMessage({
      type: 'bugreel:compile',
      requestId: 'r9',
      meta: null as unknown as ReportMeta,
    });
    expect(out[0]).toMatchObject({ type: 'bugreel:error', requestId: 'r9' });
  });
});
