import { RingBuffer } from './ringBuffer';
import { packBugpack, selectMediaEntries } from './bugpack';
import { compileReport, runDetectors } from './pipeline';
import type {
  BugDetector,
  DiagnosticFinding,
  FromWorkerMessage,
  RawBugReelEvent,
  ReportMeta,
  ToWorkerMessage,
} from '../types';

const DEFAULT_WINDOW_MS = 60_000;

const INBOUND_TYPES: ReadonlySet<string> = new Set<ToWorkerMessage['type']>([
  'bugreel:event',
  'bugreel:events',
  'bugreel:annotate',
  'bugreel:compile',
  'bugreel:pack',
]);

/**
 * True for messages the worker should handle. The main-thread fallback runs
 * the worker with `self === window`, so its own replies re-enter `onmessage`;
 * the shell must drop those instead of answering them (an error reply to an
 * error reply never terminates).
 */
export const isToWorkerMessage = (data: unknown): data is ToWorkerMessage =>
  typeof (data as { type?: unknown } | null)?.type === 'string' &&
  INBOUND_TYPES.has((data as { type: string }).type);

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
  // The last full report meta — meta-less compile/pack messages (the modal
  // sends these to keep the loader chunk lean) reuse the opener's meta.
  let lastMeta: ReportMeta | undefined;

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
        case 'bugreel:compile':
        case 'bugreel:pack': {
          const meta = message.meta ?? lastMeta;
          if (message.meta) lastMeta = message.meta;
          if (!meta) {
            return [
              {
                type: 'bugreel:error',
                requestId: requestIdOf(message),
                message: 'report meta required',
              },
            ];
          }
          // One clock for the whole report: the host stamps meta.capturedAt at
          // open time; the event window and the findings cutoff share it.
          const now = Number.isFinite(meta.capturedAt) ? meta.capturedAt : Date.now();
          const liveFindings = findings.filter((f) => f.timestamp >= now - windowMs);
          // The manifest inside report.json must name exactly what lands in
          // the archive — sanitize + lite-filter before compiling.
          const mediaEntries =
            message.type === 'bugreel:pack'
              ? selectMediaEntries(
                  Object.fromEntries((message.media ?? []).map((m) => [m.name, m.data])),
                  { lite: message.lite },
                )
              : [];
          const report = compileReport({
            events: buffer.window(now),
            findings: liveFindings,
            meta,
            answers: message.answers,
            media: mediaEntries.map((e) => e.name),
          });
          if (message.type === 'bugreel:compile') {
            return [{ type: 'bugreel:report', requestId: message.requestId, report }];
          }
          return [
            {
              type: 'bugreel:bugpack',
              requestId: message.requestId,
              bugpack: packBugpack(
                report,
                Object.fromEntries(mediaEntries.map((e) => [e.name, e.data])),
                { lite: message.lite },
              ),
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
