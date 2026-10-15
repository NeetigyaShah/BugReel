/** Hotkey parsing/matching, editable-focus guard, and pill visibility policy. */

export interface HotkeySpec {
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

export const DEFAULT_HOTKEY = 'ctrl+shift+b';

const MODIFIER_ALIASES: Record<string, 'ctrl' | 'meta' | 'alt' | 'shift' | undefined> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};

/**
 * `'ctrl+shift+b'` / `'cmd+shift+b'` / `'alt+b'` → spec. Modifier tokens
 * (including macOS `cmd`/`option`/`control` aliases) are order-free; exactly
 * one non-modifier token is the key — a second one invalidates the spec.
 */
export function parseHotkey(spec: string = DEFAULT_HOTKEY): HotkeySpec | undefined {
  if (typeof spec !== 'string') return undefined;
  const out: HotkeySpec = { key: '', ctrl: false, meta: false, shift: false, alt: false };
  for (const token of spec.toLowerCase().split('+')) {
    const t = token.trim();
    const modifier = MODIFIER_ALIASES[t];
    if (modifier) out[modifier] = true;
    else if (!t) continue;
    else if (out.key) return undefined; // second non-modifier token
    else out.key = t;
  }
  return out.key ? out : undefined;
}

/** Config override, falling back to `Ctrl+Shift+B` when absent or invalid. */
export const resolveHotkey = (configured: string | undefined): HotkeySpec =>
  parseHotkey(configured) || (parseHotkey() as HotkeySpec);

export interface HotkeyEventLike {
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  preventDefault?(): void;
}

/**
 * Exact match — Cmd and Ctrl count as the same "primary" modifier
 * (`Ctrl+Shift+B` on Windows/Linux == `Cmd+Shift+B` on macOS); any extra or
 * missing modifier rejects.
 */
export function hotkeyMatches(e: HotkeyEventLike, spec: HotkeySpec): boolean {
  if (!e || typeof e.key !== 'string' || e.key.toLowerCase() !== spec.key) return false;
  return (
    !!(e.ctrlKey || e.metaKey) === (spec.ctrl || spec.meta) &&
    !!e.altKey === spec.alt &&
    !!e.shiftKey === spec.shift
  );
}

/**
 * The editable-focus guard (ADR-0007): never hijack typing contexts.
 * `isContentEditable` already accounts for inherited `contenteditable`.
 */
export function isEditableTarget(el: unknown): boolean {
  const e = el as { tagName?: unknown; isContentEditable?: unknown } | undefined;
  if (!e || typeof e !== 'object') return false;
  const tag = typeof e.tagName === 'string' ? e.tagName.toLowerCase() : '';
  return tag === 'input' || tag === 'textarea' || tag === 'select' || !!e.isContentEditable;
}

/**
 * `'auto'` shows the pill on dev surfaces only (localhost, loopback — IPv4/6 —
 * *.local, *.localhost, empty/file hosts, or a `?bugreel=1` URL flag);
 * `true` always shows, `false` never.
 */
export function shouldShowPill(
  pill: 'auto' | boolean | undefined,
  loc: { hostname?: string; search?: string },
): boolean {
  if (pill === true) return true;
  if (pill === false) return false;
  try {
    const host = String(loc.hostname ?? '');
    if (
      !host ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host.endsWith('.local')
    )
      return true;
    const flag = new URLSearchParams(String(loc.search ?? '')).get('bugreel');
    return flag === '1' || flag === 'true';
  } catch {
    return false;
  }
}
