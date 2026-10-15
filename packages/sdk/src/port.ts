/**
 * Private channel for the main-thread `<script>` fallback (strict CSP, no
 * Worker). `worker.global.js` publishes a port on `globalThis` instead of
 * touching `window.onmessage` / `window.postMessage`, so the host page's own
 * message handlers are never overwritten and never see SDK traffic.
 */
export const PORT_KEY = '__bugreelPort';

export interface MainThreadPort {
  /** transport -> worker */
  receive(data: unknown): void;
  /** worker -> transport; assigned by the transport once the script has loaded */
  reply: ((message: unknown) => void) | null;
}
