import { createSensor, type SensorWindow } from './sensor';
import type { CaptureDeps, CaptureHandle } from './capture';
import {
  createTransport,
  injectScript,
  scriptTagWorker,
  type Transport,
  type WorkerLike,
} from './transport';
import { hotkeyMatches, isEditableTarget, resolveHotkey, shouldShowPill, type HotkeyEventLike } from './triggers';
import { mountPill } from './pill';
import { scheduleIdle, uuid } from './util';

export const version = '0.1.0';

export interface BugReelConfig {
  webhookUrl?: string;
  /** Explicit worker script URL — overrides every worker resolution path. */
  workerUrl?: string;
  /** Trigger hotkey spec, e.g. 'ctrl+shift+b' (default) or 'alt+b'. */
  hotkey?: string;
  /** 'auto' shows the pill on localhost/dev surfaces only. */
  pill?: 'auto' | boolean;
  /** Opt-in shake trigger (ADR-0007). */
  shake?: boolean;
  privacyMode?: 'standard' | 'strict';
  user?: { id?: string; email?: string };
  project?: string;
  app?: string;
}

export interface BugReelHandle {
  open(): void;
  destroy(): void;
}

/** Environment seams — each entry point (npm/CDN) injects what it can resolve. */
export interface BugReelEnv {
  window?: SensorWindow;
  /**
   * Base URL for sibling artifacts — CDN passes `document.currentScript.src`,
   * npm passes `import.meta.url`; sibling files resolve against it.
   */
  scriptUrl?: string;
  makeWorker?(): WorkerLike;
  fetchText?(url: string): Promise<string>;
  startWorker?(url: string | URL): WorkerLike;
  /** Local main-thread worker for strict CSP (npm bundles the runtime). */
  fallback?(): WorkerLike;
  /**
   * Lazy capture installer — the npm entry injects the static module (sync,
   * no capture gap); the CDN default loads sibling `capture.global.js` as a
   * classic `<script>` (allowed by the same script-src that ran the loader).
   */
  installCapture?(deps: CaptureDeps): CaptureHandle | undefined;
  scheduleIdle?(cb: () => void): void;
  mountPill?(doc: SensorWindow['document'], onOpen: () => void): { remove(): void } | undefined;
}

export const noopHandle: BugReelHandle = {
  open() {},
  destroy() {},
};

let active: BugReelHandle | undefined;

/** `BugReel.open()` for custom entry points — safe to call before init. */
export function openActive(): void {
  try {
    active?.open();
  } catch {}
}

/**
 * Wires sensor → transport → worker and the three Triggers (hotkey, pill,
 * shake). Nothing here may throw into the host — every step is guarded and
 * failure degrades to a quieter SDK, never to a broken page.
 */
export function startBugReel(config: BugReelConfig = {}, env: BugReelEnv = {}): BugReelHandle {
  const win =
    env.window ??
    (typeof window !== 'undefined' ? (window as unknown as SensorWindow) : undefined);
  if (!win || typeof win.addEventListener !== 'function') return noopHandle;

  try {
    active?.destroy();
  } catch {}

  const doc = win.document;
  const idle = env.scheduleIdle ?? scheduleIdle;

  /** Resolve a sibling artifact (worker.global.js / capture.global.js). */
  const siblingUrl = (name: string): string | undefined => {
    try {
      const base = env.scriptUrl ?? doc?.currentScript?.src ?? win.location?.href;
      return base ? new URL(name, base).href : undefined;
    } catch {
      return undefined;
    }
  };

  // Bound before the capture chunk wraps window.fetch so bootstrap fetches
  // don't report themselves as app traffic.
  const nativeFetch = win.fetch;
  const fetchText =
    env.fetchText ??
    (typeof nativeFetch === 'function'
      ? (url: string) =>
          (nativeFetch.call(win, url) as Promise<{ text?: () => Promise<string> }>).then(
            (r) => r.text?.() as Promise<string>,
          )
      : undefined);

  const dispatch = (type: string, detail?: unknown): void => {
    try {
      doc?.dispatchEvent?.(new CustomEvent(type, { detail }));
    } catch {}
  };

  const sessionId = uuid();

  const open = (): void => {
    try {
      transport.send({
        type: 'bugreel:compile',
        requestId: uuid(),
        meta: {
          url: String(win.location?.href ?? ''),
          userAgent: String(win.navigator?.userAgent ?? ''),
          viewport: { width: win.innerWidth ?? 0, height: win.innerHeight ?? 0 },
          capturedAt: Date.now(),
          sdkVersion: version,
          sessionId,
          project: config.project,
          app: config.app,
          user: config.user,
        },
      });
    } catch {}
    dispatch('bugreel:open');
  };

  const transport: Transport = createTransport({
    workerUrl: config.workerUrl,
    makeWorker: env.makeWorker,
    fetchText,
    resolveWorkerUrl: () => siblingUrl('worker.global.js'),
    startWorker: env.startWorker,
    fallback:
      env.fallback ??
      (() => scriptTagWorker(win, config.workerUrl ?? siblingUrl('worker.global.js'), idle)),
    scheduleIdle: idle,
    // The report a trigger asked for is published for the modal (T08).
    onMessage: (message) => {
      if (message?.type === 'bugreel:report') dispatch('bugreel:report', message.report);
    },
  });

  const sensor = createSensor({
    window: win,
    emit: (event) => transport.send({ type: 'bugreel:event', event }),
    annotate: (eventId, patch) => transport.send({ type: 'bugreel:annotate', eventId, patch }),
    strict: config.privacyMode === 'strict',
  });

  // Heavy capture paths (fetch/XHR/console/error/shake) install lazily so the
  // loader chunk stays under its size budget — the npm entry hands over the
  // module synchronously; CDN injects sibling `capture.global.js` as a
  // classic <script>, allowed by the same script-src that ran the loader.
  let capture: CaptureHandle | undefined;
  try {
    const deps: CaptureDeps = {
      window: win,
      send: sensor.bridge.send,
      shake: !!config.shake,
      onShake: open,
    };
    if (env.installCapture) {
      capture = env.installCapture(deps);
    } else {
      injectScript(doc, siblingUrl('capture.global.js'), () => {
        try {
          capture = (
            globalThis as {
              BugReelCapture?: { installCapture?: (x: CaptureDeps) => CaptureHandle };
            }
          ).BugReelCapture?.installCapture?.(deps);
        } catch {}
      });
    }
  } catch {}

  // Hotkey trigger — the editable-focus guard keeps typing contexts untouched.
  const hotkey = resolveHotkey(config.hotkey);
  const onKeydown = (e: HotkeyEventLike): void => {
    try {
      if (!hotkeyMatches(e, hotkey) || isEditableTarget(doc?.activeElement)) return;
      e.preventDefault?.();
      open();
    } catch {}
  };
  try {
    win.addEventListener('keydown', onKeydown as (e: never) => void);
  } catch {}

  // Pill trigger — environment policy decides visibility (ADR-0007).
  let pillEl: { remove(): void } | undefined;
  try {
    if (
      doc &&
      shouldShowPill(config.pill, {
        hostname: win.location?.hostname,
        search: win.location?.search,
      })
    ) {
      pillEl = (env.mountPill ?? mountPill)(doc, open);
    }
  } catch {}

  const handle: BugReelHandle = {
    open,
    destroy() {
      try {
        sensor.destroy();
      } catch {}
      try {
        capture?.destroy();
      } catch {}
      try {
        transport.destroy();
      } catch {}
      try {
        win.removeEventListener('keydown', onKeydown as (e: never) => void);
      } catch {}
      try {
        pillEl?.remove();
      } catch {}
      if (active === handle) active = undefined;
    },
  };
  active = handle;
  return handle;
}
