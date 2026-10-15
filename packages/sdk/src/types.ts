export type BugReelEventId = string;

/**
 * DOM reference captured at the element at event time. Carries the resolved
 * human label and nearest heading so the Story Engine can write plain-English
 * sentences without touching the DOM again, plus the bounding rect the
 * Timeline Player needs for its coordinate beacon.
 */
export interface EventTargetRef {
  /** CSS path to the element, e.g. "form#checkout button.pay" */
  selector: string;
  tagName?: string;
  id?: string;
  role?: string;
  inputType?: string;
  name?: string;
  /** Best human label: innerText > aria-label > placeholder > textContent */
  label?: string;
  labelSource?: 'innerText' | 'aria-label' | 'placeholder' | 'textContent' | 'unknown';
  /** Nearest form/section heading, e.g. "Checkout" -> "inside the Checkout section" */
  headingContext?: string;
  placeholder?: string;
  /** Viewport rect at capture time */
  rect?: { x: number; y: number; width: number; height: number };
}

interface EventBase {
  id: BugReelEventId;
  /** epoch ms, main-thread clock at capture */
  at: number;
}

export interface ClickEvent extends EventBase {
  type: 'click';
  target: EventTargetRef;
  x?: number;
  y?: number;
  /**
   * Sensor verdict ~400ms later: did the DOM mutate at all after this click?
   * `false` is the Dead Click signal. Arrives post-hoc via annotate.
   */
  domMutatedAfterClick?: boolean;
}

export interface InputEvent extends EventBase {
  type: 'input';
  target: EventTargetRef;
  /** Value after the Privacy Firewall: literal, "[REDACTED]", masked, or char-length in strict mode */
  value: string;
}

export interface RouteEvent extends EventBase {
  type: 'route';
  from?: string;
  to: string;
}

export interface NetworkEvent extends EventBase {
  type: 'fetch' | 'xhr';
  method: string;
  url: string;
  /** Response status; undefined when the request never completed (CORS/network failure) */
  status?: number;
  ok?: boolean;
  durationMs?: number;
  corsBlocked?: boolean;
  /** Scrubbed + truncated bodies */
  requestBody?: string;
  responseBody?: string;
  /**
   * Sensor verdict ~2s later: did the app render any error feedback?
   * `false` alongside status >= 400 is the Silent Failure signal. Arrives via annotate.
   */
  errorUiRendered?: boolean;
}

export interface ConsoleEvent extends EventBase {
  type: 'console';
  level: 'error' | 'warn' | 'info' | 'log' | 'debug';
  /** Serialized args, post-Privacy-Firewall */
  message: string;
  stack?: string;
}

export interface ErrorEvent extends EventBase {
  type: 'error';
  source: 'window.onerror' | 'unhandledrejection';
  message: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
}

export type RawBugReelEvent =
  | ClickEvent
  | InputEvent
  | RouteEvent
  | NetworkEvent
  | ConsoleEvent
  | ErrorEvent;

export type BugReelEventType = RawBugReelEvent['type'];

export type Severity = 'critical' | 'warning';

/** ADR-0008 — emitted by a BugDetector, consumed by the Story Engine for What Happened. */
export interface DiagnosticFinding {
  detectorId: 'dead-click' | 'silent-api-error' | 'rage-click' | string;
  severity: Severity;
  timestamp: number;
  /** Plain-English headline for the What Happened section */
  headline: string;
  /** Human-readable causal sentence */
  explanation: string;
  selector?: string;
  relatedEventIds: string[];
}

/** ADR-0008 — stable plugin contract; v1 ships three implementations. */
export interface BugDetector {
  id: string;
  onEvent(event: RawBugReelEvent, recentWindow: RawBugReelEvent[]): DiagnosticFinding | null;
}

export interface StoryStep {
  at: number;
  eventId?: BugReelEventId;
  kind: 'click' | 'input' | 'route' | 'network' | 'console' | 'error' | 'finding';
  /** Plain-English sentence, e.g. "Typed 'SAVE20' into 'Promo Code'" */
  text: string;
  severity?: Severity;
}

export interface ReportMeta {
  url: string;
  userAgent: string;
  viewport: { width: number; height: number };
  capturedAt: number;
  sdkVersion: string;
  sessionId: string;
  project?: string;
  app?: string;
  user?: { id?: string; email?: string };
}

export interface ReporterAnswers {
  tryingToDo?: string;
  wentWrong?: string;
}

export interface CompiledOutputs {
  /** report.md — the fixed four-part human report */
  markdown: string;
  curl?: string;
  playwright?: string;
  cursorPrompt?: string;
}

/** report.json — the frozen .bugpack v1.0 payload contract (ADR-0001/0005). */
export interface BugReelReport {
  schemaVersion: '1.0';
  meta: ReportMeta;
  reporterAnswers: ReporterAnswers;
  findings: DiagnosticFinding[];
  storySteps: StoryStep[];
  events: RawBugReelEvent[];
  /** Network events distilled from `events` for the player inspector pane */
  network: NetworkEvent[];
  /** Console events distilled from `events` for the player inspector pane */
  console: ConsoleEvent[];
  outputs: CompiledOutputs;
}

export type ToWorkerMessage =
  | { type: 'bugreel:event'; event: RawBugReelEvent }
  | { type: 'bugreel:events'; events: RawBugReelEvent[] }
  | { type: 'bugreel:annotate'; eventId: BugReelEventId; patch: Record<string, unknown> }
  | { type: 'bugreel:compile'; requestId: string; meta: ReportMeta; answers?: ReporterAnswers };

export type FromWorkerMessage =
  | { type: 'bugreel:worker-ready' }
  | { type: 'bugreel:report'; requestId: string; report: BugReelReport }
  | { type: 'bugreel:error'; requestId?: string; message: string };
