import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOTKEY,
  hotkeyMatches,
  isEditableTarget,
  parseHotkey,
  resolveHotkey,
  shouldShowPill,
} from '../src/triggers';

describe('parseHotkey', () => {
  it('parses "ctrl+shift+b"', () => {
    expect(parseHotkey('ctrl+shift+b')).toEqual({
      key: 'b',
      ctrl: true,
      meta: false,
      shift: true,
      alt: false,
    });
  });

  it('parses "alt+b"', () => {
    expect(parseHotkey('alt+b')).toEqual({
      key: 'b',
      ctrl: false,
      meta: false,
      shift: false,
      alt: true,
    });
  });

  it('parses a bare key', () => {
    expect(parseHotkey('b')).toEqual({
      key: 'b',
      ctrl: false,
      meta: false,
      shift: false,
      alt: false,
    });
  });

  it('accepts cmd/command/option/control synonyms and is case-insensitive', () => {
    expect(parseHotkey('Cmd+Shift+B')).toMatchObject({ key: 'b', meta: true, shift: true });
    expect(parseHotkey('Control+K')).toMatchObject({ key: 'k', ctrl: true });
    expect(parseHotkey('option+b')).toMatchObject({ key: 'b', alt: true });
  });

  it('defaults to ctrl+shift+b when unspecified', () => {
    expect(parseHotkey()).toEqual(parseHotkey(DEFAULT_HOTKEY));
  });

  it('returns undefined without a non-modifier key', () => {
    expect(parseHotkey('ctrl+shift')).toBeUndefined();
    expect(parseHotkey('+++')).toBeUndefined();
  });

  it('returns undefined for two keys in one spec', () => {
    expect(parseHotkey('ctrl+a+b')).toBeUndefined();
  });

  it('resolveHotkey falls back to the default on invalid input', () => {
    expect(resolveHotkey('ctrl+shift')).toEqual(parseHotkey(DEFAULT_HOTKEY));
    expect(resolveHotkey('alt+k')).toMatchObject({ key: 'k', alt: true });
  });
});

describe('hotkeyMatches', () => {
  const hotkey = parseHotkey('ctrl+shift+b')!;

  it('matches ctrl+shift+b', () => {
    expect(hotkeyMatches({ key: 'b', ctrlKey: true, shiftKey: true }, hotkey)).toBe(true);
  });

  it('treats Cmd as the Ctrl modifier (Cmd+Shift+B on macOS)', () => {
    expect(hotkeyMatches({ key: 'b', metaKey: true, shiftKey: true }, hotkey)).toBe(true);
  });

  it('is case-insensitive on the key', () => {
    expect(hotkeyMatches({ key: 'B', ctrlKey: true, shiftKey: true }, hotkey)).toBe(true);
  });

  it('rejects when shift is missing', () => {
    expect(hotkeyMatches({ key: 'b', ctrlKey: true }, hotkey)).toBe(false);
  });

  it('rejects when the modifier is missing', () => {
    expect(hotkeyMatches({ key: 'b', shiftKey: true }, hotkey)).toBe(false);
  });

  it('rejects extra modifiers not in the spec', () => {
    expect(hotkeyMatches({ key: 'b', ctrlKey: true, shiftKey: true, altKey: true }, hotkey)).toBe(false);
  });

  it('rejects a different key', () => {
    expect(hotkeyMatches({ key: 'x', ctrlKey: true, shiftKey: true }, hotkey)).toBe(false);
  });
});

describe('isEditableTarget', () => {
  it('guards input, textarea, select and contentEditable', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('does not guard plain elements or nothing', () => {
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });
});

describe('shouldShowPill', () => {
  it('pill:true always shows, pill:false never does', () => {
    expect(shouldShowPill(true, { hostname: 'example.com' })).toBe(true);
    expect(shouldShowPill(false, { hostname: 'localhost' })).toBe(false);
  });

  it('auto shows on localhost, loopback, and *.local', () => {
    expect(shouldShowPill('auto', { hostname: 'localhost' })).toBe(true);
    expect(shouldShowPill('auto', { hostname: '127.0.0.1' })).toBe(true);
    expect(shouldShowPill('auto', { hostname: '[::1]' })).toBe(true);
    expect(shouldShowPill('auto', { hostname: 'dev.local' })).toBe(true);
    expect(shouldShowPill('auto', { hostname: 'app.localhost' })).toBe(true);
    expect(shouldShowPill('auto', { hostname: '' })).toBe(true);
  });

  it('auto shows when ?bugreel=1 is in the query string', () => {
    expect(shouldShowPill('auto', { hostname: 'example.com', search: '?bugreel=1' })).toBe(true);
    expect(shouldShowPill('auto', { hostname: 'example.com', search: '?a=1&bugreel=1&b=2' })).toBe(true);
  });

  it('auto hides on production hostnames', () => {
    expect(shouldShowPill('auto', { hostname: 'app.example.com' })).toBe(false);
    expect(shouldShowPill('auto', { hostname: 'example.com', search: '?bugreel=0' })).toBe(false);
    expect(shouldShowPill(undefined, { hostname: 'example.com' })).toBe(false);
  });
});
