import { describe, expect, it } from 'vitest';
import { initBugReel, openBugReel, version } from '@bugreel/sdk';

describe('public api', () => {
  it('exposes initBugReel returning a handle with open/destroy', () => {
    const handle = initBugReel({ webhookUrl: 'https://example.com/hook', project: 'demo' });
    expect(typeof handle.open).toBe('function');
    expect(typeof handle.destroy).toBe('function');
  });

  it('openBugReel is safe to call before init', () => {
    expect(() => openBugReel()).not.toThrow();
  });

  it('exposes a semver version string', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
