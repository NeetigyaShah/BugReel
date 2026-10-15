import type { SensorDocument } from './sensor';

/**
 * Minimal `<bugreel-pill>` Trigger — a floating "Report a bug" affordance.
 * No custom-element registration or Shadow DOM: it only needs to exist,
 * look right, and open the modal. Inline styles keep it isolated enough for
 * a dev-surface widget (the full modal gets Shadow DOM, per ADR-0003).
 */
export function mountPill(
  doc: SensorDocument,
  onOpen: () => void,
): { remove(): void } | undefined {
  try {
    const el = doc.createElement?.('bugreel-pill') as
      | (HTMLElement & { addEventListener?: (t: string, f: () => void) => void })
      | undefined;
    const parent = doc.body ?? (doc.documentElement as { appendChild?: (e: unknown) => unknown });
    if (!el || !parent?.appendChild) return undefined;
    el.innerHTML =
      `<button style="all:unset;cursor:pointer;position:fixed;bottom:16px;right:16px;` +
      `z-index:2147483000;background:#111827;color:#fff;border-radius:99px;` +
      `padding:8px 14px;font:600 13px system-ui">Report a bug</button>`;
    el.addEventListener?.('click', () => {
      try {
        onOpen();
      } catch {}
    });
    parent.appendChild(el);
    return el;
  } catch {
    return undefined;
  }
}
