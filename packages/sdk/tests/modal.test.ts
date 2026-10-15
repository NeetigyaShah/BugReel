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
});
