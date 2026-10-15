import type { BugDetector, ClickEvent } from '../../types';
import { targetLabel } from './utils';

/** Frozen detection window: a burst is clicks on one element inside ~800ms. */
export const RAGE_CLICK_WINDOW_MS = 800;
/** Minimum clicks in the window that count as a Rage Click (GLOSSARY: "three or more"). */
export const RAGE_CLICK_MIN_CLICKS = 3;

/**
 * Rage Click (GLOSSARY): rapid repeated clicks on the same element — the
 * reporter's tell for an unresponsive control.
 *
 * Fires when the incoming click is the third-or-later same-selector click
 * inside the trailing RAGE_CLICK_WINDOW_MS. Only clicks at or before the
 * evaluated event count, so the Finding is identical when annotate re-runs
 * detectors on a patched click and the runtime dedupe key stays stable.
 * Pure in (event, recentWindow) — no internal clock or burst bookkeeping.
 */
export const RageClickDetector: BugDetector = {
  id: 'rage-click',
  onEvent(event, recentWindow) {
    if (event.type !== 'click') return null;
    const selector = event.target.selector;
    const burst = recentWindow.filter(
      (e): e is ClickEvent =>
        e.type === 'click' &&
        e.target.selector === selector &&
        e.at <= event.at &&
        event.at - e.at <= RAGE_CLICK_WINDOW_MS,
    );
    // The runtime pushes before running detectors, but tolerate windows that
    // don't contain the event itself (direct calls at Seam 1).
    if (!burst.some((e) => e.id === event.id)) burst.push(event);
    if (burst.length < RAGE_CLICK_MIN_CLICKS) return null;

    const label = targetLabel(event.target);
    return {
      detectorId: 'rage-click',
      severity: 'warning',
      timestamp: event.at,
      headline: `User rage-clicked ${label} (${burst.length}× in ${RAGE_CLICK_WINDOW_MS}ms)`,
      explanation:
        `${burst.length} rapid clicks landed on ${label} inside ${RAGE_CLICK_WINDOW_MS}ms — ` +
        `the element is likely unresponsive or its action is silently failing.`,
      selector,
      relatedEventIds: burst.map((e) => e.id),
    };
  },
};
