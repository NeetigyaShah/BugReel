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

/**
 * Captured strings may carry line breaks (textarea inputs, pasted labels,
 * crafted URLs). Every fragment that lands in a sentence or a code comment
 * passes through here so one event can never inject a second line — or a
 * second command — into a generated artifact.
 */
export const inline = (value: string): string => value.replace(/[\r\n\t]+/g, ' ').trim();

const truncate = (value: string, limit = MAX_MESSAGE_LENGTH): string =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;

/** `'Pay Now'` when a label resolved, `'button#pay'` when only the selector exists. */
const quotedTarget = (target: EventTargetRef): string => `'${inline(target.label || target.selector)}'`;

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
  const where = headingContext ? ` inside '${inline(headingContext)}'` : '';
  return `Clicked ${quotedTarget(event.target)}${kind ? ` ${kind}` : ''}${where}`;
};

const inputStep = (event: InputEvent): string =>
  `Typed '${truncate(inline(event.value))}' into ${quotedTarget(event.target)}`;

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
  return `Navigated from ${inline(from)} to ${inline(to)}`;
};

/**
 * The HTTP-status phrase map — observed outcome language, not diagnoses:
 * 401 permission blocked, 403 access denied, 404 missing endpoint,
 * other 4xx invalid data, 5xx backend crash, no response → connection blocked.
 */
export const statusPhrase = (status?: number, corsBlocked?: boolean): string => {
  // A blocked request claims no status — CORS verdict outranks any number.
  if (corsBlocked) return 'connection blocked (CORS or a network error)';
  if (status === undefined || status === 0) return 'no response (network failure)';
  if (status === 401) return 'permission blocked';
  if (status === 403) return 'access denied';
  if (status === 404) return 'missing endpoint';
  if (status >= 500) return 'backend crash';
  if (status >= 400) return 'invalid data';
  return `OK (${status})`;
};

/**
 * One shared definition of "this request failed" — the story, the cURL
 * compiler, the Playwright comments, and the prompt all agree on it:
 * CORS/transport blocks, XHR loadend with status 0, any no-response fetch,
 * or a 4xx/5xx status.
 */
export const isFailedRequest = (event: NetworkEvent): boolean =>
  event.corsBlocked === true ||
  event.status === undefined ||
  event.status === 0 ||
  event.status >= 400;

const networkStep = (event: NetworkEvent): string => {
  const request = `${inline(event.method)} ${shortPath(inline(event.url))}`;
  if (isFailedRequest(event)) {
    // A blocked or unanswered request reports no status — none arrived.
    const suffix =
      event.corsBlocked || event.status === undefined || event.status === 0
        ? ''
        : ` (${event.status})`;
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
  `${CONSOLE_LABEL[event.level] ?? `Console ${event.level}`}: "${truncate(inline(event.message))}"`;

/**
 * JavaScript error → plain English. The two dominant vibe-code failure shapes
 * get their own wording: reading a property off missing data, and calling a
 * function that was never defined. Everything else passes through verbatim.
 */
const ERROR_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [
    // Modern V8: Cannot read properties of undefined (reading 'x')
    /Cannot read propert(?:y|ies) of (undefined|null) \(reading '([^']+)'\)/,
    (m) =>
      m[1] === 'null'
        ? `Crash — missing data: '${m[2]}' was missing (null)`
        : `Crash — missing data: '${m[2]}' was read before it existed`,
  ],
  [
    // Legacy V8: Cannot read property 'x' of undefined
    /Cannot read property '([^']+)' of (undefined|null)/,
    (m) =>
      m[2] === 'null'
        ? `Crash — missing data: '${m[1]}' was missing (null)`
        : `Crash — missing data: '${m[1]}' was read before it existed`,
  ],
  [
    // JavaScriptCore: null/undefined is not an object (evaluating 'x')
    /(undefined|null) is not an object \(evaluating '([^']+)'\)/,
    (m) =>
      m[1] === 'null'
        ? `Crash — missing data: '${m[2]}' was missing (null)`
        : `Crash — missing data: '${m[2]}' was read before it existed`,
  ],
  [
    // SpiderMonkey: can't access property "x", y is undefined / can't access property "x" of undefined
    /can't access property ["']([^"']+)["'],? [\w$]+ is (undefined|null)|can't access property ["']([^"']+)["'] of (undefined|null)/,
    (m) => {
      const prop = m[1] ?? m[3];
      const missing = m[2] ?? m[4];
      return missing === 'null'
        ? `Crash — missing data: '${prop}' was missing (null)`
        : `Crash — missing data: '${prop}' was read before it existed`;
    },
  ],
  [
    /\b([A-Za-z_$][\w$.]*) is not a function\b/,
    (m) => `Crash — missing wiring: '${m[1]}' is not a function`,
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
  return `Uncaught error: "${truncate(inline(event.message))}"`;
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
