import { PORT_KEY, type MainThreadPort } from './port';
import { scheduleIdle } from './util';
import type { FromWorkerMessage, ToWorkerMessage } from './types';

const DEFAULT_QUEUE_LIMIT = 500;
/** A constructed worker that never reports ready (async CSP kill, script error) is abandoned. */
const READY_TIMEOUT_MS = 4_000;

/** The slice of Worker the transport needs — a real Worker or a local stand-in. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  terminate?(): void;
}

export interface RuntimeHandle {
  handleMessage(message: ToWorkerMessage): FromWorkerMessage[];
}

export interface TransportDeps {
  /** Explicit worker script URL — wins over every other resolution path. */
  workerUrl?: string;
  /**
   * Direct worker factory — the npm entry injects
   * `() => new Worker(new URL('worker.global.js', import.meta.url))`.
   */
  makeWorker?(): WorkerLike;
  /** URL whose text becomes the worker (CDN: sibling of loader.global.js). */
  resolveWorkerUrl?(): string | undefined;
  fetchText?(url: string): Promise<string>;
  /** Low-level constructor — defaults to `u => new Worker(u)`. */
  startWorker?(url: string | URL): WorkerLike;
  /**
   * Strict-CSP last resort — a local main-thread worker. Entries inject it:
   * the npm entry hands over `idleWorker(createWorkerRuntime(...))`; the CDN
   * app wiring defaults it to `scriptTagWorker` (the fetched worker URL as a
   * same-origin `<script>`). Missing → the queue just caps out.
   */
  fallback?(): WorkerLike;
  /** requestIdleCallback seam — defaults to rIC, else setTimeout(0). */
  scheduleIdle?(cb: () => void): void;
  onMessage?(message: FromWorkerMessage): void;
  queueLimit?: number;
  /** Default true — bootstrap begins on the next idle slice. */
  autoStart?: boolean;
}

export interface Transport {
  send(message: ToWorkerMessage): void;
  /** Idempotent — begins the async worker bootstrap. */
  start(): void;
  readonly ready: boolean;
  destroy(): void;
}

const defaultStartWorker = (url: string | URL): WorkerLike =>
  new Worker(url) as unknown as WorkerLike;

/**
 * Runs `worker.global.js` on the main thread as a plain `<script>` — the
 * strict-CSP fallback. Classic scripts ride the same `script-src` rule that
 * loaded the SDK itself, so this survives CSPs that block `blob:` workers.
 * The script publishes a private port on `globalThis` (see `port.ts`); the
 * host page's `window.onmessage` and message listeners are never touched.
 */
export const scriptTagWorker = (
  win: { document?: InjectableDocument | null },
  url: string | undefined,
  idle: (cb: () => void) => void = scheduleIdle,
): WorkerLike => {
  const portOf = (): MainThreadPort | undefined =>
    (win as unknown as Record<string, MainThreadPort | undefined>)[PORT_KEY];
  const worker: WorkerLike = {
    onmessage: null,
    // Inbound work is sliced into idle callbacks so capture never blocks.
    postMessage(m) {
      idle(() => {
        try {
          portOf()?.receive(m);
        } catch {}
      });
    },
    terminate() {
      const port = portOf();
      if (port) port.reply = null;
    },
  };
  const bind = (): void => {
    try {
      const port = portOf();
      if (!port) return;
      port.reply = (data) => worker.onmessage?.({ data });
      worker.onmessage?.({ data: { type: 'bugreel:worker-ready' } });
    } catch {}
  };
  try {
    // A published port means the worker script is live — adopting it avoids a
    // second <script> that would overwrite the shared port and drop replies.
    if (portOf()) bind();
    else injectScript(win.document, url, bind);
  } catch {}
  return worker;
};

/** A document we can attach a sibling `<script>` to. */
interface InjectableDocument {
  createElement?: (tag: string) => {
    src?: string;
    async?: boolean;
    onload?: (() => void) | null;
    onerror?: (() => void) | null;
  };
  head?: { appendChild?(el: unknown): unknown };
  body?: { appendChild?(el: unknown): unknown };
  documentElement?: { appendChild?(el: unknown): unknown } | unknown;
}

/** Append a classic sibling `<script src>` — CSP-safe wherever ours loaded. */
export const injectScript = (
  doc: InjectableDocument | null | undefined,
  url: string | undefined,
  onload?: () => void,
  onerror?: () => void,
): void => {
  const script = doc?.createElement?.('script');
  const parent = (doc?.head ?? doc?.body ?? doc?.documentElement) as
    | { appendChild?(el: unknown): unknown }
    | undefined;
  if (!script || !url || !parent?.appendChild) return;
  script.src = url;
  script.async = true;
  script.onload = onload ?? null;
  script.onerror = onerror ?? null;
  parent.appendChild(script);
};

/**
 * Main-thread → worker transport. Events buffer into a bounded preWorkerQueue
 * until the worker posts `bugreel:worker-ready`, then drain in order.
 * Bootstrap chain: `workerUrl`/factory Worker → fetched source as a Blob-URL
 * worker → injected local fallback (main-thread runtime or `<script>` shim).
 * Every failure degrades quietly — never throws into the host.
 */
export function createTransport(deps: TransportDeps = {}): Transport {
  const limit = deps.queueLimit ?? DEFAULT_QUEUE_LIMIT;
  const idle = deps.scheduleIdle ?? scheduleIdle;
  const onMessage = deps.onMessage ?? (() => {});
  const startWorker = deps.startWorker ?? defaultStartWorker;
  const queue: ToWorkerMessage[] = [];
  let worker: WorkerLike | undefined;
  let ready = false;
  let started = false;
  let dead = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  const post = (m: ToWorkerMessage): void => {
    try {
      worker?.postMessage(m);
    } catch {
      /* a broken worker drops the message, never the host */
    }
  };

  const deliver = (message: FromWorkerMessage | undefined): void => {
    if (!message) return;
    if (message.type === 'bugreel:worker-ready') {
      ready = true;
      clearTimeout(watchdog);
      for (const m of queue.splice(0)) post(m);
      return;
    }
    onMessage(message); // attach()'s onmessage wrapper guards the whole delivery
  };

  const attach = (w: WorkerLike): void => {
    worker = w;
    w.onmessage = (e) => {
      try {
        deliver(e?.data as FromWorkerMessage);
      } catch {}
    };
  };

  /** Last resort — the injected local worker, else a never-ready stub. */
  const lastResort = (): WorkerLike => {
    try {
      const w = deps.fallback?.();
      if (w) return w;
    } catch {}
    return { onmessage: null, postMessage() {}, terminate() {} };
  };

  /**
   * Attach a real Worker and arm the watchdog: construction can succeed while
   * the script is still killed asynchronously (CSP) or throws on load, in
   * which case `worker-ready` never arrives and capture would silently stop.
   */
  const attachWatched = (w: WorkerLike): void => {
    attach(w);
    watchdog = setTimeout(() => {
      if (ready || dead) return;
      try {
        w.terminate?.();
      } catch {}
      attach(lastResort());
    }, READY_TIMEOUT_MS);
  };

  const bootstrap = async (): Promise<void> => {
    try {
      if (deps.workerUrl) {
        attachWatched(startWorker(deps.workerUrl));
        return;
      }
      if (deps.makeWorker) {
        attachWatched(deps.makeWorker());
        return;
      }
    } catch {
      /* construction blocked (CSP) — fall through to the source path */
    }
    try {
      const url = deps.workerUrl ?? deps.resolveWorkerUrl?.();
      if (url && deps.fetchText) {
        const source = await deps.fetchText(url);
        if (typeof source === 'string' && source) {
          attachWatched(
            startWorker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))),
          );
          return;
        }
      }
    } catch {}
    attach(lastResort());
  };

  const transport: Transport = {
    get ready() {
      return ready;
    },
    send(m) {
      if (dead || !m) return;
      if (ready && worker) post(m);
      else if (queue.push(m) > limit) queue.shift();
    },
    start() {
      if (started || dead) return;
      started = true;
      void bootstrap().catch(() => {
        try {
          attach(lastResort());
        } catch {
          /* fully inert — the queue still bounds memory */
        }
      });
    },
    destroy() {
      dead = true;
      clearTimeout(watchdog);
      queue.length = 0;
      try {
        worker?.terminate?.();
      } catch {}
      worker = undefined;
    },
  };

  if (deps.autoStart !== false) idle(() => transport.start());
  return transport;
}
