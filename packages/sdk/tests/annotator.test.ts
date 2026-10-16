// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
  createAnnotator,
  type AnnotatorCanvas,
  type AnnotatorContext,
  type AnnotatorFrame,
} from '../src/annotator';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

interface FakeCtx extends AnnotatorContext {
  calls: string[];
}
interface FakeCanvas extends AnnotatorCanvas {
  ctxRef: FakeCtx;
}

const fakeCtx = (): FakeCtx => {
  const ctx: FakeCtx = {
    calls: [],
    drawImage(source: unknown, ...args: number[]) {
      ctx.calls.push(`drawImage:${args.join(',')}`);
    },
    getImageData(x: number, y: number, w: number, h: number) {
      ctx.calls.push(`getImageData:${x},${y},${w},${h}`);
      return { width: w, height: h, data: new Uint8ClampedArray(4) };
    },
    putImageData(data: unknown, x: number, y: number) {
      ctx.calls.push(`putImageData:${x},${y}`);
    },
    clearRect() {
      ctx.calls.push('clearRect');
    },
    beginPath() {
      ctx.calls.push('beginPath');
    },
    moveTo(x: number, y: number) {
      ctx.calls.push(`moveTo:${x},${y}`);
    },
    lineTo(x: number, y: number) {
      ctx.calls.push(`lineTo:${x},${y}`);
    },
    stroke() {
      ctx.calls.push('stroke');
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      ctx.calls.push(`strokeRect:${x},${y},${w},${h}`);
    },
  };
  return ctx;
};

const fakeFrame = (w: number, h: number): AnnotatorFrame => {
  const ctx = fakeCtx();
  const canvas: FakeCanvas = {
    width: w,
    height: h,
    ctxRef: ctx,
    getContext: () => ctx,
    toDataURL: () => `data:image/png;base64,${btoa('\x89PNG')}`,
  };
  return { canvas, ctx };
};

const setup = (opts: Partial<Parameters<typeof createAnnotator>[0]> = {}) => {
  const frames: { frame: AnnotatorFrame; ctx: FakeCtx; canvas: FakeCanvas }[] = [];
  const h = createAnnotator({
    document: document as never,
    makeCanvas: (w, hh) => {
      const f = fakeFrame(w, hh);
      frames.push({ frame: f, ctx: f.ctx as FakeCtx, canvas: f.canvas as FakeCanvas });
      return f;
    },
    encodePng: () => PNG,
    image: { width: 400, height: 300, source: { fake: 'img' } },
    ...opts,
  });
  return { h: h!, frames, base: frames[0]!, ink: frames[1]! };
};

const evt = (el: Element, type: string, x: number, y: number): void => {
  const e = new window.Event(type, { bubbles: true });
  Object.assign(e, { clientX: x, clientY: y });
  el.dispatchEvent(e);
};

const stage = (h: { el: HTMLElement }): Element => h.el.querySelector('.br-stage')!;
const stroke = (h: { el: HTMLElement }, x1 = 10, y1 = 10, x2 = 50, y2 = 40): void => {
  const s = stage(h);
  evt(s, 'pointerdown', x1, y1);
  evt(s, 'pointermove', x2, y2);
  evt(s, 'pointerup', x2, y2);
};

const click = (h: { el: HTMLElement }, br: string): void =>
  (h.el.querySelector(`[data-br="${br}"]`) as HTMLButtonElement).click();

describe('createAnnotator', () => {
  it('mounts a toolbar + canvas stack; paints the snapshot into the base layer', () => {
    const { h, base } = setup();
    for (const br of ['anno-pen', 'anno-box', 'anno-highlight', 'anno-redact', 'anno-undo', 'anno-done', 'anno-cancel']) {
      expect(h.el.querySelector(`[data-br="${br}"]`), br).toBeTruthy();
    }
    expect(base.ctx.calls[0]).toBe('drawImage:0,0,400,300');
    h.destroy();
  });

  it('returns undefined where a 2d context is unavailable', () => {
    const h = createAnnotator({
      document: document as never,
      makeCanvas: () => undefined,
      image: { width: 10, height: 10, source: {} },
    });
    expect(h).toBeUndefined();
  });

  it('a tap with no pointermove still commits a single-point stroke', () => {
    const { h, base, ink } = setup();
    const s = stage(h);
    evt(s, 'pointerdown', 20, 20);
    evt(s, 'pointerup', 20, 20); // no move — browsers don't synthesize one
    // The dot renders on ink (beginPath+moveTo+lineTo+stroke) then commits.
    expect(ink.ctx.calls).toContain('beginPath');
    expect(ink.ctx.calls).toContain('moveTo:20,20');
    expect(ink.ctx.calls).toContain('lineTo:20.5,20.5'); // single-point dot
    expect(ink.ctx.calls).toContain('stroke');
    expect(base.ctx.calls.filter((c) => c.startsWith('drawImage'))).toHaveLength(2);
    h.destroy();
  });

  it('pen stroke previews on the ink canvas and commits to the base on pointerup', () => {
    const { h, base, ink } = setup();
    stroke(h, 10, 10, 60, 60);
    expect(ink.ctx.calls).toContain('beginPath');
    expect(ink.ctx.calls).toContain('moveTo:10,10');
    expect(ink.ctx.calls).toContain('lineTo:60,60');
    expect(ink.ctx.calls).toContain('stroke');
    // commit = base.drawImage(inkCanvas) after the initial image paint
    expect(base.ctx.calls.filter((c) => c.startsWith('drawImage'))).toHaveLength(2);
    expect(ink.ctx.strokeStyle).toBe('#e11d48');
    h.destroy();
  });

  it('box tool draws a strokeRect between the drag corners', () => {
    const { h, ink } = setup();
    click(h, 'anno-box');
    stroke(h, 20, 20, 80, 70);
    expect(ink.ctx.calls).toContain('strokeRect:20,20,60,50');
    h.destroy();
  });

  it('highlight tool strokes with a semi-transparent wide brush', () => {
    const { h, ink } = setup();
    click(h, 'anno-highlight');
    stroke(h, 5, 5, 30, 30);
    expect(ink.ctx.strokeStyle).toBe('rgba(253,224,71,0.45)');
    expect(ink.ctx.lineWidth).toBe(16);
    h.destroy();
  });

  it('redact pixelates directly on the base (downscale → upscale)', () => {
    const { h, base, frames } = setup();
    click(h, 'anno-redact');
    stroke(h, 100, 100, 140, 120);
    // a scratch canvas was allocated for the downscale pass
    expect(frames.length).toBeGreaterThan(2);
    // base received an upscaled blit of the downscaled scratch region
    expect(base.ctx.calls.some((c) => c.startsWith('drawImage'))).toBe(true);
    expect(base.ctx.imageSmoothingEnabled).toBe(false);
    h.destroy();
  });

  it('undo restores the pre-stroke ImageData and the button state tracks the stack', () => {
    const { h, base } = setup();
    const undoBtn = h.el.querySelector('[data-br="anno-undo"]') as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(true);
    stroke(h);
    expect(base.ctx.calls.some((c) => c.startsWith('getImageData'))).toBe(true);
    expect(h.canUndo()).toBe(true);
    expect(undoBtn.disabled).toBe(false);
    click(h, 'anno-undo');
    expect(base.ctx.calls).toContain('putImageData:0,0');
    expect(h.canUndo()).toBe(false);
    h.destroy();
  });

  it('bounds the undo stack at 10 frames', () => {
    const { h, base } = setup();
    for (let i = 0; i < 14; i++) stroke(h, 10, 10, 20 + i, 20 + i);
    for (let i = 0; i < 14; i++) click(h, 'anno-undo');
    expect(base.ctx.calls.filter((c) => c.startsWith('putImageData'))).toHaveLength(10);
    h.destroy();
  });

  it('toPng returns the encoded base canvas; destroy stops all listeners', () => {
    const { h, ink } = setup();
    stroke(h);
    expect(h.toPng()).toBe(PNG);
    h.destroy();
    const before = ink.ctx.calls.length;
    stroke(h, 1, 1, 2, 2);
    expect(ink.ctx.calls).toHaveLength(before);
  });

  it('Done reports the PNG through onDone; Cancel fires onCancel', () => {
    const onDone = vi.fn();
    const onCancel = vi.fn();
    const { h } = setup({ onDone, onCancel });
    click(h, 'anno-done');
    expect(onDone).toHaveBeenCalledWith(PNG);
    const { h: h2 } = setup({ onCancel });
    click(h2, 'anno-cancel');
    expect(onCancel).toHaveBeenCalledTimes(1);
    h.destroy();
    h2.destroy();
  });
});
