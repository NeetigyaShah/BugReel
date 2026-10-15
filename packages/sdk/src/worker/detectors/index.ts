import type { BugDetector } from '../../types';
import { DeadClickDetector } from './deadClick';
import { SilentApiErrorDetector } from './silentApiError';
import { RageClickDetector } from './rageClick';

export { DeadClickDetector } from './deadClick';
export { SilentApiErrorDetector } from './silentApiError';
export { RageClickDetector } from './rageClick';

/**
 * Detector registry — the frozen v1 catalog (ADR-0008): Dead Click,
 * Silent Failure, Rage Click. All three are pure over (event, recentWindow);
 * annotate re-runs emit identical Findings that the runtime dedupes by key.
 */
export const detectors: BugDetector[] = [
  DeadClickDetector,
  SilentApiErrorDetector,
  RageClickDetector,
];
