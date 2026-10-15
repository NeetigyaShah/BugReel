import { gateValue, isBlocked } from './firewall/stage1';
import { guard, uuid } from './util';
import type { BugReelEventId, EventTargetRef, NetworkEvent, RawBugReelEvent } from './types';

/** Post-click liveness window — no effect within ~400ms means a Dead Click. */
export const CLICK_WATCH_MS = 400;
/** Post-error-response window for user-visible error UI (Silent Failure). */
export const ERROR_UI_WATCH_MS = 2_000;
type AnyFn = (...args: any[]) => any;

interface EventTargetLike {
  addEventListener(type: string, listener: AnyFn, options?: unknown): void;
  removeEventListener(type: string, listener: AnyFn, options?: unknown): void;
}

export interface SensorDocument {
  documentElement?: unknown;
  head?: { appendChild?: (el: unknown) => unknown };
  body?: { appendChild?: (el: unknown) => unknown };
  activeElement?: unknown;
  currentScript?: { src?: string; dataset?: Record<string, string | undefined> } | null;
  dispatchEvent?: (event: unknown) => unknown;
  createElement?: (tag: string) => {
    addEventListener?: (t: string, f: AnyFn) => void;
    src?: string;
    async?: boolean;
    onload?: (() => void) | null;
  };
  defaultView?: { customElements?: unknown; HTMLElement?: unknown };
}

/** The minimal slice of `window` the sensor touches — injected for tests. */
export interface SensorWindow extends EventTargetLike {
  document?: SensorDocument | null;
  location?: { href?: string; hostname?: string; search?: string };
  history?: Record<string, unknown>;
  fetch?: AnyFn;
  XMLHttpRequest?: unknown;
  console?: Record<string, AnyFn>;
  MutationObserver?: new (cb: (mutations: MutationRecordLike[]) => void) => {
    observe(root: unknown, options: unknown): void;
    disconnect(): void;
  };
  DeviceMotionEvent?: { requestPermission?: () => Promise<unknown> };
  navigator?: { userAgent?: string };
  onmessage?: ((e: { data: unknown }) => void) | null;
  innerWidth?: number;
  innerHeight?: number;
}

interface MutationRecordLike {
  type?: string;
  addedNodes?: ArrayLike<unknown>;
}

export interface SensorOptions {
  emit(event: RawBugReelEvent): void;
  annotate(eventId: BugReelEventId, patch: Record<string, unknown>): void;
  window?: SensorWindow;
  /** privacyMode:'strict' — record input lengths instead of literal values. */
  strict?: boolean;
  /** Seams — injectable in tests; default to the stage-1 gate and a bare-selector target. */
  blocked?(el: Element): boolean;
  describeTarget?(el: Element): EventTargetRef;
  scrubInputValue?(value: string, strict?: boolean): string | undefined;
  now?(): number;
  randomId?(): string;
}

/** What the lazy `capture` chunk needs from the core to emit coherently. */
export interface SensorBridge {
  /**
   * Send an event through the core pipeline — satisfies open click watches
   * and arms the ~2s error-UI watch on network events with status >=400.
   */
  send(event: RawBugReelEvent): void;
  /** Swap in the rich target describer once the lazy capture chunk has loaded. */
  setDescribeTarget(describe: (el: Element) => EventTargetRef): void;
}

/** Loader-chunk target: just enough for detectors until `enrich.ts` arrives. */
const bareTarget = (el: Element): EventTargetRef => {
  const tag = String(el.tagName).toLowerCase();
  return { selector: el.id ? `${tag}#${el.id}` : tag };
};

export interface SensorHandle {
  destroy(): void;
  /** Hand-off seam for `installCapture` (lazily loaded; see app.ts). */
  readonly bridge: SensorBridge;
}

/**
 * The Sensor core: the always-on listeners that must exist at t=0 — click,
 * input, route — plus the observation-window machinery and the shared emit
 * pipeline. The heavier capture paths (fetch/XHR/console/error/shake) live in
 * the lazy `capture` chunk and call back through `bridge`.
 */
export function createSensor(options: SensorOptions): SensorHandle {
  const win =
    options.window ??
    (typeof window !== 'undefined' ? (window as unknown as SensorWindow) : undefined);
  const now = options.now ?? (() => Date.now());
  const randomId = options.randomId ?? uuid;
  const blocked = options.blocked ?? isBlocked;
  let describe = options.describeTarget ?? bareTarget;
  const scrub = options.scrubInputValue ?? gateValue;
  const doc = win?.document;

  const cleanups: Array<() => void> = [];

  /** addEventListener + auto-remove on destroy; swallows host rejections. */
  const on = (
    target: EventTargetLike | undefined,
    type: string,
    fn: AnyFn,
    opts?: unknown,
  ): void => {
    try {
      target?.addEventListener(type, fn, opts);
      cleanups.push(() => target?.removeEventListener(type, fn, opts));
    } catch {}
  };

  /** Wrap a host method (history.pushState); restore on destroy. */
  const patch = (
    obj: Record<string, any> | undefined | null,
    key: string,
    wrap: (orig: AnyFn) => AnyFn,
  ): void => {
    const orig = obj?.[key];
    if (!obj || typeof orig !== 'function') return;
    try {
      obj[key] = wrap(orig);
      cleanups.push(() => {
        obj[key] = orig;
      });
    } catch {}
  };

  const emit = guard(options.emit);
  const annotate = guard(options.annotate);
  /** Shared event envelope: `{ id, at }`. */
  const ev = () => ({ id: randomId(), at: now() });

  // ------------------------------------------------------------------
  // Observation windows — post-hoc verdicts leave as bugreel:annotate.
  // `domMutatedAfterClick` accepts any DOM mutation or following
  // network/route/console/error event as proof of life (Dead Click);
  // `errorUiRendered` waits for a DOM *insertion* only (Silent Failure).
  // ------------------------------------------------------------------
  const watches = new Map<
    BugReelEventId,
    { errorUi: boolean; timer: ReturnType<typeof setTimeout> }
  >();
  let observer:
    | { observe(root: unknown, options: unknown): void; disconnect(): void }
    | undefined;

  const closeWatch = (id: BugReelEventId, rendered: boolean): void => {
    const watch = watches.get(id);
    if (!watch) return;
    watches.delete(id);
    clearTimeout(watch.timer);
    annotate(id, watch.errorUi ? { errorUiRendered: rendered } : { domMutatedAfterClick: rendered });
  };

  const watch = (id: BugReelEventId, errorUi: boolean, ms: number): void => {
    watches.set(id, { errorUi, timer: setTimeout(() => closeWatch(id, false), ms) });
    if (observer || !doc || typeof win?.MutationObserver !== 'function') return;
    try {
      // Created once, kept for the session — watching the empty map costs ~0.
      observer = new win.MutationObserver((mutations: MutationRecordLike[]) => {
        watches.forEach((w, watchId) => {
          const hit = w.errorUi
            ? mutations.some(
                (m) =>
                  m?.type === 'characterData' ||
                  (m?.type === 'childList' && !!m.addedNodes?.length),
              )
            : !!mutations.length;
          if (hit) closeWatch(watchId, true);
        });
      });
      observer.observe(doc.documentElement ?? doc, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    } catch {
      observer = undefined;
    }
  };

  /** Central emit — every event passes through so liveness watches see it. */
  const send = (event: RawBugReelEvent): void => {
    // A network/route/console/error event following a click counts as the
    // click producing an effect (Dead Click definition, GLOSSARY).
    if (event.type !== 'click' && event.type !== 'input') {
      watches.forEach((w, id) => {
        if (!w.errorUi) closeWatch(id, true);
      });
      // A >=400 response — or a request that never got one (CORS / network
      // failure, no status) — starts the ~2s error-UI insertion watch.
      const { status, corsBlocked } = event as NetworkEvent;
      if ((typeof status === 'number' && status >= 400) || corsBlocked) {
        watch(event.id, true, ERROR_UI_WATCH_MS);
      }
    }
    emit(event);
  };

  const asElement = (t: unknown): Element | undefined =>
    t && typeof t === 'object' && typeof (t as { tagName?: unknown }).tagName === 'string'
      ? (t as Element)
      : undefined;

  // ------------------------------------------------------------------
  // Click — emit immediately, then arm the ~400ms liveness watch.
  // ------------------------------------------------------------------
  const onClick = guard((e: { target?: unknown; clientX?: number; clientY?: number }): void => {
    const el = asElement(e?.target);
    if (!el || blocked(el)) return; // stage 1: a blocked element produces no event at all
    const event: RawBugReelEvent = {
      ...ev(),
      type: 'click',
      target: describe(el),
      x: e.clientX,
      y: e.clientY,
    };
    send(event);
    watch(event.id, false, CLICK_WATCH_MS);
  });

  // ------------------------------------------------------------------
  // Input — `change` gives the committed value, once per control (keystroke
  // spam compressed away by the browser). Value passes stage 1 first.
  // ------------------------------------------------------------------
  const onChange = guard((e: { target?: unknown }): void => {
    const el = asElement(e?.target);
    if (!el || blocked(el)) return;
    const raw = (el as HTMLInputElement).value;
    const value = scrub(typeof raw === 'string' ? raw : String(el.textContent ?? ''), options.strict);
    if (value === undefined) return;
    send({ ...ev(), type: 'input', target: describe(el), value });
  });

  // ------------------------------------------------------------------
  // Route — popstate + patched history methods.
  // ------------------------------------------------------------------
  let href = String(win?.location?.href ?? '');
  const onRoute = guard((): void => {
    const to = String(win?.location?.href ?? '');
    if (!to || to === href) return;
    send({ ...ev(), type: 'route', from: href, to });
    href = to;
  });
  for (const method of ['pushState', 'replaceState']) {
    patch(win?.history, method, (orig) =>
      function (this: unknown, ...args: unknown[]) {
        const result = orig.apply(this, args);
        onRoute();
        return result;
      } as AnyFn,
    );
  }

  // ------------------------------------------------------------------
  // Attach + teardown
  // ------------------------------------------------------------------
  if (win) {
    const passive = { capture: true, passive: true };
    on(win, 'click', onClick, passive);
    on(win, 'change', onChange, passive);
    on(win, 'popstate', onRoute);
  }

  let destroyed = false;
  return {
    bridge: {
      send,
      setDescribeTarget(next) {
        describe = next;
      },
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const w of watches.values()) clearTimeout(w.timer);
      watches.clear();
      try {
        observer?.disconnect();
      } catch {}
      observer = undefined;
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch {}
      }
    },
  };
}
