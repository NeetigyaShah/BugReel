/**
 * Privacy Firewall stage 1 — the synchronous DOM gate (ADR-0004). It ships in
 * the size-budgeted loader chunk, so it only decides "may this element
 * produce an event at all?". Regex value scrubbing lives in stage 2 (worker);
 * descriptive enrichment (selector/label/heading/rect) lives in `enrich.ts`.
 *
 * Precedence:
 *   1. `type=password|hidden|file`, or the element sits inside
 *      `data-bugreel="mask"` / `data-sensitive` — always blocked.
 *   2. `data-bugreel="allow"` on the element or an ancestor — explicit opt-in
 *      that skips rule 3 only.
 *   3. Form controls with a sensitive `autocomplete` token, or a name / id /
 *      placeholder / aria-label matching the keyword list, are blocked.
 *
 * The keyword list is deliberately a substring match: a false positive loses
 * one event, a false negative leaks a credential. `data-bugreel="allow"` is
 * the escape hatch for fields like `shipping_address`.
 */

const BLOCKED_TYPE = /^(?:password|hidden|file)$/;
const SENSITIVE_AUTOCOMPLETE = /(?:^|\s)(?:cc-|current-password|new-password|one-time-code)/;
const SENSITIVE_ATTR = /pass|pwd|secret|token|key|auth|cvv|cvc|ssn|tax_id|card|pin|otp/;
const FORM_CONTROL = /^(?:input|textarea|select)$/i;
// MASKED also names BugReel's own chrome: composed shadow events retarget
// to the host element, and a reporter clicking Submit inside bugreel-modal
// must not become a user click (phantom Dead Click findings, answers in
// the story). Being ours IS a reason it produces no events.
const MASKED = '[data-bugreel=mask i],[data-sensitive],bugreel-modal,bugreel-pill';
const ALLOWED = '[data-bugreel=allow i]';
const KEYWORD_ATTRS = ['name', 'id', 'placeholder', 'aria-label'];

/** True when `el` must produce no event. Fails closed on any DOM fault. */
export const isBlocked = (el: Element): boolean => {
  try {
    const attr = (name: string): string => el.getAttribute?.(name)?.toLowerCase() ?? '';
    if (BLOCKED_TYPE.test(attr('type')) || el.closest?.(MASKED)) return true;
    if (!FORM_CONTROL.test(el.tagName) || el.closest?.(ALLOWED)) return false;
    return (
      SENSITIVE_AUTOCOMPLETE.test(attr('autocomplete')) ||
      KEYWORD_ATTRS.some((name) => SENSITIVE_ATTR.test(attr(name)))
    );
  } catch {
    return true;
  }
};

/** The value to record for an allowed field: literal, or its length in strict mode. */
export const gateValue = (value: string, strict?: boolean): string =>
  strict ? `[${value.length} chars]` : value;
