import type {
  BugReelReport,
  BugDetector,
  ConsoleEvent,
  DiagnosticFinding,
  NetworkEvent,
  RawBugReelEvent,
  ReporterAnswers,
  ReportMeta,
} from '../types';

export interface CompileInput {
  events: RawBugReelEvent[];
  findings: DiagnosticFinding[];
  meta: ReportMeta;
  answers?: ReporterAnswers;
}

const isNetworkEvent = (e: RawBugReelEvent): e is NetworkEvent =>
  e.type === 'fetch' || e.type === 'xhr';
const isConsoleEvent = (e: RawBugReelEvent): e is ConsoleEvent => e.type === 'console';

/**
 * Events + findings -> report.json skeleton. storySteps and the compiled
 * outputs (markdown, cURL, Playwright, Cursor prompt) are filled by the
 * Story Engine in a later ticket; the frozen v1.0 shape lands here.
 */
export function compileReport({ events, findings, meta, answers }: CompileInput): BugReelReport {
  if (!meta) throw new Error('compileReport requires report meta');
  return {
    schemaVersion: '1.0',
    meta,
    reporterAnswers: answers ?? {},
    findings: [...findings],
    storySteps: [],
    events: [...events],
    network: events.filter(isNetworkEvent),
    console: events.filter(isConsoleEvent),
    outputs: { markdown: '' },
  };
}

/**
 * Run every registered detector against one incoming event. A broken
 * detector must never break the pipeline — it is skipped, not propagated.
 */
export function runDetectors(
  detectors: BugDetector[],
  event: RawBugReelEvent,
  recentWindow: RawBugReelEvent[],
): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  for (const detector of detectors) {
    try {
      const finding = detector.onEvent(event, recentWindow);
      if (finding) findings.push(finding);
    } catch {
      // detector failures are swallowed: the report pipeline must keep working
    }
  }
  return findings;
}
