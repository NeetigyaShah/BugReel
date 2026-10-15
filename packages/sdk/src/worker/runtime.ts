import { RingBuffer } from './ringBuffer';
import { compileReport, runDetectors } from './pipeline';
import type {
  BugDetector,
  DiagnosticFinding,
  FromWorkerMessage,
  RawBugReelEvent,
  ToWorkerMessage,
} from '../types';

const DEFAULT_WINDOW_MS = 60_000;

export interface WorkerRuntimeOptions {
  windowMs?: number;
  maxEvents?: number;
  detectors?: BugDetector[];
  /** Stage-2 Privacy Firewall seam (lands in T05): transforms each event before buffering. */
  scrubEvent?: (event: RawBugReelEvent) => RawBugReelEvent;
}

/**
 * Pure worker core: message in -> messages out. The worker entry point is a
 * thin shell around this so the whole pipeline is testable without a DOM or
 * a real Worker (Seam 1).
 */
export function createWorkerRuntime(options: WorkerRuntimeOptions = {}) {
  const buffer = new RingBuffer(options.windowMs, options.maxEvents);
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const detectors = options.detectors ?? [];
  const scrubEvent = options.scrubEvent ?? ((event: RawBugReelEvent) => event);
  const findings: DiagnosticFinding[] = [];
  const seenFindings = new Set<string>();

  const collect = (emitted: DiagnosticFinding[]): void => {
    for (const finding of emitted) {
      const key = `${finding.detectorId}:${[...finding.relatedEventIds].sort().join(',')}`;
      if (!seenFindings.has(key)) {
        seenFindings.add(key);
        findings.push(finding);
      }
    }
  };

  const handleEvent = (event: RawBugReelEvent): void => {
    const scrubbed = scrubEvent(event);
    buffer.push(scrubbed);
    collect(runDetectors(detectors, scrubbed, buffer.window(scrubbed.at)));
  };

  const requestIdOf = (message: ToWorkerMessage): string | undefined =>
    'requestId' in message ? message.requestId : undefined;

  const handleMessage = (message: ToWorkerMessage): FromWorkerMessage[] => {
    try {
      switch (message.type) {
        case 'bugreel:event':
          handleEvent(message.event);
          return [];
        case 'bugreel:events':
          for (const event of message.events) handleEvent(event);
          return [];
        case 'bugreel:annotate': {
          // Verdict fields (domMutatedAfterClick, errorUiRendered) arrive
          // post-hoc — detectors must re-run against the patched event.
          const patched = buffer.annotate(message.eventId, message.patch);
          if (patched) collect(runDetectors(detectors, patched, buffer.window()));
          return [];
        }
        case 'bugreel:compile': {
          const now = Date.now();
          const liveFindings = findings.filter((f) => f.timestamp >= now - windowMs);
          return [
            {
              type: 'bugreel:report',
              requestId: message.requestId,
              report: compileReport({
                events: buffer.window(now),
                findings: liveFindings,
                meta: message.meta,
                answers: message.answers,
              }),
            },
          ];
        }
        default:
          return [{ type: 'bugreel:error', message: 'unknown worker message type' }];
      }
    } catch (err) {
      return [
        {
          type: 'bugreel:error',
          requestId: requestIdOf(message),
          message: err instanceof Error ? err.message : String(err),
        },
      ];
    }
  };

  return { handleMessage };
}
