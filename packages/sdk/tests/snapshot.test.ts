// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
  buildSnapshotSvg,
  canvasToPngBytes,
  captureSnapshot,
  collectDocumentCss,
  isPngBytes,
  serializeForSnapshot,
  shouldStripForSnapshot,
  stripForSnapshot,
  type SnapshotCanvas,
  type SnapshotDeps,
  type SnapshotWindow,
} from '../src/snapshot';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const fakeCanvas = (w: number, h: number): SnapshotCanvas => ({
  width: w,
  height: h,
  getContext: () => ({ drawImage: vi.fn() }),
  toDataURL: () => `data:image/png;base64,${btoa('\x89PNG\x0d\x0a\x1a\x0a')}`,
});

const makeWin = (extra: Partial<SnapshotWindow> = {}): SnapshotWindow => ({
  innerWidth: 800,
  innerHeight: 600,
  devicePixelRatio: 1,
  document: document as unknown as SnapshotWindow['document'],
  ...extra,
});

describe('isPngBytes', () => {
  it('recognizes the PNG signature', () => {
    expect(isPngBytes(PNG)).toBe(true);
    expect(isPngBytes(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(isPngBytes(undefined)).toBe(false);
  });
});

describe('shouldStripForSnapshot', () => {
  it('strips firewall-masked nodes, password/hidden/file inputs, and SDK chrome', () => {
    document.body.innerHTML = `
      <input id="pw" type="password" />
      <input id="hd" type="hidden" />
      <input id="file" type="file" />
      <div id="masked" data-bugreel="mask">x</div>
      <div id="blocked" data-bugreel-block>y</div>
      <div id="flagged" data-bugreel="block">z</div>
      <div id="sens" data-sensitive>s</div>
      <script id="scr"></script>
      <bugreel-modal id="modal"></bugreel-modal>
      <input id="allowed" name="note" data-bugreel="allow" value="keep me" />
      <button id="plain">ok</button>`;
    const $ = (id: string) => document.getElementById(id);
    for (const id of ['pw', 'hd', 'file', 'masked', 'blocked', 'flagged', 'sens', 'scr', 'modal']) {
      expect(shouldStripForSnapshot($(id)), id).toBe(true);
    }
    // detached iframe — happy-dom refuses to host one in a parsed document
    expect(shouldStripForSnapshot(document.createElement('iframe'))).toBe(true);
    // data-bugreel="allow" is an explicit opt-in — it is never stripped.
    expect(shouldStripForSnapshot($('allowed'))).toBe(false);
    expect(shouldStripForSnapshot($('plain'))).toBe(false);
    document.body.innerHTML = '';
  });

  it('stage-1 parity: autocomplete + keyword rules strip form controls', () => {
    document.body.innerHTML = `
      <input id="cc" autocomplete="cc-number" />
      <input id="tok" name="api_token" />
      <textarea id="sec" name="secret_notes">hunter2</textarea>
      <select id="otp" name="otp_code"></select>
      <input id="ship" name="shipping_token" data-bugreel="allow" />
      <div id="card" class="card">kept — keyword rules only gate form controls</div>`;
    const $ = (id: string) => document.getElementById(id);
    for (const id of ['cc', 'tok', 'sec', 'otp']) {
      expect(shouldStripForSnapshot($(id)), id).toBe(true);
    }
    // The allow escape hatch beats the keyword match; non-form elements keep
    // keyword-ish attributes without stripping.
    expect(shouldStripForSnapshot($('ship'))).toBe(false);
    expect(shouldStripForSnapshot($('card'))).toBe(false);
    document.body.innerHTML = '';
  });
});

describe('serializeForSnapshot', () => {
  it('serializes a stripped clone — privacy nodes never reach the SVG', () => {
    document.body.innerHTML = `
      <div id="keep">safe</div>
      <input type="password" value="hunter2" />
      <div data-bugreel="mask"><span>secret</span></div>
      <bugreel-modal></bugreel-modal>`;
    const xml = serializeForSnapshot(document, (n) =>
      new XMLSerializer().serializeToString(n as Node),
    );
    expect(xml).toBeTruthy();
    expect(xml).toContain('safe');
    expect(xml).not.toContain('hunter2');
    expect(xml).not.toContain('secret');
    expect(xml).not.toContain('bugreel-modal');
    expect(xml).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    // The live document is untouched — we stripped a clone.
    expect(document.querySelector('input[type="password"]')).toBeTruthy();
    document.body.innerHTML = '';
  });

  it('injects collected same-origin stylesheet text into <head>', () => {
    const style = document.createElement('style');
    style.textContent = 'body { color: rgb(1, 2, 3); }';
    document.head.appendChild(style);
    const css = collectDocumentCss(document);
    expect(css).toContain('rgb(1, 2, 3)');
    const xml = serializeForSnapshot(document, (n) =>
      new XMLSerializer().serializeToString(n as Node),
    );
    expect(xml).toContain('rgb(1, 2, 3)');
    document.head.removeChild(style);
  });
});

describe('stripForSnapshot', () => {
  it('empties the root when the root itself is blocked', () => {
    const div = document.createElement('div');
    div.setAttribute('data-bugreel', 'mask');
    div.innerHTML = '<span>gone</span>';
    expect(stripForSnapshot(div)).toBe(1);
    expect(div.innerHTML).toBe('');
  });
});

describe('buildSnapshotSvg', () => {
  it('sizes the svg to the viewport and offsets the foreignObject by scroll', () => {
    const svg = buildSnapshotSvg('<html xmlns="http://www.w3.org/1999/xhtml"></html>', {
      width: 800,
      height: 600,
      scrollX: 10,
      scrollY: 320,
      docWidth: 800,
      docHeight: 2000,
    });
    expect(svg).toContain('width="800" height="600"');
    expect(svg).toContain('x="-10" y="-320"');
    expect(svg).toContain('width="800" height="2000"');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });
});

describe('canvasToPngBytes', () => {
  it('decodes a PNG data URL', () => {
    const out = canvasToPngBytes(fakeCanvas(2, 2));
    expect(out && isPngBytes(out)).toBe(true);
  });
  it('returns undefined when toDataURL throws (tainted canvas)', () => {
    const bad: SnapshotCanvas = {
      width: 1,
      height: 1,
      toDataURL: () => {
        throw new Error('SecurityError');
      },
    };
    expect(canvasToPngBytes(bad)).toBeUndefined();
    expect(canvasToPngBytes({ width: 1, height: 1 })).toBeUndefined();
  });
});

describe('captureSnapshot', () => {
  const domDeps = (): SnapshotDeps => ({
    serialize: () => '<html xmlns="http://www.w3.org/1999/xhtml"><body>hi</body></html>',
    loadImage: async () => ({ width: 4, height: 4, source: {} }),
    makeCanvas: fakeCanvas,
    encodePng: () => PNG,
  });

  it('returns the DOM-serialized PNG when the silent path works', async () => {
    const grab = vi.fn(async () => new Uint8Array([9]));
    const pick = vi.fn(async () => new Uint8Array([8]));
    const out = await captureSnapshot(makeWin(), {
      ...domDeps(),
      grabDisplayFrame: grab,
      pickFile: pick,
    });
    expect(out).toBe(PNG);
    expect(grab).not.toHaveBeenCalled();
    expect(pick).not.toHaveBeenCalled();
  });

  it('falls back to getDisplayMedia when DOM serialization fails', async () => {
    const grab = vi.fn(async () => PNG);
    const pick = vi.fn(async () => undefined);
    const out = await captureSnapshot(makeWin(), {
      ...domDeps(),
      serialize: () => {
        throw new Error('serialize blew up');
      },
      grabDisplayFrame: grab,
      pickFile: pick,
    });
    expect(out).toBe(PNG);
    expect(grab).toHaveBeenCalledTimes(1);
    expect(pick).not.toHaveBeenCalled();
  });

  it('falls back to the upload picker when display capture is unavailable', async () => {
    const pick = vi.fn(async () => PNG);
    const out = await captureSnapshot(makeWin(), {
      ...domDeps(),
      loadImage: async () => {
        throw new Error('img refused');
      },
      // navigator.mediaDevices absent → the real getDisplayMedia stage no-ops
      grabDisplayFrame: async () => undefined,
      pickFile: pick,
    });
    expect(out).toBe(PNG);
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it('resolves undefined when every stage fails — and never throws', async () => {
    const out = await captureSnapshot(makeWin(), {
      serialize: () => {
        throw new Error('nope');
      },
      grabDisplayFrame: async () => {
        throw new Error('denied');
      },
      pickFile: async () => undefined,
    });
    expect(out).toBeUndefined();
  });

  it('resolves undefined without a document', async () => {
    expect(await captureSnapshot({})).toBeUndefined();
    // An absent window falls back to globalThis.window — every stage seam is
    // stubbed to fail so the real chain never runs in tests.
    const dead: SnapshotDeps = {
      serialize: () => '',
      grabDisplayFrame: async () => undefined,
      pickFile: async () => undefined,
    };
    expect(await captureSnapshot(undefined, dead)).toBeUndefined();
    expect(await captureSnapshot(null, dead)).toBeUndefined();
  });

  it('skips the display-media stage entirely when the API is missing', async () => {
    // No grabDisplayFrame dep and no navigator.mediaDevices — the default
    // stage must no-op rather than throw, landing on the upload picker.
    const pick = vi.fn(async () => PNG);
    const out = await captureSnapshot(
      makeWin({ navigator: {} }),
      {
        ...domDeps(),
        loadImage: async () => {
          throw new Error('nope');
        },
        pickFile: pick,
      },
    );
    expect(out).toBe(PNG);
    expect(pick).toHaveBeenCalledTimes(1);
  });
});
