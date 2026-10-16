/**
 * Screen Recorder (T09b): a capability-gated `getDisplayMedia` +
 * `MediaRecorder` wrapper producing a bounded `.webm` clip for the
 * `.bugpack` media/ slot. The browser asks permission — this module only
 * runs from a user gesture (the modal's Record button), never on open.
 *
 * Everything is guarded — denial, missing APIs, and recorder errors all
 * resolve `undefined` rather than throwing into the host.
 */

export const RECORD_MAX_MS = 15_000;
/**
 * Grace period after `recorder.stop()` for the queued `dataavailable`/`stop`
 * events — MediaRecorder flushes its buffer asynchronously (no synchronous
 * final chunk without a timeslice), so a bare microtask would resolve before
 * the data arrives. A bounded timer covers engines that never emit `onstop`.
 */
const STOP_GRACE_MS = 1_000;

/** Loose shapes so tests inject fakes — every member optional. */
export interface RecorderWindow {
  navigator?: {
    mediaDevices?: {
      getDisplayMedia?(constraints?: unknown): Promise<MediaStreamLike>;
    };
  };
  MediaRecorder?: unknown;
}

interface MediaStreamLike {
  getTracks(): Array<{ stop(): void }>;
}

interface RecorderLike {
  mimeType?: string;
  ondataavailable: ((e: { data?: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  start(): void;
  stop(): void;
}

export interface RecordingResult {
  bytes: Uint8Array;
  mimeType: string;
}

export interface RecordingHandle {
  /** Resolves with the clip bytes, or undefined on denial/failure/cancel. */
  done: Promise<RecordingResult | undefined>;
  /** Stop early (user clicked stop); also resolves `done`. Idempotent. */
  stop(): void;
  /** True while the recorder is running. */
  readonly active: boolean;
}

/**
 * True when the browser can screen-record: both `getDisplayMedia` and
 * `MediaRecorder` must exist (iOS Safari lacks the former → the modal shows
 * a file picker instead of a dead button).
 */
export const isScreenRecordingSupported = (win: RecorderWindow | undefined): boolean => {
  try {
    const mr = win?.MediaRecorder;
    if (typeof mr !== 'function') return false;
    if (typeof win?.navigator?.mediaDevices?.getDisplayMedia !== 'function') return false;
    const probe = (mr as { isTypeSupported?(t: string): boolean }).isTypeSupported;
    return typeof probe !== 'function' || probe.call(mr, 'video/webm') !== false;
  } catch {
    return false;
  }
};

/**
 * Start a bounded screen recording. Returns `undefined` immediately when the
 * APIs are absent; otherwise returns a handle whose `done` resolves with the
 * `.webm` bytes once recording stops (manual stop, max duration, track end,
 * or recorder error). Tracks are always stopped — even on error paths — so
 * the OS recording indicator can't linger.
 */
export const recordScreen = (
  win: RecorderWindow | undefined,
  opts: { maxMs?: number; setTimeout?: (fn: () => void, ms: number) => unknown; clearTimeout?(h: unknown): void } = {},
): RecordingHandle | undefined => {
  if (!isScreenRecordingSupported(win)) return undefined;

  const setT = opts.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT =
    opts.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let rec: RecorderLike | undefined;
  let tracks: Array<{ stop(): void }> = [];
  let timer: unknown;
  let stopTimer: unknown;
  let active = true;
  const chunks: Blob[] = [];
  let stopFn: () => void = () => {};

  const done = new Promise<RecordingResult | undefined>((resolve) => {
    const finish = (bytes?: Uint8Array, mimeType?: string): void => {
      if (!active) return;
      active = false;
      try {
        clearT(timer);
        clearT(stopTimer);
      } catch {}
      for (const t of tracks) {
        try {
          t.stop();
        } catch {}
      }
      resolve(bytes?.byteLength ? { bytes, mimeType: mimeType ?? 'video/webm' } : undefined);
    };
    stopFn = () => {
      // recorder.stop() queues dataavailable+stop as tasks — they resolve
      // `done` with real bytes. If the recorder throws or never emits them
      // (already-inactive, hostile impl), the bounded grace timer finishes
      // with whatever chunks arrived instead of wedging the promise.
      try {
        rec?.stop();
      } catch {}
      if (stopTimer === undefined) {
        stopTimer = setT(() => {
          void blobToBytes(chunks).then((bytes) => finish(bytes, rec?.mimeType));
        }, STOP_GRACE_MS);
      }
    };

    void (async () => {
      try {
        // A permission picker left open would pend `done` forever — bound it
        // like snapshot.ts's own display-capture timeout.
        const stream = await Promise.race<MediaStreamLike | undefined>([
          win!.navigator!.mediaDevices!.getDisplayMedia!({
            video: true,
            audio: false,
          }),
          new Promise<undefined>((res) => {
            setT(() => res(undefined), 30_000);
          }),
        ]);
        if (!stream) {
          finish();
          return;
        }
        if (!active) {
          // Denied→granted late after a cancel — stop the tracks we got and
          // resolve promptly rather than riding out the grace timer.
          for (const t of stream.getTracks()) {
            try {
              t.stop();
            } catch {}
          }
          resolve(undefined);
          return;
        }
        tracks = stream.getTracks();
        const MR = win!.MediaRecorder as new (s: unknown, o?: unknown) => RecorderLike;
        try {
          rec = new MR(stream, { mimeType: 'video/webm' });
        } catch {
          rec = new MR(stream);
        }
        rec.ondataavailable = (e) => {
          try {
            if (e?.data && e.data.size > 0) chunks.push(e.data);
          } catch {}
        };
        rec.onstop = () => {
          void blobToBytes(chunks).then((bytes) => finish(bytes, rec?.mimeType));
        };
        rec.onerror = () => finish();
        // The OS-side "stop sharing" control ends tracks without onstop.
        try {
          for (const t of tracks) {
            (t as { addEventListener?(t: string, f: () => void): void }).addEventListener?.(
              'ended',
              stopFn,
            );
          }
        } catch {}
        rec.start();
        timer = setT(stopFn, opts.maxMs ?? RECORD_MAX_MS);
      } catch {
        finish();
      }
    })();
  });

  return {
    done,
    stop: () => stopFn(),
    get active() {
      return active;
    },
  };
};

const blobToBytes = async (chunks: Blob[]): Promise<Uint8Array | undefined> => {
  try {
    if (!chunks.length) return undefined;
    const blob = new Blob(chunks);
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return undefined;
  }
};
