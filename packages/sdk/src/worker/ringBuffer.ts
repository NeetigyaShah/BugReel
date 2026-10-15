import type { BugReelEventId, RawBugReelEvent } from '../types';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_EVENTS = 2_000;

/**
 * The Event Window: a time-windowed circular buffer of raw events living in
 * the worker. Evicts by age on every mutation, hard-caps by count so a
 * runaway page can't grow it unboundedly.
 */
export class RingBuffer {
  private events: RawBugReelEvent[] = [];
  private latestAt = 0;

  constructor(
    private readonly windowMs: number = DEFAULT_WINDOW_MS,
    private readonly maxEvents: number = DEFAULT_MAX_EVENTS,
  ) {}

  push(event: RawBugReelEvent): void {
    if (event.at > this.latestAt) this.latestAt = event.at;
    let i = this.events.length;
    while (i > 0 && this.events[i - 1]!.at > event.at) i--;
    this.events.splice(i, 0, event);
    this.evict(this.latestAt);
  }

  /**
   * Post-hoc enrichment: sensor verdicts (dead-click, silent-failure) land
   * here. Structural fields (id, type, at) are not patchable — they hold the
   * buffer's ordering and eviction invariants.
   */
  annotate(eventId: BugReelEventId, patch: Record<string, unknown>): RawBugReelEvent | undefined {
    const event = this.events.find((e) => e.id === eventId);
    if (!event) return undefined;
    const safe = { ...patch };
    delete safe.id;
    delete safe.type;
    delete safe.at;
    Object.assign(event, safe);
    return event;
  }

  /** Chronological copy of the current window. */
  window(now: number = Date.now()): RawBugReelEvent[] {
    this.evict(Math.max(now, this.latestAt));
    return [...this.events];
  }

  get size(): number {
    return this.events.length;
  }

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    let firstLive = 0;
    while (firstLive < this.events.length && this.events[firstLive]!.at < cutoff) firstLive++;
    if (firstLive > 0) this.events.splice(0, firstLive);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }
}
