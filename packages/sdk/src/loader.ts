import { initBugReel } from './index';

export { initBugReel as init, openBugReel as open, version } from './index';
export type { BugReelConfig, BugReelHandle } from './index';

if (typeof document !== 'undefined') {
  const script = document.currentScript;
  if (script instanceof HTMLScriptElement) {
    const attrs = script.dataset;
    try {
      initBugReel({
        webhookUrl: attrs.bugreelWebhook,
        hotkey: attrs.bugreelHotkey,
        pill: attrs.bugreelPill === undefined ? 'auto' : attrs.bugreelPill === 'true',
        shake: attrs.bugreelShake === 'true',
        privacyMode: attrs.bugreelPrivacy === 'strict' ? 'strict' : 'standard',
        project: attrs.bugreelProject,
        app: attrs.bugreelApp,
      });
    } catch {
      // SDK failures must never propagate into the host app.
    }
  }
}
