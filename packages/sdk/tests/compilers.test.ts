import { describe, expect, it } from 'vitest';
import { compileCurl, compileMarkdown, compilePlaywright, compilePrompt } from '../src/worker/compilers';
import { compileReport } from '../src/worker/pipeline';
import { meta } from './helpers';
import type {
  ClickEvent,
  DiagnosticFinding,
  InputEvent,
  NetworkEvent,
  RawBugReelEvent,
  ReporterAnswers,
  RouteEvent,
} from '../src/types';

const payClick: ClickEvent = {
  id: 'c1',
  at: 1_699_999_995_000, // T-5.0s before meta.capturedAt
  type: 'click',
  target: {
    selector: 'button#pay',
    label: 'Pay Now',
    labelSource: 'innerText',
    tagName: 'button',
    headingContext: 'Checkout',
  },
  domMutatedAfterClick: false,
};

const typedPromo: InputEvent = {
  id: 'i1',
  at: 1_699_999_996_000, // T-4.0s
  type: 'input',
  target: { selector: 'input#promo', label: 'Promo Code', labelSource: 'placeholder', tagName: 'input' },
  value: 'SAVE20',
};

const maskedField: InputEvent = {
  id: 'i2',
  at: 1_699_999_997_000, // T-3.0s
  type: 'input',
  target: { selector: 'input#pw', tagName: 'input' },
  value: '[REDACTED]',
};

const failedFetch: NetworkEvent = {
  id: 'n1',
  at: 1_699_999_998_000, // T-2.0s
  type: 'fetch',
  method: 'POST',
  url: '/api/pay',
  status: 500,
  ok: false,
  durationMs: 230,
  errorUiRendered: false,
  requestHeaders: { 'Content-Type': 'application/json', Authorization: '[REDACTED]' },
  requestBody: '{"card":"[REDACTED]","amount":42}',
  responseBody: '{"error":"boom"}',
};

const nav: RouteEvent = {
  id: 'r1',
  at: 1_699_999_999_000, // T-1.0s
  type: 'route',
  from: 'https://app.test/checkout',
  to: 'https://app.test/confirm',
};

const events: RawBugReelEvent[] = [payClick, typedPromo, maskedField, failedFetch, nav];

const findings: DiagnosticFinding[] = [
  {
    detectorId: 'dead-click',
    severity: 'warning',
    timestamp: 1_699_999_995_400,
    headline: "Clicked 'Pay Now', but nothing happened",
    explanation: 'The button appears unwired: no network, route, console, or DOM change followed the click.',
    selector: 'button#pay',
    relatedEventIds: ['c1'],
  },
  {
    detectorId: 'silent-api-error',
    severity: 'critical',
    timestamp: 1_699_999_998_000,
    headline: 'POST /api/pay failed (500) and no error UI appeared',
    explanation: 'The app received a backend crash response but showed the reporter nothing.',
    selector: undefined,
    relatedEventIds: ['n1'],
  },
];

const answers: ReporterAnswers = {
  tryingToDo: 'Apply the coupon and pay',
  wentWrong: 'Nothing happened when I clicked Pay',
};

describe('compileMarkdown — the fixed four-part report', () => {
  const report = compileReport({ events, findings, meta, answers });
  const md = report.outputs.markdown;

  it('renders all four sections in order with a collapsible toolkit', () => {
    const positions = [
      '## 1. What the reporter said',
      '## 2. What Happened',
      '## 3. Story',
      '## 4. Developer toolkit',
    ].map((s) => md.indexOf(s));
    for (const pos of positions) expect(pos).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(md).toContain('<details>');
    expect(md.match(/<details>/g)?.length).toBe(3);
  });

  it('reporter answers land verbatim in section 1', () => {
    expect(md).toContain('**Trying to:** Apply the coupon and pay');
    expect(md).toContain('**Went wrong:** Nothing happened when I clicked Pay');
  });

  it('What Happened renders findings — facts only, no raw log dumps', () => {
    const section = md.slice(md.indexOf('## 2.'), md.indexOf('## 3.'));
    expect(section).toContain("**Clicked 'Pay Now', but nothing happened.**");
    expect(section).toContain('**POST /api/pay failed (500) and no error UI appeared.**');
    expect(section).not.toContain('{"error"'); // no raw event payloads
    expect(section).not.toContain('stack');
    expect(section.toLowerCase()).not.toContain('root cause');
  });

  it('Story renders relative timestamps and story sentences', () => {
    const section = md.slice(md.indexOf('## 3.'), md.indexOf('## 4.'));
    expect(section).toContain("`T-5.0s` Clicked 'Pay Now' button inside 'Checkout'");
    expect(section).toContain("`T-4.0s` Typed 'SAVE20' into 'Promo Code'");
    expect(section).toContain('`T-2.0s` POST /api/pay failed — backend crash (500)');
    expect(section).toContain('`T-1.0s` Navigated from /checkout to /confirm');
  });

  it('meta header carries url, SDK version and session id', () => {
    expect(md).toContain('https://app.test/checkout');
    expect(md).toContain('SDK 0.1.0');
    expect(md).toContain('sess-1');
  });

  it('handles a report with no findings and no answers', () => {
    const md = compileReport({ events: [payClick], findings: [], meta }).outputs.markdown;
    expect(md).toContain('No detectors fired');
    expect(md).toContain('## 4. Developer toolkit');
  });
});

describe('compileCurl', () => {
  it('reproduces failed requests with scrubbed headers and bodies', () => {
    expect(compileCurl([failedFetch], meta)).toBe(
      `curl --request POST --url 'https://app.test/api/pay' --header 'Content-Type: application/json' --header 'Authorization: [REDACTED]' --data-raw '{"card":"[REDACTED]","amount":42}'`,
    );
  });

  it('marks transport-level failures so a working cURL is not a surprise', () => {
    const corsed = netCors();
    expect(compileCurl([corsed], meta)).toContain('connection failed at the browser level');
  });

  it('skips successful requests entirely', () => {
    expect(compileCurl([{ ...failedFetch, status: 200, ok: true }], meta)).toBeUndefined();
    expect(compileCurl([], meta)).toBeUndefined();
  });
});

describe('compilePlaywright', () => {
  it('emits a deterministic replay script for clicks and inputs', () => {
    const script = compilePlaywright(events, meta);
    expect(script).toBe(
      [
        `import { test } from '@playwright/test';`,
        ``,
        `// Generated by BugReel from a captured session — deterministic replay.`,
        `test('bugreel replay', async ({ page }) => {`,
        `  await page.goto("https://app.test/checkout");`,
        `  await page.click("button#pay"); // Clicked 'Pay Now' button inside 'Checkout'`,
        `  await page.fill("input#promo", "SAVE20"); // Typed 'SAVE20' into 'Promo Code'`,
        `  // Skipped sensitive field: input#pw (value withheld)`,
        `  // POST /api/pay failed — backend crash (500)`,
        `  // Navigated from /checkout to /confirm`,
        `});`,
      ].join('\n'),
    );
  });
});

describe('compilePrompt — the AI fix prompt', () => {
  const prompt = compilePrompt({ events, findings, meta, answers });

  it('names the failure and the story without claiming a root cause', () => {
    expect(prompt).toContain('Fix this bug');
    expect(prompt).toContain("Clicked 'Pay Now', but nothing happened");
    expect(prompt).toContain('POST /api/pay failed — backend crash (500)');
    expect(prompt.toLowerCase()).not.toContain('root cause');
  });

  it('points at the failing request and the involved element', () => {
    expect(prompt).toContain('button#pay');
    expect(prompt).toContain('/api/pay');
  });

  it('includes the reporter answers', () => {
    expect(prompt).toContain('Apply the coupon and pay');
  });
});

const netCors = (): NetworkEvent => ({
  id: 'n2',
  at: 1_699_999_999_500,
  type: 'fetch',
  method: 'GET',
  url: 'https://api.other.test/data',
  corsBlocked: true,
});
