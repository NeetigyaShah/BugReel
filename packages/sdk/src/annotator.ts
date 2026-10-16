import { canvasToPngBytes } from './snapshot';
import type { SnapshotCanvas, SnapshotContext, SnapshotImage } from './snapshot';

/**
 * Interactive `<canvas>` annotator (GLOSSARY: Snapshot annotation) — pure
 * DOM/canvas, no dependencies, Shadow-DOM safe. Tools: pen, box, highlight
 * (semi-transparent fill), redact (pixelate brush — downsample → upscale with
 * smoothing off), and a bounded undo stack.
 *
 * Rendering model: a base canvas holds the snapshot + committed strokes; an
 * absolutely-stacked "ink" canvas previews the in-progress stroke so partial
 * shapes never touch the base. On pointer-up the ink canvas is composited
 * down. The redact brush mutates the base directly (pixelation is
 * cumulative), which is why undo snapshots are taken at pointer-down.
 *
 * Everything is guarded — a missing canvas 2d context yields `undefined`, and
 * pointer faults are swallowed. This module ships in the modal chunk only.
 */

export type AnnotatorTool = 'pen' | 'box' | 'highlight' | 'redact';

/** The 2d-context slice the annotator draws through. */
export interface AnnotatorContext extends SnapshotContext {
  getImageData?(x: number, y: number, w: number, h: number): unknown;
  putImageData?(data: unknown, x: number, y: number): void;
  clearRect?(x: number, y: number, w: number, h: number): void;
  beginPath?(): void;
  moveTo?(x: number, y: number): void;
  lineTo?(x: number, y: number): void;
  stroke?(): void;
  strokeRect?(x: number, y: number, w: number, h: number): void;
  strokeStyle?: unknown;
  lineWidth?: number;
  lineCap?: string;
  lineJoin?: string;
}

export interface AnnotatorCanvas extends SnapshotCanvas {
  className?: string;
  style?: { cssText?: string } & Record<string, unknown>;
  setAttribute?(name: string, value: string): void;
  setPointerCapture?(pointerId: number): void;
  getBoundingClientRect?(): { left: number; top: number; width: number; height: number };
  getContext?(id: string): AnnotatorContext | null;
}

/** A canvas paired with its 2d context — the makeCanvas seam's product. */
export interface AnnotatorFrame {
  canvas: AnnotatorCanvas;
  ctx: AnnotatorContext;
}

export interface AnnotatorDocument {
  createElement?(tag: string): any;
}

export interface AnnotatorDeps {
  /** Document seam — default `globalThis.document`. */
  document?: AnnotatorDocument | null;
  /** Canvas factory — tests inject fakes; default creates real canvases. */
  makeCanvas?(width: number, height: number): AnnotatorFrame | undefined;
  /** PNG encoder — default `canvas.toDataURL` + base64 decode. */
  encodePng?(canvas: AnnotatorCanvas): Uint8Array | undefined;
}

export interface AnnotatorOptions extends AnnotatorDeps {
  /** Decoded snapshot painted into the base layer; omit for a blank board. */
  image?: SnapshotImage;
  /** Canvas size when no image supplies one (px). */
  width?: number;
  height?: number;
  /** Done toolbar action — receives the annotated PNG (undefined on encode failure). */
  onDone?(png: Uint8Array | undefined): void;
  /** Cancel toolbar action. */
  onCancel?(): void;
}

export interface AnnotatorHandle {
  /** Root element — mount inside a container (Shadow DOM safe). */
  el: HTMLElement;
  setTool(tool: AnnotatorTool): void;
  undo(): void;
  canUndo(): boolean;
  /** Current base layer as PNG bytes — undefined when encoding fails. */
  toPng(): Uint8Array | undefined;
  destroy(): void;
}

const TOOL_ORDER: AnnotatorTool[] = ['pen', 'box', 'highlight', 'redact'];
const TOOL_LABEL: Record<AnnotatorTool, string> = {
  pen: 'Pen',
  box: 'Box',
  highlight: 'Highlight',
  redact: 'Redact',
};

const UNDO_LIMIT = 10;
const REDACT_BLOCK = 10;
const MIN_W = 240;
const MIN_H = 160;
const MAX_DIM = 2048;
const PEN_COLOR = '#e11d48';
const PEN_WIDTH = 3;
const BOX_COLOR = '#e11d48';
const BOX_WIDTH = 3;
const HIGHLIGHT_COLOR = 'rgba(253,224,71,0.45)';
const HIGHLIGHT_WIDTH = 16;

interface Pt {
  x: number;
  y: number;
}
interface PointerLike {
  clientX?: number;
  clientY?: number;
  pointerId?: number;
  preventDefault?(): void;
}

/**
 * Mount the annotator UI. Pointer listeners live on the stage container so
 * strokes keep tracking while captured, and fake canvases in tests never need
 * to be event targets.
 */
export const createAnnotator = (opts: AnnotatorOptions): AnnotatorHandle | undefined => {
  const doc =
    opts.document ??
    (typeof document !== 'undefined'
      ? (document as unknown as AnnotatorDocument)
      : undefined);
  if (typeof doc?.createElement !== 'function') return undefined;

  const make =
    opts.makeCanvas ??
    ((w: number, h: number): AnnotatorFrame | undefined => {
      try {
        const canvas = doc.createElement?.('canvas') as AnnotatorCanvas;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext?.('2d');
        return ctx ? { canvas, ctx } : undefined;
      } catch {
        return undefined;
      }
    });

  // Canvas dims follow the image aspect; tiny sources upscale to a drawable
  // minimum, huge ones cap at MAX_DIM.
  const iw = Math.round(opts.image?.width ?? 0);
  const ih = Math.round(opts.image?.height ?? 0);
  let W = Math.max(1, Math.round(opts.width ?? 640));
  let H = Math.max(1, Math.round(opts.height ?? 400));
  if (iw > 0 && ih > 0) {
    const grow = Math.max(MIN_W / iw, MIN_H / ih, 1);
    const shrink = Math.min(1, MAX_DIM / Math.max(iw * grow, ih * grow));
    W = Math.max(1, Math.round(iw * grow * shrink));
    H = Math.max(1, Math.round(ih * grow * shrink));
  }

  const base = make(W, H);
  const ink = make(W, H);
  if (!base?.ctx?.drawImage || !ink?.ctx) return undefined;

  try {
    if (opts.image) base.ctx.drawImage?.(opts.image.source, 0, 0, W, H);
  } catch {}

  const cleanups: Array<() => void> = [];
  const on = (
    target: { addEventListener?: (t: string, f: (...a: never[]) => void, o?: unknown) => void; removeEventListener?: (t: string, f: (...a: never[]) => void, o?: unknown) => void } | undefined,
    type: string,
    fn: (...a: never[]) => void,
    options?: unknown,
  ): void => {
    if (!target?.addEventListener) return;
    try {
      target.addEventListener(type, fn, options);
      cleanups.push(() => {
        try {
          target.removeEventListener?.(type, fn, options);
        } catch {}
      });
    } catch {}
  };

  /* ------------------------- DOM ------------------------- */
  let destroyed = false;
  let root: HTMLElement;
  try {
    root = doc.createElement('div') as HTMLElement;
    root.className = 'br-anno-root';
  } catch {
    return undefined;
  }
  let bar: { className: string; appendChild?(c: unknown): unknown };
  let stage: HTMLElement & {
    addEventListener?: (t: string, f: (...a: never[]) => void, o?: unknown) => void;
    removeEventListener?: (t: string, f: (...a: never[]) => void, o?: unknown) => void;
  };
  try {
    bar = doc.createElement('div') as typeof bar;
    stage = doc.createElement('div') as typeof stage;
  } catch {
    return undefined;
  }
  try {
    bar.className = 'br-anno-bar';
    stage.className = 'br-stage';
    base.canvas.setAttribute?.('data-br', 'anno-base');
    ink.canvas.setAttribute?.('data-br', 'anno-ink');
    ink.canvas.className = 'br-anno-ink';
    try {
      stage.appendChild?.(base.canvas as unknown as Node);
    } catch {}
    try {
      stage.appendChild?.(ink.canvas as unknown as Node);
    } catch {}
    root.appendChild?.(bar as unknown as Node);
    root.appendChild?.(stage);
  } catch {
    return undefined;
  }

  /* ------------------------- stroke state ------------------------- */
  let tool: AnnotatorTool = 'pen';
  let drawing = false;
  let sawPointer = false;
  let stroke: Pt[] = [];
  let lastRedact: Pt | undefined;
  const undoStack: unknown[] = [];
  const brushR = Math.max(10, Math.round(Math.min(W, H) / 30));
  const toolButtons = new Map<AnnotatorTool, { classList?: { toggle?(c: string, on: boolean): void } }>();
  let undoBtn: { disabled?: boolean } | undefined;

  const syncUndo = (): void => {
    try {
      if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    } catch {}
  };

  const pushUndo = (): void => {
    try {
      const frame = base.ctx.getImageData?.(0, 0, W, H);
      if (frame !== undefined && frame !== null) {
        undoStack.push(frame);
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      }
    } catch {}
    syncUndo();
  };

  const undo = (): void => {
    const frame = undoStack.pop();
    if (frame === undefined) return;
    try {
      base.ctx.putImageData?.(frame, 0, 0);
    } catch {}
    syncUndo();
  };

  const rectOf = (): { left: number; top: number; width: number; height: number } => {
    try {
      const r = ink.canvas.getBoundingClientRect?.();
      if (r && r.width > 0 && r.height > 0) return r;
    } catch {}
    return { left: 0, top: 0, width: W, height: H };
  };

  /** Pointer event → base-canvas coordinates (handles CSS downscaling). */
  const pointOf = (e: PointerLike): Pt => {
    const r = rectOf();
    return {
      x: (((e.clientX ?? 0) - r.left) * W) / r.width,
      y: (((e.clientY ?? 0) - r.top) * H) / r.height,
    };
  };

  const inside = (p: Pt): boolean => p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H;

  const styleStroke = (ctx: AnnotatorContext, t: AnnotatorTool): void => {
    if (t === 'highlight') {
      ctx.strokeStyle = HIGHLIGHT_COLOR;
      ctx.lineWidth = HIGHLIGHT_WIDTH;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    } else if (t === 'box') {
      ctx.strokeStyle = BOX_COLOR;
      ctx.lineWidth = BOX_WIDTH;
    } else {
      ctx.strokeStyle = PEN_COLOR;
      ctx.lineWidth = PEN_WIDTH;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }
  };

  const drawStroke = (ctx: AnnotatorContext, t: AnnotatorTool, pts: Pt[]): void => {
    if (!pts.length) return;
    try {
      styleStroke(ctx, t);
      const first = pts[0]!;
      const last = pts[pts.length - 1]!;
      if (t === 'box') {
        ctx.strokeRect?.(
          Math.min(first.x, last.x),
          Math.min(first.y, last.y),
          Math.abs(last.x - first.x) || 1,
          Math.abs(last.y - first.y) || 1,
        );
        return;
      }
      ctx.beginPath?.();
      ctx.moveTo?.(first.x, first.y);
      for (const p of pts.slice(1)) ctx.lineTo?.(p.x, p.y);
      if (pts.length === 1) ctx.lineTo?.(first.x + 0.5, first.y + 0.5); // single-tap dot
      ctx.stroke?.();
    } catch {}
  };

  /** Pixelate the region around p — crop → downscale → upscale unsmoothed. */
  const redactAt = (p: Pt): void => {
    try {
      const sx = Math.max(0, Math.floor(p.x - brushR));
      const sy = Math.max(0, Math.floor(p.y - brushR));
      const sw = Math.min(W, p.x + brushR) - sx;
      const sh = Math.min(H, p.y + brushR) - sy;
      if (sw < 2 || sh < 2) return;
      const dw = Math.max(1, Math.floor(sw / REDACT_BLOCK));
      const dh = Math.max(1, Math.floor(sh / REDACT_BLOCK));
      const tmp = make(dw, dh);
      if (!tmp?.ctx?.drawImage) return;
      tmp.ctx.imageSmoothingEnabled = false;
      tmp.ctx.drawImage?.(base.canvas, sx, sy, sw, sh, 0, 0, dw, dh);
      base.ctx.imageSmoothingEnabled = false;
      base.ctx.drawImage?.(tmp.canvas, 0, 0, dw, dh, sx, sy, sw, sh);
    } catch {}
  };

  /* ------------------------- pointer handlers ------------------------- */
  const down = (e: PointerLike): void => {
    try {
      sawPointer = true;
      const p = pointOf(e);
      if (!inside(p) || drawing) return;
      drawing = true;
      stroke = [p];
      lastRedact = undefined;
      pushUndo();
      try {
        ink.canvas.setPointerCapture?.(e.pointerId ?? 0);
      } catch {}
      e.preventDefault?.();
      if (tool === 'redact') {
        redactAt(p);
        lastRedact = p;
      }
    } catch {}
  };

  const move = (e: PointerLike): void => {
    if (!drawing) return;
    try {
      const p = pointOf(e);
      stroke.push(p);
      if (tool === 'redact') {
        const last = lastRedact;
        if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= brushR / 2) {
          redactAt(p);
          lastRedact = p;
        }
        return;
      }
      ink.ctx.clearRect?.(0, 0, W, H);
      drawStroke(ink.ctx, tool, stroke);
    } catch {}
  };

  const up = (): void => {
    if (!drawing) return;
    drawing = false;
    try {
      // Render the final stroke first — a tap with no pointermove (browsers
      // don't synthesize one) must still land its single-point dot.
      if (tool !== 'redact') {
        drawStroke(ink.ctx, tool, stroke);
        base.ctx.drawImage?.(ink.canvas, 0, 0);
      }
      ink.ctx.clearRect?.(0, 0, W, H);
    } catch {}
    stroke = [];
    lastRedact = undefined;
  };

  // Mouse fallback for environments without pointer events — once a real
  // pointer event arrives, the mouse path stays ignored (they double-fire).
  const mouseDown = (e: PointerLike): void => {
    try {
      if (sawPointer) return;
      const p = pointOf(e);
      if (!inside(p) || drawing) return;
      drawing = true;
      stroke = [p];
      lastRedact = undefined;
      pushUndo();
      e.preventDefault?.();
      if (tool === 'redact') {
        redactAt(p);
        lastRedact = p;
      }
    } catch {}
  };
  const mouseMove = (e: PointerLike): void => move(e);
  const mouseUp = (): void => up();

  on(stage, 'pointerdown', down as (...a: never[]) => void);
  on(stage, 'pointermove', move as (...a: never[]) => void);
  on(stage, 'pointerup', up as (...a: never[]) => void);
  on(stage, 'pointercancel', up as (...a: never[]) => void);
  on(stage, 'mousedown', mouseDown as (...a: never[]) => void);
  on(stage, 'mousemove', mouseMove as (...a: never[]) => void);
  // mouseup lives on the document: a drag released outside the stage must
  // still end the stroke (setPointerCapture covers the pointer path only).
  on(doc as unknown as { addEventListener?: (t: string, f: (...a: never[]) => void, o?: unknown) => void }, 'mouseup', mouseUp as (...a: never[]) => void);

  /* ------------------------- toolbar ------------------------- */
  const mkBtn = (
    label: string,
    br: string,
    cls = 'br-tool',
  ): { disabled?: boolean; classList?: { toggle?(c: string, on: boolean): void }; setAttribute?(n: string, v: string): void } | undefined => {
    try {
      const b = doc.createElement?.('button') as {
        className: string;
        textContent: string;
        disabled?: boolean;
        classList?: { toggle?(c: string, on: boolean): void };
        setAttribute?(n: string, v: string): void;
        addEventListener?: (t: string, f: () => void) => void;
        removeEventListener?: (t: string, f: () => void) => void;
      };
      b.className = cls;
      b.textContent = label;
      b.setAttribute?.('type', 'button');
      b.setAttribute?.('data-br', br);
      bar.appendChild?.(b);
      return b;
    } catch {
      return undefined;
    }
  };

  const handle: AnnotatorHandle = {
    el: root,
    setTool(t) {
      tool = t;
      for (const [k, b] of toolButtons) {
        try {
          b?.classList?.toggle?.('br-active', k === t);
        } catch {}
      }
    },
    undo,
    canUndo: () => undoStack.length > 0,
    toPng() {
      try {
        return (opts.encodePng ?? canvasToPngBytes)(base.canvas) ?? undefined;
      } catch {
        return undefined;
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      drawing = false;
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch {}
      }
      try {
        (root as { remove?(): void }).remove?.();
      } catch {}
    },
  };

  for (const t of TOOL_ORDER) {
    const b = mkBtn(TOOL_LABEL[t], `anno-${t}`);
    if (b) {
      toolButtons.set(t, b);
      on(b as { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void }, 'click', () => handle.setTool(t));
    }
  }
  undoBtn = mkBtn('Undo', 'anno-undo');
  if (undoBtn) {
    undoBtn.disabled = true;
    on(undoBtn as { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void }, 'click', () => undo());
  }
  try {
    const spacer = doc.createElement('span') as { className: string };
    spacer.className = 'br-anno-spacer';
    bar.appendChild?.(spacer);
  } catch {}
  const doneBtn = mkBtn('Done', 'anno-done', 'br-tool br-anno-done');
  if (doneBtn) {
    on(doneBtn as { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void }, 'click', () => {
      try {
        opts.onDone?.(handle.toPng());
      } catch {}
    });
  }
  const cancelBtn = mkBtn('Cancel', 'anno-cancel');
  if (cancelBtn) {
    on(cancelBtn as { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void }, 'click', () => {
      try {
        opts.onCancel?.();
      } catch {}
    });
  }

  handle.setTool('pen');
  return handle;
};
