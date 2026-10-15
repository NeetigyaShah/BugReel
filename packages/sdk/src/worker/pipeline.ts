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
import { compileCurl, compileMarkdown, compilePlaywright, compilePrompt } from './compilers';
import { buildStory } from './story';

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
 * Events + findings -> report.json. The Story Engine translates scrubbed
 * events into Story steps and fills every compiled output; report.md is
 * rendered last because its toolkit embeds the other compilers' output.
 */
export function compileReport({ events, findings, meta, answers }: CompileInput): BugReelReport {
  if (!meta) throw new Error('compileReport requires report meta');
  const network = events.filter(isNetworkEvent);
  const report: BugReelReport = {
    schemaVersion: '1.0',
    meta,
    reporterAnswers: answers ?? {},
    findings: [...findings],
    storySteps: buildStory(events, findings),
    events: [...events],
    network,
    console: events.filter(isConsoleEvent),
    outputs: {
      markdown: '',
      curl: compileCurl(network, meta),
      playwright: compilePlaywright(events, meta),
      cursorPrompt: compilePrompt({ events, findings, meta, answers }),
    },
  };
  report.outputs.markdown = compileMarkdown(report);
  return report;
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
