import type { BugReelReport } from '../types';

/**
 * .bugpack builder (ADR-0005) — a ~90-line hand-rolled STORE-mode ZIP writer.
 * No zip dependency: report entries and media are already-compressed formats,
 * so deflate buys nothing. Runs entirely inside the worker chunk.
 *
 * Correctness rules (frozen):
 *  - Names and JSON/markdown are encoded with TextEncoder first; all header
 *    sizes and offsets use Uint8Array.byteLength — never string.length — so
 *    multi-byte characters can't corrupt the archive.
 *  - General Purpose bit 11 (0x0800) marks UTF-8 filenames.
 *  - Entry names are sanitized: no leading separators, no `..` segments.
 */

export interface ZipEntry {
  /** Archive path — sanitized (no `..`, no leading separators) before packing. */
  name: string;
  data: Uint8Array;
}

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Reflected CRC-32 (poly 0xEDB88320), table-driven — RFC 1952. */
export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/**
 * Strip anything that could escape the archive root: leading separators and
 * `.`/`..` segments; backslashes normalized to `/`. Returns null when nothing
 * safe remains — callers skip the entry rather than trusting it.
 */
export function sanitizeEntryName(name: string): string | null {
  // Resolve segments rather than filtering them: `a/../b` collapses to `b`,
  // and a `..` with nothing left to pop is swallowed — never escaping the root.
  const resolved: string[] = [];
  for (const segment of name.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.length ? resolved.join('/') : null;
}

/** DOS date/time fields — UTC getters keep archives byte-reproducible across timezones. */
const dosDateTime = (mtime?: number): { date: number; time: number } => {
  if (mtime === undefined) return { date: 0x0021, time: 0 }; // 1980-01-01 00:00:00
  const d = new Date(mtime);
  if (!Number.isFinite(d.getTime())) return { date: 0x0021, time: 0 };
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear())); // 7-bit field
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  };
};

/** Assemble a STORE-mode ZIP from raw entries. Unsafe names are skipped. */
export function buildZip(entries: ZipEntry[], mtime?: number): Uint8Array {
  const { date, time } = dosDateTime(mtime);
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let entryCount = 0;
  let offset = 0;

  for (const entry of entries) {
    const name = sanitizeEntryName(entry.name);
    if (name === null) continue;
    entryCount += 1;
    const nameBytes = encoder.encode(name);
    if (nameBytes.byteLength > 0xffff) continue; // name-length field is u16 — skip, never corrupt
    const crc = crc32(entry.data);
    const size = entry.data.byteLength;

    const lfh = new DataView(new ArrayBuffer(30));
    lfh.setUint32(0, 0x04034b50, true); // local file header sig
    lfh.setUint16(4, 20, true); // version needed
    lfh.setUint16(6, 0x0800, true); // GP flag bit 11: UTF-8 names
    lfh.setUint16(8, 0, true); // method: STORE
    lfh.setUint16(10, time, true);
    lfh.setUint16(12, date, true);
    lfh.setUint32(14, crc, true);
    lfh.setUint32(18, size, true); // compressed = stored
    lfh.setUint32(22, size, true);
    lfh.setUint16(26, nameBytes.byteLength, true);
    lfh.setUint16(28, 0, true); // no extra field
    local.push(new Uint8Array(lfh.buffer), nameBytes, entry.data);

    const cdfh = new DataView(new ArrayBuffer(46));
    cdfh.setUint32(0, 0x02014b50, true); // central directory sig
    cdfh.setUint16(4, 20, true); // version made by
    cdfh.setUint16(6, 20, true); // version needed
    cdfh.setUint16(8, 0x0800, true);
    cdfh.setUint16(10, 0, true); // STORE
    cdfh.setUint16(12, time, true);
    cdfh.setUint16(14, date, true);
    cdfh.setUint32(16, crc, true);
    cdfh.setUint32(20, size, true);
    cdfh.setUint32(24, size, true);
    cdfh.setUint16(28, nameBytes.byteLength, true);
    // extra len, comment len, disk, internal attrs: all zero (offsets 30-38)
    cdfh.setUint32(38, 0, true); // external attrs
    cdfh.setUint32(42, offset, true); // local header offset
    central.push(new Uint8Array(cdfh.buffer), nameBytes);

    offset += 30 + nameBytes.byteLength + size;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((n, c) => n + c.byteLength, 0);

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  // disk numbers: 0 (offsets 4-8)
  eocd.setUint16(8, entryCount, true); // entries on this disk
  eocd.setUint16(10, entryCount, true); // total entries
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralOffset, true);
  eocd.setUint16(20, 0, true); // no comment

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of [...local, ...central, new Uint8Array(eocd.buffer)]) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const IMAGE_MEDIA = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/**
 * The media entries that will actually land in the archive — names resolved
 * through `sanitizeEntryName`, lite mode keeping images only. Shared by
 * `packBugpack` and the runtime so `report.media` (the manifest inside
 * report.json) always matches the archive contents exactly.
 */
export const selectMediaEntries = (
  media: Record<string, Uint8Array> | undefined,
  options: { lite?: boolean } = {},
): ZipEntry[] => {
  const out: ZipEntry[] = [];
  const seen = new Set<string>();
  for (const [name, data] of Object.entries(media ?? {})) {
    const clean = sanitizeEntryName(name);
    if (clean === null || seen.has(clean)) continue;
    if (options.lite && !IMAGE_MEDIA.test(clean)) continue;
    seen.add(clean);
    out.push({ name: clean, data });
  }
  return out;
};

/**
 * report.json + report.md + media/* → a .bugpack archive.
 * The lite variant (Discord 7.5MB guard) keeps report.json, report.md, and
 * image attachments — video and other heavy media drop out.
 */
export function packBugpack(
  report: BugReelReport,
  media?: Record<string, Uint8Array>,
  options: { lite?: boolean } = {},
): Uint8Array {
  const entries: ZipEntry[] = [
    { name: 'report.json', data: encoder.encode(JSON.stringify(report)) },
    { name: 'report.md', data: encoder.encode(report.outputs.markdown) },
    ...selectMediaEntries(media, options).map((e) => ({ ...e, name: `media/${e.name}` })),
  ];
  return buildZip(entries, Number.isFinite(report.meta.capturedAt) ? report.meta.capturedAt : undefined);
}
