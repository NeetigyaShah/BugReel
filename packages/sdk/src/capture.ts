import { guard, truncate, uuid } from './util';
import type { SensorWindow } from './sensor';
import type { NetworkEvent, RawBugReelEvent } from './types';

const BODY_LIMIT = 4_096;
const SHAKE_THRESHOLD = 25; // m/s² — a firm shake on accelerationIncludingGravity
const SHAKE_COOLDOWN_MS = 1_000;

type AnyFn = (...args: any[]) => any;

interface EventTargetLike {
  addEventListener(type: string, listener: AnyFn, options?: unknown): void;
  removeEventListener(type: string, listener: AnyFn, options?: unknown): void;
}

export interface CaptureDeps {
  window?: SensorWindow;
  /**
   * Emit a captured event through the core pipeline — satisfies click
   * liveness watches and arms the ~2s error-UI watch on >=400 responses.
   */
  send(event: RawBugReelEvent | NetworkEvent): void;
  /** Opt-in shake trigger (ADR-0007); fires onShake. */
  shake?: boolean;
  onShake?(): void;
  now?(): number;
  randomId?(): string;
}

export interface CaptureHandle {
  destroy(): void;
}

/** Headers/HeadersInit/array → plain record, via the platform normalizer. */
const headersToRecord = (h: unknown): Record<string, string> | undefined => {
  try {
    if (h == null || typeof Headers !== 'function') return;
    const entries = [...new Headers(h as HeadersInit)];
    return entries.length ? Object.fromEntries(entries) : undefined;
  } catch {
    return undefined;
  }
};

/** XHR's getAllResponseHeaders() CRLF block → plain record. */
const parseHeaderLines = (raw: string | undefined): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
};

/**
 * Best-effort body capture — clone() first so the host's body is never
 * consumed (Request/Response/Blob). Always async so callers share one path.
 */
const bodyOf = async (body: unknown): Promise<string | undefined> => {
  try {
    if (typeof body === 'string') return truncate(body, BODY_LIMIT);
    if (!body || typeof body !== 'object') return;
    const b = body as { clone?: AnyFn; text?: AnyFn };
    const target = typeof b.clone === 'function' ? b.clone() : body;
    if (typeof (target as { text?: AnyFn }).text === 'function') {
      return truncate(String(await (target as { text: AnyFn }).text()), BODY_LIMIT);
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) return '[FormData]';
    if (
      (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) ||
      (typeof ArrayBuffer !== 'undefined' &&
        (body instanceof ArrayBuffer || ArrayBuffer.isView(body)))
    )
      return '[binary]';
    return truncate(JSON.stringify(body) ?? String(body), BODY_LIMIT);
  } catch {
    return undefined;
  }
};

const serialize = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

/**
 * The heavy half of the Sensor, loaded lazily (chunk 2 territory): fetch/XHR
 * wrappers, console.error/warn, window.onerror, unhandledrejection, and the
 * opt-in shake trigger. On the CDN path this installs ~50–100ms after the
 * listener core — a documented trade-off to keep the loader under budget.
 * Every entry point is guarded — never throws into the host.
 */
export function installCapture(deps: CaptureDeps): CaptureHandle {
  const win =
    deps.window ??
    (typeof window !== 'undefined' ? (window as unknown as SensorWindow) : undefined);
  const now = deps.now ?? (() => Date.now());
  const randomId = deps.randomId ?? uuid;
  const send = guard(deps.send);
  const ev = () => ({ id: randomId(), at: now() });

  const cleanups: Array<() => void> = [];

  const on = (
    target: EventTargetLike | undefined,
    type: string,
    fn: AnyFn,
    opts?: unknown,
  ): void => {
    if (!target) return;
    try {
      target.addEventListener(type, fn, opts);
      cleanups.push(() => {
        try {
          target.removeEventListener(type, fn, opts);
        } catch {}
      });
    } catch {}
  };

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
        try {
          obj[key] = orig;
        } catch {}
      });
    } catch {}
  };

  // ------------------------------------------------------------------
  // fetch
  // ------------------------------------------------------------------
  const origFetch = win?.fetch;
  if (win && typeof origFetch === 'function') {
    const wrappedFetch = function (this: unknown, input: any, init?: any) {
      const t0 = now();
      const finish = guard(async (res?: any, err?: unknown): Promise<void> => {
        const status = typeof res?.status === 'number' ? res.status : undefined;
        const [requestBody, responseBody] = await Promise.all([
          bodyOf(
            init?.body !== undefined ? init.body : typeof input === 'object' ? input : undefined,
          ),
          bodyOf(res?.clone?.()),
        ]);
        send({
          ...ev(),
          at: now(),
          type: 'fetch',
          method: String(init?.method ?? input?.method ?? 'GET').toUpperCase(),
          url: typeof input === 'string' ? input : String(input?.url ?? input?.href ?? input),
          status,
          ok: res ? !!res.ok : false,
          durationMs: now() - t0,
          corsBlocked: !res && err instanceof TypeError ? true : undefined,
          requestHeaders: headersToRecord(init?.headers ?? input?.headers),
          responseHeaders: headersToRecord(res?.headers),
          requestBody,
          responseBody,
        });
      });
      try {
        return Promise.resolve(origFetch.call(this ?? win, input, init)).then(
          (res) => (finish(res), res),
          (err) => (finish(undefined, err), Promise.reject(err)),
        );
      } catch (err) {
        finish(undefined, err);
        throw err;
      }
    };
    try {
      win.fetch = wrappedFetch;
      cleanups.push(() => {
        try {
          win.fetch = origFetch;
        } catch {}
      });
    } catch {}
  }

  // ------------------------------------------------------------------
  // XMLHttpRequest — open/setRequestHeader record metadata; send arms a
  // loadend listener that emits the completed request.
  // ------------------------------------------------------------------
  const xhrProto = (
    win?.XMLHttpRequest as { prototype?: Record<string, AnyFn> } | undefined
  )?.prototype;
  if (xhrProto) {
    const xhrMeta = new WeakMap<
      object,
      { m: string; u: string; h: Record<string, string>; t: number }
    >();
    patch(xhrProto, 'open', (orig) =>
      function (this: object, ...args: unknown[]) {
        try {
          xhrMeta.set(this, {
            m: String(args[0] ?? 'GET').toUpperCase(),
            u: String(args[1] ?? ''),
            h: {},
            t: 0,
          });
        } catch {}
        return orig.apply(this, args);
      } as AnyFn,
    );
    patch(xhrProto, 'setRequestHeader', (orig) =>
      function (this: object, ...args: unknown[]) {
        try {
          const rec = xhrMeta.get(this);
          if (rec && args.length > 1) rec.h[String(args[0])] = String(args[1]);
        } catch {}
        return orig.apply(this, args);
      } as AnyFn,
    );
    patch(xhrProto, 'send', (orig) =>
      function (this: object, ...args: unknown[]) {
        const rec = xhrMeta.get(this);
        if (rec) {
          rec.t = now();
          const xhr = this as {
            addEventListener?: AnyFn;
            status?: unknown;
            responseType?: unknown;
            responseText?: unknown;
            response?: unknown;
            getAllResponseHeaders?: () => string;
          };
          const done = guard((): void => {
            const status = typeof xhr.status === 'number' ? xhr.status : undefined;
            const raw =
              (!xhr.responseType || xhr.responseType === 'text') &&
              typeof xhr.responseText === 'string'
                ? xhr.responseText
                : xhr.response;
            const body = args[0];
            send({
              ...ev(),
              type: 'xhr',
              method: rec.m,
              url: rec.u,
              status,
              ok: status === undefined ? undefined : status > 0 && status < 400,
              durationMs: rec.t ? now() - rec.t : undefined,
              requestHeaders: Object.keys(rec.h).length ? rec.h : undefined,
              requestBody:
                typeof body === 'string'
                  ? truncate(body, BODY_LIMIT)
                  : typeof FormData !== 'undefined' && body instanceof FormData
                    ? '[FormData]'
                    : undefined,
              responseHeaders: parseHeaderLines(xhr.getAllResponseHeaders?.()),
              responseBody: typeof raw === 'string' ? truncate(raw, BODY_LIMIT) : undefined,
            });
          });
          try {
            xhr.addEventListener?.('loadend', done, { once: true });
          } catch {}
        }
        return orig.apply(this, args);
      } as AnyFn,
    );
  }

  // ------------------------------------------------------------------
  // console.error / console.warn
  // ------------------------------------------------------------------
  for (const level of ['error', 'warn'] as const) {
    patch(win?.console, level, (orig) =>
      function (this: unknown, ...args: unknown[]) {
        try {
          const stacked = args.find(
            (a) => a && typeof (a as { stack?: unknown }).stack === 'string',
          ) as { stack: string } | undefined;
          send({
            ...ev(),
            type: 'console',
            level,
            message: truncate(args.slice(0, 8).map(serialize).join(' '), BODY_LIMIT),
            stack: stacked?.stack,
          });
        } catch {}
        return orig.apply(this, args);
      } as AnyFn,
    );
  }

  // ------------------------------------------------------------------
  // window.onerror + unhandledrejection
  // ------------------------------------------------------------------
  on(
    win,
    'error',
    guard(
      (e: {
        target?: unknown;
        message?: unknown;
        filename?: unknown;
        lineno?: unknown;
        colno?: unknown;
        error?: { message?: unknown; stack?: unknown } | null;
      }): void => {
        // Resource-load failures (<img>, <script>) reach window in capture —
        // they are not JS crashes, skip them.
        if (e?.target != null && e.target !== win && e?.message === undefined) return;
        send({
          ...ev(),
          type: 'error',
          source: 'window.onerror',
          message: String(e?.message ?? e?.error?.message ?? 'Script error'),
          filename: typeof e?.filename === 'string' ? e.filename : undefined,
          lineno: typeof e?.lineno === 'number' ? e.lineno : undefined,
          colno: typeof e?.colno === 'number' ? e.colno : undefined,
          stack: typeof e?.error?.stack === 'string' ? e.error.stack : undefined,
        });
      },
    ),
    true,
  );
  on(
    win,
    'unhandledrejection',
    guard((e: { reason?: unknown }): void => {
      const reason = e?.reason as { message?: unknown; stack?: unknown } | undefined;
      send({
        ...ev(),
        type: 'error',
        source: 'unhandledrejection',
        message: typeof reason?.message === 'string' ? reason.message : serialize(reason),
        stack: typeof reason?.stack === 'string' ? reason.stack : undefined,
      });
    }),
  );

  // ------------------------------------------------------------------
  // Shake — opt-in; iOS 13+ permission deferred to the first user gesture.
  // ------------------------------------------------------------------
  let lastShakeAt = 0;
  const onMotion = guard(
    (e: {
      accelerationIncludingGravity?: { x?: number; y?: number; z?: number } | null;
      acceleration?: { x?: number; y?: number; z?: number } | null;
    }): void => {
      const a = e?.accelerationIncludingGravity ?? e?.acceleration;
      const t = now();
      if (
        a &&
        Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0) > SHAKE_THRESHOLD &&
        t - lastShakeAt > SHAKE_COOLDOWN_MS
      ) {
        lastShakeAt = t;
        deps.onShake?.();
      }
    },
  );
  const attachMotion = (): void => on(win, 'devicemotion', onMotion, { passive: true });

  if (win && deps.shake && deps.onShake) {
    const requestPermission = win.DeviceMotionEvent?.requestPermission;
    if (typeof requestPermission === 'function') {
      // iOS requires a direct user gesture — hook the first natural tap.
      const ask = guard((): void => {
        void Promise.resolve(requestPermission.call(win.DeviceMotionEvent))
          .then((state) => {
            if (state === 'granted') attachMotion();
          })
          .catch(() => {});
      });
      on(win, 'pointerdown', ask, { once: true });
      on(win, 'touchstart', ask, { once: true });
    } else {
      attachMotion();
    }
  }

  let destroyed = false;
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch {}
      }
    },
  };
}
