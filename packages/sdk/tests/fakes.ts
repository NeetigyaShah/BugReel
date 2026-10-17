import { vi } from 'vitest';
import type { RawBugReelEvent, BugReelEventId } from '../src/types';
import type { FromWorkerMessage, ToWorkerMessage } from '../src/types';
import type { SensorWindow } from '../src/sensor';

type FakeEl = {
  tag: string;
  innerHTML: string;
  src?: string;
  async?: boolean;
  onload?: (() => void) | null;
  onerror?: (() => void) | null;
  removed: boolean;
  listeners: { type: string; fn: (e: never) => void }[];
  addEventListener(t: string, f: (e: never) => void): void;
  removeEventListener(t: string, f: (e: never) => void): void;
  remove(): void;
  fire(t: string, e: unknown): void;
  load(): void;
};

/**
 * Minimal fake `window` for the sensor/app seam — an event-target registry
 * plus the handful of globals the SDK touches. No DOM emulation needed.
 */
export class FakeWindow {
  listeners: { type: string; fn: (e: never) => void }[] = [];
  location = { href: 'https://app.test/home', hostname: 'app.test', search: '' };
  onmessage: ((e: { data: unknown }) => void) | null = null;
  document = {
    documentElement: { tagName: 'HTML', appendChild(e: unknown) { return e; } },
    activeElement: null as unknown,
    dispatched: [] as { type: string; detail?: unknown }[],
    created: [] as FakeEl[],
    listeners: [] as { type: string; fn: (e: never) => void }[],
    addEventListener(type: string, fn: (e: never) => void) {
      this.listeners.push({ type, fn });
    },
    removeEventListener(type: string, fn: (e: never) => void) {
      this.listeners = this.listeners.filter((l) => l.type !== type || l.fn !== fn);
    },
    /** Deliver an event to addEventListener subscribers (no dispatch record). */
    fire(type: string, e: unknown) {
      for (const l of [...this.listeners]) if (l.type === type) l.fn(e as never);
    },
    /** Elements previously produced by createElement — enough for script lookup. */
    getElementsByTagName(tag: string) {
      return this.created.filter((e) => e.tag === tag.toUpperCase());
    },
    dispatchEvent(e: unknown) {
      const evt = e as { type: string; detail?: unknown };
      this.dispatched.push(evt);
      for (const l of [...this.listeners]) if (l.type === evt.type) l.fn(e as never);
      return true;
    },
    createElement(tag: string): FakeEl {
      const element: FakeEl = {
        tag: tag.toUpperCase(),
        innerHTML: '',
        async: false,
        removed: false,
        listeners: [],
        addEventListener(t: string, f: (e: never) => void) {
          this.listeners.push({ type: t, fn: f });
        },
        removeEventListener(t: string, f: (e: never) => void) {
          this.listeners = this.listeners.filter((l) => l.type !== t || l.fn !== f);
        },
        remove() {
          this.removed = true;
        },
        fire(t: string, e: unknown) {
          for (const l of [...this.listeners]) if (l.type === t) l.fn(e as never);
        },
        load() {
          this.onload?.();
        },
      };
      this.created.push(element);
      return element;
    },
    head: {
      appended: [] as unknown[],
      appendChild(e: unknown) {
        this.appended.push(e);
        return e;
      },
    },
    body: {
      appended: [] as unknown[],
      appendChild(e: unknown) {
        this.appended.push(e);
        return e;
      },
    },
  };
  navigator = { userAgent: 'fake-agent/1.0' };
  history = {
    pushState: (_s: unknown, _t: string, url?: string) => {
      if (url) this.location.href = url;
    },
    replaceState: (_s: unknown, _t: string, url?: string) => {
      if (url) this.location.href = url;
    },
  };
  console = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };
  innerWidth = 1280;
  innerHeight = 800;
  fetch?: (...args: unknown[]) => Promise<unknown>;
  XMLHttpRequest?: unknown;
  MutationObserver?: SensorWindow['MutationObserver'];
  DeviceMotionEvent?: SensorWindow['DeviceMotionEvent'];

  addEventListener(type: string, fn: (e: never) => void): void {
    this.listeners.push({ type, fn });
  }
  removeEventListener(type: string, fn: (e: never) => void): void {
    this.listeners = this.listeners.filter((l) => l.type !== type || l.fn !== fn);
  }
  fire(type: string, event: unknown): void {
    for (const l of [...this.listeners]) if (l.type === type) l.fn(event as never);
  }
  listensTo(type: string): boolean {
    return this.listeners.some((l) => l.type === type);
  }
}

export class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  observed: { root: unknown; options: unknown } | undefined;
  disconnected = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private cb: (mutations: any[]) => void) {
    FakeMutationObserver.instances.push(this);
  }
  observe(root: unknown, options: unknown): void {
    this.observed = { root, options };
  }
  disconnect(): void {
    this.disconnected = true;
  }
  trigger(mutations: unknown[]): void {
    if (!this.disconnected) this.cb(mutations);
  }
  static latest(): FakeMutationObserver {
    return FakeMutationObserver.instances[FakeMutationObserver.instances.length - 1]!;
  }
}

export const fakeResponse = (status = 200, body = '{"ok":true}') => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers({ 'content-type': 'application/json' }),
  clone() {
    return { text: () => Promise.resolve(body) };
  },
});

export class FakeXHR {
  private listeners: { type: string; fn: () => void }[] = [];
  status = 0;
  responseType = '';
  responseText = '';
  response: unknown;
  open(_method?: string, _url?: string): void {}
  send(_body?: unknown): void {}
  setRequestHeader(_name?: string, _value?: string): void {}
  getAllResponseHeaders(): string {
    return 'content-type: application/json\r\n';
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.push({ type, fn });
  }
  finish(): void {
    for (const l of this.listeners) if (l.type === 'loadend') l.fn();
  }
}

/** A Worker-like test double; `ready()` simulates the worker-ready post. */
export const fakeWorker = () => {
  const w = {
    posted: [] as ToWorkerMessage[],
    terminated: false,
    onmessage: null as null | ((e: { data: unknown }) => void),
    postMessage(m: ToWorkerMessage) {
      w.posted.push(m);
    },
    terminate() {
      w.terminated = true;
    },
    ready() {
      w.onmessage?.({ data: { type: 'bugreel:worker-ready' } });
    },
    deliver(m: FromWorkerMessage) {
      w.onmessage?.({ data: m });
    },
  };
  return w;
};

export const collect = () => {
  const events: RawBugReelEvent[] = [];
  const annotations: { id: BugReelEventId; patch: Record<string, unknown> }[] = [];
  return {
    events,
    annotations,
    emit: (e: RawBugReelEvent) => {
      events.push(e);
    },
    annotate: (id: BugReelEventId, patch: Record<string, unknown>) => {
      annotations.push({ id, patch });
    },
  };
};

export const el = (tagName: string, extra: Record<string, unknown> = {}) =>
  ({ tagName, ...extra }) as unknown as Element;

export interface FakeDomInit {
  attrs?: Record<string, string>;
  innerText?: string;
  textContent?: string;
  children?: FakeDomElement[];
  rect?: { x: number; y: number; width: number; height: number };
}

/**
 * Duck-typed Element for the DOM-reading modules (stage-1 gate, enrich):
 * tagName, getAttribute, parentElement, closest, querySelector, innerText,
 * textContent, getBoundingClientRect. `closest` understands only the
 * `[attr]` / `[attr=value i]` selector lists those modules use.
 */
export class FakeDomElement {
  readonly tagName: string;
  readonly innerText?: string;
  readonly textContent?: string;
  parentElement: FakeDomElement | null = null;
  private readonly attrs: Record<string, string>;
  private readonly children: FakeDomElement[] = [];
  private readonly rect?: FakeDomInit['rect'];

  constructor(tagName: string, init: FakeDomInit = {}) {
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...(init.attrs ?? {}) };
    if (init.innerText !== undefined) this.innerText = init.innerText;
    if (init.textContent !== undefined) this.textContent = init.textContent;
    this.rect = init.rect;
    for (const child of init.children ?? []) this.append(child);
  }

  append(child: FakeDomElement): FakeDomElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name]! : null;
  }

  getBoundingClientRect() {
    return this.rect ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  closest(selectors: string): FakeDomElement | null {
    const tests = selectors.split(',').map((part) => {
      const p = part.trim();
      if (/^[\w-]+$/.test(p)) {
        const tag = p.toUpperCase();
        return (node: FakeDomElement) => node.tagName === tag;
      }
      const [, name, value] = /^\[([\w-]+)(?:=(\w+)(?: i)?)?\]$/.exec(p)!;
      return (node: FakeDomElement) => {
        const actual = node.getAttribute(name!);
        return value === undefined ? actual !== null : actual?.toLowerCase() === value;
      };
    });
    for (let node: FakeDomElement | null = this; node; node = node.parentElement) {
      if (tests.some((test) => test(node!))) return node;
    }
    return null;
  }

  /** Descendant matcher for the `h1..h6,legend` heading selector. */
  querySelector(selector: string): FakeDomElement | null {
    const wanted = selector.split(',').map((s) => s.trim().toUpperCase());
    const visit = (node: FakeDomElement): FakeDomElement | null => {
      for (const child of node.children) {
        if (wanted.includes(child.tagName)) return child;
        const hit = visit(child);
        if (hit) return hit;
      }
      return null;
    };
    return visit(this);
  }
}

export const domEl = (tag: string, init?: FakeDomInit): Element =>
  new FakeDomElement(tag, init) as unknown as Element;
