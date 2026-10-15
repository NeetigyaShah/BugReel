import type { BugDetector, RawBugReelEvent } from '../../types';
import { targetLabel } from './utils';

/** Event types that prove the app reacted to a click — a click followed by one is not dead. */
const CLICK_EFFECT_TYPES = new Set<RawBugReelEvent['type']>([
  'fetch',
  'xhr',
  'route',
  'console',
  'error',
]);

/**
 * Dead Click (GLOSSARY): a click that produced zero observable effect — no
 * network request, route change, console output, or DOM mutation.
 *
 * The sensor verdict `domMutatedAfterClick` arrives post-hoc via annotate
 * (~400ms after the click), so a plain `undefined` verdict keeps the detector
 * quiet; `=== false` is the signal. A flagged click is also absolved when any
 * effect event followed it in the Event Window. Pure in (event, recentWindow):
 * the same verdict always produces the same Finding, so the runtime's
 * finding-key dedupe makes annotate re-runs free.
 */
export const DeadClickDetector: BugDetector = {
  id: 'dead-click',
  onEvent(event, recentWindow) {
    if (event.type !== 'click' || event.domMutatedAfterClick !== false) return null;
    const reacted = recentWindow.some(
      (e) => e.id !== event.id && e.at > event.at && CLICK_EFFECT_TYPES.has(e.type),
    );
    if (reacted) return null;

    const label = targetLabel(event.target);
    return {
      detectorId: 'dead-click',
      severity: 'warning',
      timestamp: event.at,
      headline: `Clicked ${label} — nothing happened`,
      explanation:
        `${label} produced no network request, route change, console output, ` +
        `or DOM mutation after the click.`,
      selector: event.target.selector,
      relatedEventIds: [event.id],
    };
  },
};
