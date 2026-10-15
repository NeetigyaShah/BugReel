/**
 * Small shared helpers for the loader chunk. Everything here must be safe
 * in any environment (no unguarded globals) since it ships in chunk 1.
 */

/** RFC4122 v4 id via crypto when available, with a non-crypto fallback for insecure contexts. */
export const uuid = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    return 'br-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
};

/** Hard-truncate a string, marking the cut. */
export const truncate = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;

/** requestIdleCallback with a setTimeout fallback for older browsers/tests. */
export const scheduleIdle = (cb: () => void): void => {
  const ric = (
    globalThis as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
    }
  ).requestIdleCallback;
  if (typeof ric === 'function') {
    // Without a timeout bound, a saturated main thread can defer transport
    // work (queue drain, worker bootstrap) for seconds.
    ric.call(globalThis, cb, { timeout: 250 });
    return;
  }
  setTimeout(cb, 0);
};

/** Wrap a callback so SDK failures never propagate into the host app. */
export const guard = <A extends unknown[]>(fn: (...args: A) => void): ((...args: A) => void) => {
  return (...args: A) => {
    try {
      fn(...args);
    } catch {
      /* BugReel must never break the host */
    }
  };
};
