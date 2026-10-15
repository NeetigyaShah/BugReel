import type { ClickEvent, ReportMeta } from '../src/types';

export const click = (id: string, at: number, extra: Partial<ClickEvent> = {}): ClickEvent => ({
  id,
  at,
  type: 'click',
  target: { selector: `button#${id}`, label: id },
  x: 10,
  y: 20,
  ...extra,
});

export const meta: ReportMeta = {
  url: 'https://app.test/checkout',
  userAgent: 'test-agent',
  viewport: { width: 1280, height: 800 },
  capturedAt: 1_700_000_000_000,
  sdkVersion: '0.1.0',
  sessionId: 'sess-1',
  project: 'demo',
};
