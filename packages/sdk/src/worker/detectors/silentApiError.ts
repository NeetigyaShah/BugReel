import type { BugDetector } from '../../types';

/**
 * Silent Failure (GLOSSARY): an HTTP error response that rendered no
 * user-visible error feedback — the app swallowed the failure.
 *
 * Fires on fetch/xhr events with `status >= 400` or `corsBlocked`, but only
 * once the sensor verdict lands: `errorUiRendered === false` is the signal,
 * `undefined` (pending) and `true` (a toast/banner did appear) stay quiet.
 * Severity is critical for 5xx, warning for everything else. Pure in
 * (event, recentWindow) — all needed data sits on the event itself.
 */
export const SilentApiErrorDetector: BugDetector = {
  id: 'silent-api-error',
  onEvent(event) {
    if (event.type !== 'fetch' && event.type !== 'xhr') return null;
    const failed = event.corsBlocked === true || event.status === 0 || (event.status ?? 0) >= 400;
    if (!failed || event.errorUiRendered !== false) return null;

    const severity = (event.status ?? 0) >= 500 ? 'critical' : 'warning';
    const statusText = event.corsBlocked
      ? 'CORS blocked'
      : event.status !== undefined && event.status !== 0
        ? String(event.status)
        : 'no response';
    const durationText = event.durationMs !== undefined ? ` in ${event.durationMs}ms` : '';
    const detail =
      event.status !== undefined && event.status !== 0
        ? `returned a ${event.status} error${durationText}`
        : `never completed${durationText} (CORS or network block)`;
    return {
      detectorId: 'silent-api-error',
      severity,
      timestamp: event.at,
      headline: `${event.method} ${event.url} failed (${statusText}) and no error UI appeared`,
      explanation:
        `${event.method} ${event.url} ${detail}, but the app rendered no error ` +
        `feedback — the failure stayed invisible to the reporter.`,
      relatedEventIds: [event.id],
    };
  },
};
