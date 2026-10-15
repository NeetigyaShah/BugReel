import type {
  ClickEvent,
  ConsoleEvent,
  DiagnosticFinding,
  ErrorEvent,
  EventTargetRef,
  InputEvent,
  NetworkEvent,
  RawBugReelEvent,
  RouteEvent,
  StoryStep,
} from '../types';

/**
 * Story Engine — deterministic event → plain-English translation (Zero-AI).
 * Every sentence is a fixed template over scrubbed, post-Firewall event data;
 * nothing here infers or guesses.
 */

const MAX_MESSAGE_LENGTH = 160;

const truncate = (value: string, limit = MAX_MESSAGE_LENGTH): string =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;

/** `'Pay Now'` when a label resolved, `'button#pay'` when only the selector exists. */
const quotedTarget = (target: EventTargetRef): string => `'${target.label || target.selector}'`;

/** Element kind in plain words — only where the tag reads naturally. */
const ELEMENT_KIND: Record<string, string> = {
  button: 'button',
  a: 'link',
  input: 'field',
  select: 'dropdown',
  textarea: 'text field',
};

const clickStep = (event: ClickEvent): string => {
  const { tagName, headingContext, labelSource } = event.target;
  // The selector already carries the tag, so only spelled-out kinds are added
  // when a real label was resolved (labelSource !== 'unknown').
  const kind = labelSource !== 'unknown' && tagName ? (ELEMENT_KIND[tagName] ?? '') : '';
  const where = headingContext ? ` inside '${headingContext}'` : '';
  return `Clicked ${quotedTarget(event.target)}${kind ? ` ${kind}` : ''}${where}`;
};

const inputStep = (event: InputEvent): string =>
  `Typed '${event.value}' into ${quotedTarget(event.target)}`;

/** Path+search+hash when the URL is absolute or path-relative; the raw string otherwise. */
const shortPath = (raw: string): string => {
  try {
    const url = raw.startsWith('/') ? undefined : new URL(raw);
    if (!url) return raw;
    return url.pathname + url.search + url.hash || '/';
  } catch {
    return raw;
  }
};

const routeStep = (event: RouteEvent): string => {
  let to = event.to;
  if (event.from) {
    try {
      // Cross-origin hops keep the full destination — the domain is the story.
      to =
        new URL(event.to, event.from).origin === new URL(event.from).origin
          ? shortPath(event.to)
          : event.to;
    } catch {
      to = event.to;
    }
  }
  const from = event.from ? shortPath(event.from) : '(unknown origin)';
  return `Navigated from ${from} to ${to}`;
};

/**
 * The HTTP-status phrase map — observed outcome language, not diagnoses:
 * 401 permission blocked, 403 access denied, 404 missing endpoint,
 * other 4xx invalid data, 5xx backend crash, no response → connection blocked.
 */
export const statusPhrase = (status?: number, corsBlocked?: boolean): string => {
  if (status === undefined) {
    return corsBlocked === true
      ? 'connection blocked (CORS or a network error)'
      : 'no response (network failure)';
  }
  if (status === 401) return 'permission blocked';
  if (status === 403) return 'access denied';
  if (status === 404) return 'missing endpoint';
  if (status >= 500) return 'backend crash';
  if (status >= 400) return 'invalid data';
  return `OK (${status})`;
};

const networkStep = (event: NetworkEvent): string => {
  const request = `${event.method} ${shortPath(event.url)}`;
  if ((event.status === undefined && !event.corsBlocked) || (event.status ?? 0) >= 400 || event.corsBlocked) {
    const suffix = event.status === undefined ? '' : ` (${event.status})`;
    return `${request} failed — ${statusPhrase(event.status, event.corsBlocked)}${suffix}`;
  }
  const duration = event.durationMs === undefined ? '' : ` in ${event.durationMs}ms`;
  return `${request} → ${event.status}${duration}`;
};

const CONSOLE_LABEL: Record<string, string> = {
  error: 'Console error',
  warn: 'Console warning',
};

const consoleStep = (event: ConsoleEvent): string =>
  `${CONSOLE_LABEL[event.level] ?? `Console ${event.level}`}: "${truncate(event.message)}"`;

/**
 * JavaScript error → plain English. The two dominant vibe-code failure shapes
 * get their own wording: reading a property off missing data, and calling a
 * function that was never defined. Everything else passes through verbatim.
 */
const ERROR_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [
    /Cannot read propert(?:y|ies) of (undefined|null) \(reading '([^']+)'\)/,
    (m) =>
      m[1] === 'null'
        ? `Crash — missing data: '${m[2]}' was missing (null)`
        : `Crash — missing data: '${m[2]}' was read before it existed`,
  ],
  [
    /(undefined|null) is not an object \(evaluating '([^']+)'\)/,
    (m) =>
      m[1] === 'null'
        ? `Crash — missing data: '${m[2]}' was missing (null)`
        : `Crash — missing data: '${m[2]}' was read before it existed`,
  ],
  [
    /\b([A-Za-z_$][\w$.]*) is not a function\b/,
    (m) => `Crash — missing wiring: '${m[1]}' is not a function (the action was never defined)`,
  ],
  [
    /\b([A-Za-z_$][\w$.]*) is not defined\b/,
    (m) => `Crash — missing wiring: '${m[1]}' is not defined`,
  ],
];

const errorStep = (event: ErrorEvent): string => {
  for (const [pattern, render] of ERROR_PATTERNS) {
    const match = event.message.match(pattern);
    if (match) return render(match);
  }
  return `Uncaught error: "${truncate(event.message)}"`;
};

/** One event → one StoryStep; the caller merges findings separately. */
export function eventToStep(event: RawBugReelEvent): StoryStep | null {
  const base = { at: event.at, eventId: event.id };
  switch (event.type) {
    case 'click':
      return { ...base, kind: 'click', text: clickStep(event) };
    case 'input':
      return { ...base, kind: 'input', text: inputStep(event) };
    case 'route':
      return { ...base, kind: 'route', text: routeStep(event) };
    case 'fetch':
    case 'xhr':
      return { ...base, kind: 'network', text: networkStep(event) };
    case 'console':
      return {
        ...base,
        kind: 'console',
        text: consoleStep(event),
        severity: event.level === 'error' ? 'warning' : undefined,
      };
    case 'error':
      return { ...base, kind: 'error', text: errorStep(event), severity: 'critical' };
    default:
      return null;
  }
}

/**
 * Events + findings → the chronological Story. Findings join the timeline at
 * their own timestamp so the report reads as a single narrative rather than
 * a log followed by an appendix.
 */
export function buildStory(
  events: RawBugReelEvent[],
  findings: DiagnosticFinding[],
): StoryStep[] {
  const steps = events
    .map(eventToStep)
    .filter((s): s is StoryStep => s !== null);
  for (const finding of findings) {
    steps.push({
      at: finding.timestamp,
      eventId: finding.relatedEventIds[0],
      kind: 'finding',
      text: finding.headline,
      severity: finding.severity,
    });
  }
  steps.sort((a, b) => a.at - b.at);
  return steps;
}
