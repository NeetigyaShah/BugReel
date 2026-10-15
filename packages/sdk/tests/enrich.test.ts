import { describe, expect, it } from 'vitest';
import { describeElement } from '../src/enrich';
import { domEl, FakeDomElement } from './fakes';

const rect = { x: 10, y: 20, width: 100, height: 40 };
const asElement = (node: FakeDomElement) => node as unknown as Element;

describe('describeElement', () => {
  it('builds a selector path like "form#checkout > button.pay"', () => {
    const form = new FakeDomElement('form', { attrs: { id: 'checkout' } });
    const button = form.append(new FakeDomElement('button', { attrs: { class: 'pay' } }));
    expect(describeElement(asElement(button)).selector).toBe('form#checkout > button.pay');
  });

  it('captures tagName, id, role, inputType, name, placeholder and rect', () => {
    const ref = describeElement(
      domEl('input', {
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
      rect,
    });
  });

  it('defaults inputType to "text" for bare inputs and omits it elsewhere', () => {
    expect(describeElement(domEl('input', { attrs: { name: 'city' } })).inputType).toBe('text');
    expect(describeElement(domEl('button')).inputType).toBeUndefined();
  });

  it('omits fields it cannot resolve rather than emitting undefined keys', () => {
    expect(Object.keys(describeElement(domEl('div')))).not.toContain('id');
  });

  it('resolves the human label by priority innerText > aria-label > placeholder > textContent', () => {
    const all = domEl('button', {
      attrs: { 'aria-label': 'Aria', placeholder: 'PH' },
      innerText: 'Inner',
      textContent: 'Text',
    });
    expect(describeElement(all)).toMatchObject({ label: 'Inner', labelSource: 'innerText' });

    const aria = domEl('button', { attrs: { 'aria-label': 'Aria', placeholder: 'PH' }, textContent: 'Text' });
    expect(describeElement(aria)).toMatchObject({ label: 'Aria', labelSource: 'aria-label' });

    const placeholder = domEl('input', { attrs: { placeholder: 'PH' }, textContent: 'Text' });
    expect(describeElement(placeholder)).toMatchObject({ label: 'PH', labelSource: 'placeholder' });

    const text = domEl('button', { textContent: 'Text' });
    expect(describeElement(text)).toMatchObject({ label: 'Text', labelSource: 'textContent' });

    const bare = describeElement(domEl('div'));
    expect(bare.labelSource).toBe('unknown');
    expect(bare.label).toBeUndefined();
  });

  it('captures the nearest form heading', () => {
    const form = new FakeDomElement('form', { children: [new FakeDomElement('h2', { textContent: 'Checkout' })] });
    const button = form.append(new FakeDomElement('button', { innerText: 'Pay' }));
    expect(describeElement(asElement(button)).headingContext).toBe('Checkout');
  });

  it('captures a fieldset legend', () => {
    const fieldset = new FakeDomElement('fieldset', {
      children: [new FakeDomElement('legend', { textContent: 'Payment Details' })],
    });
    const field = fieldset.append(new FakeDomElement('input', { attrs: { name: 'memo' } }));
    expect(describeElement(asElement(field)).headingContext).toBe('Payment Details');
  });

  it('falls back to the container aria-label when no heading exists', () => {
    const section = new FakeDomElement('section', { attrs: { 'aria-label': 'Billing' } });
    const field = section.append(new FakeDomElement('input', { attrs: { name: 'memo' } }));
    expect(describeElement(asElement(field)).headingContext).toBe('Billing');
  });

  it('omits headingContext outside any form/section/fieldset', () => {
    expect(describeElement(domEl('button', { innerText: 'OK' })).headingContext).toBeUndefined();
  });

  it('degrades to a bare selector when reading the element throws', () => {
    const broken = {
      tagName: 'BUTTON',
      get parentElement(): never {
        throw new Error('exotic element');
      },
    } as unknown as Element;
    expect(describeElement(broken)).toEqual({ selector: 'button' });
  });
});
