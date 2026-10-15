/**
 * `<bugreel-player>` — the Timeline Player for .bugpack archives (ADR-0003).
 * A self-contained custom element: Shadow DOM, inline styles, zero runtime
 * dependencies. Loads a bugpack from a URL (`src` attribute / property), raw
 * bytes (`bugpack` property / `loadBytes`), or a `File`/`Blob` (`loadBlob`).
 *
 * Layout: visual-evidence pane (snapshot + pulsing coordinate beacon, media
 * tabs, video), a color-coded ~60s timeline scrubber, and a story + inspector
 * pane (plain-English steps, DOM target metadata, synchronized network and
 * console state). One-click copy buttons for the compiled outputs.
 *
 * Never throws: malformed archives, missing entries, and fetch failures all
 * render an error pane inside the element.
 */

import type {
  BugReelReport,
  DiagnosticFinding,
  EventTargetRef,
  NetworkEvent,
  RawBugReelEvent,
  StoryStep,
} from '@bugreel/sdk';
import { readStoreZip } from './zip';

// --- pure helpers -----------------------------------------------------------

/** Escape untrusted report strings (labels, messages, URLs) for innerHTML. */
const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const decoder = new TextDecoder();

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  webm: 'video/webm',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
};

const mimeOf = (name: string): string =>
  MIME[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
const isImage = (name: string): boolean => mimeOf(name).startsWith('image/');
const isVideo = (name: string): boolean => mimeOf(name).startsWith('video/');

/** Timeline lanes — event types fold onto the StoryStep kind vocabulary. */
type NodeKind = 'click' | 'input' | 'route' | 'network' | 'console' | 'error' | 'finding';

const KIND_OF: Record<RawBugReelEvent['type'], NodeKind> = {
  click: 'click',
  input: 'input',
  route: 'route',
  fetch: 'network',
  xhr: 'network',
  console: 'console',
  error: 'error',
};

// Report fields are page-controlled data — a hostile .bugpack could carry a
// crafted kind/severity into a class attribute. Whitelist both before they
// touch innerHTML; anything unknown renders as a neutral kind.
const KNOWN_KINDS = new Set<NodeKind>([
  'click',
  'input',
  'route',
  'network',
  'console',
  'error',
  'finding',
]);
const KNOWN_SEVERITIES = new Set(['info', 'warning', 'critical']);
const clsKind = (kind: unknown): NodeKind =>
  KNOWN_KINDS.has(kind as NodeKind) ? (kind as NodeKind) : 'console';
const clsSev = (severity: unknown): string =>
  typeof severity === 'string' && KNOWN_SEVERITIES.has(severity) ? ` sev-${severity}` : '';

const KIND_LABEL: Record<NodeKind, string> = {
  click: 'Click',
  input: 'Input',
  route: 'Route',
  network: 'Network',
  console: 'Console',
  error: 'Error',
  finding: 'Finding',
};

interface TimelineNode {
  at: number;
  kind: NodeKind;
  event?: RawBugReelEvent;
  finding?: DiagnosticFinding;
  /** Short title for the scrubber dot tooltip. */
  label: string;
}

/** Plain-English fallback when no StoryStep references an event. */
const describeEvent = (event: RawBugReelEvent): string => {
  const target = 'target' in event ? event.target.label || event.target.selector : undefined;
  switch (event.type) {
    case 'click':
      return `Clicked '${target ?? 'element'}'`;
    case 'input':
      return `Typed into '${target ?? 'field'}'`;
    case 'route':
      return `Navigated to ${event.to}`;
    case 'fetch':
    case 'xhr':
      return `${event.method} ${event.url} → ${event.status ?? 'no response'}`;
    case 'console':
      return `console.${event.level}: ${event.message}`;
    case 'error':
      return `Error: ${event.message}`;
    default:
      return 'Event';
  }
};

/** `+12.3s` — timestamp rendered relative to the window start. */
const relTime = (at: number, start: number): string => `+${((at - start) / 1000).toFixed(1)}s`;

const clampPct = (value: number): number => Math.min(100, Math.max(0, value));

const COPY_BUTTONS: Array<{ key: keyof BugReelReport['outputs']; label: string }> = [
  { key: 'cursorPrompt', label: 'Copy Cursor prompt' },
  { key: 'curl', label: 'Copy cURL' },
  { key: 'playwright', label: 'Copy Playwright' },
  { key: 'markdown', label: 'Copy report.md' },
];

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** FileReader fallback for environments where `blob.arrayBuffer()` is missing. */
const readBlob = (blob: Blob): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsArrayBuffer(blob);
  });

const CSS = `
  :host { display: block; }
  * { box-sizing: border-box; }
  .br-root { font: 13px/1.45 system-ui, sans-serif; background: #0f1115; color: #e8e8ea;
    height: 100%; min-height: 420px; display: flex; flex-direction: column; }
  .br-empty, .br-error, .br-loading { margin: auto; padding: 48px; text-align: center;
    color: #9aa4b2; border: 2px dashed #333a45; border-radius: 12px; max-width: 460px; }
  .br-error { border-color: #7a2e2e; color: #ff9d9d; }
  .br-error strong { display: block; margin-bottom: 8px; color: #ff6b6b; }
  .br-player { display: grid; height: 100%; min-height: 420px; flex: 1;
    grid-template-columns: minmax(0, 1fr) 360px; grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas: "head head" "evidence side" "timeline timeline"; }
  .br-head { grid-area: head; padding: 10px 16px; border-bottom: 1px solid #232833;
    display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  .br-title { font-weight: 600; font-size: 14px; }
  .br-meta { color: #9aa4b2; font-size: 12px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; max-width: 46ch; }
  .br-answers { flex-basis: 100%; color: #c8cdd5; font-size: 12px; }
  .br-answers em { color: #9aa4b2; font-style: normal; }
  .br-copies { margin-left: auto; display: flex; gap: 8px; }
  button { font: inherit; }
  .br-copy { background: #1c2230; color: #cfe0ff; border: 1px solid #33405a;
    border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
  .br-copy:hover { background: #24304a; }
  .br-copy[data-state="ok"] { border-color: #3f7a4e; color: #9fe8b2; }
  .br-copy[data-state="fail"] { border-color: #7a2e2e; color: #ff9d9d; }
  .br-evidence { grid-area: evidence; display: flex; flex-direction: column;
    border-right: 1px solid #232833; min-width: 0; }
  .br-tabs { display: flex; gap: 4px; padding: 6px 10px; border-bottom: 1px solid #232833;
    overflow-x: auto; }
  .br-tab { background: none; border: 1px solid transparent; color: #9aa4b2;
    border-radius: 6px; padding: 3px 10px; cursor: pointer; font-size: 12px; white-space: nowrap; }
  .br-tab:hover { color: #e8e8ea; }
  .br-tab.sel { border-color: #33405a; color: #e8e8ea; background: #1c2230; }
  .br-stage { position: relative; flex: 1; display: grid; place-items: center;
    overflow: auto; min-height: 200px; }
  .br-shot { position: relative; display: inline-block; line-height: 0;
    max-width: 100%; max-height: 100%; }
  .br-stage img, .br-stage video { max-width: 100%; max-height: 100%; object-fit: contain; }
  .br-stage .br-file { color: #9aa4b2; text-align: center; padding: 24px; }
  .br-stage .br-file a { color: #6ea8ff; }
  .br-nomedia { color: #667080; text-align: center; padding: 40px; }
  .br-beacon { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px;
    border-radius: 50%; background: rgba(255, 93, 93, .95); pointer-events: none;
    box-shadow: 0 0 0 0 rgba(255, 93, 93, .55); animation: br-pulse 1.4s ease-out infinite; }
  @keyframes br-pulse { 70% { box-shadow: 0 0 0 16px rgba(255, 93, 93, 0); }
    100% { box-shadow: 0 0 0 0 rgba(255, 93, 93, 0); } }
  .br-side { grid-area: side; display: grid; grid-template-rows: minmax(0, 1fr) auto;
    min-height: 0; }
  .br-story { overflow-y: auto; padding: 8px 0; min-height: 120px; }
  .br-story ol { margin: 0; padding: 0; list-style: none; }
  .br-step { padding: 5px 14px 5px 12px; border-left: 3px solid transparent;
    cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
  .br-step:hover { background: #161a22; }
  .br-step.sel { background: #1c2230; border-left-color: #6ea8ff; }
  .br-step .br-t { color: #667080; font-size: 11px; flex: none; width: 48px; }
  .br-step.sev-critical .br-step-text { color: #ff9d9d; }
  .br-step.sev-warning .br-step-text { color: #ffd24d; }
  .br-step.k-finding { font-weight: 600; }
  .br-inspector { border-top: 1px solid #232833; padding: 12px 14px; max-height: 46%;
    overflow-y: auto; background: #12151c; }
  .br-insp-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .br-badge { font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 10px;
    background: #1c2230; border: 1px solid #33405a; }
  .br-insp-time { color: #667080; font-size: 11px; }
  .br-insp-moment { margin: 0 0 8px; font-size: 13px; }
  .br-insp-finding { border: 1px solid #7a5f2e; background: #221c10; border-radius: 8px;
    padding: 8px 10px; margin: 0 0 8px; }
  .br-insp-finding.sev-critical { border-color: #7a2e2e; background: #221010; }
  .br-insp-finding strong { display: block; margin-bottom: 2px; }
  .br-insp-finding p { margin: 0; color: #c8cdd5; font-size: 12px; }
  .br-insp dl { margin: 0 0 8px; display: grid; grid-template-columns: 92px 1fr;
    gap: 2px 8px; font-size: 12px; }
  .br-insp dt { color: #667080; }
  .br-insp dd { margin: 0; color: #c8cdd5; word-break: break-all; font-family: ui-monospace, monospace; }
  .br-insp h4 { margin: 8px 0 4px; font-size: 11px; text-transform: uppercase;
    letter-spacing: .06em; color: #667080; }
  .br-insp ul { margin: 0; padding: 0; list-style: none; font-size: 12px; color: #c8cdd5; }
  .br-insp li { padding: 1px 0; word-break: break-all; }
  .br-insp .bad { color: #ff9d9d; }
  .br-insp .quiet { color: #667080; }
  .br-timeline { grid-area: timeline; border-top: 1px solid #232833; padding: 10px 16px 14px; }
  .br-track-labels { display: flex; justify-content: space-between; color: #667080;
    font-size: 11px; margin-bottom: 4px; }
  .br-track { position: relative; height: 26px; background: #161a22; border-radius: 13px;
    border: 1px solid #232833; }
  .br-node { position: absolute; top: 50%; width: 12px; height: 12px; padding: 0;
    transform: translate(-50%, -50%); border-radius: 50%; border: 2px solid #0f1115;
    cursor: pointer; }
  .br-node.k-finding { border-radius: 3px; transform: translate(-50%, -50%) rotate(45deg); }
  .br-node.sel { outline: 2px solid #e8e8ea; z-index: 2; }
  .br-node.sev-critical { box-shadow: 0 0 0 2px rgba(255, 93, 93, .5); }
  .br-node.k-click { background: #4da3ff; } .br-node.k-input { background: #8be28b; }
  .br-node.k-route { background: #b48cff; } .br-node.k-network { background: #ffb84d; }
  .br-node.k-console { background: #8b95a5; } .br-node.k-error { background: #ff5d5d; }
  .br-node.k-finding { background: #ffd24d; }
  .br-badge.k-click { color: #4da3ff; } .br-badge.k-input { color: #8be28b; }
  .br-badge.k-route { color: #b48cff; } .br-badge.k-network { color: #ffb84d; }
  .br-badge.k-console { color: #8b95a5; } .br-badge.k-error { color: #ff5d5d; }
  .br-badge.k-finding { color: #ffd24d; }
  .br-step.k-finding .br-step-text { color: #ffd24d; }
`;

/** The element's small public surface — see module docstring for usage. */
export class BugReelPlayer extends HTMLElement {
  static observedAttributes = ['src'];

  /**
   * Injectable fetch — tests and embedders may replace it. Signature returns
   * the raw bytes; anything thrown lands in the error pane.
   */
  fetchBytes: (url: string) => Promise<ArrayBuffer> = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.arrayBuffer();
  };

  /** Injectable clipboard — defaults to `navigator.clipboard` when present. */
  clipboard: { writeText(text: string): Promise<void> } | undefined;

  #report: BugReelReport | null = null;
  #media = new Map<string, Uint8Array>();
  #objectUrls: string[] = [];
  /** media name → object URL: one per entry, no accumulation on tab switches */
  #urlCache = new Map<string, string>();
  #nodes: TimelineNode[] = [];
  #steps: StoryStep[] = [];
  #start = 0;
  #end = 1;
  #lastError: string | null = null;
  #dropBound = false;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.#renderEmpty();
  }

  connectedCallback(): void {
    if (!this.#dropBound) {
      this.#dropBound = true;
      this.addEventListener('dragover', this.#onDragOver);
      this.addEventListener('drop', this.#onDrop);
    }
    // Reconnect after a disconnect revoked the object URLs — rebuild the stage.
    if (this.#report && this.shadowRoot?.querySelector('.br-player')) {
      this.#renderMediaTabs();
    }
  }

  disconnectedCallback(): void {
    this.#dropBound = false;
    this.removeEventListener('dragover', this.#onDragOver);
    this.removeEventListener('drop', this.#onDrop);
    this.#revokeUrls();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === 'src' && newValue && newValue !== oldValue) {
      void this.loadFromUrl(newValue);
    }
  }

  /** The URL to fetch a .bugpack from (attribute-reflected). */
  get src(): string | null {
    return this.getAttribute('src');
  }
  set src(url: string | null) {
    if (url === null) this.removeAttribute('src');
    else this.setAttribute('src', url);
  }

  /** Assign raw .bugpack bytes — ArrayBuffer or Uint8Array; null resets. */
  set bugpack(bytes: ArrayBuffer | Uint8Array | null | undefined) {
    if (bytes == null) {
      this.#report = null;
      this.#media.clear();
      this.#revokeUrls();
      this.#renderEmpty();
      return;
    }
    this.loadBytes(bytes);
  }

  /** The parsed report, or null when nothing (valid) is loaded. */
  get report(): BugReelReport | null {
    return this.#report;
  }

  /** Last load error message, or null. */
  get error(): string | null {
    return this.#lastError;
  }

  /** Fetch + load a .bugpack from a URL. Never throws. */
  async loadFromUrl(url: string): Promise<void> {
    this.#renderLoading(url);
    try {
      this.loadBytes(await this.fetchBytes(url));
    } catch (err) {
      this.#renderError(`Couldn't load '${url}' — ${message(err)}`);
    }
  }

  /** Load from a File/Blob (drop + file-input path; FileReader fallback). */
  async loadBlob(blob: Blob): Promise<void> {
    try {
      const buffer =
        typeof blob.arrayBuffer === 'function'
          ? await blob.arrayBuffer()
          : await readBlob(blob);
      this.loadBytes(buffer);
    } catch (err) {
      this.#renderError(`Couldn't read file — ${message(err)}`);
    }
  }

  /**
   * Parse bytes as a .bugpack and render. Never throws — bad input renders
   * the error pane and returns with `report === null`.
   */
  loadBytes(bytes: ArrayBuffer | Uint8Array): void {
    try {
      const entries = readStoreZip(bytes);
      const byName = new Map(entries.map((e) => [e.name, e.data]));
      const jsonBytes = byName.get('report.json');
      if (!jsonBytes) throw new Error("no report.json — this doesn't look like a .bugpack");
      const report = JSON.parse(decoder.decode(jsonBytes)) as BugReelReport;
      if (!report || typeof report !== 'object' || !report.meta || !Array.isArray(report.events)) {
        throw new Error('report.json is not a BugReel report');
      }
      this.#report = report;
      this.#lastError = null;
      this.#media = new Map(
        entries.filter((e) => e.name.startsWith('media/')).map((e) => [e.name, e.data]),
      );
      this.#prepareTimeline();
      this.#renderReport();
      this.dispatchEvent(new CustomEvent('bugreel:loaded'));
    } catch (err) {
      this.#report = null;
      this.#renderError(message(err));
    }
  }

  // --- internals --------------------------------------------------------------

  #onDragOver = (e: Event): void => e.preventDefault();

  #onDrop = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation(); // a page-level drop handler (player.html) must not double-load
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) void this.loadBlob(file);
  };

  #revokeUrls(): void {
    for (const url of this.#objectUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* revoked already */
      }
    }
    this.#objectUrls = [];
    this.#urlCache.clear(); // revoked URLs must never be handed out again
  }

  /** Window = trailing ~60s frame ending at capture time (or the last event). */
  #prepareTimeline(): void {
    const report = this.#report;
    if (!report) return;
    const ats = [
      ...report.events.map((e) => e.at),
      ...(report.findings ?? []).map((f) => f.timestamp),
    ].filter(Number.isFinite);
    // A fully-degenerate report (no finite timestamps at all) still needs a
    // stable window — never fall back to wall-clock, or the same file renders
    // differently each load.
    this.#end = Math.max(report.meta.capturedAt || 0, ...ats) || 60_000;
    this.#start = Math.min(...ats, this.#end - 60_000);
    if (this.#end - this.#start < 1) this.#end = this.#start + 1;

    const stepText = new Map<string, string>();
    for (const s of report.storySteps ?? []) {
      if (s.eventId) stepText.set(s.eventId, s.text);
    }
    this.#steps = (report.storySteps?.length
      ? [...report.storySteps]
      : // Foreign reports without storySteps still list findings on the
        // timeline — the scrubber already plots them as diamonds.
        [
          ...report.events.map((e) => ({
            at: e.at,
            eventId: e.id,
            kind: KIND_OF[e.type],
            text: describeEvent(e),
          })),
          ...(report.findings ?? []).map((f) => ({
            at: f.timestamp,
            eventId: f.relatedEventIds?.[0],
            kind: 'finding' as const,
            text: f.headline,
            severity: f.severity,
          })),
        ]
    ).sort((a, b) => a.at - b.at);

    this.#nodes = [
      ...report.events.map((event) => ({
        at: event.at,
        kind: KIND_OF[event.type],
        event,
        label: stepText.get(event.id) ?? describeEvent(event),
      })),
      ...(report.findings ?? []).map((finding) => ({
        at: finding.timestamp,
        kind: 'finding' as NodeKind,
        finding,
        label: finding.headline,
      })),
    ].sort((a, b) => a.at - b.at);
  }

  #shell(html: string): void {
    const root = this.shadowRoot;
    if (!root) return;
    this.#revokeUrls();
    root.innerHTML = `<style>${CSS}</style><div class="br-root">${html}</div>`;
  }

  #renderEmpty(): void {
    this.#shell(
      `<div class="br-empty" part="empty">Drop a <code>.bugpack</code> here, or load one via
      the <code>src</code> attribute / <code>bugpack</code> property.</div>`,
    );
  }

  #renderLoading(url: string): void {
    this.#shell(`<div class="br-loading">Loading ${esc(url)}…</div>`);
  }

  #renderError(detail: string): void {
    this.#lastError = detail;
    this.#shell(
      `<div class="br-error" part="error"><strong>Couldn't open this bugpack</strong>${esc(
        detail,
      )}</div>`,
    );
    this.dispatchEvent(new CustomEvent('bugreel:player-error', { detail }));
  }

  #renderReport(): void {
    const report = this.#report;
    if (!report) return;
    const meta = report.meta;
    const answers = report.reporterAnswers ?? {};
    const outputs = report.outputs ?? { markdown: '' };

    this.#shell(`
      <div class="br-player">
        <header class="br-head">
          <span class="br-title">BugReel report</span>
          <span class="br-meta" title="${esc(meta.url)}">${esc(meta.url)} · ${esc(
            new Date(meta.capturedAt).toLocaleString(),
          )} · sdk ${esc(meta.sdkVersion)}${meta.app ? ` · ${esc(meta.app)}` : ''}</span>
          ${
            answers.tryingToDo || answers.wentWrong
              ? `<span class="br-answers"><em>Reporter:</em> ${esc(
                  answers.tryingToDo ?? '',
                )}${answers.wentWrong ? ` — <em>went wrong:</em> ${esc(answers.wentWrong)}` : ''}</span>`
              : ''
          }
          <span class="br-copies">${COPY_BUTTONS.filter(({ key }) => outputs[key])
            .map(
              ({ key, label }) =>
                `<button class="br-copy" data-copy="${key}">${esc(label)}</button>`,
            )
            .join('')}</span>
        </header>
        <section class="br-evidence">
          <div class="br-tabs"></div>
          <div class="br-stage"><div class="br-beacon" hidden></div></div>
        </section>
        <aside class="br-side">
          <div class="br-story"><ol>${
            this.#steps
              .map(
                (s, i) =>
                  `<li class="br-step k-${clsKind(s.kind)}${clsSev(s.severity)}"
                    data-i="${i}" title="${esc(new Date(s.at).toLocaleTimeString())}">
                    <span class="br-t">${esc(relTime(s.at, this.#start))}</span>
                    <span class="br-step-text">${esc(s.text)}</span></li>`,
              )
              .join('') || '<li class="br-step"><span class="br-step-text">No story steps.</span></li>'
          }</ol></div>
          <div class="br-inspector br-insp"><p class="br-insp-moment quiet">Select a moment on the timeline or story.</p></div>
        </aside>
        <footer class="br-timeline">
          <div class="br-track-labels"><span>-${((this.#end - this.#start) / 1000).toFixed(
            0,
          )}s</span><span>capture · ${esc(
            new Date(meta.capturedAt).toLocaleTimeString(),
          )}</span></div>
          <div class="br-track">${this.#nodes
            .map(
              (n, i) =>
                `<button class="br-node k-${clsKind(n.kind)}${
                  n.finding ? clsSev(n.finding.severity) : ''
                }" data-i="${i}" style="left:${clampPct(
                  ((n.at - this.#start) / (this.#end - this.#start)) * 100,
                )}%" title="${esc(`${relTime(n.at, this.#start)} · ${KIND_LABEL[n.kind]} — ${n.label}`)}"></button>`,
            )
            .join('')}</div>
        </footer>
      </div>`);

    const root = this.shadowRoot;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('.br-node').forEach((el) =>
      el.addEventListener('click', () => this.#selectNode(Number(el.dataset['i']))),
    );
    root.querySelectorAll<HTMLElement>('.br-step[data-i]').forEach((el) =>
      el.addEventListener('click', () => this.#selectStep(Number(el.dataset['i']))),
    );
    root.querySelectorAll<HTMLElement>('.br-copy').forEach((el) =>
      el.addEventListener('click', () => void this.#copy(el.dataset['copy'] ?? '', el)),
    );
    this.#renderMediaTabs();
    // Land on the most interesting moment: first finding, else the last event.
    const firstFinding = this.#nodes.findIndex((n) => n.kind === 'finding');
    if (firstFinding >= 0) this.#selectNode(firstFinding);
    else if (this.#nodes.length) this.#selectNode(this.#nodes.length - 1);
  }

  // --- evidence pane ---------------------------------------------------------

  #mediaNames(): string[] {
    const names = [...this.#media.keys()];
    const first = 'media/snapshot-annotated.png';
    return names.sort((a, b) => (a === first ? -1 : b === first ? 1 : a.localeCompare(b)));
  }

  #renderMediaTabs(): void {
    const tabs = this.shadowRoot?.querySelector('.br-tabs');
    if (!tabs) return;
    const names = this.#mediaNames();
    if (!names.length) {
      tabs.remove();
      const stage = this.shadowRoot?.querySelector('.br-stage');
      if (stage) stage.innerHTML = `<div class="br-nomedia">No visual evidence in this bugpack.</div><div class="br-beacon" hidden></div>`;
      return;
    }
    tabs.innerHTML = names
      .map(
        (n, i) =>
          `<button class="br-tab${i === 0 ? ' sel' : ''}" data-media="${esc(n)}">${esc(
            n.replace(/^media\//, ''),
          )}</button>`,
      )
      .join('');
    tabs.querySelectorAll<HTMLElement>('.br-tab').forEach((el) =>
      el.addEventListener('click', () => {
        tabs.querySelectorAll('.br-tab.sel').forEach((t) => t.classList.remove('sel'));
        el.classList.add('sel');
        this.#showMedia(el.dataset['media'] ?? '');
      }),
    );
    this.#showMedia(names[0] ?? '');
  }

  /** bytes → displayable URL: object URL preferred, data-URL fallback. */
  #mediaUrl(name: string, bytes: Uint8Array): string | null {
    const mime = mimeOf(name);
    const cached = this.#urlCache.get(name);
    if (cached) return cached;
    try {
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
      this.#objectUrls.push(url);
      this.#urlCache.set(name, url);
      return url;
    } catch {
      /* fall through to data URL */
    }
    try {
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return `data:${mime};base64,${btoa(bin)}`;
    } catch {
      return null;
    }
  }

  #showMedia(name: string): void {
    const stage = this.shadowRoot?.querySelector('.br-stage');
    const bytes = this.#media.get(name);
    if (!stage) return;
    const beacon = stage.querySelector('.br-beacon');
    const short = name.replace(/^media\//, '');
    if (!bytes) {
      stage.innerHTML = `<div class="br-file">Missing entry ${esc(name)}</div>`;
    } else if (isImage(name)) {
      const url = this.#mediaUrl(name, bytes);
      // .br-shot hugs the rendered image box so the beacon's % coords land on
      // the capture, not on letterboxed stage space.
      stage.innerHTML = url
        ? `<div class="br-shot"><img src="${url}" alt="${esc(short)}" /></div>`
        : `<div class="br-file">${esc(short)} (${bytes.length} bytes — preview unavailable)</div>`;
    } else if (isVideo(name)) {
      const url = this.#mediaUrl(name, bytes);
      stage.innerHTML = url
        ? `<video src="${url}" controls></video>`
        : `<div class="br-file">${esc(short)} (${bytes.length} bytes — playback unavailable)</div>`;
    } else {
      const url = this.#mediaUrl(name, bytes);
      stage.innerHTML = `<div class="br-file"><strong>${esc(short)}</strong><br/>${
        bytes.length
      } bytes${url ? ` · <a href="${url}" download="${esc(short)}">download</a>` : ''}</div>`;
    }
    if (beacon) (stage.querySelector('.br-shot') ?? stage).appendChild(beacon);
  }

  // --- selection: node ⇄ step ⇄ inspector ⇄ beacon ----------------------------

  /** Best story-step index for a node: same event, else nearest timestamp. */
  #stepIndexFor(node: TimelineNode): number {
    if (node.event) {
      const i = this.#steps.findIndex((s) => s.eventId === node.event?.id);
      if (i >= 0) return i;
    }
    if (node.finding?.relatedEventIds?.length) {
      const i = this.#steps.findIndex((s) => s.eventId === node.finding?.relatedEventIds[0]);
      if (i >= 0) return i;
    }
    let best = -1;
    let dist = Infinity;
    this.#steps.forEach((s, i) => {
      const d = Math.abs(s.at - node.at);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    return dist <= 750 ? best : -1;
  }

  #selectNode(i: number): void {
    const node = this.#nodes[i];
    const root = this.shadowRoot;
    if (!node || !root) return;
    root.querySelectorAll('.br-node.sel').forEach((el) => el.classList.remove('sel'));
    root.querySelector(`.br-node[data-i="${i}"]`)?.classList.add('sel');
    const stepIndex = this.#stepIndexFor(node);
    root.querySelectorAll('.br-step.sel').forEach((el) => el.classList.remove('sel'));
    const stepEl = stepIndex >= 0 ? root.querySelector(`.br-step[data-i="${stepIndex}"]`) : null;
    if (stepEl) {
      stepEl.classList.add('sel');
      try {
        stepEl.scrollIntoView({ block: 'nearest' });
      } catch {
        /* scrollIntoView unsupported — cosmetic only */
      }
    }
    this.#renderInspector(node, stepIndex >= 0 ? this.#steps[stepIndex] : undefined);
    this.#placeBeacon(node);
  }

  #selectStep(i: number): void {
    const step = this.#steps[i];
    if (!step) return;
    let nodeIndex = step.eventId
      ? this.#nodes.findIndex((n) => n.event?.id === step.eventId)
      : -1;
    if (nodeIndex < 0) {
      nodeIndex = this.#nodes.findIndex(
        (n) => n.kind === step.kind && Math.abs(n.at - step.at) <= 1,
      );
    }
    if (nodeIndex >= 0) {
      this.#selectNode(nodeIndex);
      return;
    }
    // No matching node (foreign kind, synthetic step): select the step itself
    // and show what we can — the moment text + surrounding state still help.
    const root = this.shadowRoot;
    if (!root) return;
    root.querySelectorAll('.br-node.sel, .br-step.sel').forEach((el) => el.classList.remove('sel'));
    root.querySelector(`.br-step[data-i="${i}"]`)?.classList.add('sel');
    this.#renderInspector(
      { at: step.at, kind: step.kind as NodeKind, label: step.text },
      step,
    );
    this.#placeBeacon({ at: step.at, kind: step.kind as NodeKind, label: step.text });
  }

  #placeBeacon(node: TimelineNode): void {
    const beacon = this.shadowRoot?.querySelector<HTMLElement>('.br-beacon');
    if (!beacon) return;
    // The beacon is only meaningful over the snapshot image — a video or
    // file card has no coordinate space for it.
    if (!this.shadowRoot?.querySelector('.br-shot')) {
      beacon.hidden = true;
      return;
    }
    const event = node.event;
    const viewport = this.#report?.meta?.viewport;
    let x: number | undefined;
    let y: number | undefined;
    if (event?.type === 'click') {
      x = event.x;
      y = event.y;
    }
    const rect: EventTargetRef['rect'] =
      event && 'target' in event ? event.target?.rect : undefined;
    if ((x == null || y == null) && rect) {
      x = rect.x + rect.width / 2;
      y = rect.y + rect.height / 2;
    }
    if (x == null || y == null || !viewport?.width || !viewport?.height) {
      beacon.hidden = true;
      return;
    }
    const left = (x / viewport.width) * 100;
    const top = (y / viewport.height) * 100;
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      beacon.hidden = true;
      return;
    }
    beacon.style.left = `${clampPct(left)}%`;
    beacon.style.top = `${clampPct(top)}%`;
    beacon.hidden = false;
  }

  // --- inspector --------------------------------------------------------------

  #targetRows(target?: EventTargetRef): string {
    if (!target) return '';
    const rows: Array<[string, unknown]> = [
      ['selector', target.selector],
      ['label', target.label],
      ['tag', target.tagName],
      ['role', target.role],
      ['name', target.name],
      ['heading', target.headingContext],
      [
        'rect',
        target.rect &&
          `${Math.round(target.rect.x)},${Math.round(target.rect.y)} ${Math.round(
            target.rect.width,
          )}×${Math.round(target.rect.height)}`,
      ],
    ];
    const html = rows
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`)
      .join('');
    return html ? `<h4>DOM target</h4><dl>${html}</dl>` : '';
  }

  /** Console errors + network failures within ±2s of the selected moment. */
  #contextHtml(at: number, ignoreId?: string): string {
    const report = this.#report;
    if (!report) return '';
    const near = <T extends { at: number; id?: string }>(list: T[] | undefined): T[] =>
      (Array.isArray(list) ? list : []).filter(
        (e) => e.id !== ignoreId && Math.abs(e.at - at) <= 2000,
      );
    // Mirrors the worker's isFailedRequest() — keep predicates in lockstep:
    // CORS/transport blocks, status 0, missing status, or any 4xx/5xx.
    const net = near(report.network).filter(
      (e: NetworkEvent) =>
        e.corsBlocked === true ||
        e.ok === false ||
        e.status === undefined ||
        e.status === 0 ||
        e.status >= 400,
    );
    const con = near(report.console).filter((e) => e.level === 'error' || e.level === 'warn');
    let html = '';
    if (net.length) {
      html += `<h4>Network around this moment</h4><ul>${net
        .map(
          (e) =>
            `<li class="bad">${esc(e.method)} ${esc(e.url)} → ${esc(
              e.corsBlocked
                ? 'blocked (CORS/network)'
                : e.status === undefined
                  ? 'no response'
                  : String(e.status),
            )}</li>`,
        )
        .join('')}</ul>`;
    }
    if (con.length) {
      html += `<h4>Console around this moment</h4><ul>${con
        .map((e) => `<li class="${e.level === 'error' ? 'bad' : ''}">${esc(e.level)}: ${esc(e.message)}</li>`)
        .join('')}</ul>`;
    }
    return html;
  }

  #renderInspector(node: TimelineNode, step?: StoryStep): void {
    const insp = this.shadowRoot?.querySelector('.br-inspector');
    const report = this.#report;
    if (!insp || !report) return;
    const event = node.event;
    const finding =
      node.finding ??
      (event
        ? (Array.isArray(report.findings) ? report.findings : []).find(
            (f) => Array.isArray(f.relatedEventIds) && f.relatedEventIds.includes(event.id),
          )
        : undefined);
    const moment = step?.text ?? node.label;
    insp.innerHTML = `
      <div class="br-insp-head">
        <span class="br-badge k-${clsKind(node.kind)}">${esc(KIND_LABEL[clsKind(node.kind)])}</span>
        <span class="br-insp-time">${esc(relTime(node.at, this.#start))} · ${esc(
          new Date(node.at).toLocaleTimeString(),
        )}</span>
      </div>
      <p class="br-insp-moment">${esc(moment)}</p>
      ${
        finding
          ? `<div class="br-insp-finding${clsSev(finding.severity)}"><strong>${esc(
              finding.headline,
            )}</strong><p>${esc(finding.explanation)}</p></div>`
          : ''
      }
      ${this.#targetRows(event && 'target' in event ? event.target : undefined)}
      ${this.#contextHtml(node.at, event?.id) || '<p class="quiet">No network failures or console errors within ±2s.</p>'}`;
  }

  // --- copy buttons -----------------------------------------------------------

  async #copy(key: string, btn: HTMLElement): Promise<void> {
    const text = (this.#report?.outputs as Record<string, string | undefined> | undefined)?.[key];
    if (!text) return;
    const clip =
      this.clipboard ??
      (typeof navigator !== 'undefined' ? (navigator.clipboard as Clipboard | undefined) : undefined);
    const done = (state: string, label: string) => {
      btn.dataset['state'] = state;
      const original = btn.textContent ?? '';
      btn.textContent = label;
      setTimeout(() => {
        btn.dataset['state'] = '';
        btn.textContent = original;
      }, 1200);
    };
    if (!clip?.writeText) {
      done('fail', 'No clipboard');
      return;
    }
    try {
      await clip.writeText(text);
      done('ok', 'Copied ✓');
    } catch {
      done('fail', 'Copy failed');
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('bugreel-player')) {
  customElements.define('bugreel-player', BugReelPlayer);
}
