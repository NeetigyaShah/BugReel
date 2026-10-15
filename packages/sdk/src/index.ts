export * from './types';
export const version = '0.1.0';

export interface BugReelConfig {
  webhookUrl?: string;
  hotkey?: string;
  pill?: 'auto' | boolean;
  shake?: boolean;
  privacyMode?: 'standard' | 'strict';
  user?: { id?: string; email?: string };
  project?: string;
  app?: string;
}

export interface BugReelHandle {
  open(): void;
  destroy(): void;
}

let active: BugReelHandle | undefined;

export function initBugReel(config: BugReelConfig = {}): BugReelHandle {
  const handle: BugReelHandle = {
    open() {},
    destroy() {
      if (active === handle) active = undefined;
    },
  };
  void config;
  active = handle;
  return handle;
}

export function openBugReel(): void {
  active?.open();
}
