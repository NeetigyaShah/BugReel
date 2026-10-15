import type { EventTargetRef } from './types';

/**
 * Descriptive target enrichment — selector path, human label, nearest
 * heading and bounding rect. Lives in the lazy capture chunk: the loader only
 * emits a minimal `{ selector }` until this is registered. It runs strictly
 * after the stage-1 gate, so it never sees a blocked element.
 */

const MAX_SELECTOR_DEPTH = 6;
const MAX_TEXT_LENGTH = 160;
const MAX_SELECTOR_CLASSES = 3;
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,legend';
const HEADING_CONTAINERS = new Set(['form', 'section', 'fieldset']);

type LabelSource = NonNullable<EventTargetRef['labelSource']>;
type TextProp = 'id' | 'name' | 'type' | 'innerText' | 'textContent';

const clean = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed.slice(0, MAX_TEXT_LENGTH) : undefined;
};
const tagOf = (el: Element): string => (el.tagName ?? '').toLowerCase();
const attrOf = (el: Element, name: string): string | undefined => clean(el.getAttribute?.(name));
const propOf = (el: Element, key: TextProp): string | undefined =>
  clean((el as unknown as Record<TextProp, unknown>)[key]);

const idOf = (el: Element): string | undefined => attrOf(el, 'id') ?? propOf(el, 'id');

const selectorSegment = (el: Element, tag: string): string => {
  const id = idOf(el);
  if (id) return `${tag}#${id}`;
  const classes = (el.getAttribute?.('class') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SELECTOR_CLASSES);
  return classes.length ? `${tag}.${classes.join('.')}` : tag;
};

/** "form#checkout > button.pay" — up to MAX_SELECTOR_DEPTH ancestors. */
const selectorOf = (el: Element): string => {
  const parts: string[] = [];
  for (let node: Element | null = el; node && parts.length < MAX_SELECTOR_DEPTH; node = node.parentElement) {
    const tag = tagOf(node);
    if (!tag || tag === 'html' || tag === 'body') break;
    parts.unshift(selectorSegment(node, tag));
  }
  return parts.join(' > ');
};

const resolveLabel = (el: Element): { label?: string; source: LabelSource } => {
  const candidates: Array<[LabelSource, string | undefined]> = [
    ['innerText', propOf(el, 'innerText')],
    ['aria-label', attrOf(el, 'aria-label')],
    ['placeholder', attrOf(el, 'placeholder')],
    ['textContent', propOf(el, 'textContent')],
  ];
  const hit = candidates.find(([, label]) => label);
  return hit ? { label: hit[1], source: hit[0] } : { source: 'unknown' };
};

/** Nearest form/section/fieldset (or role=form) heading text, walking outward. */
const headingContextOf = (el: Element): string | undefined => {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (!HEADING_CONTAINERS.has(tagOf(node)) && attrOf(node, 'role') !== 'form') continue;
    const heading = node.querySelector?.(HEADING_SELECTOR);
    const text = (heading && propOf(heading, 'textContent')) || attrOf(node, 'aria-label');
    if (text) return text;
  }
  return undefined;
};

const rectOf = (el: Element): EventTargetRef['rect'] => {
  const r = el.getBoundingClientRect?.();
  if (!r) return undefined;
  const { x, y, width, height } = r;
  return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : undefined;
};

/** Full EventTargetRef for an allowed element; degrades to a bare selector on any fault. */
export function describeElement(el: Element): EventTargetRef {
  const tagName = tagOf(el);
  try {
    const { label, source } = resolveLabel(el);
    const inputType = attrOf(el, 'type')?.toLowerCase() ?? (tagName === 'input' ? 'text' : undefined);
    const ref: EventTargetRef = {
      selector: selectorOf(el) || tagName || 'unknown',
      tagName: tagName || undefined,
      id: idOf(el),
      role: attrOf(el, 'role'),
      inputType,
      name: attrOf(el, 'name') ?? propOf(el, 'name'),
      placeholder: attrOf(el, 'placeholder'),
      label,
      labelSource: source,
      headingContext: headingContextOf(el),
      rect: rectOf(el),
    };
    return Object.fromEntries(Object.entries(ref).filter(([, v]) => v !== undefined)) as unknown as EventTargetRef;
  } catch {
    return { selector: tagName || 'unknown' };
  }
}
