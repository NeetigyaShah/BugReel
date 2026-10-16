// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installModal, mountModal, withAnswers, type ModalDeps, type ModalHandle } from '../src/modal';
import type { BugReelReport, ReporterAnswers, ToWorkerMessage } from '../src/types';
import { meta } from './helpers';

const report = (): BugReelReport => ({
  schemaVersion: '1.0',
  meta,
  reporterAnswers: {},
  findings: [
    {
      detectorId: 'dead-click',
      severity: 'critical',
      timestamp: meta.capturedAt - 1_000,
      headline: 'Pay button did nothing',
      explanation: 'The click produced no network, route, console, or DOM change.',
      selector: 'button#pay',
      relatedEventIds: ['e1'],
    },
  ],
  storySteps: [
    { at: meta.capturedAt - 2_000, kind: 'click', text: "Clicked 'Pay'" },
    { at: meta.capturedAt - 1_000, kind: 'finding', text: 'Pay button did nothing', severity: 'critical' },
  ],
  events: [],
  network: [],
  console: [],
  outputs: {
    markdown: '# BugReel Bug Report\n\n## 1. What the reporter said',
    curl: 'curl --request GET',
    playwright: "import { test } from '@playwright/test';",
    cursorPrompt: 'Fix this bug in demo.',
  },
});

const setup = (extra: Partial<ModalDeps> = {}) => {
  const sent: ToWorkerMessage[] = [];
  const saved: BugReelReport[] = [];
  const copied: string[] = [];
  const downloads: { filename: string; bytes: Uint8Array }[] = [];
  const deps: ModalDeps = {
    window,
    send: (m) => sent.push(m),
    store: {
      saveReport: async (r) => {
        saved.push(r);
        return 'report-id-1';
      },
      listReports: async () => [],
    },
    clipboard: { writeText: async (t) => void copied.push(t) },
    download: (filename, bytes) => downloads.push({ filename, bytes }),
    ...extra,
  };
  return { deps, sent, saved, copied, downloads };
};

const br = <T extends Element>(handle: ModalHandle, sel: string): T =>
  handle.el.shadowRoot!.querySelector(`[data-br="${sel}"]`) as T;

const text = (handle: ModalHandle, sel: string): string =>
  br<HTMLElement>(handle, sel)?.textContent ?? '';

const fill = (handle: ModalHandle, sel: 'trying' | 'wrong', value: string): void => {
  const ta = br<HTMLTextAreaElement>(handle, sel);
  ta.value = value;
  ta.dispatchEvent(new window.Event('input'));
};

const fillBoth = (handle: ModalHandle, a: ReporterAnswers = { tryingToDo: 'pay', wentWrong: 'nothing happened' }): void => {
  fill(handle, 'trying', a.tryingToDo ?? '');
  fill(handle, 'wrong', a.wentWrong ?? '');
};

const deliver = (type: string, detail: unknown): void => {
  document.dispatchEvent(new CustomEvent(type, { detail }));
};

const ACTION_BUTTONS = ['copy-md', 'copy-prompt', 'download', 'submit'] as const;

const enabled = (handle: ModalHandle): boolean[] =>
  ACTION_BUTTONS.map((k) => !br<HTMLButtonElement>(handle, k).disabled);

let handles: ModalHandle[] = [];
const mount = (deps: ModalDeps): ModalHandle => {
  const h = mountModal(deps)!;
  handles.push(h);
  return h;
};

afterEach(() => {
  for (const h of handles.splice(0)) {
    try {
      h.destroy();
    } catch {}
  }
  document.querySelectorAll('bugreel-modal').forEach((el) => el.remove());
});

describe('withAnswers', () => {
  it('recompiles markdown and cursor prompt with the reporter answers', () => {
    const next = withAnswers(report(), { tryingToDo: 'pay', wentWrong: 'it 500ed' });
    expect(next.reporterAnswers).toEqual({ tryingToDo: 'pay', wentWrong: 'it 500ed' });
    expect(next.outputs.markdown).toContain('pay');
    expect(next.outputs.cursorPrompt).toContain('it 500ed');
    // untouched fields preserved
    expect(next.outputs.curl).toBe('curl --request GET');
    expect(next.findings).toHaveLength(1);
  });
});

describe('mountModal', () => {
  it('mounts a <bugreel-modal> host with a ShadowRoot and shows the loading state', () => {
    const { deps } = setup();
    const h = mount(deps);
    expect(h.el.tagName.toLowerCase()).toBe('bugreel-modal');
    expect(h.el.shadowRoot).toBeTruthy();
    expect(text(h, 'loading')).toContain('Compiling');
    expect(document.body.contains(h.el)).toBe(true);
  });

  it('renders the four-part preview when a bugreel:report event lands', () => {
    const { deps } = setup();
    const h = mount(deps);
    deliver('bugreel:report', { requestId: 't', report: report() });
    const preview = text(h, 'preview');
    expect(preview).toContain('What the reporter said');
    expect(preview).toContain('What Happened');
    expect(preview).toContain('Pay button did nothing');
    expect(preview).toContain('Story');
    expect(preview).toContain("Clicked 'Pay'");
    expect(preview).toContain('Developer toolkit');
    expect(preview).toContain('(not answered)');
  });

  it('hostile report fields stay inert — preview never turns them into elements', () => {
    const { deps } = setup();
    const h = mount(deps);
    const hostile = report();
    hostile.storySteps = [
      { at: 1, kind: 'click', text: '"><img src=x><script>alert(1)</script>' },
    ];
    hostile.findings = [
      {
        detectorId: 'dead-click',
        severity: 'warning',
        timestamp: 1,
        headline: '<img src=y onerror=alert(1)>',
        explanation: '</details><img src=z>',
        relatedEventIds: [],
      },
    ];
    fillBoth(h, { tryingToDo: '"><b>x</b>', wentWrong: '</textarea><img src=w>' });
    deliver('bugreel:report', { requestId: 't', report: hostile });
    const root = h.el.shadowRoot!;
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('b')).toBeNull();
    expect(text(h, 'preview')).toContain('<img src=x>'); // as text, not markup
  });

  it('renders immediately when a report is provided in deps', () => {
    const { deps } = setup({ report: report() });
    const h = mount(deps);
    expect(br<HTMLElement>(h, 'loading').classList.contains('br-hidden')).toBe(true);
    expect(text(h, 'preview')).toContain('Pay button did nothing');
  });

  it('gates every action until both questions are answered', () => {
    const { deps } = setup({ report: report() });
    const h = mount(deps);
    expect(enabled(h)).toEqual([false, false, false, false]);
    fill(h, 'trying', 'pay');
    expect(enabled(h)).toEqual([false, false, false, false]);
    fill(h, 'wrong', 'nothing happened');
    expect(enabled(h)).toEqual([true, true, true, true]);
    fill(h, 'wrong', '   ');
    expect(enabled(h)).toEqual([false, false, false, false]);
  });

  it('re-compiles with answers after the debounce window', () => {
    vi.useFakeTimers();
    try {
      const { deps, sent } = setup({ report: report() });
      const h = mount(deps);
      sent.length = 0;
      fillBoth(h);
      expect(sent.find((m) => m.type === 'bugreel:compile')).toBeUndefined();
      vi.advanceTimersByTime(400);
      const compile = sent.find((m) => m.type === 'bugreel:compile');
      expect(compile).toBeTruthy();
      expect(compile?.answers).toEqual({ tryingToDo: 'pay', wentWrong: 'nothing happened' });
      expect(compile?.requestId).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests its own compile on mount so a missed report event cannot wedge it', () => {
    const { deps, sent } = setup();
    mount(deps);
    expect(sent.some((m) => m.type === 'bugreel:compile')).toBe(true);
  });

  it('copies the markdown report with answers folded in', async () => {
    const { deps, copied } = setup({ report: report() });
    const h = mount(deps);
    fillBoth(h);
    br<HTMLButtonElement>(h, 'copy-md').click();
    await vi.waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).toContain('BugReel Bug Report');
    expect(copied[0]).toContain('nothing happened');
    await vi.waitFor(() => expect(text(h, 'status')).toContain('copied'));
  });

  it('copies the Cursor/AI fix prompt', async () => {
    const { deps, copied } = setup({ report: report() });
    const h = mount(deps);
    fillBoth(h);
    br<HTMLButtonElement>(h, 'copy-prompt').click();
    await vi.waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).toContain('Fix this bug');
    expect(copied[0]).toContain('pay');
  });

  it('shows an error status when the clipboard rejects', async () => {
    const { deps } = setup({
      report: report(),
      clipboard: { writeText: () => Promise.reject(new Error('denied')) },
    });
    const h = mount(deps);
    fillBoth(h);
    br<HTMLButtonElement>(h, 'copy-md').click();
    await vi.waitFor(() => expect(text(h, 'status')).toContain('Copy failed'));
  });

  it('sends bugreel:pack with answers and downloads the bugreel:bugpack reply', async () => {
    const { deps, sent, downloads } = setup({ report: report() });
    const h = mount(deps);
    fillBoth(h, { tryingToDo: 'export', wentWrong: 'it broke' });
    br<HTMLButtonElement>(h, 'download').click();
    const pack = sent.find((m) => m.type === 'bugreel:pack');
    expect(pack).toBeTruthy();
    expect(pack?.answers).toEqual({ tryingToDo: 'export', wentWrong: 'it broke' });
    expect(text(h, 'status')).toContain('Packing');

    // wrong requestId is ignored
    deliver('bugreel:bugpack', { requestId: 'other', bugpack: new Uint8Array([1, 2]) });
    expect(downloads).toHaveLength(0);

    deliver('bugreel:bugpack', { requestId: pack!.requestId, bugpack: new Uint8Array([80, 75, 3]) });
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toMatch(/\.bugpack$/);
    expect([...downloads[0]!.bytes]).toEqual([80, 75, 3]);
    expect(text(h, 'status')).toContain('Downloaded');
  });

  it('reports an error when the pack request cannot be sent', () => {
    const { deps } = setup({ report: report(), send: undefined });
    const h = mount(deps);
    fillBoth(h);
    br<HTMLButtonElement>(h, 'download').click();
    expect(text(h, 'status')).toContain('unavailable');
  });

  it('persists to the store on submit (Mode 1 default)', async () => {
    const { deps, saved } = setup({ report: report() });
    const h = mount(deps);
    fillBoth(h);
    br<HTMLButtonElement>(h, 'submit').click();
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.reporterAnswers).toEqual({ tryingToDo: 'pay', wentWrong: 'nothing happened' });
    await vi.waitFor(() => expect(text(h, 'status')).toContain('saved locally'));
  });

  it('hands submit to the onSubmit seam when provided (T10 hook)', async () => {
    const onSubmit = vi.fn();
    const { deps, saved } = setup({ report: report(), onSubmit });
    const h = mount(deps);
    fillBoth(h);
    br<HTMLButtonElement>(h, 'submit').click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const ctx = onSubmit.mock.calls[0]![0] as { report: BugReelReport; answers: ReporterAnswers };
    expect(ctx.answers.wentWrong).toBe('nothing happened');
    expect(saved).toHaveLength(0); // custom seam replaces the IDB default
    await vi.waitFor(() => expect(text(h, 'status')).toContain('submitted'));
  });

  it('drops to the error state — buttons usable again — when submit fails', async () => {
    const { deps } = setup({
      report: report(),
      onSubmit: () => Promise.reject(new Error('boom')),
    });
    const h = mount(deps);
    fillBoth(h);
    br<HTMLButtonElement>(h, 'submit').click();
    await vi.waitFor(() => expect(text(h, 'status')).toContain('Submit failed'));
    expect(enabled(h)).toEqual([true, true, true, true]);
  });

  /* ------------------------- Mode-2 webhook submit (T10) ------------------------- */

  it('Mode 2: submit packs a .bugpack and dispatches to the webhook instead of the store', async () => {
    const calls: { url: string; init: { body: FormData | string } }[] = [];
    const { deps, sent, saved } = setup({
      report: report(),
      webhook: 'https://hooks.example.test/bugreel',
      fetch: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200 };
      },
    });
    const h = mount(deps);
    fillBoth(h, { tryingToDo: 'check out', wentWrong: 'it broke' });
    br<HTMLButtonElement>(h, 'submit').click();

    await vi.waitFor(() => expect(sent.some((m) => m.type === 'bugreel:pack')).toBe(true));
    const pack = sent.find((m) => m.type === 'bugreel:pack')!;
    expect(pack.answers).toEqual({ tryingToDo: 'check out', wentWrong: 'it broke' });
    expect(text(h, 'status')).toContain('Packing');

    deliver('bugreel:bugpack', { requestId: pack.requestId, bugpack: new Uint8Array([80, 75, 3]) });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe('https://hooks.example.test/bugreel');
    // Custom target → multipart report + bugpack parts (happy-dom drops the
    // Blob filename, so assert the part content/type instead of its name).
    const body = calls[0]!.init.body as FormData;
    const reportPart = body.get('report') as File;
    expect(JSON.parse(await reportPart.text()).meta.sessionId).toBe('sess-1');
    const packPart = body.get('bugpack') as File;
    expect(packPart.type).toBe('application/zip');
    expect([...new Uint8Array(await packPart.arrayBuffer())]).toEqual([80, 75, 3]);
    await vi.waitFor(() => expect(text(h, 'status')).toContain('Report submitted'));
    expect(saved).toHaveLength(0); // dispatch replaces the IDB save
  });

  it('Mode 2 + Slack: downloads the .bugpack locally and says so', async () => {
    const calls: { init: { headers?: Record<string, string>; body: unknown } }[] = [];
    const { deps, sent, downloads } = setup({
      report: report(),
      webhook: 'https://hooks.slack.com/services/T/B/x',
      fetch: async (_url, init) => {
        calls.push({ init });
        return { ok: true, status: 200 };
      },
    });
    const h = mount(deps);
    fillBoth(h);
    br<HTMLButtonElement>(h, 'submit').click();
    const pack = sent.find((m) => m.type === 'bugreel:pack')!;
    deliver('bugreel:bugpack', { requestId: pack.requestId, bugpack: new Uint8Array([80, 75]) });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.init.headers).toEqual({ 'Content-Type': 'text/plain' });
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toMatch(/\.bugpack$/);
    await vi.waitFor(() => expect(text(h, 'status')).toContain('downloaded locally'));
  });

  it('Mode 2 + Discord oversize: re-packs lite, sends it, and downloads the full pack', async () => {
    const calls: { body: FormData }[] = [];
    const { deps, sent, downloads } = setup({
      report: report(),
      webhook: 'https://discord.com/api/webhooks/1/tok',
      fetch: async (_url, init) => {
        calls.push({ body: init.body as FormData });
        return { ok: true, status: 200 };
      },
    });
    const h = mount(deps);
    fillBoth(h);
    br<HTMLButtonElement>(h, 'submit').click();

    const first = sent.find((m) => m.type === 'bugreel:pack')!;
    expect((first as { lite?: boolean }).lite).toBeUndefined();
    // Trip the 7.5MB guard.
    deliver('bugreel:bugpack', {
      requestId: first.requestId,
      bugpack: new Uint8Array(8_000_000),
    });
    await vi.waitFor(() =>
      expect(
        sent.filter((m) => m.type === 'bugreel:pack' && (m as { lite?: boolean }).lite === true),
      ).toHaveLength(1),
    );
    const litePack = sent.filter((m) => m.type === 'bugreel:pack')[1]!;
    deliver('bugreel:bugpack', { requestId: litePack.requestId, bugpack: new Uint8Array([80, 75, 9]) });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0]!.body.get('files[0]') as File).size).toBe(3); // the lite pack went out
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.bytes.byteLength).toBe(8_000_000); // the full pack stayed local
    await vi.waitFor(() => expect(text(h, 'status')).toContain('too large'));
    expect(text(h, 'status')).toContain('downloaded locally');
  });

  it('Mode 2 failure: non-2xx lands in the error state with retry possible', async () => {
    const { deps, sent, saved } = setup({
      report: report(),
      webhook: 'https://hooks.slack.com/services/T/B/x',
      fetch: async () => ({ ok: false, status: 500 }),
    });
    const h = mount(deps);
    fillBoth(h);
    br<HTMLButtonElement>(h, 'submit').click();
    const pack = sent.find((m) => m.type === 'bugreel:pack')!;
    deliver('bugreel:bugpack', { requestId: pack.requestId, bugpack: new Uint8Array([1]) });
    await vi.waitFor(() => expect(text(h, 'status')).toContain('Submit failed'));
    expect(text(h, 'status')).toContain('500');
    expect(text(h, 'status')).not.toContain('hooks.slack.com'); // token never echoed
    expect(enabled(h)).toEqual([true, true, true, true]);
    expect(saved).toHaveLength(0);
  });

  it('Mode 2 failure: a pack timeout resolves to the error state', async () => {
    vi.useFakeTimers();
    try {
      const { deps } = setup({
        report: report(),
        webhook: 'https://hooks.example.test/x',
        fetch: async () => ({ ok: true, status: 200 }),
      });
      const h = mount(deps);
      fillBoth(h);
      br<HTMLButtonElement>(h, 'submit').click();
      await vi.advanceTimersByTimeAsync(16_000);
      expect(text(h, 'status')).toContain('Submit failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Mode 2: a stale bugpack reply cannot resolve a submit pack', async () => {
    const calls: unknown[] = [];
    const { deps, sent } = setup({
      report: report(),
      webhook: 'https://hooks.example.test/x',
      fetch: async () => {
        calls.push(1);
        return { ok: true, status: 200 };
      },
    });
    const h = mount(deps);
    fillBoth(h);
    br<HTMLButtonElement>(h, 'submit').click();
    const pack = sent.find((m) => m.type === 'bugreel:pack')!;
    deliver('bugreel:bugpack', { requestId: 'stale', bugpack: new Uint8Array([9]) });
    deliver('bugreel:bugpack', { requestId: pack.requestId, bugpack: new Uint8Array([9]) });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });

  it('closes on the × button, Escape, and backdrop click — and re-opens on bugreel:open', () => {
    const { deps } = setup({ report: report() });
    const h = mount(deps);
    const visible = () => h.el.style.display !== 'none';

    expect(visible()).toBe(true);
    br<HTMLButtonElement>(h, 'close').click();
    expect(visible()).toBe(false);

    deliver('bugreel:open', undefined);
    expect(visible()).toBe(true);

    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(visible()).toBe(false);

    deliver('bugreel:open', undefined);
    expect(visible()).toBe(true);
    br<HTMLElement>(h, 'backdrop').click();
    expect(visible()).toBe(false);
  });

  it('shows a pipeline error when bugreel:error arrives', () => {
    const { deps } = setup();
    const h = mount(deps);
    deliver('bugreel:error', { requestId: 'x', message: 'worker died' });
    expect(text(h, 'status')).toContain('worker died');
  });

  it('installModal is a singleton — a second call re-opens the live modal', () => {
    const { deps } = setup();
    const first = installModal(deps)!;
    handles.push(first);
    first.close();
    const second = installModal(deps)!;
    expect(second).toBe(first);
    expect(first.el.style.display).not.toBe('none');
  });

  it('destroy removes the element and its listeners', () => {
    const { deps, sent } = setup();
    const h = mount(deps);
    h.destroy();
    expect(document.body.contains(h.el)).toBe(false);
    const before = text(h, 'preview');
    deliver('bugreel:report', { requestId: 't', report: report() });
    deliver('bugreel:open', undefined);
    expect(text(h, 'preview')).toBe(before); // listeners are gone — no re-render
    expect(sent.filter((m) => m.type === 'bugreel:compile')).toHaveLength(1);
  });

  it('returns undefined where there is no usable document', () => {
    expect(mountModal({ window: { addEventListener() {}, removeEventListener() {} } })).toBeUndefined();
  });

  /* ------------------------- T09a media ------------------------- */

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);

  const mediaDeps = (extra: Partial<ModalDeps> = {}) => {
    let onDone: ((p: Uint8Array | undefined) => void) | undefined;
    let onCancel: (() => void) | undefined;
    const annoEl = document.createElement('div');
    const annotator = {
      el: annoEl,
      setTool: vi.fn(),
      undo: vi.fn(),
      canUndo: () => false,
      toPng: () => png,
      destroy: vi.fn(),
    };
    const deps: Partial<ModalDeps> = {
      captureSnapshot: vi.fn(async () => png),
      decodeImage: vi.fn(async () => ({ width: 8, height: 8, source: {} })),
      createAnnotator: vi.fn((opts) => {
        onDone = opts.onDone;
        onCancel = opts.onCancel;
        return annotator;
      }),
      ...extra,
    };
    return { deps, annotator, annoEl, done: (p?: Uint8Array) => onDone?.(p), cancel: () => onCancel?.() };
  };

  it('captures a snapshot, mounts the annotator, and attaches the PNG to pack + submit', async () => {
    const onSubmit = vi.fn();
    const kit = mediaDeps({ onSubmit });
    const { deps, sent } = setup({ report: report(), ...kit.deps });
    const h = mount(deps);

    br<HTMLButtonElement>(h, 'annotate').click();
    await vi.waitFor(() => expect(kit.deps.captureSnapshot).toHaveBeenCalled());
    await vi.waitFor(() => expect(kit.deps.createAnnotator).toHaveBeenCalled());
    const host = br<HTMLElement>(h, 'annotator');
    expect(host.classList.contains('br-hidden')).toBe(false);
    expect(host.contains(kit.annoEl)).toBe(true);

    kit.done(png);
    expect(kit.annotator.destroy).toHaveBeenCalled();
    expect(host.classList.contains('br-hidden')).toBe(true);
    expect(text(h, 'media-list')).toContain('snapshot-annotated.png');
    expect(text(h, 'status')).toContain('attached');

    // The pack request carries the media entry.
    fillBoth(h);
    br<HTMLButtonElement>(h, 'download').click();
    const pack = sent.find((m) => m.type === 'bugreel:pack');
    expect(pack?.media?.map((m) => m.name)).toEqual(['snapshot-annotated.png']);
    expect(pack?.media?.[0]?.mimeType).toBe('image/png');
    expect(pack?.media?.[0]?.data).toBe(png);

    // The submit ctx carries media and the report manifest names it.
    br<HTMLButtonElement>(h, 'submit').click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const ctx = onSubmit.mock.calls[0]![0] as {
      report: BugReelReport;
      media?: { name: string; data: Uint8Array }[];
    };
    expect(ctx.media?.[0]?.name).toBe('snapshot-annotated.png');
    expect(ctx.report.media).toContain('snapshot-annotated.png');
  });

  it('reports an error when every snapshot path comes back empty', async () => {
    const kit = mediaDeps({ captureSnapshot: vi.fn(async () => undefined) });
    const { deps } = setup({ report: report(), ...kit.deps });
    const h = mount(deps);
    br<HTMLButtonElement>(h, 'annotate').click();
    await vi.waitFor(() => expect(text(h, 'status')).toContain('No snapshot'));
    expect(kit.deps.createAnnotator).not.toHaveBeenCalled();
  });

  it('attaches nothing when the annotator is cancelled', async () => {
    const kit = mediaDeps();
    const { deps } = setup({ report: report(), ...kit.deps });
    const h = mount(deps);
    br<HTMLButtonElement>(h, 'annotate').click();
    await vi.waitFor(() => expect(kit.deps.createAnnotator).toHaveBeenCalled());
    kit.cancel();
    expect(kit.annotator.destroy).toHaveBeenCalled();
    expect(text(h, 'media-list')).toBe('');
    expect(br<HTMLElement>(h, 'annotator').classList.contains('br-hidden')).toBe(true);
  });

  it('removes an attachment via its × button and drops it from the pack', async () => {
    const kit = mediaDeps();
    const { deps, sent } = setup({ report: report(), ...kit.deps });
    const h = mount(deps);
    br<HTMLButtonElement>(h, 'annotate').click();
    await vi.waitFor(() => expect(kit.deps.createAnnotator).toHaveBeenCalled());
    kit.done(png);
    const remove = h.el.shadowRoot!.querySelector('.br-media-remove') as HTMLButtonElement;
    expect(remove).toBeTruthy();
    remove.click();
    expect(text(h, 'media-list')).not.toContain('snapshot-annotated.png');
    fillBoth(h);
    br<HTMLButtonElement>(h, 'download').click();
    const pack = sent.find((m) => m.type === 'bugreel:pack');
    expect(pack?.media).toBeUndefined();
  });

  /* ------------------------- T09b attachments ------------------------- */

  const setFiles = (h: ModalHandle, files: File[]): void => {
    const input = br<HTMLInputElement>(h, 'file-input');
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new window.Event('change'));
  };

  it('attaches multiple files via the picker, sizes them, and packs them', async () => {
    const { deps, sent } = setup({ report: report() });
    const h = mount(deps);
    expect(br<HTMLElement>(h, 'media-size').textContent).toBe('');

    setFiles(h, [
      new File([new Uint8Array([1, 2, 3])], 'screen.png', { type: 'image/png' }),
      new File([new Uint8Array([4, 5])], 'clip.webm', { type: 'video/webm' }),
    ]);
    await vi.waitFor(() => expect(text(h, 'media-list')).toContain('screen.png'));
    expect(text(h, 'media-list')).toContain('clip.webm');
    // A video attachment renders a <video> thumb, not an <img>.
    expect(h.el.shadowRoot!.querySelector('.br-media-item video')).toBeTruthy();
    // Aggregate size readout: "2 files · N KB".
    expect(text(h, 'media-size')).toMatch(/^2 files · /);

    fillBoth(h);
    br<HTMLButtonElement>(h, 'download').click();
    const pack = sent.find((m) => m.type === 'bugreel:pack');
    expect(pack?.media?.map((m) => m.name).sort()).toEqual(['clip.webm', 'screen.png']);
  });

  it('rejects non-media and oversized files with an honest status', async () => {
    const { deps } = setup({ report: report() });
    const h = mount(deps);
    // Batch 1: a wrong-type file is skipped.
    setFiles(h, [new File([new Uint8Array([1])], 'notes.txt', { type: 'text/plain' })]);
    // Batch 2: oversize is enforced via the File.size hint — fake it past the cap.
    const input = br<HTMLInputElement>(h, 'file-input');
    const huge = new File([new Uint8Array([1])], 'huge.webm', { type: 'video/webm' });
    Object.defineProperty(huge, 'size', { value: 21 * 1024 * 1024 });
    Object.defineProperty(input, 'files', {
      value: [huge, new File([new Uint8Array([1])], 'ok.png', { type: 'image/png' })],
      configurable: true,
    });
    input.dispatchEvent(new window.Event('change'));
    await vi.waitFor(() => expect(text(h, 'status')).toContain('skipped'));
    expect(text(h, 'media-list')).toContain('ok.png');
    expect(text(h, 'media-list')).not.toContain('huge.webm');
  });

  it('dedupes colliding attachment names', async () => {
    const { deps } = setup({ report: report() });
    const h = mount(deps);
    const f = () => new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
    setFiles(h, [f(), f()]);
    await vi.waitFor(() => expect(text(h, 'media-list')).toContain('shot (2).png'));
  });

  it('a real drop event (dataTransfer.files) attaches files and toggles the hover class', async () => {
    const { deps } = setup({ report: report() });
    const h = mount(deps);
    const dz = br<HTMLElement>(h, 'dropzone');

    const dragover = new window.Event('dragover', { bubbles: true, cancelable: true });
    dz.dispatchEvent(dragover);
    expect(dragover.defaultPrevented).toBe(true);
    expect(dz.classList.contains('br-over')).toBe(true);

    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.assign(drop, {
      dataTransfer: {
        files: [new File([new Uint8Array([9])], 'dropped.png', { type: 'image/png' })],
      },
    });
    dz.dispatchEvent(drop);
    await vi.waitFor(() => expect(text(h, 'media-list')).toContain('dropped.png'));
    expect(dz.classList.contains('br-over')).toBe(false);
    expect(drop.defaultPrevented).toBe(true);
  });

  it('accepts media files that report an empty MIME type via extension', async () => {
    const { deps } = setup({ report: report() });
    const h = mount(deps);
    const noType = new File([new Uint8Array([1])], 'clue.webm', { type: 'video/webm' });
    Object.defineProperty(noType, 'type', { value: '' });
    setFiles(h, [noType]);
    await vi.waitFor(() => expect(text(h, 'media-list')).toContain('clue.webm'));
  });

  it('the size readout clears when the last attachment is removed', async () => {
    const { deps } = setup({ report: report() });
    const h = mount(deps);
    setFiles(h, [new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(text(h, 'media-size')).toMatch(/^1 file · /));
    (h.el.shadowRoot!.querySelector('.br-media-remove') as HTMLButtonElement).click();
    expect(text(h, 'media-size')).toBe('');
  });

  it('hides the record button where recording is unsupported (iOS Safari path)', () => {
    const { deps } = setup({ report: report() });
    const h = mount(deps);
    // happy-dom lacks getDisplayMedia + MediaRecorder → the picker path.
    expect(br<HTMLElement>(h, 'record').classList.contains('br-hidden')).toBe(true);
    expect(br<HTMLElement>(h, 'dropzone')).toBeTruthy();
  });

  it('record → 15s clip → screen-recording.webm media entry', async () => {
    let resolveDone: ((r: { bytes: Uint8Array; mimeType: string } | undefined) => void) | undefined;
    const handle = {
      done: new Promise<{ bytes: Uint8Array; mimeType: string } | undefined>((res) => {
        resolveDone = res;
      }),
      stop: vi.fn(),
      active: true,
    };
    const recordScreen = vi.fn(() => handle);
    const { deps, sent } = setup({ report: report(), recordScreen });
    const h = mount(deps);
    const btn = br<HTMLButtonElement>(h, 'record');
    expect(btn.classList.contains('br-hidden')).toBe(false);

    btn.click();
    expect(recordScreen).toHaveBeenCalled();
    expect(text(h, 'status')).toContain('Recording');
    expect(btn.textContent).toContain('Stop');

    resolveDone!({ bytes: new Uint8Array([7, 8, 9]), mimeType: 'video/webm' });
    await vi.waitFor(() => expect(text(h, 'media-list')).toContain('screen-recording.webm'));
    expect(text(h, 'status')).toContain('recording attached');

    fillBoth(h);
    br<HTMLButtonElement>(h, 'download').click();
    const pack = sent.find((m) => m.type === 'bugreel:pack');
    const webm = pack?.media?.find((m) => m.name === 'screen-recording.webm');
    expect(webm?.mimeType).toBe('video/webm');
    expect(webm?.data.byteLength).toBe(3);
  });

  it('a second click stops recording early via the handle', async () => {
    const handle = {
      done: new Promise<undefined>(() => {}),
      stop: vi.fn(),
      active: true,
    };
    const { deps } = setup({ report: report(), recordScreen: vi.fn(() => handle) });
    const h = mount(deps);
    const btn = br<HTMLButtonElement>(h, 'record');
    btn.click();
    btn.click();
    expect(handle.stop).toHaveBeenCalled();
  });

  it('destroy() stops an in-flight recording', () => {
    const handle = {
      done: new Promise<undefined>(() => {}),
      stop: vi.fn(),
      active: true,
    };
    const { deps } = setup({ report: report(), recordScreen: vi.fn(() => handle) });
    const h = mount(deps);
    br<HTMLButtonElement>(h, 'record').click();
    h.destroy();
    expect(handle.stop).toHaveBeenCalled();
  });
});
