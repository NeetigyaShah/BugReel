import { describe, expect, it } from 'vitest';
import { compileReport, runDetectors } from '../src/worker/pipeline';
import type {
  BugDetector,
  ClickEvent,
  ConsoleEvent,
  DiagnosticFinding,
  NetworkEvent,
  RawBugReelEvent,
  ReportMeta,
} from '../src/types';

const meta: ReportMeta = {
  url: 'https://app.test/checkout',
  userAgent: 'test-agent',
  viewport: { width: 1280, height: 800 },
  capturedAt: 1_700_000_000_000,
  sdkVersion: '0.1.0',
  sessionId: 'sess-1',
  project: 'demo',
  user: { id: 'u1', email: 'dev@example.com' },
};

const click: ClickEvent = {
  id: 'e1',
  at: 100,
  type: 'click',
  target: { selector: 'button#pay', label: 'Pay Now', headingContext: 'Checkout' },
  domMutatedAfterClick: false,
};

const network: NetworkEvent = {
  id: 'n1',
  at: 150,
  type: 'fetch',
  method: 'POST',
  url: '/api/pay',
  status: 500,
  ok: false,
  durationMs: 230,
  errorUiRendered: false,
};

const consoleErr: ConsoleEvent = {
  id: 'c1',
  at: 180,
  type: 'console',
  level: 'error',
  message: "TypeError: Cannot read properties of null (reading 'x')",
};

const finding: DiagnosticFinding = {
  detectorId: 'dead-click',
  severity: 'warning',
  timestamp: 500,
  headline: "Clicked 'Pay Now', but nothing happened",
  explanation: 'The button appears unwired: no network, route, console, or DOM change followed the click.',
  selector: 'button#pay',
  relatedEventIds: ['e1'],
};

const events: RawBugReelEvent[] = [click, network, consoleErr];

describe('compileReport', () => {
  it('produces a schema-valid report skeleton', () => {
    const report = compileReport({ events, findings: [finding], meta });

    expect(report.schemaVersion).toBe('1.0');
    expect(report.meta).toEqual(meta);
    expect(report.reporterAnswers).toEqual({});
    expect(report.findings).toEqual([finding]);
    expect(report.events).toEqual(events);
    expect(report.storySteps).toEqual([]);
    expect(report.outputs.markdown).toBe('');
  });

  it('distills network and console lanes from the raw event stream', () => {
    const report = compileReport({ events, findings: [], meta });
    expect(report.network).toEqual([network]);
    expect(report.console).toEqual([consoleErr]);
  });

  it('carries reporter answers when provided', () => {
    const report = compileReport({
      events,
      findings: [],
      meta,
      answers: { tryingToDo: 'Apply the coupon', wentWrong: 'Nothing happened' },
    });
    expect(report.reporterAnswers.tryingToDo).toBe('Apply the coupon');
  });
});

describe('runDetectors', () => {
  const deadClick: BugDetector = {
    id: 'dead-click',
    onEvent: (event) =>
      event.type === 'click' && event.domMutatedAfterClick === false ? finding : null,
  };

  it('collects findings emitted by registered detectors', () => {
    const findings = runDetectors([deadClick], click, events);
    expect(findings).toEqual([finding]);
  });

  it('emits nothing when no detector fires', () => {
    const aliveClick: ClickEvent = { ...click, domMutatedAfterClick: true };
    expect(runDetectors([deadClick], aliveClick, events)).toEqual([]);
  });

  it('a throwing detector cannot break the pipeline', () => {
    const broken: BugDetector = {
      id: 'broken',
      onEvent: () => {
        throw new Error('boom');
      },
    };
    expect(runDetectors([broken, deadClick], click, events)).toEqual([finding]);
  });
});
