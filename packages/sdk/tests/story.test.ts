import { describe, expect, it } from 'vitest';
import { buildStory, eventToStep } from '../src/worker/story';
import type {
  ClickEvent,
  ConsoleEvent,
  DiagnosticFinding,
  ErrorEvent,
  InputEvent,
  NetworkEvent,
  RouteEvent,
} from '../src/types';

const clickEvent = (extra: Partial<ClickEvent> = {}): ClickEvent => ({
  id: 'c',
  at: 0,
  type: 'click',
  target: { selector: 'button#pay', label: 'Pay Now', labelSource: 'innerText' },
  ...extra,
});

const net = (extra: Partial<NetworkEvent>): NetworkEvent => ({
  id: 'n',
  at: 0,
  type: 'fetch',
  method: 'POST',
  url: '/api/pay',
  ...extra,
});

describe('eventToStep — clicks and inputs', () => {
  it('renders clicks with label, element kind and heading context', () => {
    expect(
      eventToStep(
        clickEvent({ target: { selector: 'button#pay', label: 'Pay Now', labelSource: 'innerText', tagName: 'button', headingContext: 'Checkout' } }),
      )?.text,
    ).toBe("Clicked 'Pay Now' button inside 'Checkout'");
  });

  it('calls a link a link and omits the kind for other elements', () => {
    expect(
      eventToStep(clickEvent({ target: { selector: 'a.home', label: 'Home', labelSource: 'innerText', tagName: 'a' } }))?.text,
    ).toBe("Clicked 'Home' link");
    expect(
      eventToStep(clickEvent({ target: { selector: 'div.box', label: 'Close', labelSource: 'aria-label', tagName: 'div' } }))?.text,
    ).toBe("Clicked 'Close'");
  });

  it('falls back to the raw selector when no label resolved', () => {
    expect(eventToStep(clickEvent({ target: { selector: 'button#pay', labelSource: 'unknown' } }))?.text).toBe(
      "Clicked 'button#pay'",
    );
  });

  it('renders typed values into their resolved label', () => {
    const event: InputEvent = {
      id: 'i',
      at: 0,
      type: 'input',
      target: { selector: 'input#promo', label: 'Promo Code', labelSource: 'placeholder' },
      value: 'SAVE20',
    };
    expect(eventToStep(event)?.text).toBe("Typed 'SAVE20' into 'Promo Code'");
  });

  it('renders strict-mode length placeholders verbatim', () => {
    const event: InputEvent = {
      id: 'i',
      at: 0,
      type: 'input',
      target: { selector: 'input#pw' },
      value: '[8 chars]',
    };
    expect(eventToStep(event)?.text).toBe("Typed '[8 chars]' into 'input#pw'");
  });
});

describe('eventToStep — routes', () => {
  const route = (from: string, to: string): RouteEvent => ({ id: 'r', at: 0, type: 'route', from, to });

  it('renders same-origin navigation as paths', () => {
    expect(eventToStep(route('https://app.test/home', 'https://app.test/away'))?.text).toBe(
      'Navigated from /home to /away',
    );
  });

  it('keeps cross-origin destinations in full', () => {
    expect(eventToStep(route('https://app.test/a', 'https://other.test/b'))?.text).toBe(
      'Navigated from /a to https://other.test/b',
    );
  });
});

describe('eventToStep — network', () => {
  it('renders HTTP errors with the spec phrase map', () => {
    const cases: Array<[number, string]> = [
      [401, 'permission blocked'],
      [403, 'access denied'],
      [404, 'missing endpoint'],
      [422, 'invalid data'],
      [500, 'backend crash'],
      [503, 'backend crash'],
    ];
    for (const [status, phrase] of cases) {
      expect(eventToStep(net({ status, ok: false }))?.text, String(status)).toBe(
        `POST /api/pay failed — ${phrase} (${status})`,
      );
    }
  });

  it('renders transport-level failures without a status', () => {
    expect(eventToStep(net({ corsBlocked: true }))?.text).toBe(
      'POST /api/pay failed — connection blocked (CORS or a network error)',
    );
  });

  it('renders successes compactly with duration', () => {
    expect(eventToStep(net({ method: 'GET', status: 200, durationMs: 40 }))?.text).toBe(
      'GET /api/pay → 200 in 40ms',
    );
  });
});

describe('eventToStep — console and errors', () => {
  it('renders console output by level', () => {
    const error: ConsoleEvent = { id: 'e', at: 0, type: 'console', level: 'error', message: 'fixture-error' };
    expect(eventToStep(error)?.text).toBe('Console error: "fixture-error"');
    const warn: ConsoleEvent = { id: 'w', at: 0, type: 'console', level: 'warn', message: 'meh' };
    expect(eventToStep(warn)?.text).toBe('Console warning: "meh"');
  });

  it('truncates long console messages deterministically', () => {
    const long: ConsoleEvent = { id: 'l', at: 0, type: 'console', level: 'error', message: 'x'.repeat(200) };
    const step = eventToStep(long);
    expect(step?.text).toBe(`Console error: "${'x'.repeat(160)}…"`);
  });

  it('parses reading-undefined/null TypeErrors as missing-data crashes', () => {
    const reading = (message: string): ErrorEvent => ({ id: 'e', at: 0, type: 'error', source: 'window.onerror', message });
    expect(eventToStep(reading("TypeError: Cannot read properties of undefined (reading 'total')"))?.text).toBe(
      "Crash — missing data: 'total' was read before it existed",
    );
    expect(eventToStep(reading("Cannot read properties of null (reading 'user')"))?.text).toBe(
      "Crash — missing data: 'user' was missing (null)",
    );
    expect(eventToStep(reading("null is not an object (evaluating 'items.length')"))?.text).toBe(
      "Crash — missing data: 'items.length' was missing (null)",
    );
  });

  it('parses missing-function/undefined-name errors as unwired code', () => {
    const reading = (message: string): ErrorEvent => ({ id: 'e', at: 0, type: 'error', source: 'window.onerror', message });
    expect(eventToStep(reading("TypeError: handleSubmit is not a function"))?.text).toBe(
      "Crash — missing wiring: 'handleSubmit' is not a function (the action was never defined)",
    );
    expect(eventToStep(reading("ReferenceError: processPayment is not defined"))?.text).toBe(
      "Crash — missing wiring: 'processPayment' is not defined",
    );
  });

  it('falls back to the raw message for unrecognized errors', () => {
    const event: ErrorEvent = { id: 'e', at: 0, type: 'error', source: 'window.onerror', message: 'QuotaExceededError: disk full' };
    expect(eventToStep(event)?.text).toBe('Uncaught error: "QuotaExceededError: disk full"');
  });

  it('marks crashes as critical steps', () => {
    const event: ErrorEvent = { id: 'e', at: 0, type: 'error', source: 'window.onerror', message: 'boom' };
    expect(eventToStep(event)?.severity).toBe('critical');
  });
});

describe('buildStory', () => {
  const finding: DiagnosticFinding = {
    detectorId: 'dead-click',
    severity: 'warning',
    timestamp: 500,
    headline: "Clicked 'Pay Now', but nothing happened",
    explanation: 'No network, route, console, or DOM change followed the click.',
    selector: 'button#pay',
    relatedEventIds: ['c'],
  };

  it('interleaves findings into the event timeline chronologically', () => {
    const steps = buildStory(
      [clickEvent({ at: 100 }), net({ at: 400, status: 500 }), net({ at: 800, status: 200, method: 'GET' })],
      [finding],
    );
    expect(steps.map((s) => s.kind)).toEqual(['click', 'network', 'finding', 'network']);
    expect(steps[2]?.text).toBe("Clicked 'Pay Now', but nothing happened");
    expect(steps[2]?.severity).toBe('warning');
    expect(steps[2]?.eventId).toBe('c');
  });

  it('produces a step per event in source order', () => {
    const steps = buildStory([clickEvent({ id: 'a', at: 10 }), clickEvent({ id: 'b', at: 20 })], []);
    expect(steps.map((s) => s.eventId)).toEqual(['a', 'b']);
  });
});
