// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest';
// Dev-time only: fixtures round-trip through the real compiler + packer so the
// player is always tested against the true .bugpack shape, never a mock.
import { compileReport } from '../../sdk/src/worker/pipeline';
import { packBugpack } from '../../sdk/src/worker/bugpack';
import type { BugReelReport, RawBugReelEvent } from '../../sdk/src/types';
import '../src/index';
import { BugReelPlayer } from '../src/player';

const t0 = 1_700_000_000_000;

const PNG_1PX = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
  0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
  0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c,
  0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const events: RawBugReelEvent[] = [
  {
    id: 'c1',
    at: t0 + 5_000,
    type: 'click',
    target: {
      selector: 'button#pay',
      label: 'Pay Now',
      labelSource: 'innerText',
      tagName: 'button',
      headingContext: 'Checkout',
      rect: { x: 90, y: 40, width: 120, height: 40 },
    },
    x: 100,
    y: 60,
  },
  {
    id: 'i1',
    at: t0 + 8_000,
    type: 'input',
    target: { selector: 'input#code', label: 'Promo Code', tagName: 'input' },
    value: 'SAVE20',
  },
  {
    id: 'n1',
    at: t0 + 12_000,
    type: 'fetch',
    method: 'POST',
    url: 'https://app.test/api/pay',
    status: 500,
    ok: false,
    durationMs: 240,
  },
  {
    id: 'k1',
    at: t0 + 12_500,
    type: 'console',
    level: 'error',
    message: 'payment request failed',
  },
  {
    id: 'e1',
    at: t0 + 13_000,
    type: 'error',
    source: 'window.onerror',
    message: 'Uncaught TypeError: total is not a function',
  },
];

const report: BugReelReport = compileReport({
  events,
  findings: [
    {
      detectorId: 'dead-click',
      severity: 'critical',
      timestamp: t0 + 6_000,
      headline: 'Click on Pay Now did nothing',
      explanation: 'No DOM change, route, or network activity followed the click.',
      selector: 'button#pay',
      relatedEventIds: ['c1'],
    },
  ],
  meta: {
    url: 'https://app.test/checkout',
    userAgent: 'test-agent',
    viewport: { width: 1000, height: 600 },
    capturedAt: t0 + 30_000,
    sdkVersion: '0.1.0',
    sessionId: 'sess-1',
    app: 'shop',
  },
  answers: { tryingToDo: 'Pay for my order', wentWrong: 'Pay button did nothing' },
  media: ['snapshot-annotated.png'],
});

const bugpack = (): Uint8Array =>
  packBugpack(report, { 'snapshot-annotated.png': PNG_1PX });

/** Detach a Uint8Array to a plain ArrayBuffer (slice types as ArrayBuffer|SharedArrayBuffer). */
const ab = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

const makePlayer = (): BugReelPlayer => {
  const el = document.createElement('bugreel-player') as BugReelPlayer;
  document.body.appendChild(el);
  return el;
};

const shadow = (el: BugReelPlayer): ShadowRoot => el.shadowRoot as ShadowRoot;

let registered: unknown;
beforeAll(() => {
  registered = customElements.get('bugreel-player');
});

describe('BugReelPlayer', () => {
  it('registers the custom element and shows an empty state', () => {
    expect(registered).toBe(BugReelPlayer);
    const el = makePlayer();
    expect(shadow(el).querySelector('.br-empty')).toBeTruthy();
    expect(el.report).toBeNull();
  });

  it('renders the three panes from an ArrayBuffer', () => {
    const el = makePlayer();
    el.bugpack = ab(bugpack());
    const root = shadow(el);
    expect(el.report?.schemaVersion).toBe('1.0');
    expect(root.querySelector('.br-evidence')).toBeTruthy();
    expect(root.querySelector('.br-timeline')).toBeTruthy();
    expect(root.querySelector('.br-story')).toBeTruthy();
    expect(root.querySelector('.br-inspector')).toBeTruthy();
    // 5 events + 1 finding = 6 scrubber nodes; story steps come from the compiler.
    expect(root.querySelectorAll('.br-node').length).toBe(6);
    expect(root.querySelectorAll('.br-step[data-i]').length).toBeGreaterThanOrEqual(6);
    // reporter answers + meta in the header
    expect(root.querySelector('.br-answers')?.textContent).toContain('Pay for my order');
    expect(root.querySelector('.br-meta')?.textContent).toContain('app.test/checkout');
  });

  it('shows the snapshot with media tabs in the evidence pane', () => {
    const el = makePlayer();
    el.bugpack = bugpack();
    const root = shadow(el);
    expect(root.querySelector('.br-tab')?.textContent).toBe('snapshot-annotated.png');
    const img = root.querySelector<HTMLImageElement>('.br-stage img');
    expect(img?.getAttribute('src')).toBeTruthy();
  });

  it('selecting a scrubber node drives the inspector and beacon', () => {
    const el = makePlayer();
    el.bugpack = bugpack();
    const root = shadow(el);
    // Node order follows `at`: the click is the earliest event.
    const clickNode = root.querySelector<HTMLElement>('.br-node.k-click');
    clickNode?.click();
    expect(clickNode?.classList.contains('sel')).toBe(true);

    const beacon = root.querySelector<HTMLElement>('.br-beacon');
    // x=100 of viewport 1000, y=60 of viewport 600.
    expect(beacon?.hidden).toBe(false);
    expect(beacon?.style.left).toBe('10%');
    expect(beacon?.style.top).toBe('10%');

    const insp = root.querySelector('.br-inspector');
    expect(insp?.textContent).toContain('Pay Now');
    expect(insp?.textContent).toContain('button#pay');
    expect(insp?.textContent).toContain('Checkout'); // headingContext
    // The click's dead-click finding rides along in the inspector.
    expect(insp?.textContent).toContain('Click on Pay Now did nothing');
    // Its story step is highlighted.
    const selStep = root.querySelector('.br-step.sel');
    expect(selStep?.textContent).toContain('Pay Now');
  });

  it('shows network/console context around a selected moment', () => {
    const el = makePlayer();
    el.bugpack = bugpack();
    const root = shadow(el);
    root.querySelector<HTMLElement>('.br-node.k-error')?.click();
    const insp = root.querySelector('.br-inspector');
    // The failed fetch (t0+12s) and console error (t0+12.5s) are within ±2s.
    expect(insp?.textContent).toContain('/api/pay');
    expect(insp?.textContent).toContain('500');
    expect(insp?.textContent).toContain('payment request failed');
  });

  it('selecting a story step selects its timeline node', () => {
    const el = makePlayer();
    el.bugpack = bugpack();
    const root = shadow(el);
    const steps = [...root.querySelectorAll<HTMLElement>('.br-step[data-i]')];
    const errorStep = steps.find((s) => s.textContent?.includes('not a function'));
    errorStep?.click();
    expect(root.querySelector('.br-node.sel.k-error')).toBeTruthy();
  });

  it('copy buttons write the compiled outputs through the injectable clipboard', async () => {
    const el = makePlayer();
    el.bugpack = bugpack();
    const root = shadow(el);
    const writeText = vi.fn(async () => {});
    el.clipboard = { writeText };

    const promptBtn = root.querySelector<HTMLElement>('[data-copy="cursorPrompt"]');
    expect(promptBtn).toBeTruthy();
    promptBtn?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(report.outputs.cursorPrompt));

    const curlBtn = root.querySelector<HTMLElement>('[data-copy="curl"]');
    curlBtn?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(report.outputs.curl));

    const pwBtn = root.querySelector<HTMLElement>('[data-copy="playwright"]');
    pwBtn?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(report.outputs.playwright));
  });

  it('loads via the src attribute through the injectable fetch', async () => {
    const el = makePlayer();
    const fetchBytes = vi.fn(async () => ab(bugpack()));
    el.fetchBytes = fetchBytes;
    el.setAttribute('src', 'https://files.test/report.bugpack');
    await vi.waitFor(() => expect(el.report).not.toBeNull());
    expect(fetchBytes).toHaveBeenCalledWith('https://files.test/report.bugpack');
    expect(shadow(el).querySelector('.br-node')).toBeTruthy();
  });

  it('renders an error pane — never throws — on malformed input', () => {
    const el = makePlayer();
    expect(() => {
      el.bugpack = new Uint8Array([1, 2, 3]);
    }).not.toThrow();
    expect(shadow(el).querySelector('.br-error')).toBeTruthy();
    expect(el.error).toBeTruthy();
    expect(el.report).toBeNull();
  });

  it('renders an error pane for a zip without report.json', () => {
    const el = makePlayer();
    // valid zip, wrong payload — build via the shared fixture helpers
    return import('../../sdk/src/worker/bugpack').then(({ buildZip }) => {
      el.bugpack = buildZip([{ name: 'readme.txt', data: new TextEncoder().encode('hi') }]);
      expect(shadow(el).querySelector('.br-error')?.textContent).toContain('report.json');
    });
  });

  it('shows a graceful empty-evidence state when the bugpack has no media', () => {
    const bare = compileReport({
      events,
      findings: [],
      meta: report.meta,
    });
    const el = makePlayer();
    el.bugpack = packBugpack(bare);
    const root = shadow(el);
    expect(root.querySelector('.br-nomedia')?.textContent).toContain('No visual evidence');
    // Story still renders without findings.
    expect(root.querySelectorAll('.br-step[data-i]').length).toBeGreaterThanOrEqual(5);
  });

  it('renders a video player for video media entries', () => {
    const el = makePlayer();
    el.bugpack = packBugpack(report, { 'clip.webm': new Uint8Array([9, 9, 9]) });
    const root = shadow(el);
    const tabs = [...root.querySelectorAll<HTMLElement>('.br-tab')];
    expect(tabs.some((t) => t.textContent === 'clip.webm')).toBe(true);
    tabs.find((t) => t.textContent === 'clip.webm')?.click();
    expect(root.querySelector('.br-stage video')).toBeTruthy();
  });

  it('fetch failures land in the error pane, not the console', async () => {
    const el = makePlayer();
    el.fetchBytes = async () => {
      throw new Error('network gone');
    };
    await el.loadFromUrl('https://gone.test/x.bugpack');
    expect(shadow(el).querySelector('.br-error')?.textContent).toContain('network gone');
  });
});
