import { describe, expect, it } from 'vitest';
import { gateValue, isBlocked } from '../src/firewall/stage1';
import { domEl, FakeDomElement, type FakeDomInit } from './fakes';

const input = (attrs: Record<string, string>): Element => domEl('input', { attrs });
const asElement = (node: FakeDomElement) => node as unknown as Element;

describe('stage-1 gate — absolute blocks', () => {
  it('blocks password, hidden and file inputs, case-insensitively', () => {
    for (const type of ['password', 'hidden', 'file', 'PASSWORD']) {
      expect(isBlocked(input({ type })), type).toBe(true);
    }
  });

  it('blocks elements matching or inside [data-bugreel="mask"]', () => {
    expect(isBlocked(domEl('button', { attrs: { 'data-bugreel': 'mask' } }))).toBe(true);

    const region = new FakeDomElement('div', { attrs: { 'data-bugreel': 'mask' } });
    expect(isBlocked(asElement(region.append(new FakeDomElement('input', { attrs: { name: 'email' } }))))).toBe(true);
  });

  it('blocks elements inside [data-sensitive] subtrees', () => {
    const region = new FakeDomElement('div', { attrs: { 'data-sensitive': '' } });
    expect(isBlocked(asElement(region.append(new FakeDomElement('span'))))).toBe(true);
  });

  it('data-bugreel="allow" never overrides password/hidden/file blocking', () => {
    expect(isBlocked(input({ type: 'password', 'data-bugreel': 'allow' }))).toBe(true);
  });

  it('data-bugreel="allow" cannot punch out of a masked subtree', () => {
    const region = new FakeDomElement('div', { attrs: { 'data-bugreel': 'mask' } });
    const inner = region.append(new FakeDomElement('input', { attrs: { 'data-bugreel': 'allow' } }));
    expect(isBlocked(asElement(inner))).toBe(true);
  });
});

describe('stage-1 gate — sensitive form controls', () => {
  it('blocks sensitive autocomplete tokens (cc-*, passwords, OTP)', () => {
    for (const autocomplete of [
      'cc-number',
      'cc-csc',
      'current-password',
      'new-password',
      'one-time-code',
      'section-blue shipping cc-number',
    ]) {
      expect(isBlocked(input({ autocomplete })), autocomplete).toBe(true);
    }
    expect(isBlocked(input({ autocomplete: 'email' }))).toBe(false);
  });

  it('blocks controls whose name, id, placeholder or aria-label hold a keyword', () => {
    const cases: Record<string, string>[] = [
      { name: 'user_password' },
      { name: 'userPassword' },
      { id: 'apiKey' },
      { name: 'card_number' },
      { name: 'cvv' },
      { name: 'otp_code' },
      { name: 'tax_id' },
      { placeholder: 'Enter your SSN' },
      { 'aria-label': 'Credit card CVV' },
      { name: 'csrf_token' },
      { name: 'auth_code' },
    ];
    for (const attrs of cases) expect(isBlocked(input(attrs)), JSON.stringify(attrs)).toBe(true);
  });

  it('applies to textarea and select, not just input', () => {
    expect(isBlocked(domEl('textarea', { attrs: { name: 'secret_note' } }))).toBe(true);
    expect(isBlocked(domEl('select', { attrs: { name: 'card_type' } }))).toBe(true);
  });

  it('lets ordinary controls through', () => {
    for (const name of ['promo_code', 'email', 'city', 'quantity']) {
      expect(isBlocked(input({ name })), name).toBe(false);
    }
  });

  it('data-bugreel="allow" on the control or an ancestor rescues keyword and autocomplete blocks', () => {
    expect(isBlocked(input({ name: 'shipping_address', 'data-bugreel': 'allow' }))).toBe(false);
    expect(isBlocked(input({ autocomplete: 'cc-number', 'data-bugreel': 'allow' }))).toBe(false);

    const region = new FakeDomElement('div', { attrs: { 'data-bugreel': 'allow' } });
    expect(isBlocked(asElement(region.append(new FakeDomElement('input', { attrs: { name: 'card_number' } }))))).toBe(false);
  });

  it('known false positive: substring keywords also block names like shipping_address', () => {
    expect(isBlocked(input({ name: 'shipping_address' }))).toBe(true);
  });
});

describe('stage-1 gate — non-form elements', () => {
  it('does not keyword-block buttons or links, so their clicks stay visible to detectors', () => {
    const cases: FakeDomInit[] = [
      { attrs: { id: 'shipping-btn' } },
      { attrs: { 'aria-label': 'Pinterest' } },
      { attrs: { id: 'author-link' } },
    ];
    for (const init of cases) expect(isBlocked(domEl('button', init)), JSON.stringify(init)).toBe(false);
  });
});

describe('stage-1 gate — fail closed', () => {
  it('blocks when reading the element throws', () => {
    const broken = {
      tagName: 'INPUT',
      getAttribute() {
        throw new Error('exotic element');
      },
    } as unknown as Element;
    expect(isBlocked(broken)).toBe(true);
  });
});

describe('gateValue', () => {
  it('returns the literal value by default', () => {
    expect(gateValue('SAVE20')).toBe('SAVE20');
  });

  it('returns the character count in strict mode', () => {
    expect(gateValue('SAVE20', true)).toBe('[6 chars]');
  });
});
