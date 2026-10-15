import type { RawBugReelEvent } from '../types';

/**
 * Privacy Firewall stage 2 — runs in the worker via the runtime's
 * `scrubEvent` hook, before events enter the Event Window. T05 implements
 * the network/console/error scrubbing (auth headers, cookies, secrets,
 * card numbers, SSNs, emails, phones per policy).
 */
export function scrubEvent(event: RawBugReelEvent): RawBugReelEvent {
  return event;
}
