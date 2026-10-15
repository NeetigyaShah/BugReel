import { describe, expect, it } from 'vitest';
import { createWorkerRuntime, isToWorkerMessage } from '../src/worker/runtime';
import { scrubEvent } from '../src/firewall/stage2';
import type {
  BugDetector,
  ClickEvent,
  DiagnosticFinding,
  RawBugReelEvent,
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

  it('bugreel:pack returns a real .bugpack whose reply can never re-enter as work', () => {
    const rt = createWorkerRuntime({ scrubEvent });
    rt.handleMessage({ type: 'bugreel:event', event: click('p1', T() - 100) });
    const out = rt.handleMessage({
      type: 'bugreel:pack',
      requestId: 'bp1',
      meta,
      media: [{ name: 'shot.png', data: new Uint8Array([1, 2]) }],
    });
    const reply = out[0];
    expect(reply?.type).toBe('bugreel:bugpack');
    if (reply?.type !== 'bugreel:bugpack') return;
    // ZIP local-file-header signature 'PK\x03\x04'
    expect(Array.from(reply.bugpack.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // The reply must never be mistaken for inbound work (echo-loop guard)
    expect(isToWorkerMessage(reply)).toBe(false);
    // report.json inside the archive names the media exactly as packed
    const jsonView = new DataView(reply.bugpack.buffer, reply.bugpack.byteOffset);
    const jsonSize = jsonView.getUint32(18, true); // LFH size field
    const reportJson = JSON.parse(
      new TextDecoder().decode(reply.bugpack.slice(30 + 11, 30 + 11 + jsonSize)),
    ) as { media?: string[] };
    expect(reportJson.media).toEqual(['shot.png']);
    // media filenames are recorded on the compiled report contract
    const out2 = rt.handleMessage(compile());
    if (out2[0]?.type === 'bugreel:report') {
      expect(out2[0].report.media).toBeUndefined(); // compile alone carries no media
    }
  });

  it('compiled outputs are built only from post-Firewall events', () => {
    const rt = createWorkerRuntime({ scrubEvent });
    const secret = 'sk_live_4eC39HqLyjWDarjtT1zdp7dc';
    rt.handleMessage({
      type: 'bugreel:event',
      event: {
        id: 'n1',
        at: T() - 500,
        type: 'fetch',
        method: 'POST',
        url: '/api/pay',
        status: 500,
        ok: false,
        requestHeaders: { Authorization: `Bearer ${secret}` },
        requestBody: `{"card":"4242424242424242","token":"${secret}"}`,
      } as RawBugReelEvent,
    });
    const out = rt.handleMessage(compile());
    if (out[0]?.type !== 'bugreel:report') expect.unreachable('expected a bugreel:report message');
    const report = out[0].report;
    for (const compiled of [
      report.outputs.markdown,
      report.outputs.curl ?? '',
      report.outputs.playwright ?? '',
      report.outputs.cursorPrompt ?? '',
      JSON.stringify(report.storySteps),
    ]) {
      expect(compiled).not.toContain(secret);
      expect(compiled).not.toContain('4242424242424242');
    }
    expect(report.outputs.curl).toContain('[REDACTED]');
  });
});
