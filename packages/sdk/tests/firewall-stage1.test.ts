import { describe, expect, it } from 'vitest';
import { describeTarget, scrubInputValue } from '../src/firewall/stage1';

/**
 * Duck-typed Element stand-in. stage1 reads only: tagName, getAttribute,
 * hasAttribute, parentElement, querySelector('h1..h6,legend'), innerText,
 * textContent, getBoundingClientRect — no real DOM needed.
 */
interface FakeInit {
  attrs?: Record<string, string>;
  innerText?: string;
  textContent?: string;
  children?: FakeElement[];
  rect?: { x: number; y: number; width: number; height: number };
}

class FakeElement {
  readonly tagName: string;
  private readonly attrs: Record<string, string>;
  readonly innerText?: string;
  readonly textContent?: string;
  parentElement: FakeElement | null = null;
  private readonly children: FakeElement[] = [];
  private readonly rect?: FakeInit['rect'];

  constructor(tagName: string, init: FakeInit = {}) {
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...(init.attrs ?? {}) };
    if (init.innerText !== undefined) this.innerText = init.innerText;
    if (init.textContent !== undefined) this.textContent = init.textContent;
    this.rect = init.rect;
    for (const child of init.children ?? []) this.append(child);
  }

  append(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name]! : null;
  }

  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }

  getBoundingClientRect() {
    return this.rect ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  /** Minimal descendant matcher for the `h1..h6,legend` heading selector. */
  querySelector(selector: string): FakeElement | null {
    const wanted = selector.split(',').map((s) => s.trim().toUpperCase());
    const visit = (node: FakeElement): FakeElement | null => {
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

const el = (tag: string, init?: FakeInit): Element => new FakeElement(tag, init) as unknown as Element;

const rect = { x: 10, y: 20, width: 100, height: 40 };

describe('describeTarget — suppression (no event leaves the element)', () => {
  it('suppresses password, hidden and file inputs', () => {
    expect(describeTarget(el('input', { attrs: { type: 'password' } }))).toBeUndefined();
    expect(describeTarget(el('input', { attrs: { type: 'hidden' } }))).toBeUndefined();
    expect(describeTarget(el('input', { attrs: { type: 'file' } }))).toBeUndefined();
  });

  it('input type matching is case-insensitive', () => {
    expect(describeTarget(el('input', { attrs: { type: 'PASSWORD' } }))).toBeUndefined();
  });

  it('suppresses elements matching or inside [data-bugreel="mask"]', () => {
    expect(describeTarget(el('button', { attrs: { 'data-bugreel': 'mask' } }))).toBeUndefined();

    const region = new FakeElement('div', { attrs: { 'data-bugreel': 'mask' } });
    const inner = region.append(new FakeElement('input', { attrs: { name: 'email' } }));
    expect(describeTarget(inner as unknown as Element)).toBeUndefined();
  });

  it('suppresses elements inside [data-sensitive] subtrees', () => {
    const region = new FakeElement('div', { attrs: { 'data-sensitive': '' } });
    const inner = region.append(new FakeElement('input', { attrs: { name: 'email' } }));
    expect(describeTarget(inner as unknown as Element)).toBeUndefined();
  });

  it('suppresses sensitive autocomplete fields (cc-*, passwords, OTP)', () => {
    for (const autocomplete of [
      'cc-number',
      'cc-csc',
      'current-password',
      'new-password',
      'one-time-code',
      'section-blue shipping cc-number',
    ]) {
      expect(
        describeTarget(el('input', { attrs: { autocomplete } })),
        `autocomplete="${autocomplete}"`,
      ).toBeUndefined();
    }
    expect(describeTarget(el('input', { attrs: { autocomplete: 'email' } }))).toBeDefined();
  });

  it('suppresses sensitive names, ids, placeholders and labels', () => {
    const cases: FakeInit[] = [
      { attrs: { name: 'user_password' } },
      { attrs: { name: 'userPassword' } },
      { attrs: { id: 'api_key' } },
      { attrs: { id: 'apiKey' } },
      { attrs: { name: 'card_number' } },
      { attrs: { name: 'cardNumber' } },
      { attrs: { name: 'cvv' } },
      { attrs: { name: 'pin' } },
      { attrs: { name: 'otpCode' } },
      { attrs: { name: 'auth_code' } },
      { attrs: { placeholder: 'Enter your SSN' } },
      { attrs: { 'aria-label': 'Credit card CVV' } },
      { innerText: 'Enter card number' },
      { attrs: { name: 'secret-question' } },
      { attrs: { name: 'csrf_token' } },
    ];
    for (const init of cases) {
      expect(describeTarget(el('input', init)), JSON.stringify(init)).toBeUndefined();
    }
  });

  it('does NOT mask innocent words that merely contain a keyword substring', () => {
    const safe = ['shipping_address', 'spinner', 'pinterest_handle', 'keyboard', 'tokenize', 'author', 'promo_code'];
    for (const name of safe) {
      expect(describeTarget(el('input', { attrs: { name } })), name).toBeDefined();
    }
  });

  it('data-bugreel="allow" on the element or an ancestor overrides keyword masking', () => {
    expect(
      describeTarget(el('input', { attrs: { name: 'token', 'data-bugreel': 'allow' } })),
    ).toBeDefined();

    const region = new FakeElement('div', { attrs: { 'data-bugreel': 'allow' } });
    const inner = region.append(new FakeElement('input', { attrs: { name: 'card_number' } }));
    expect(describeTarget(inner as unknown as Element)).toBeDefined();
  });

  it('data-bugreel="allow" rescues autocomplete blocking too', () => {
    expect(
      describeTarget(
        el('input', { attrs: { autocomplete: 'cc-number', 'data-bugreel': 'allow' } }),
      ),
    ).toBeDefined();
  });

  it('data-bugreel="allow" NEVER overrides password/hidden/file suppression', () => {
    expect(
      describeTarget(el('input', { attrs: { type: 'password', 'data-bugreel': 'allow' } })),
    ).toBeUndefined();
  });

  it('data-bugreel="allow" cannot punch out of a masked subtree', () => {
    const region = new FakeElement('div', { attrs: { 'data-bugreel': 'mask' } });
    const inner = region.append(
      new FakeElement('input', { attrs: { name: 'email', 'data-bugreel': 'allow' } }),
    );
    expect(describeTarget(inner as unknown as Element)).toBeUndefined();
  });
});

describe('describeTarget — captured EventTargetRef', () => {
  it('builds a selector path like "form#checkout > button.pay"', () => {
    const form = new FakeElement('form', { attrs: { id: 'checkout' } });
    const button = form.append(new FakeElement('button', { attrs: { class: 'pay' } }));
    const ref = describeTarget(button as unknown as Element);
    expect(ref?.selector).toBe('form#checkout > button.pay');
  });

  it('captures tagName, id, role, inputType, name, placeholder and rect', () => {
    const ref = describeTarget(
      el('input', {
        attrs: { id: 'qty', name: 'quantity', type: 'number', placeholder: 'Qty', role: 'spinbutton' },
        rect,
      }),
    );
    expect(ref).toMatchObject({
      tagName: 'input',
      id: 'qty',
      role: 'spinbutton',
      inputType: 'number',
      name: 'quantity',
      placeholder: 'Qty',
      rect: { x: 10, y: 20, width: 100, height: 40 },
    });
  });

  it('defaults inputType to "text" for bare inputs', () => {
    expect(describeTarget(el('input', { attrs: { name: 'city' } }))?.inputType).toBe('text');
  });

  it('resolves the human label by priority innerText > aria-label > placeholder > textContent', () => {
    const all = el('button', {
      attrs: { 'aria-label': 'Aria', placeholder: 'PH' },
      innerText: 'Inner',
      textContent: 'Text',
    });
    expect(describeTarget(all)).toMatchObject({ label: 'Inner', labelSource: 'innerText' });

    const aria = el('button', { attrs: { 'aria-label': 'Aria', placeholder: 'PH' }, textContent: 'Text' });
    expect(describeTarget(aria)).toMatchObject({ label: 'Aria', labelSource: 'aria-label' });

    const ph = el('input', { attrs: { placeholder: 'PH' }, textContent: 'Text' });
    expect(describeTarget(ph)).toMatchObject({ label: 'PH', labelSource: 'placeholder' });

    const text = el('button', { textContent: 'Text' });
    expect(describeTarget(text)).toMatchObject({ label: 'Text', labelSource: 'textContent' });

    const bare = el('div');
    expect(describeTarget(bare)).toMatchObject({ labelSource: 'unknown' });
    expect(describeTarget(bare)?.label).toBeUndefined();
  });

  it('captures the nearest form heading (legend/heading text)', () => {
    const form = new FakeElement('form', { children: [new FakeElement('h2', { textContent: 'Checkout' })] });
    const button = form.append(new FakeElement('button', { innerText: 'Pay' }));
    expect(describeTarget(button as unknown as Element)?.headingContext).toBe('Checkout');
  });

  it('captures a fieldset legend', () => {
    const fieldset = new FakeElement('fieldset', {
      children: [new FakeElement('legend', { textContent: 'Payment Details' })],
    });
    const input = fieldset.append(new FakeElement('input', { attrs: { name: 'memo' } }));
    expect(describeTarget(input as unknown as Element)?.headingContext).toBe('Payment Details');
  });

  it('falls back to the container aria-label when no heading exists', () => {
    const section = new FakeElement('section', { attrs: { 'aria-label': 'Billing' } });
    const input = section.append(new FakeElement('input', { attrs: { name: 'memo' } }));
    expect(describeTarget(input as unknown as Element)?.headingContext).toBe('Billing');
  });

  it('omits headingContext outside any form/section/fieldset', () => {
    expect(describeTarget(el('button', { innerText: 'OK' }))?.headingContext).toBeUndefined();
  });
});

describe('scrubInputValue', () => {
  it('returns the literal value for ordinary fields', () => {
    expect(scrubInputValue(el('input', { attrs: { name: 'promo' } }), 'SAVE20')).toBe('SAVE20');
  });

  it('returns "[N chars]" in strict mode', () => {
    expect(
      scrubInputValue(el('input', { attrs: { name: 'promo' } }), 'SAVE20', { strict: true }),
    ).toBe('[6 chars]');
  });

  it('masked elements record nothing at all', () => {
    const masked = el('input', { attrs: { name: 'x', 'data-bugreel': 'mask' } });
    expect(scrubInputValue(masked, 'secret')).toBeUndefined();
    expect(scrubInputValue(masked, 'secret', { strict: true })).toBeUndefined();
  });

  it('sensitive-type elements yield "[REDACTED]" even in strict mode', () => {
    const pw = el('input', { attrs: { type: 'password' } });
    expect(scrubInputValue(pw, 'hunter2')).toBe('[REDACTED]');
    expect(scrubInputValue(pw, 'hunter2', { strict: true })).toBe('[REDACTED]');
  });

  it('keyword-sensitive names yield "[REDACTED]" unless explicitly allowed', () => {
    expect(scrubInputValue(el('input', { attrs: { name: 'api_key' } }), 'abc')).toBe('[REDACTED]');
    expect(
      scrubInputValue(el('input', { attrs: { name: 'api_key', 'data-bugreel': 'allow' } }), 'abc'),
    ).toBe('abc');
  });
});
