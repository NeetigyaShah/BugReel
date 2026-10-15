import type { EventTargetRef } from '../types';

/**
 * Privacy Firewall stage 1 — runs on the MAIN THREAD inside the sensor,
 * before data leaves the DOM element (ADR-0004).
 *
 * `describeTarget` returns the captured element reference, or `undefined`
 * when the element (or its masked subtree) must produce NO event at all.
 * `scrubInputValue` returns the value to record — literal, "[REDACTED]",
 * or a `[N chars]` length placeholder in strict mode — or `undefined`
 * to record nothing.
 *
 * Suppression precedence:
 *   1. `type=password|hidden|file` inputs — absolute, never overridable.
 *   2. The element or an ancestor carries `data-bugreel="mask"` or
 *      `data-sensitive` — absolute, never overridable.
 *   3. `data-bugreel="allow"` on the element or an ancestor — an explicit
 *      safe opt-in that rescues ONLY the keyword/autocomplete rules below.
 *   4. `autocomplete` credit-card (`cc-` prefix), password and OTP values.
 *   5. Sensitive keyword match on name/id/placeholder/aria-label/label.
 *
 * Every DOM read is fail-soft: a fault produces no event, never an
 * unvetted one. Only a minimal Element surface is used (tagName,
 * getAttribute/hasAttribute, parentElement, querySelector, innerText/
 * textContent, getBoundingClientRect) so the sensor and tests can drive
 * it with lightweight implementations.
 */

const REDACTED = '[REDACTED]';
const MAX_SELECTOR_DEPTH = 6;
const MAX_TEXT_LENGTH = 160;
const MAX_SELECTOR_CLASSES = 3;

/** Input types that carry credentials/files — suppressed absolutely. */
const SUPPRESSED_INPUT_TYPES = new Set(['password', 'hidden', 'file']);

/**
 * ADR-0004 sensitive-field vocabulary, matched against words.
 * Candidates are word-split first (camelCase/acronym runs and
 * `snake_case`/`kebab-case`/spaces all count as boundaries), so
 * `userPassword`, `card_number` and `OTP field` match while `shipping`,
 * `spinner` or `keyboard` do not.
 */
const SENSITIVE_KEYWORD =
  /(?<![a-zA-Z0-9])(?:password|token|secret|api[-_ ]?key|ssn|social|card(?:[-_ ]?number)?|cvv|cvc|pin|otp|auth(?:entication)?[-_ ]?code)(?![a-zA-Z0-9])/i;

/** `autocomplete` tokens marking credential/payment/OTP fields. */
const SENSITIVE_AUTOCOMPLETE =
  /(?:^|\s)(?:cc-\S+|(?:current|new)-password|one-time-code)(?=\s|$)/i;

/** Headings that give a form/section/fieldset its human name. */
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,legend';
const HEADING_CONTAINER_TAGS = new Set(['form', 'section', 'fieldset']);

type LabelSource = NonNullable<EventTargetRef['labelSource']>;

/* ------------------------------------------------------------------ */
/* DOM accessors — every read guarded so exotic elements cannot throw. */
/* ------------------------------------------------------------------ */

const tagOf = (el: Element): string => {
  try {
    return (el.tagName ?? '').toLowerCase();
  } catch {
    return '';
  }
};

const getAttr = (el: Element, name: string): string | undefined => {
  try {
    const v = el.getAttribute?.(name);
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
};

const hasAttr = (el: Element, name: string): boolean => {
  try {
    if (typeof el.hasAttribute === 'function') return el.hasAttribute(name);
    return el.getAttribute?.(name) != null;
  } catch {
    return false;
  }
};

const propStr = (el: Element, key: 'id' | 'name' | 'type' | 'innerText' | 'textContent'): string | undefined => {
  try {
    const v = (el as unknown as Record<string, unknown>)[key];
    return typeof v === 'string' && v !== '' ? v : undefined;
  } catch {
    return undefined;
  }
};

const parentOf = (el: Element): Element | null => {
  try {
    return el.parentElement ?? null;
  } catch {
    return null;
  }
};

/** Walk the element and its ancestors; true when any satisfies `pred`. */
const anyInChain = (el: Element, pred: (e: Element) => boolean): boolean => {
  for (let node: Element | null = el; node; node = parentOf(node)) {
    try {
      if (pred(node)) return true;
    } catch {
      // keep walking — a broken ancestor must not disable the firewall
    }
  }
  return false;
};

const cleanText = (value: unknown): string | undefined => {
  const t = typeof value === 'string' ? value.trim() : '';
  if (!t) return undefined;
  return t.length > MAX_TEXT_LENGTH ? t.slice(0, MAX_TEXT_LENGTH) : t;
};

/* ------------------------------- */
/* Masking rules                   */
/* ------------------------------- */

const bugreelFlag = (el: Element): string | undefined =>
  getAttr(el, 'data-bugreel')?.trim().toLowerCase();

/** Element or ancestor is `data-bugreel="mask"` or `data-sensitive`. */
const isMasked = (el: Element): boolean =>
  anyInChain(el, (n) => bugreelFlag(n) === 'mask' || hasAttr(n, 'data-sensitive'));

/** Element or ancestor is `data-bugreel="allow"` — explicit safe opt-in. */
const isAllowed = (el: Element): boolean => anyInChain(el, (n) => bugreelFlag(n) === 'allow');

const inputTypeOf = (el: Element): string | undefined => {
  const attrType = getAttr(el, 'type')?.toLowerCase();
  if (attrType) return attrType;
  if (tagOf(el) === 'input') return propStr(el, 'type')?.toLowerCase() ?? 'text';
  return undefined;
};

const autocompleteSensitive = (el: Element): boolean => {
  const ac = getAttr(el, 'autocomplete');
  return ac !== undefined && SENSITIVE_AUTOCOMPLETE.test(ac);
};

/** camelCase/acronym runs become spaces so word-boundary keywords match. */
const splitWords = (value: string): string =>
  value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');

const keywordSensitive = (value: string | undefined): boolean =>
  value !== undefined && SENSITIVE_KEYWORD.test(splitWords(value));

const sensitiveKeywordPresent = (el: Element): boolean => {
  const candidates = [
    getAttr(el, 'name'),
    propStr(el, 'name'),
    getAttr(el, 'id'),
    propStr(el, 'id'),
    getAttr(el, 'placeholder'),
    getAttr(el, 'aria-label'),
    resolveLabel(el).label,
  ];
  return candidates.some(keywordSensitive);
};

/**
 * Why an element must produce no event, or `undefined` when it may be
 * captured. `data-bugreel="allow"` rescues keyword/autocomplete matches
 * only — never a masked subtree and never a password/hidden/file input.
 */
const suppressionReason = (el: Element): 'type' | 'mask' | 'sensitive' | undefined => {
  const type = inputTypeOf(el);
  if (type !== undefined && SUPPRESSED_INPUT_TYPES.has(type)) return 'type';
  if (isMasked(el)) return 'mask';
  if (isAllowed(el)) return undefined;
  if (autocompleteSensitive(el) || sensitiveKeywordPresent(el)) return 'sensitive';
  return undefined;
};

/**
 * Would this element's *value* be a credential? Mirrors suppressionReason
 * minus the mask rule (masking is handled separately as "record nothing").
 */
const isSensitiveSource = (el: Element): boolean => {
  const type = inputTypeOf(el);
  if (type !== undefined && SUPPRESSED_INPUT_TYPES.has(type)) return true;
  if (isAllowed(el)) return false;
  return autocompleteSensitive(el) || sensitiveKeywordPresent(el);
};

/* ------------------------------- */
/* EventTargetRef construction     */
/* ------------------------------- */

const selectorSegment = (el: Element, tag: string): string => {
  const id = cleanText(getAttr(el, 'id')) ?? propStr(el, 'id');
  if (id) return `${tag}#${id}`;
  const classes = (getAttr(el, 'class') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SELECTOR_CLASSES);
  return classes.length ? `${tag}.${classes.join('.')}` : tag;
};

/** "form#checkout > button.pay" — up to MAX_SELECTOR_DEPTH ancestors. */
const selectorOf = (el: Element): string => {
  const parts: string[] = [];
  for (let node: Element | null = el; node && parts.length < MAX_SELECTOR_DEPTH; node = parentOf(node)) {
    const tag = tagOf(node);
    if (!tag || tag === 'html' || tag === 'body') break;
    parts.unshift(selectorSegment(node, tag));
  }
  return parts.join(' > ');
};

const resolveLabel = (el: Element): { label?: string; source: LabelSource } => {
  const innerText = cleanText(propStr(el, 'innerText'));
  if (innerText) return { label: innerText, source: 'innerText' };
  const aria = cleanText(getAttr(el, 'aria-label'));
  if (aria) return { label: aria, source: 'aria-label' };
  const placeholder = cleanText(getAttr(el, 'placeholder'));
  if (placeholder) return { label: placeholder, source: 'placeholder' };
  const text = cleanText(propStr(el, 'textContent'));
  if (text) return { label: text, source: 'textContent' };
  return { source: 'unknown' };
};

const headingOf = (container: Element): string | undefined => {
  try {
    const heading = container.querySelector?.(HEADING_SELECTOR);
    const text = heading ? cleanText(propStr(heading, 'textContent')) : undefined;
    if (text) return text;
  } catch {
    // fall through to the container's aria-label
  }
  return cleanText(getAttr(container, 'aria-label'));
};

/** Nearest form/section/fieldset (or role=form) heading text, walking outward. */
const headingContextOf = (el: Element): string | undefined => {
  for (let node: Element | null = el; node; node = parentOf(node)) {
    const container = HEADING_CONTAINER_TAGS.has(tagOf(node)) || getAttr(node, 'role') === 'form';
    if (!container) continue;
    const heading = headingOf(node);
    if (heading) return heading;
  }
  return undefined;
};

const rectOf = (el: Element): EventTargetRef['rect'] => {
  try {
    const r = el.getBoundingClientRect?.();
    if (!r) return undefined;
    const { x, y, width, height } = r;
    return [x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v))
      ? { x, y, width, height }
      : undefined;
  } catch {
    return undefined;
  }
};

/* ------------------------------- */
/* Frozen seam — called by the     */
/* sensor (T03).                   */
/* ------------------------------- */

export function describeTarget(el: Element): EventTargetRef | undefined {
  try {
    if (!el || suppressionReason(el) !== undefined) return undefined;

    const tagName = tagOf(el);
    const ref: EventTargetRef = { selector: selectorOf(el) || tagName || 'unknown' };
    if (tagName) ref.tagName = tagName;

    const id = cleanText(getAttr(el, 'id')) ?? propStr(el, 'id');
    if (id) ref.id = id;
    const role = cleanText(getAttr(el, 'role'));
    if (role) ref.role = role;
    const inputType = inputTypeOf(el);
    if (inputType) ref.inputType = inputType;
    const name = cleanText(getAttr(el, 'name')) ?? propStr(el, 'name');
    if (name) ref.name = name;
    const placeholder = cleanText(getAttr(el, 'placeholder'));
    if (placeholder) ref.placeholder = placeholder;

    const { label, source } = resolveLabel(el);
    if (label) ref.label = label;
    ref.labelSource = source;

    const heading = headingContextOf(el);
    if (heading) ref.headingContext = heading;
    const rect = rectOf(el);
    if (rect) ref.rect = rect;

    return ref;
  } catch {
    // Fail closed: a firewall fault produces no event, never an unvetted one.
    return undefined;
  }
}

export function scrubInputValue(
  el: Element,
  value: string,
  opts?: { strict?: boolean },
): string | undefined {
  try {
    const v = typeof value === 'string' ? value : String(value ?? '');
    if (isMasked(el)) return undefined;
    if (isSensitiveSource(el)) return REDACTED;
    if (opts?.strict === true) return `[${v.length} chars]`;
    return v;
  } catch {
    return undefined;
  }
}
