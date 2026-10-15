import type { EventTargetRef } from '../../types';

/**
 * Human-readable element name for Finding headlines, quoted for plain-English
 * sentences: the sensor-resolved label ("Pay Now") when present, the CSS
 * selector otherwise (selector is always captured, so this never goes empty).
 */
export const targetLabel = (target: EventTargetRef): string =>
  `'${target.label || target.selector}'`;
