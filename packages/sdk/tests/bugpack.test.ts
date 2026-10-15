import { describe, expect, it } from 'vitest';
import { buildZip, packBugpack, sanitizeEntryName, type ZipEntry } from '../src/worker/bugpack';
import { compileReport } from '../src/worker/pipeline';
import { meta } from './helpers';
import type { ClickEvent } from '../src/types';

// --- a minimal stdlib-equivalent ZIP reader: round-trips our writer --------

interface ParsedEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  data: Uint8Array;
}

const dec = new TextDecoder();

function readZip(bytes: Uint8Array): ParsedEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // locate the End Of Central Directory record
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd, 'EOCD signature').toBeGreaterThanOrEqual(0);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const out: ParsedEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(offset, true), `cd[${i}] sig`).toBe(0x02014b50);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = dec.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;

    // read the local header to find the data
    expect(view.getUint32(localOffset, true), `${name} LFH sig`).toBe(0x04034b50);
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = bytes.slice(dataStart, dataStart + compSize);
    expect(data.length, `${name} stored size`).toBe(size);
    out.push({ name, flags, method, crc, data });
  }
  return out;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const refCrc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

// --- tests -----------------------------------------------------------------

const click: ClickEvent = {
  id: 'c1',
  at: 1_699_999_999_000,
  type: 'click',
  target: { selector: 'button#pay', label: 'Pay Now', labelSource: 'innerText' },
};

const report = compileReport({
  events: [click],
  findings: [],
  meta: { ...meta, capturedAt: 1_700_000_000_000 },
  answers: { tryingToDo: 'Pay' },
});

describe('sanitizeEntryName', () => {
  it('strips traversal and leading separators', () => {
    expect(sanitizeEntryName('../evil.png')).toBe('evil.png');
    expect(sanitizeEntryName('../../etc/passwd')).toBe('etc/passwd');
    expect(sanitizeEntryName('/abs/path.png')).toBe('abs/path.png');
    expect(sanitizeEntryName('./dot.png')).toBe('dot.png');
    expect(sanitizeEntryName('a\\b\\c.png')).toBe('a/b/c.png');
    expect(sanitizeEntryName('media/../shot.png')).toBe('shot.png');
  });

  it('rejects names that sanitize to nothing', () => {
    expect(sanitizeEntryName('..')).toBeNull();
    expect(sanitizeEntryName('/')).toBeNull();
    expect(sanitizeEntryName('')).toBeNull();
    expect(sanitizeEntryName('../..')).toBeNull();
  });
});

describe('buildZip', () => {
  const enc = new TextEncoder();

  it('emits a STORE archive that round-trips through a stdlib-style reader', () => {
    const entries: ZipEntry[] = [
      { name: 'report.json', data: enc.encode('{"a":1}') },
      { name: 'media/shot.png', data: enc.encode('PNGDATA') },
    ];
    const parsed = readZip(buildZip(entries));
    expect(parsed.map((e) => e.name)).toEqual(['report.json', 'media/shot.png']);
    expect(parsed.map((e) => e.method)).toEqual([0, 0]); // STORE
    expect(parsed[0]?.data).toEqual(enc.encode('{"a":1}'));
    expect(parsed[1]?.data).toEqual(enc.encode('PNGDATA'));
  });

  it('computes CRC32 correctly (known vector: "123456789" -> 0xCBF43926)', () => {
    const zip = buildZip([{ name: 'v.txt', data: enc.encode('123456789') }]);
    const [entry] = readZip(zip);
    expect(entry?.crc).toBe(0xcbf43926);
    expect(entry?.crc).toBe(refCrc32(enc.encode('123456789')));
  });

  it('handles multi-byte UTF-8 content and filenames without corrupting offsets', () => {
    const content = enc.encode('Clicked → pay — 100% café ☕');
    const zip = buildZip([
      { name: 'media/截屏.png', data: content },
      { name: 'report.md', data: enc.encode('# Título — with → arrows') },
    ]);
    const parsed = readZip(zip);
    expect(parsed[0]?.name).toBe('media/截屏.png');
    expect((parsed[0]?.flags ?? 0) & 0x0800).toBe(0x0800); // UTF-8 filename flag
    expect(parsed[0]?.data).toEqual(content);
    expect(dec.decode(parsed[1]?.data)).toBe('# Título — with → arrows');
  });
});

describe('packBugpack', () => {
  it('assembles report.json + report.md + media/* into a valid archive', () => {
    const media = {
      'snapshot-annotated.png': new Uint8Array([1, 2, 3]),
      'clip.webm': new Uint8Array([9, 9]),
    };
    const parsed = readZip(packBugpack(report, media));
    expect(parsed.map((e) => e.name)).toEqual([
      'report.json',
      'report.md',
      'media/snapshot-annotated.png',
      'media/clip.webm',
    ]);
    const json = JSON.parse(dec.decode(parsed[0]?.data)) as { schemaVersion: string };
    expect(json.schemaVersion).toBe('1.0');
    expect(dec.decode(parsed[1]?.data)).toBe(report.outputs.markdown);
    expect(parsed[2]?.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('lite variant keeps images and drops video', () => {
    const media = {
      'shot.png': new Uint8Array([1]),
      'clip.webm': new Uint8Array([2, 2]),
      'photo.jpg': new Uint8Array([3]),
      'notes.txt': new Uint8Array([4]),
    };
    const parsed = readZip(packBugpack(report, media, { lite: true }));
    // lite = JSON + markdown + images only — video and arbitrary files drop
    expect(parsed.map((e) => e.name)).toEqual([
      'report.json',
      'report.md',
      'media/shot.png',
      'media/photo.jpg',
    ]);
  });

  it('sanitizes hostile media filenames instead of trusting them', () => {
    const media = { '../../../escape.png': new Uint8Array([7]), 'safe.png': new Uint8Array([8]) };
    const parsed = readZip(packBugpack(report, media));
    expect(parsed.map((e) => e.name)).toEqual(['report.json', 'report.md', 'media/escape.png', 'media/safe.png']);
  });

  it('dedupes names that sanitize identically — first wins', () => {
    const media = { 'x/../a.png': new Uint8Array([1]), 'a.png': new Uint8Array([2]) };
    const parsed = readZip(packBugpack(report, media));
    expect(parsed.map((e) => e.name)).toEqual(['report.json', 'report.md', 'media/a.png']);
    expect(parsed[2]?.data).toEqual(new Uint8Array([1]));
  });

  it('is deterministic — same inputs produce identical bytes', () => {
    const media = { 's.png': new Uint8Array([1]) };
    expect(packBugpack(report, media)).toEqual(packBugpack(report, media));
  });
});
