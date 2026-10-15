import { compileMarkdown, compilePrompt } from './worker/compilers';
import { downloadBytes } from './download';
import { createReportStore, type ReportStore } from './store';
import { guard, uuid } from './util';
import type {
  BugReelReport,
  BugpackMediaEntry,
  ReporterAnswers,
  ReportMeta,
  ToWorkerMessage,
} from './types';

type AnyFn = (...args: any[]) => any;

interface EventTargetLike {
  addEventListener?(type: string, listener: AnyFn, options?: unknown): void;
  removeEventListener?(type: string, listener: AnyFn, options?: unknown): void;
}

/** The slice of `document` the modal touches — every member optional/injectable. */
export interface ModalDocument extends EventTargetLike {
  createElement?(tag: string): any;
  body?: { appendChild?(el: unknown): unknown } | null;
  documentElement?: unknown;
  execCommand?(command: string): boolean;
}

/** The slice of `window` the modal touches — every member optional/injectable. */
export interface ModalWindow extends EventTargetLike {
  document?: ModalDocument | null;
  navigator?: {
    userAgent?: string;
    clipboard?: { writeText?(text: string): Promise<unknown> };
  };
  indexedDB?: IDBFactory;
  customElements?: { get?(name: string): unknown; define?(name: string, ctor: unknown): void };
  HTMLElement?: unknown;
}

/**
 * Modal dependency seam — the capture chunk injects what the loader owns
 * (worker channel); tests inject fakes for everything else.
 */
export interface ModalDeps {
  window?: ModalWindow;
  document?: ModalDocument | null;
  /** Pre-seeded compiled report (skips the initial loading state). */
  report?: BugReelReport;
  /** Fresh report meta for worker round-trips (re-compile, .bugpack pack). */
  meta?(): ReportMeta;
  /** Worker channel — the app injects `transport.send`; accepts compile/pack. */
  send?(message: ToWorkerMessage): void;
  /** Report persistence — defaults to an IndexedDB store when available. */
  store?: ReportStore | null;
  /** Clipboard seam — defaults to navigator.clipboard with an execCommand fallback. */
  clipboard?: { writeText(text: string): Promise<unknown> };
  /** Download seam — defaults to a Blob+anchor download. */
  download?(filename: string, bytes: Uint8Array): void;
  /**
   * Mode-2 flag reserved for the webhook ticket (T10): a configured webhook
   * means submit should dispatch rather than only persist locally.
   */
  webhook?: boolean;
  /**
   * T10 extension seam — replaces the default submit path (IndexedDB save in
   * Mode 1). Awaited; a throw or rejection drops the modal into its error
   * state and never propagates to the host.
   */
  onSubmit?(ctx: { report: BugReelReport; answers: ReporterAnswers }): unknown;
  /** Injectable clock for tests. */
  now?(): number;
}

export interface ModalHandle {
  /** The mounted `<bugreel-modal>` host element. */
  el: HTMLElement;
  /** Show the modal — the loading state shows until a report lands. */
  open(): void;
  close(): void;
  destroy(): void;
}

type Phase = 'loading' | 'ready' | 'submitting' | 'submitted';

/** What the modal asks the worker for — the injected channel stamps requestId + meta. */
type WorkerRequest =
  | { type: 'bugreel:compile'; answers?: ReporterAnswers }
  | {
      type: 'bugreel:pack';
      answers?: ReporterAnswers;
      media?: BugpackMediaEntry[];
      lite?: boolean;
    };

const COMPILE_DEBOUNCE_MS = 300;
const PACK_TIMEOUT_MS = 15_000;
const STATUS_CLEAR_MS = 4_000;
const SEVERITY_MARK: Record<string, string> = { critical: '🚨', warning: '⚠️' };

/* ------------------------------------------------------------------ */
/* Style + skeleton — every selector is shadow-scoped; nothing global.  */
/* ------------------------------------------------------------------ */

const SKELETON = `<style>
:host{all:initial;display:block;position:fixed;inset:0;z-index:2147483001;font:14px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827}
*,*:before,*:after{box-sizing:border-box}
.br-backdrop{position:absolute;inset:0;background:rgba(17,24,39,.55)}
.br-panel{position:relative;margin:4vh auto 0;width:min(680px,94vw);max-height:92vh;display:flex;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.35)}
.br-head{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid #e5e7eb}
.br-title{margin:0;font-size:16px;font-weight:600}
.br-close{border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:#6b7280;padding:4px}
.br-close:hover{color:#111827}
.br-body{padding:16px 20px;overflow:auto}
.br-loading{padding:28px 0;text-align:center;color:#6b7280}
.br-field{display:block;margin:0 0 12px}
.br-label{display:block;font-weight:600;margin-bottom:4px}
.br-textarea{display:block;width:100%;min-height:56px;resize:vertical;border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font:inherit;color:#111827;background:#fff}
.br-textarea:focus{outline:2px solid #2563eb;outline-offset:-1px;border-color:#2563eb}
.br-preview{border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin:0;max-height:300px;overflow:auto;background:#f9fafb}
.br-preview h3{margin:12px 0 4px;font-size:13px;font-weight:700;color:#374151}
.br-preview h3:first-child{margin-top:0}
.br-preview ul{margin:0;padding-left:18px}
.br-preview li{margin:2px 0}
.br-preview details{margin:6px 0}
.br-preview summary{cursor:pointer;font-weight:600}
.br-preview pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:8px;font:12px/1.5 ui-monospace,Menlo,monospace;margin:6px 0 10px;max-height:220px;overflow:auto}
.br-crit{color:#b91c1c}.br-warn{color:#b45309}
.br-status{min-height:18px;padding:4px 20px;font-size:13px;color:#6b7280}
.br-status.br-err{color:#b91c1c}
.br-actions{display:flex;flex-wrap:wrap;gap:8px;padding:12px 20px;border-top:1px solid #e5e7eb}
.br-btn{border:1px solid #d1d5db;background:#fff;border-radius:8px;padding:8px 12px;font:inherit;font-weight:600;cursor:pointer;color:#111827}
.br-btn:hover:not(:disabled){background:#f3f4f6}
.br-btn:disabled{opacity:.45;cursor:not-allowed}
.br-btn-primary{background:#111827;border-color:#111827;color:#fff}
.br-btn-primary:hover:not(:disabled){background:#1f2937}
.br-hidden{display:none!important}
</style>
<div class="br-backdrop" data-br="backdrop"></div>
<div class="br-panel" role="dialog" aria-modal="true" aria-label="Report a bug">
  <div class="br-head">
    <h2 class="br-title">Report a bug</h2>
    <button class="br-close" type="button" data-br="close" aria-label="Close">×</button>
  </div>
  <div class="br-body">
    <div class="br-loading" data-br="loading">Compiling your report…</div>
    <div data-br="main" class="br-hidden">
      <label class="br-field"><span class="br-label">What were you trying to do?</span>
        <textarea class="br-textarea" data-br="trying" rows="2"></textarea></label>
      <label class="br-field"><span class="br-label">What went wrong?</span>
        <textarea class="br-textarea" data-br="wrong" rows="2"></textarea></label>
      <div class="br-preview" data-br="preview"></div>
    </div>
  </div>
  <div class="br-status" data-br="status" role="status"></div>
  <div class="br-actions">
    <button class="br-btn" type="button" data-br="copy-md" disabled>Copy Markdown report</button>
    <button class="br-btn" type="button" data-br="copy-prompt" disabled>Copy AI fix prompt</button>
    <button class="br-btn" type="button" data-br="download" disabled>Download .bugpack</button>
    <button class="br-btn br-btn-primary" type="button" data-br="submit" disabled>Submit report</button>
  </div>
</div>`;

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * The report with the reporter's answers folded in — outputs are recompiled
 * locally by the same deterministic compilers the worker uses, so the preview
 * and clipboard always reflect the latest keystroke without a worker hop.
 */
export const withAnswers = (base: BugReelReport, answers: ReporterAnswers): BugReelReport => {
  const next: BugReelReport = {
    ...base,
    reporterAnswers: answers,
    outputs: { ...base.outputs },
  };
  try {
    next.outputs.cursorPrompt = compilePrompt({
      events: base.events,
      findings: base.findings,
      meta: base.meta,
      answers,
    });
    next.outputs.markdown = compileMarkdown(next);
  } catch {
    /* compilers are pure — a failure keeps the worker-provided outputs */
  }
  return next;
};

/** Deterministic .bugpack filename from the report timestamp. */
const bugpackName = (capturedAt: number | undefined): string => {
  try {
    const stamp = new Date(capturedAt ?? Date.now()).toISOString().replace(/[:.]/g, '-');
    return `bugreel-${stamp}.bugpack`;
  } catch {
    return 'bugreel-report.bugpack';
  }
};

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

/** Register `<bugreel-modal>` when a registry exists — best-effort only. */
const defineElement = (win: ModalWindow): void => {
  try {
    const registry = win.customElements;
    const Base = win.HTMLElement;
    if (typeof Base === 'function' && registry?.define && !registry.get?.('bugreel-modal')) {
      registry.define('bugreel-modal', class extends (Base as { new (): HTMLElement }) {});
    }
  } catch {}
};

/**
 * Mount the report modal. Everything is guarded — a hostile DOM, a missing
 * ShadowRoot, a dead worker channel all degrade to "no modal" rather than a
 * broken host page.
 */
export const mountModal = (deps: ModalDeps = {}): ModalHandle | undefined => {
  const win =
    deps.window ??
    (typeof window !== 'undefined' ? (window as unknown as ModalWindow) : undefined);
  const doc = deps.document ?? win?.document;
  if (!win || typeof doc?.createElement !== 'function') return undefined;
  const now = deps.now ?? (() => Date.now());

  defineElement(win);

  // Bound once — the entry guard proved it exists; real Documents need `this`.
  const createElement = doc.createElement.bind(doc) as (tag: string) => any;
  const el = createElement('bugreel-modal') as HTMLElement;
  if (!el) return undefined;
  const root = (
    (el as { attachShadow?(init: { mode: string }): unknown }).attachShadow?.({
      mode: 'open',
    }) ?? el
  ) as { querySelector(selector: string): Element | null; innerHTML: string };
  root.innerHTML = SKELETON;

  const q = <T>(selector: string): T | undefined =>
    (root.querySelector(`[data-br="${selector}"]`) ?? undefined) as T | undefined;
  const loadingEl = q<{ classList: { toggle(c: string, on: boolean): void } }>('loading');
  const mainEl = q<{ classList: { toggle(c: string, on: boolean): void } }>('main');
  const previewEl = q<{ replaceChildren(...nodes: unknown[]): void }>('preview');
  const statusEl = q<{ textContent: string | null; classList: { toggle(c: string, on: boolean): void } }>('status');
  const tryingEl = q<{ value: string; addEventListener?: AnyFn }>('trying');
  const wrongEl = q<{ value: string; addEventListener?: AnyFn }>('wrong');
  const buttons = (['copy-md', 'copy-prompt', 'download', 'submit'] as const).map(
    (key) => q<{ disabled: boolean; addEventListener?: AnyFn; click?: () => void }>(key),
  );

  /* ------------------------- state ------------------------- */
  let phase: Phase = deps.report ? 'ready' : 'loading';
  let report: BugReelReport | undefined = deps.report;
  let pendingPack: string | undefined;
  let packTimer: ReturnType<typeof setTimeout> | undefined;
  let compileTimer: ReturnType<typeof setTimeout> | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  // `window.indexedDB` itself can throw in sandboxed/restricted contexts —
  // a storage feature must never take the whole modal down with it.
  const store = ((): ReportStore | undefined => {
    if (deps.store !== undefined) return deps.store ?? undefined;
    try {
      return createReportStore(win.indexedDB);
    } catch {
      return undefined;
    }
  })();
  const download = deps.download ?? downloadBytes;
  const cleanups: Array<() => void> = [];

  const on = (
    target: EventTargetLike | undefined,
    type: string,
    fn: AnyFn,
    opts?: unknown,
  ): void => {
    if (!target?.addEventListener) return;
    try {
      target.addEventListener(type, fn, opts);
      cleanups.push(() => {
        try {
          target.removeEventListener?.(type, fn, opts);
        } catch {}
      });
    } catch {}
  };

  const answers = (): ReporterAnswers => ({
    tryingToDo: String(tryingEl?.value ?? '').trim(),
    wentWrong: String(wrongEl?.value ?? '').trim(),
  });

  /** The report with live answers folded in — what preview/copy/submit see. */
  const currentReport = (): BugReelReport | undefined =>
    report ? withAnswers(report, answers()) : undefined;

  const setStatus = (text: string, isError = false): void => {
    try {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.classList.toggle('br-err', isError);
      clearTimeout(statusTimer);
      if (text && !isError) {
        statusTimer = setTimeout(() => {
          try {
            statusEl.textContent = '';
          } catch {}
        }, STATUS_CLEAR_MS);
      }
    } catch {}
  };

  const gate = (): void => {
    const filled = !!(answers().tryingToDo && answers().wentWrong);
    for (const [i, b] of buttons.entries()) {
      try {
        // Only submit stays gated once 'submitted' — copy/download must keep
        // working so the reporter can still take the artifact away.
        const submitted = phase === 'submitted' && i === 3;
        if (b) b.disabled = !filled || phase === 'submitting' || submitted;
      } catch {}
    }
  };

  const setPhase = (next: Phase): void => {
    phase = next;
    try {
      loadingEl?.classList.toggle('br-hidden', next !== 'loading');
      mainEl?.classList.toggle('br-hidden', next === 'loading');
    } catch {}
    gate();
  };

  /** Element builder — dynamic strings only ever land via textContent. */
  const h = (tag: string, cls: string | undefined, text?: string) => {
    const node = createElement(tag) as {
      className: string;
      textContent: string;
      append(...kids: unknown[]): void;
    };
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /** Structured render of the four-part report (GLOSSARY: Report). */
  const renderPreview = (): void => {
    try {
      if (!previewEl) return;
      const r = currentReport();
      const kids: unknown[] = [];
      const a = r?.reporterAnswers ?? answers();

      kids.push(h('h3', undefined, '1 · What the reporter said'));
      const said = h('ul', undefined);
      said.append(h('li', undefined, `Trying to: ${a?.tryingToDo || '(not answered)'}`));
      said.append(h('li', undefined, `Went wrong: ${a?.wentWrong || '(not answered)'}`));
      kids.push(said);

      kids.push(h('h3', undefined, '2 · What Happened'));
      if (r?.findings?.length) {
        const list = h('ul', undefined);
        for (const f of r.findings) {
          list.append(
            h(
              'li',
              f.severity === 'critical' ? 'br-crit' : 'br-warn',
              `${SEVERITY_MARK[f.severity] ?? '⚠️'} ${f.headline} — ${f.explanation}${f.selector ? ` (${f.selector})` : ''}`,
            ),
          );
        }
        kids.push(list);
      } else {
        kids.push(h('p', undefined, 'No detectors fired — the story below is the observed record.'));
      }

      kids.push(h('h3', undefined, '3 · Story'));
      const steps = h('ul', undefined);
      for (const s of r?.storySteps ?? []) {
        const mark = s.kind === 'finding' ? `${SEVERITY_MARK[s.severity ?? 'warning'] ?? '⚠️'} ` : '';
        steps.append(
          h('li', s.kind === 'finding' ? (s.severity === 'critical' ? 'br-crit' : 'br-warn') : undefined, `${mark}${s.text}`),
        );
      }
      if (!(r?.storySteps?.length)) steps.append(h('li', undefined, '(no captured steps)'));
      kids.push(steps);

      kids.push(h('h3', undefined, '4 · Developer toolkit'));
      const blocks: Array<[string, string | undefined]> = [
        ['AI fix prompt', r?.outputs.cursorPrompt],
        ['cURL — replay the failed request', r?.outputs.curl],
        ['Playwright repro', r?.outputs.playwright],
        ['Markdown report', r?.outputs.markdown],
      ];
      for (const [summary, content] of blocks) {
        if (!content) continue;
        const details = h('details', undefined) as { append(...k: unknown[]): void };
        details.append(h('summary', undefined, summary));
        details.append(h('pre', undefined, content));
        kids.push(details);
      }
      previewEl.replaceChildren(...kids);
    } catch {}
  };

  /**
   * Fire a worker request through the injected channel — never throws. Meta is
   * stamped only when a `meta` dep was provided; otherwise the worker reuses
   * the opener's meta (see runtime `lastMeta`).
   */
  const sendWorker = (message: WorkerRequest): string | undefined => {
    if (!deps.send) return undefined;
    try {
      const requestId = uuid();
      const meta = deps.meta?.();
      deps.send({ ...message, requestId, meta } as ToWorkerMessage);
      return requestId;
    } catch {
      return undefined;
    }
  };

  /** Debounced re-compile so the worker's report gains the reporter's answers. */
  const scheduleCompile = (): void => {
    clearTimeout(compileTimer);
    compileTimer = setTimeout(() => {
      sendWorker({ type: 'bugreel:compile', answers: answers() });
    }, COMPILE_DEBOUNCE_MS);
  };

  /* ------------------------- actions ------------------------- */

  const writeClipboard = async (text: string): Promise<void> => {
    if (deps.clipboard?.writeText) {
      await deps.clipboard.writeText(text);
      return;
    }
    const clip = win.navigator?.clipboard;
    if (clip?.writeText) {
      await clip.writeText(text);
      return;
    }
    // Legacy fallback — a hidden textarea plus execCommand.
    if (typeof doc.execCommand !== 'function') throw new Error('clipboard unavailable');
    const ta = createElement('textarea') as {
      value: string;
      select?(): void;
      remove?(): void;
      style?: { cssText: string };
    };
    ta.value = text;
    if (ta.style) ta.style.cssText = 'position:fixed;inset:0;opacity:0';
    (doc.body ?? (doc.documentElement as { appendChild?(e: unknown): unknown } | undefined))
      ?.appendChild?.(ta);
    ta.select?.();
    const ok = doc.execCommand('copy');
    ta.remove?.();
    if (!ok) throw new Error('copy rejected');
  };

  const copyAction = guard(async (kind: 'markdown' | 'prompt'): Promise<void> => {
    const r = currentReport();
    const text = kind === 'markdown' ? r?.outputs.markdown : r?.outputs.cursorPrompt;
    if (!text) {
      setStatus('Nothing to copy yet.', true);
      return;
    }
    try {
      await writeClipboard(text);
      setStatus(kind === 'markdown' ? 'Markdown report copied.' : 'AI fix prompt copied.');
    } catch {
      setStatus('Copy failed — you can still select the text in the preview.', true);
    }
  });

  const downloadAction = guard((): void => {
    if (pendingPack) return;
    const requestId = sendWorker({ type: 'bugreel:pack', answers: answers() });
    if (!requestId) {
      setStatus('Report pipeline unavailable — try the copy buttons instead.', true);
      return;
    }
    pendingPack = requestId;
    setStatus('Packing .bugpack…');
    packTimer = setTimeout(() => {
      pendingPack = undefined;
      setStatus('Pack timed out — try again.', true);
    }, PACK_TIMEOUT_MS);
  });

  const submitAction = guard(async (): Promise<void> => {
    const r = currentReport();
    if (!r || phase === 'submitting') return;
    setPhase('submitting');
    setStatus('Submitting…');
    try {
      const ctx = { report: r, answers: answers() };
      // T10 seam: a configured webhook injects onSubmit (dispatch); the
      // Mode-1 default persists the report to IndexedDB.
      const result = deps.onSubmit ? await deps.onSubmit(ctx) : await store?.saveReport(r);
      setPhase('submitted');
      setStatus(
        typeof result === 'string'
          ? 'Report saved locally.'
          : deps.onSubmit
            ? 'Report submitted.'
            : 'Report submitted (local save unavailable).',
      );
    } catch {
      setPhase('ready');
      setStatus('Submit failed — your report is still here, try again or download it.', true);
    }
  });

  /* ------------------------- lifecycle ------------------------- */

  const open = (): void => {
    try {
      el.style.display = '';
    } catch {}
    setStatus('');
    setPhase(report ? 'ready' : 'loading');
    renderPreview();
  };

  const close = (): void => {
    try {
      el.style.display = 'none';
    } catch {}
    clearTimeout(compileTimer);
  };

  const onReport = guard((detail: unknown): void => {
    // Replies arrive whole — the report rides `detail.report`.
    const r = (detail as { report?: unknown })?.report;
    if (!r || typeof r !== 'object') return;
    report = r as BugReelReport;
    if (phase === 'loading') setPhase('ready');
    if ((el.style as { display?: string }).display !== 'none') renderPreview();
  });

  const onBugpack = guard((detail: unknown): void => {
    const d = detail as { requestId?: string; bugpack?: Uint8Array | ArrayLike<number> };
    if (!pendingPack || d?.requestId !== pendingPack) return;
    pendingPack = undefined;
    clearTimeout(packTimer);
    try {
      const bytes =
        d?.bugpack instanceof Uint8Array ? d.bugpack : new Uint8Array(d?.bugpack ?? []);
      const name = bugpackName(report?.meta?.capturedAt ?? now());
      download(name, bytes);
      setStatus(`Downloaded ${name}`);
    } catch {
      setStatus('Download failed.', true);
    }
  });

  const onWorkerError = guard((detail: unknown): void => {
    const d = detail as { requestId?: unknown; message?: unknown };
    // Only an error for OUR pack cancels the pending download — an unrelated
    // failed compile must not drop an in-flight pack reply.
    if (pendingPack && (d?.requestId === undefined || d.requestId === pendingPack)) {
      pendingPack = undefined;
      clearTimeout(packTimer);
    }
    setStatus(
      `Report pipeline error${typeof d?.message === 'string' ? `: ${d.message}` : ''}`,
      true,
    );
  });

  const onKeydown = guard((e: { key?: string }): void => {
    if (e?.key === 'Escape' && (el.style as { display?: string }).display !== 'none') close();
  });

  /* ------------------------- wiring ------------------------- */

  on(doc, 'bugreel:open', () => open());
  on(doc, 'bugreel:report', (e: { detail?: unknown }) => onReport(e?.detail));
  on(doc, 'bugreel:bugpack', (e: { detail?: unknown }) => onBugpack(e?.detail));
  on(doc, 'bugreel:error', (e: { detail?: unknown }) => onWorkerError(e?.detail));
  on(win, 'keydown', onKeydown as AnyFn);
  on(q('backdrop') as EventTargetLike | undefined, 'click', () => close());
  on(q('close') as EventTargetLike | undefined, 'click', () => close());
  on(tryingEl as EventTargetLike | undefined, 'input', () => {
    gate();
    renderPreview();
    scheduleCompile();
  });
  on(wrongEl as EventTargetLike | undefined, 'input', () => {
    gate();
    renderPreview();
    scheduleCompile();
  });
  on(q('copy-md') as EventTargetLike | undefined, 'click', () => copyAction('markdown'));
  on(q('copy-prompt') as EventTargetLike | undefined, 'click', () => copyAction('prompt'));
  on(q('download') as EventTargetLike | undefined, 'click', downloadAction);
  on(q('submit') as EventTargetLike | undefined, 'click', submitAction);

  try {
    (doc.body ?? (doc.documentElement as { appendChild?(e: unknown): unknown } | undefined))
      ?.appendChild?.(el);
  } catch {
    return undefined;
  }

  // Mount = open intent: show immediately, then ask the worker for a fresh
  // report ourselves so a report dispatched before the chunk finished loading
  // can never leave the modal stuck on the spinner.
  open();
  sendWorker({ type: 'bugreel:compile' });

  let destroyed = false;
  const handle: ModalHandle = {
    el,
    open,
    close,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(compileTimer);
      clearTimeout(packTimer);
      clearTimeout(statusTimer);
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch {}
      }
      try {
        (el as { remove?: () => void }).remove?.();
      } catch {}
      if (live === handle) live = undefined;
    },
  };
  return handle;
};

let live: ModalHandle | undefined;

/**
 * Chunk entry — the lazy-capture chunk calls this on the first `bugreel:open`
 * (CDN: after injecting sibling `modal.global.js`; npm: via the dynamic-import
 * seam in `initBugReel`). One modal per page: a second call re-opens the live
 * instance.
 */
export function installModal(deps: ModalDeps = {}): ModalHandle | undefined {
  try {
    if (live && live.el.isConnected !== false) {
      live.open();
      return live;
    }
    // A detached-but-live handle still holds listeners/timers — destroy it
    // before replacing so a remount can't leak the old wiring.
    if (live) {
      try {
        live.destroy();
      } catch {}
      live = undefined;
    }
    const handle = mountModal(deps);
    if (handle) live = handle;
    return handle;
  } catch {
    return undefined;
  }
}
