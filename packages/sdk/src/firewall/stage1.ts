import type { EventTargetRef } from '../types';

/**
 * Privacy Firewall stage 1 — runs on the MAIN THREAD inside the sensor,
 * before data leaves the DOM element. T05 implements the masking rules;
 * these signatures are the frozen seam the sensor calls.
 *
 * Contract: `describeTarget` returns the captured element reference, or
 * `undefined` when the element (or its masked subtree) must produce NO
 * event at all (password/hidden/file inputs, `data-bugreel="mask"`).
 * `scrubInputValue` returns the value to record (literal / "[REDACTED]" /
 * length placeholder in strict mode), or `undefined` to record nothing.
 */
export function describeTarget(el: Element): EventTargetRef | undefined {
  return { selector: el.tagName.toLowerCase() };
}

export function scrubInputValue(el: Element, value: string): string | undefined {
  void el;
  return value;
}
