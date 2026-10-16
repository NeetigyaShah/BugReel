// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isScreenRecordingSupported,
  recordScreen,
  type RecorderWindow,
} from '../src/recorder';

interface FakeTrack {
  stop: () => void;
}
interface FakeStream {
  getTracks(): FakeTrack[];
}

const fakeStream = (stop?: () => void): FakeStream => ({
  getTracks: () => [{ stop: stop ?? vi.fn() }],
});

/** Minimal MediaRecorder fake — instances are collected for test control. */
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported(): boolean {
    return true;
  }
  mimeType = 'video/webm';
  ondataavailable: ((e: { data?: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  state = 'inactive';
  chunks: Blob[] = [];
  constructor(
    public stream: unknown,
    public opts?: unknown,
  ) {
    FakeRecorder.instances.push(this);
  }
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    this.onstop?.();
  }
  /** Test driver: feed a data chunk. */
  emitData(bytes: number[]): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) });
  }
}

const makeWin = (overrides: {
  getDisplayMedia?: unknown;
  MediaRecorder?: unknown;
} = {}): RecorderWindow =>
  ({
    navigator: {
      mediaDevices: {
        getDisplayMedia: overrides.getDisplayMedia ?? vi.fn(async () => fakeStream()),
      },
    },
    MediaRecorder:
      'MediaRecorder' in overrides ? overrides.MediaRecorder : (FakeRecorder as never),
  }) as unknown as RecorderWindow;

beforeEach(() => {
  FakeRecorder.instances = [];
});

describe('isScreenRecordingSupported', () => {
  it('is true only when getDisplayMedia AND MediaRecorder exist', () => {
    expect(isScreenRecordingSupported(makeWin())).toBe(true);
    expect(isScreenRecordingSupported({ navigator: {} } as never)).toBe(false);
    expect(
      isScreenRecordingSupported({
        navigator: { mediaDevices: { getDisplayMedia: vi.fn() } },
        MediaRecorder: undefined,
      } as never),
    ).toBe(false);
    expect(isScreenRecordingSupported({} as never)).toBe(false);
  });

  it('is false when MediaRecorder cannot encode webm', () => {
    FakeRecorder.isTypeSupported = () => false;
    expect(isScreenRecordingSupported(makeWin())).toBe(false);
    FakeRecorder.isTypeSupported = () => true;
  });
});

describe('recordScreen', () => {
  it('undefined when getDisplayMedia is denied or API absent', async () => {
    const denied = makeWin({ getDisplayMedia: vi.fn(async () => Promise.reject(new Error('no'))) });
    const h = recordScreen(denied);
    expect(h).toBeDefined();
    await expect(h!.done).resolves.toBeUndefined();

    const absent = recordScreen({} as never);
    expect(absent).toBeUndefined();
  });

  it('collects chunks, stops tracks, resolves webm bytes on stop()', async () => {
    let stopped = 0;
    const win = makeWin({
      getDisplayMedia: vi.fn(async () => fakeStream(() => stopped++)),
    });
    const h = recordScreen(win);
    expect(h).toBeDefined();
    // Wait for the getDisplayMedia promise + recorder.start().
    for (let i = 0; i < 10 && !FakeRecorder.instances.length; i++) await Promise.resolve();
    const rec = FakeRecorder.instances[0]!;
    rec.emitData([1, 2, 3]);
    h!.stop();
    const result = await h!.done;
    expect(result?.mimeType).toBe('video/webm');
    expect(result?.bytes.byteLength).toBeGreaterThan(0);
    expect(stopped).toBeGreaterThan(0);
    expect(h!.active).toBe(false);
  });

  it('auto-stops at the max duration and still returns bytes', async () => {
    vi.useFakeTimers();
    try {
      const win = makeWin();
      const h = recordScreen(win, { maxMs: 15_000 });
      await vi.runAllTicks();
      for (let i = 0; i < 10 && !FakeRecorder.instances.length; i++) await Promise.resolve();
      FakeRecorder.instances[0]!.emitData([9, 9]);
      vi.advanceTimersByTime(16_000);
      const result = await h!.done;
      expect(result?.bytes.byteLength).toBeGreaterThan(0);
      expect(h!.active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns bytes when dataavailable+stop arrive as queued tasks (spec order)', async () => {
    vi.useFakeTimers();
    try {
      // Spec-faithful: stop() queues the flush — events fire as TASKS, not
      // synchronously. A microtask fallback would resolve before they land.
      class AsyncRecorder extends FakeRecorder {
        stop(): void {
          setTimeout(() => {
            this.emitData([9, 9, 9]);
            this.state = 'inactive';
            this.onstop?.();
          }, 10);
        }
      }
      const win = makeWin({ MediaRecorder: AsyncRecorder });
      const h = recordScreen(win)!;
      for (let i = 0; i < 10 && !AsyncRecorder.instances.length; i++) await Promise.resolve();
      h.stop();
      vi.advanceTimersByTime(20); // tasks land well inside the grace window
      const result = await h.done;
      expect(result?.mimeType).toBe('video/webm');
      expect(result?.bytes.byteLength).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hostile recorder that never emits onstop still resolves via the grace timer', async () => {
    vi.useFakeTimers();
    try {
      class SilentRecorder extends FakeRecorder {
        stop(): void {
          this.state = 'inactive'; // no onstop, no final chunk
        }
      }
      const win = makeWin({ MediaRecorder: SilentRecorder });
      const h = recordScreen(win)!;
      for (let i = 0; i < 10 && !SilentRecorder.instances.length; i++) await Promise.resolve();
      SilentRecorder.instances[0]!.emitData([1, 1]); // streamed chunks exist
      h.stop();
      vi.advanceTimersByTime(5_000);
      const result = await h.done;
      expect(result?.bytes.byteLength).toBeGreaterThan(0);
      expect(h.active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the OS 'stop sharing' control (track 'ended') finishes the recording", async () => {
    vi.useFakeTimers();
    try {
      const track = { stop: vi.fn(), addEventListener: undefined as unknown };
      const listeners: Record<string, () => void> = {};
      track.addEventListener = ((t: string, f: () => void) => {
        listeners[t] = f;
      }) as never;
      const win = makeWin({
        getDisplayMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      });
      const h = recordScreen(win)!;
      for (let i = 0; i < 10 && !FakeRecorder.instances.length; i++) await Promise.resolve();
      FakeRecorder.instances[0]!.emitData([4, 4]);
      listeners['ended']!(); // user stopped from the OS UI
      vi.advanceTimersByTime(20); // sync-firing fake resolves via onstop
      const result = await h.done;
      expect(result?.bytes.byteLength).toBeGreaterThan(0);
      expect(track.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves undefined on recorder error', async () => {
    const win = makeWin();
    const h = recordScreen(win);
    for (let i = 0; i < 10 && !FakeRecorder.instances.length; i++) await Promise.resolve();
    FakeRecorder.instances[0]!.onerror?.(new Error('codec fail'));
    await expect(h!.done).resolves.toBeUndefined();
  });
});
