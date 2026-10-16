/**
 * Viewport Snapshot (GLOSSARY): a DOM-derived image of the page — not a
 * pixel-level screen capture. The silent path serializes the live document
 * into an SVG `<foreignObject>`, rasterizes it through `<img>` → canvas, and
 * reads PNG bytes back out. On failure (missing APIs, serialization errors,
 * tainted canvas) the chain falls back to a `getDisplayMedia` single-frame
 * grab (permission prompt — only when the API exists), then a manual upload
 * picker. `captureSnapshot` resolves `undefined` when every path is
 * unavailable.
 *
 * Every entry point is guarded — nothing here ever throws into the host.
 * This module ships in the modal chunk only; the size-budgeted loader never
 * imports it.
 */

/* ------------------------------------------------------------------ */
/* Loose DOM shapes — every member optional so tests can inject fakes.  */
/* ------------------------------------------------------------------ */

export interface SnapshotImage {
  width: number;
  height: number;
  /** Anything `CanvasRenderingContext2D.drawImage` accepts (img/bitmap/canvas). */
  source: unknown;
}

export interface SnapshotContext {
  drawImage?(source: unknown, ...args: number[]): void;
  imageSmoothingEnabled?: boolean;
}

export interface SnapshotCanvas {
  width: number;
  height: number;
  getContext?(id: string): SnapshotContext | null;
  toDataURL?(type?: string): string;
}

interface ElementLike {
  tagName?: string;
  innerHTML?: string;
  getAttribute?(name: string): string | null;
  hasAttribute?(name: string): boolean;
  setAttribute?(name: string, value: string): void;
  remove?(): void;
  cloneNode?(deep: boolean): unknown;
  appendChild?(child: unknown): unknown;
  insertBefore?(child: unknown, ref: unknown): unknown;
  childNodes?: ArrayLike<unknown>;
  children?: ArrayLike<unknown>;
  parentElement?: unknown;
  querySelectorAll?(selector: string): ArrayLike<unknown>;
  clientWidth?: number;
  clientHeight?: number;
  scrollWidth?: number;
  scrollHeight?: number;
}

interface MediaTrackLike {
  stop?(): void;
  getSettings?(): { width?: number; height?: number };
}

interface MediaStreamLike {
  getVideoTracks?(): MediaTrackLike[];
  getTracks?(): MediaTrackLike[];
}

interface ImageLike {
  src?: string;
  width?: number;
  height?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  complete?: boolean;
  onload?: (() => void) | null;
  onerror?: (() => void) | null;
}

export interface SnapshotDocument {
  documentElement?: ElementLike | null;
  body?: { appendChild?(el: unknown): unknown } | null;
  styleSheets?: ArrayLike<{ cssRules?: ArrayLike<{ cssText?: string }> | null }> | null;
  createElement?(tag: string): any;
}

export interface SnapshotWindow {
  innerWidth?: number;
  innerHeight?: number;
  devicePixelRatio?: number;
  scrollX?: number;
  scrollY?: number;
  document?: SnapshotDocument | null;
  navigator?: {
    mediaDevices?: {
      getDisplayMedia?(options?: unknown): Promise<MediaStreamLike>;
    } | null;
  } | null;
  XMLSerializer?: (new () => { serializeToString(node: unknown): string }) | null;
  Image?: (new () => ImageLike) | null;
  URL?: {
    createObjectURL?(blob: Blob): string;
    revokeObjectURL?(url: string): void;
  } | null;
}

export interface SnapshotDeps {
  /** XMLSerializer seam — default serializes via `win.XMLSerializer`. */
  serialize?(node: unknown): string;
  /** Image loader seam — default `new Image()` + src with a timeout. */
  loadImage?(src: string): Promise<SnapshotImage>;
  /** Canvas factory seam — default `document.createElement('canvas')`. */
  makeCanvas?(width: number, height: number): SnapshotCanvas | undefined;
  /** PNG encoder seam — default `canvas.toDataURL` + base64 decode. */
  encodePng?(canvas: SnapshotCanvas): Uint8Array | undefined | Promise<Uint8Array | undefined>;
  /** Fallback-stage override — replaces the whole getDisplayMedia grab. */
  grabDisplayFrame?(win: SnapshotWindow): Promise<Uint8Array | undefined>;
  /** Fallback-stage override — replaces the manual file-upload picker. */
  pickFile?(win: SnapshotWindow): Promise<Uint8Array | undefined>;
  imageTimeoutMs?: number;
  displayTimeoutMs?: number;
}

const IMAGE_TIMEOUT_MS = 6_000;
const DISPLAY_TIMEOUT_MS = 8_000;
const VIDEO_READY_MS = 4_000;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const;

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** PNG signature check — cheap gate for "is this file already a PNG". */
export const isPngBytes = (bytes: Uint8Array | undefined | null): boolean =>
  !!bytes && bytes.length > 4 && PNG_MAGIC.every((b, i) => bytes[i] === b);

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/**
 * Privacy parity with the stage-1 firewall (ADR-0004): elements that must
 * never appear in a Snapshot. `data-bugreel="allow"` subtrees stay — they are
 * an explicit opt-in.
 */
// Mirrors of the stage-1 firewall rules (ADR-0004) — duplicated rather than
// imported because this predicate must work on loose fake shapes where
// `closest()` against `[attr=val i]` selectors is unreliable.
const SNAPSHOT_BLOCKED_TYPE = /^(?:password|hidden|file)$/;
const SNAPSHOT_AUTOCOMPLETE = /(?:^|\s)(?:cc-|current-password|new-password|one-time-code)/;
const SNAPSHOT_ATTR = /pass|pwd|secret|token|key|auth|cvv|cvc|ssn|tax_id|card|pin|otp/;
const SNAPSHOT_FORM = /^(?:input|textarea|select)$/;
const SNAPSHOT_KEYWORD_ATTRS = ['name', 'id', 'placeholder', 'aria-label'];

/** `data-bugreel="allow"` on the node or an ancestor — the stage-1 escape hatch. */
const ancestorAllows = (e: ElementLike): boolean => {
  try {
    for (let n: unknown = e; n; n = (n as ElementLike).parentElement) {
      const flag = String((n as ElementLike).getAttribute?.('data-bugreel') ?? '')
        .toLowerCase()
        .trim();
      if (flag === 'allow') return true;
    }
  } catch {}
  return false;
};

export const shouldStripForSnapshot = (el: unknown): boolean => {
  try {
    const e = el as ElementLike | null | undefined;
    const tag = String(e?.tagName ?? '').toLowerCase();
    if (!tag || e?.getAttribute === undefined) return false;
    if (
      tag === 'script' ||
      tag === 'noscript' ||
      tag === 'template' ||
      tag === 'iframe' ||
      tag === 'frame' ||
      tag === 'frameset' ||
      tag === 'object' ||
      tag === 'embed' ||
      tag === 'bugreel-modal' // our own chrome — never part of the host page
    ) {
      return true;
    }
    const attr = (name: string): string =>
      String(e.getAttribute?.(name) ?? '').toLowerCase();
    const flag = attr('data-bugreel').trim();
    if (flag === 'mask' || flag === 'block') return true;
    if (e.hasAttribute?.('data-bugreel-block') || e.hasAttribute?.('data-sensitive')) return true;
    if (!SNAPSHOT_FORM.test(tag)) return false;
    if (SNAPSHOT_BLOCKED_TYPE.test(attr('type'))) return true;
    // Stage-1 keyword/autocomplete parity (ADR-0004) — attribute-borne
    // secrets (`value`, textarea text) DO serialize into the PNG, so the
    // form-control rules must run here too. Masked ancestors are already
    // pruned by the walker; `data-bugreel="allow"` stays the escape hatch.
    if (ancestorAllows(e)) return false;
    return (
      SNAPSHOT_AUTOCOMPLETE.test(attr('autocomplete')) ||
      SNAPSHOT_KEYWORD_ATTRS.some((name) => SNAPSHOT_ATTR.test(attr(name)))
    );
  } catch {
    return true;
  }
};

/**
 * Remove every privacy-blocked node from a detached clone — the serialized
 * copy must carry the firewall's masking decisions, not the raw DOM.
 * Returns the number of stripped nodes.
 */
export const stripForSnapshot = (root: unknown): number => {
  let removed = 0;
  try {
    const el = root as ElementLike | null | undefined;
    if (!el) return 0;
    if (shouldStripForSnapshot(el)) {
      // A detached clone root cannot remove() itself — empty it instead.
      try {
        el.innerHTML = '';
      } catch {}
      return 1;
    }
    const all = el.querySelectorAll?.('*');
    for (const node of Array.from((all ?? []) as ArrayLike<ElementLike>)) {
      if (!shouldStripForSnapshot(node)) continue;
      try {
        (node as { remove?(): void }).remove?.();
        removed += 1;
      } catch {}
    }
  } catch {}
  return removed;
};

/**
 * CSS text collected from same-origin `document.styleSheets` — embedded into
 * the serialized copy because SVG-as-image contexts never load subresources.
 * Cross-origin sheets throw on `cssRules` access; they are skipped.
 */
export const collectDocumentCss = (doc: SnapshotDocument | null | undefined): string => {
  const chunks: string[] = [];
  try {
    for (const sheet of Array.from((doc?.styleSheets ?? []) as ArrayLike<{ cssRules?: ArrayLike<{ cssText?: string }> | null }>)) {
      try {
        for (const rule of Array.from(sheet?.cssRules ?? [])) {
          if (rule?.cssText) chunks.push(rule.cssText);
        }
      } catch {
        /* cross-origin stylesheet — must not be read */
      }
    }
  } catch {}
  return chunks.join('\n');
};

/**
 * Clone `documentElement`, strip privacy-blocked subtrees, fold same-origin
 * stylesheet text into `<head>`, stamp the XHTML namespace, and serialize to
 * XML — the payload `<foreignObject>` renders.
 */
export const serializeForSnapshot = (
  doc: SnapshotDocument | null | undefined,
  serialize: (node: unknown) => string,
  css = collectDocumentCss(doc),
): string | undefined => {
  try {
    const root = doc?.documentElement;
    if (!root || typeof root.cloneNode !== 'function') return undefined;
    const clone = root.cloneNode(true) as ElementLike | null;
    if (!clone || typeof clone.setAttribute !== 'function') return undefined;
    stripForSnapshot(clone);
    if (css && typeof doc?.createElement === 'function') {
      try {
        const style = doc.createElement('style') as ElementLike & { textContent?: string };
        style.textContent = css;
        let head: ElementLike | undefined;
        for (const child of Array.from((clone.childNodes ?? clone.children ?? []) as ArrayLike<ElementLike>)) {
          if (String(child?.tagName ?? '').toLowerCase() === 'head') {
            head = child;
            break;
          }
        }
        if (!head) {
          head = doc.createElement('head') as ElementLike;
          clone.insertBefore?.(head, clone.childNodes?.[0] ?? null);
        }
        head?.appendChild?.(style);
      } catch {}
    }
    clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    const out = serialize(clone);
    return typeof out === 'string' && out.length ? out : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Wrap serialized XHTML in a viewport-sized SVG. The `<foreignObject>` is
 * sized to the full document and offset by the scroll position so the
 * rasterized region matches what the reporter actually sees.
 */
export const buildSnapshotSvg = (
  xhtml: string,
  dims: {
    width?: number;
    height?: number;
    scrollX?: number;
    scrollY?: number;
    docWidth?: number;
    docHeight?: number;
  },
): string => {
  const w = Math.max(1, Math.round(num(dims.width, 800)));
  const h = Math.max(1, Math.round(num(dims.height, 600)));
  const dw = Math.max(w, Math.round(num(dims.docWidth, w)));
  const dh = Math.max(h, Math.round(num(dims.docHeight, h)));
  const sx = Math.max(0, Math.round(num(dims.scrollX)));
  const sy = Math.max(0, Math.round(num(dims.scrollY)));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="${-sx}" y="${-sy}" width="${dw}" height="${dh}">${xhtml}</foreignObject></svg>`;
};

/** `canvas.toDataURL('image/png')` → raw bytes — throws on taint, hence guarded. */
export const canvasToPngBytes = (canvas: SnapshotCanvas | null | undefined): Uint8Array | undefined => {
  try {
    const url = canvas?.toDataURL?.('image/png');
    if (typeof url !== 'string') return undefined;
    const comma = url.indexOf(',');
    if (comma < 0) return undefined;
    const bin = atob(url.slice(comma + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
};

/* ------------------------------------------------------------------ */
/* Raster plumbing                                                     */
/* ------------------------------------------------------------------ */

/** `new Image()` loader with a hard timeout — resolves only with real dims. */
export const loadImage = (
  win: SnapshotWindow | null | undefined,
  src: string,
  timeoutMs = IMAGE_TIMEOUT_MS,
): Promise<SnapshotImage> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (img?: ImageLike): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!img) {
        reject(new Error('snapshot image failed to load'));
        return;
      }
      const width = Math.round(num(img.naturalWidth, num(img.width)));
      const height = Math.round(num(img.naturalHeight, num(img.height)));
      if (!width || !height) {
        reject(new Error('snapshot image has no dimensions'));
        return;
      }
      resolve({ width, height, source: img });
    };
    const timer = setTimeout(() => finish(), Math.max(100, timeoutMs));
    try {
      const Ctor =
        win?.Image ?? (globalThis as { Image?: new () => ImageLike }).Image;
      if (typeof Ctor !== 'function') {
        finish();
        return;
      }
      const img = new Ctor();
      img.onload = () => finish(img);
      img.onerror = () => finish();
      img.src = src;
    } catch {
      finish();
    }
  });

/** Decode arbitrary image bytes (PNG/JPEG upload) into a drawable image. */
export const decodeImageBytes = async (
  win: SnapshotWindow | null | undefined,
  bytes: Uint8Array,
  deps: SnapshotDeps = {},
): Promise<SnapshotImage | undefined> => {
  let revoke: (() => void) | undefined;
  try {
    const url = win?.URL?.createObjectURL?.(new Blob([bytes as unknown as BlobPart]));
    if (!url) return undefined;
    revoke = () => {
      try {
        win?.URL?.revokeObjectURL?.(url);
      } catch {}
    };
    const load =
      deps.loadImage ??
      ((src: string) => loadImage(win, src, deps.imageTimeoutMs ?? IMAGE_TIMEOUT_MS));
    const img = await load(url);
    return img.width > 0 && img.height > 0 ? img : undefined;
  } catch {
    return undefined;
  } finally {
    revoke?.();
  }
};

/** Draw through a canvas and read back PNG bytes — the shared raster step. */
const rasterize = async (
  width: number,
  height: number,
  draw: (ctx: SnapshotContext) => void,
  deps: SnapshotDeps,
  doc?: SnapshotDocument | null,
): Promise<Uint8Array | undefined> => {
  try {
    const make =
      deps.makeCanvas ??
      ((w: number, h: number): SnapshotCanvas | undefined => {
        const canvas = doc?.createElement?.('canvas') as SnapshotCanvas | undefined;
        if (!canvas) return undefined;
        canvas.width = w;
        canvas.height = h;
        return canvas;
      });
    const canvas = make(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
    const ctx = canvas?.getContext?.('2d');
    if (!canvas || !ctx?.drawImage) return undefined;
    draw(ctx);
    const out = deps.encodePng ? await deps.encodePng(canvas) : canvasToPngBytes(canvas);
    return out?.length ? out : undefined;
  } catch {
    return undefined;
  }
};

/* ------------------------------------------------------------------ */
/* Capture stages                                                      */
/* ------------------------------------------------------------------ */

/** Stage 1 — silent `foreignObject` serialization → canvas → PNG. */
const domSnapshot = async (
  win: SnapshotWindow,
  deps: SnapshotDeps,
): Promise<Uint8Array | undefined> => {
  try {
    const doc = win.document;
    if (!doc) return undefined;
    const serialize =
      deps.serialize ??
      ((node: unknown): string => {
        const S =
          win.XMLSerializer ??
          (globalThis as { XMLSerializer?: new () => { serializeToString(n: unknown): string } })
            .XMLSerializer;
        if (!S) return '';
        return new S().serializeToString(node);
      });
    const xhtml = serializeForSnapshot(doc, serialize);
    if (!xhtml) return undefined;
    const docEl = doc.documentElement;
    const vw = Math.max(1, Math.round(num(win.innerWidth, num(docEl?.clientWidth, 800))));
    const vh = Math.max(1, Math.round(num(win.innerHeight, num(docEl?.clientHeight, 600))));
    const dpr = Math.min(3, Math.max(0.5, num(win.devicePixelRatio, 1)));
    const svg = buildSnapshotSvg(xhtml, {
      width: vw,
      height: vh,
      scrollX: num(win.scrollX),
      scrollY: num(win.scrollY),
      docWidth: num(docEl?.scrollWidth, vw),
      docHeight: num(docEl?.scrollHeight, vh),
    });
    let src: string;
    let revoke: (() => void) | undefined;
    try {
      const url = win.URL?.createObjectURL?.(
        new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
      );
      if (url) {
        src = url;
        revoke = () => {
          try {
            win.URL?.revokeObjectURL?.(url);
          } catch {}
        };
      } else {
        src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      }
    } catch {
      src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }
    let img: SnapshotImage | undefined;
    try {
      img = await (deps.loadImage ??
        ((s: string) => loadImage(win, s, deps.imageTimeoutMs ?? IMAGE_TIMEOUT_MS)))(src);
    } finally {
      revoke?.();
    }
    if (!img) return undefined;
    const w = Math.max(1, Math.round(vw * dpr));
    const h = Math.max(1, Math.round(vh * dpr));
    return await rasterize(w, h, (ctx) => ctx.drawImage?.(img!.source, 0, 0, w, h), deps, doc);
  } catch {
    return undefined;
  }
};

const stopTracks = (stream: MediaStreamLike | undefined): void => {
  try {
    for (const track of stream?.getTracks?.() ?? stream?.getVideoTracks?.() ?? []) {
      try {
        track.stop?.();
      } catch {}
    }
  } catch {}
};

const timed = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>((res) => setTimeout(() => res(undefined), ms))]);

const waitEvent = (
  el: { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void },
  name: string,
  ms: number,
): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const fin = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        el.removeEventListener?.(name, fin);
      } catch {}
      resolve();
    };
    const timer = setTimeout(fin, Math.max(50, ms));
    try {
      el.addEventListener?.(name, fin);
    } catch {
      fin();
    }
  });

/**
 * Stage 2 — `getDisplayMedia` single-frame grab. Permission prompt; only runs
 * when the API exists. A bounded timeout keeps a stuck picker from wedging the
 * chain — the reporter's later grant is still stopped, not leaked.
 */
const displaySnapshot = async (
  win: SnapshotWindow,
  deps: SnapshotDeps,
): Promise<Uint8Array | undefined> => {
  let stream: MediaStreamLike | undefined;
  try {
    const md = win.navigator?.mediaDevices;
    if (typeof md?.getDisplayMedia !== 'function') return undefined;
    const request = Promise.resolve(md.getDisplayMedia({ video: true }));
    stream = await timed(request, deps.displayTimeoutMs ?? DISPLAY_TIMEOUT_MS);
    if (!stream) {
      // Timed out (or rejects late) — stop tracks if the grant lands anyway.
      request.then((s) => stopTracks(s)).catch(() => {});
      return undefined;
    }
    const video = win.document?.createElement?.('video') as
      | ({
          muted?: boolean;
          srcObject?: unknown;
          videoWidth?: number;
          videoHeight?: number;
          play?(): Promise<unknown>;
          setAttribute?(n: string, v: string): void;
          addEventListener?(t: string, f: () => void): void;
          removeEventListener?(t: string, f: () => void): void;
        } & Record<string, unknown>)
      | undefined;
    if (!video) return undefined;
    try {
      video.muted = true;
      try {
        video.setAttribute?.('playsinline', '');
      } catch {}
      video.srcObject = stream;
      await waitEvent(video, 'loadeddata', VIDEO_READY_MS);
      try {
        await timed(Promise.resolve(video.play?.()), VIDEO_READY_MS);
      } catch {}
      const settings = stream.getVideoTracks?.()[0]?.getSettings?.() ?? {};
      const w = Math.round(num(video.videoWidth, num(settings.width)));
      const h = Math.round(num(video.videoHeight, num(settings.height)));
      if (!w || !h) return undefined;
      return await rasterize(w, h, (ctx) => ctx.drawImage?.(video, 0, 0, w, h), deps, win.document);
    } finally {
      try {
        video.srcObject = null;
      } catch {}
    }
  } catch {
    return undefined;
  } finally {
    stopTracks(stream);
  }
};

/**
 * Stage 3 — manual upload: a hidden `<input type=file>` the reporter picks
 * through. Non-PNG images are normalized through decode → canvas → PNG.
 */
const uploadSnapshot = async (
  win: SnapshotWindow,
  deps: SnapshotDeps,
): Promise<Uint8Array | undefined> => {
  try {
    const doc = win.document;
    const input = doc?.createElement?.('input') as
      | ({
          type?: string;
          accept?: string;
          files?: ArrayLike<{ arrayBuffer?(): Promise<ArrayBuffer> }> | null;
          style?: { cssText?: string };
          click?(): void;
          remove?(): void;
          setAttribute?(n: string, v: string): void;
          addEventListener?(t: string, f: () => void): void;
        } & Record<string, unknown>)
      | undefined;
    if (!input || !doc?.body?.appendChild) return undefined;
    try {
      input.type = 'file';
      input.accept = 'image/*';
      input.setAttribute?.('data-br', 'snapshot-upload');
      if (input.style) {
        input.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0';
      }
      doc.body.appendChild(input);
    } catch {
      return undefined;
    }
    const file = await timed(new Promise<unknown>((resolve) => {
      let done = false;
      const fin = (v: unknown): void => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      try {
        input.addEventListener?.('change', () => fin(input.files?.[0]));
        input.addEventListener?.('cancel', () => fin(undefined));
        if (typeof input.click === 'function') input.click();
        else fin(undefined);
      } catch {
        fin(undefined);
      }
    }), 120_000); // engines without a 'cancel' event must not hang the chain
    try {
      input.remove?.();
    } catch {}
    const f = file as { arrayBuffer?(): Promise<ArrayBuffer> } | undefined;
    if (typeof f?.arrayBuffer !== 'function') return undefined;
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!bytes.length) return undefined;
    const img = await decodeImageBytes(win, bytes, deps);
    if (img) {
      const png = await rasterize(
        img.width,
        img.height,
        (ctx) => ctx.drawImage?.(img.source, 0, 0, img.width, img.height),
        deps,
        doc,
      );
      if (png?.length) return png;
    }
    // Undecodable but already a PNG — ship the raw bytes.
    return isPngBytes(bytes) ? bytes : undefined;
  } catch {
    return undefined;
  }
};

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Capture the viewport Snapshot as PNG bytes. Fallback order: silent
 * foreignObject rasterization → `getDisplayMedia` frame grab → manual upload.
 * Resolves `undefined` when all three are unavailable/cancelled/fail.
 */
export const captureSnapshot = async (
  win?: SnapshotWindow | null,
  deps: SnapshotDeps = {},
): Promise<Uint8Array | undefined> => {
  const w =
    win ??
    (typeof window !== 'undefined' ? (window as unknown as SnapshotWindow) : undefined);
  if (!w?.document) return undefined;
  for (const stage of [
    () => domSnapshot(w, deps),
    () => (deps.grabDisplayFrame ?? displaySnapshot)(w, deps),
    () => (deps.pickFile ?? uploadSnapshot)(w, deps),
  ]) {
    try {
      const bytes = await stage();
      if (bytes?.length) return bytes;
    } catch {
      /* fall through to the next fallback — never throw into the host */
    }
  }
  return undefined;
};
