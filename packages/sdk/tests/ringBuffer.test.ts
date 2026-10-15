import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../src/worker/ringBuffer';
import type { ClickEvent } from '../src/types';
import { click } from './helpers';

describe('Event Window ring buffer', () => {
  it('returns buffered events in chronological order', () => {
    const buf = new RingBuffer();
    const now = Date.now();
    buf.push(click('second', now - 1_000));
    buf.push(click('first', now - 5_000));
    expect(buf.window(now).map((e) => e.id)).toEqual(['first', 'second']);
  });

  it('evicts events older than the 60-second window', () => {
    const buf = new RingBuffer(60_000);
    const now = Date.now();
    buf.push(click('stale', now - 61_000));
    buf.push(click('fresh', now - 1_000));
    expect(buf.window(now).map((e) => e.id)).toEqual(['fresh']);
  });

  it('annotate patches an event already in the window', () => {
    const buf = new RingBuffer();
    const now = Date.now();
    buf.push(click('c1', now));
    const patched = buf.annotate('c1', { domMutatedAfterClick: false });
    expect((patched as ClickEvent).domMutatedAfterClick).toBe(false);
  });

  it('annotate cannot overwrite structural fields', () => {
    const buf = new RingBuffer();
    const now = Date.now();
    buf.push(click('c1', now));
    const patched = buf.annotate('c1', { id: 'hijack', type: 'error', at: 0 });
    expect(patched?.id).toBe('c1');
    expect(patched?.type).toBe('click');
    expect(patched?.at).toBe(now);
  });

  it('annotate returns undefined for unknown event ids', () => {
    const buf = new RingBuffer();
    expect(buf.annotate('missing', { domMutatedAfterClick: false })).toBeUndefined();
  });

  it('caps the buffer at maxEvents, keeping the newest', () => {
    const buf = new RingBuffer(60_000, 3);
    const now = Date.now();
    for (let i = 0; i < 5; i++) buf.push(click(`e${i}`, now - i));
    expect(buf.size).toBe(3);
    expect(buf.window(now).map((e) => e.id)).toEqual(['e2', 'e1', 'e0']);
  });
});
