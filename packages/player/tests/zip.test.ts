// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
// Dev-time only: the test round-trips against the real writer, so a drift in
// the .bugpack format breaks here rather than in the player at runtime.
import { buildZip } from '../../sdk/src/worker/bugpack';
import { readStoreZip, ZipReadError } from '../src/zip';

const enc = new TextEncoder();
const dec = new TextDecoder();

const asMap = (entries: ReturnType<typeof readStoreZip>) =>
  new Map(entries.map((e) => [e.name, e.data]));

describe('readStoreZip', () => {
  it('round-trips a real STORE zip built by the sdk writer', () => {
    const zip = buildZip([
      { name: 'report.json', data: enc.encode('{"schemaVersion":"1.0"}') },
      { name: 'report.md', data: enc.encode('# Report') },
      { name: 'media/snapshot-annotated.png', data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const entries = asMap(readStoreZip(zip));
    expect([...entries.keys()]).toEqual([
      'report.json',
      'report.md',
      'media/snapshot-annotated.png',
    ]);
    expect(dec.decode(entries.get('report.json'))).toBe('{"schemaVersion":"1.0"}');
    expect(dec.decode(entries.get('report.md'))).toBe('# Report');
    expect(entries.get('media/snapshot-annotated.png')).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('decodes UTF-8 entry names and multi-byte content', () => {
    const zip = buildZip([
      { name: 'media/截屏.png', data: enc.encode('café ☕ → 100%') },
    ]);
    const [entry] = readStoreZip(zip);
    expect(entry?.name).toBe('media/截屏.png');
    expect(dec.decode(entry?.data)).toBe('café ☕ → 100%');
  });

  it('accepts an ArrayBuffer as well as Uint8Array', () => {
    const zip = buildZip([{ name: 'a.txt', data: enc.encode('hi') }]);
    const buf = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
    expect(readStoreZip(buf)[0]?.name).toBe('a.txt');
  });

  it('rejects non-zip input with ZipReadError', () => {
    expect(() => readStoreZip(new Uint8Array(0))).toThrow(ZipReadError);
    expect(() => readStoreZip(enc.encode('this is not a zip file at all, nope'))).toThrow(
      ZipReadError,
    );
  });

  it('rejects a truncated archive', () => {
    const zip = buildZip([{ name: 'report.json', data: enc.encode('{}') }]);
    expect(() => readStoreZip(zip.slice(0, zip.length - 5))).toThrow(ZipReadError);
  });

  it('rejects deflate entries — .bugpack is STORE-only', () => {
    const zip = buildZip([{ name: 'report.json', data: enc.encode('{}') }]);
    // Patch compression method 0 → 8 in both the local header (+8) and the
    // central directory record (+10) to simulate a foreign zip.
    zip[8] = 8;
    let cdir = -1;
    for (let i = 0; i < zip.length - 4; i++) {
      if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02) {
        cdir = i;
        break;
      }
    }
    zip[cdir + 10] = 8;
    expect(() => readStoreZip(zip)).toThrow(/compression method 8/);
  });
});
