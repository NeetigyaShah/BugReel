import type { BugDetector } from '../../types';

/**
 * Detector registry — T04 fills this with DeadClickDetector,
 * SilentApiErrorDetector, and RageClickDetector (ADR-0008, catalog frozen at 3).
 */
export const detectors: BugDetector[] = [];
