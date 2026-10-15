import type {
  ConsoleEvent,
  ErrorEvent,
  EventTargetRef,
  InputEvent,
  NetworkEvent,
  RawBugReelEvent,
  RouteEvent,
} from '../types';

/**
 * Privacy Firewall stage 2 — runs in the worker via the runtime's
 * `scrubEvent` hook, before events enter the Event Window (ADR-0004).
 *
 * Pure and total: returns a NEW scrubbed event, never mutates the input,
 * and never throws. A scrubber fault degrades to an event with every
 * risky field dropped rather than breaking the pipeline.
 */

const REDACTED = '[REDACTED]';

/* ------------------------------------------------------------------ */
/* Scrub patterns — applied in order to every free-text string.        */
/* ------------------------------------------------------------------ */

/**
 * Left edge of a sensitive key. `_` counts as a separator (snake_case)
 * and a lower/digit→upper transition counts too (camelCase), so
 * `access_token`, `accessToken` and `"token"` all match while `monkey`
 * or `keyboard` do not.
 */
const KEY_LEFT = String.raw`(?:(?<![a-zA-Z0-9])|(?<=[a-z0-9])(?=[A-Z]))`;

/**
 * Key vocabulary for `key=value` / `"key":"value"` contexts. Union of the
 * ticket's generic list (api-key/token/secret/password) and the URL-param
 * list (key/auth/ssn/card/cvv) plus common auth-flow compound names.
 */
const SENSITIVE_KEY = String.raw`(?:api[-_ ]?key|client[-_ ]?secret|(?:access|refresh|id|auth|session|authenticity|csrf|xsrf)[-_ ]?token|token|secret|(?:new|old|current|confirm)[-_ ]?password|password|passwd|pwd|auth(?:entication|orization)|session[-_ ]?id|session|key|ssn|card[-_ ]?num(?:ber)?|card|cvv|cvc|pin|otp|credential|cookie|private[-_ ]?key)s?`;

const QUOTED_VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;

/** `"token": "abc"` / `'password':'x'` — value replaced, key kept. */
const KV_QUOTED = new RegExp(
  `${KEY_LEFT}(["']?)(${SENSITIVE_KEY})\\1(\\s*[=:]\\s*)(${QUOTED_VALUE})`,
  'gi',
);

/**
 * `token=abc` / `key: xyz` / JSON `"password":["a","b"]` — bare value,
 * optional `Bearer ` prefix, or a `[...]`/`{...}` container is replaced.
 */
const KV_BARE = new RegExp(
  `${KEY_LEFT}(["']?)(${SENSITIVE_KEY})\\1(\\s*[=:]\\s*)(?:Bearer\\s+)?(?:[^\\s"'&,;{}\\[\\]()<>#]+|\\[[^\\]]*\\]|\\{[^}]*\\})`,
  'gi',
);

const BEARER_TOKEN = /\bBearer\s+\S+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const PEM_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/** Well-known API-token prefixes (Stripe, GitHub, Slack, AWS, Google, …). */
const SECRET_PREFIX =
  /\b(?:sk_(?:live|test)_[0-9A-Za-z]+|pk_(?:live|test)_[0-9A-Za-z]+|rk_(?:live|test)_[0-9A-Za-z]+|sk-(?:ant|proj)-[0-9A-Za-z_-]+|gh[pousr]_[0-9A-Za-z]{10,}|github_pat_[0-9A-Za-z_]+|glpat-[0-9A-Za-z_-]+|xox[bpoars]-[0-9A-Za-z-]+|xapp-[0-9A-Za-z-]+|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]+|dop_v1_[0-9A-Za-z_]+|hf_[0-9A-Za-z]{20,}|npm_[0-9A-Za-z]{36})/g;

/** 16-digit cards (separators optional) + Amex 4-6-5 (separators required). */
const CREDIT_CARD = /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b|\b\d{4}[- ]\d{6}[- ]\d{5}\b/g;
const SSN = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Phones: optional +CC, an area/group code, then 3-4 + 4 digits with
 * separators. Requires separators so bare digit runs (ids, dates) survive.
 */
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{4}\b/g;

/** Header names whose values are credentials — blanked at the event level. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-xsrf-token',
]);

/* ------------------------------------------------------------------ */
/* String scrubbing                                                    */
/* ------------------------------------------------------------------ */

const kvQuotedReplacer = (
  _match: string,
  quote: string,
  key: string,
  sep: string,
  value: string,
): string => {
  const q = value.charAt(0);
  return `${quote}${key}${quote}${sep}${q}${REDACTED}${q}`;
};

const kvBareReplacer = (_match: string, quote: string, key: string, sep: string): string =>
  `${quote}${key}${quote}${sep}${REDACTED}`;

const scrubString = (value: string): string => {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value
    .replace(KV_QUOTED, kvQuotedReplacer)
    .replace(KV_BARE, kvBareReplacer)
    .replace(BEARER_TOKEN, REDACTED)
    .replace(PEM_BLOCK, REDACTED)
    .replace(JWT, REDACTED)
    .replace(SECRET_PREFIX, REDACTED)
    .replace(CREDIT_CARD, REDACTED)
    .replace(SSN, REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(PHONE, REDACTED);
};

const scrubOpt = (value: string | undefined): string | undefined =>
  typeof value === 'string' ? scrubString(value) : value;

/* ------------------------------------------------------------------ */
/* Per-shape scrubbers                                                 */
/* ------------------------------------------------------------------ */

const scrubHeaders = (
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  if (!headers || typeof headers !== 'object') return headers;
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADERS.has(name.toLowerCase())
      ? REDACTED
      : typeof v === 'string'
        ? scrubString(v)
        : v;
  }
  return out;
};

/** Free-text fields of the target ref (label/placeholder/heading) get scrubbed; structural fields stay. */
const scrubTarget = (target: EventTargetRef): EventTargetRef => {
  if (!target || typeof target !== 'object') return target;
  return {
    ...target,
    label: scrubOpt(target.label),
    placeholder: scrubOpt(target.placeholder),
    headingContext: scrubOpt(target.headingContext),
  };
};

const scrubNetwork = (event: NetworkEvent): NetworkEvent => ({
  ...event,
  url: scrubString(event.url),
  requestHeaders: scrubHeaders(event.requestHeaders),
  responseHeaders: scrubHeaders(event.responseHeaders),
  requestBody: scrubOpt(event.requestBody),
  responseBody: scrubOpt(event.responseBody),
});

const scrubConsole = (event: ConsoleEvent): ConsoleEvent => ({
  ...event,
  message: scrubString(event.message),
  stack: scrubOpt(event.stack),
});

const scrubError = (event: ErrorEvent): ErrorEvent => ({
  ...event,
  message: scrubString(event.message),
  stack: scrubOpt(event.stack),
  filename: scrubOpt(event.filename),
});

/** Values are already stage-1 scrubbed — this re-scans for leaked secrets. */
const scrubInput = (event: InputEvent): InputEvent => ({
  ...event,
  value: scrubString(event.value),
  target: scrubTarget(event.target),
});

const scrubRoute = (event: RouteEvent): RouteEvent => ({
  ...event,
  from: scrubOpt(event.from),
  to: scrubString(event.to),
});

/* ------------------------------------------------------------------ */
/* Fail-safe: keep only known-safe scalar fields, drop risky strings.  */
/* ------------------------------------------------------------------ */

const SAFE_SCALAR_KEYS = [
  'id',
  'at',
  'type',
  'method',
  'status',
  'ok',
  'durationMs',
  'corsBlocked',
  'x',
  'y',
  'domMutatedAfterClick',
  'errorUiRendered',
  'level',
  'source',
  'lineno',
  'colno',
] as const;

const failSafeScrubbed = (event: RawBugReelEvent): RawBugReelEvent => {
  const out: Record<string, unknown> = {};
  for (const key of SAFE_SCALAR_KEYS) {
    try {
      if (key in event) out[key] = (event as unknown as Record<string, unknown>)[key];
    } catch {
      // unreadable field — skip it
    }
  }
  return out as unknown as RawBugReelEvent;
};

export function scrubEvent(event: RawBugReelEvent): RawBugReelEvent {
  try {
    switch (event.type) {
      case 'fetch':
      case 'xhr':
        return scrubNetwork(event);
      case 'console':
        return scrubConsole(event);
      case 'error':
        return scrubError(event);
      case 'input':
        return scrubInput(event);
      case 'click':
        return { ...event, target: scrubTarget(event.target) };
      case 'route':
        return scrubRoute(event);
      default:
        // Unreachable for well-typed events; still returns a fresh copy.
        return { ...(event as unknown as Record<string, unknown>) } as unknown as RawBugReelEvent;
    }
  } catch {
    return failSafeScrubbed(event);
  }
}
