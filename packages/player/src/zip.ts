/**
 * Minimal STORE-mode ZIP reader for .bugpack archives (ADR-0005) — the read
 * side of the worker's hand-rolled writer. Parses EOCD → central directory →
 * local headers and extracts uncompressed (method 0) entries. Names decode as
 * UTF-8 (well-formed archives carry GP flag bit 11; decoding unconditionally
 * is harmless for ASCII and forgiving elsewhere).
 *
 * No dependencies and deliberately small: a .bugpack is always STORE-mode, so
 * anything else — deflate entries, spanned archives, truncated data — is a
 * foreign file and surfaces as a single catchable `ZipReadError`.
 */

export interface ZipEntryData {
  /** Archive path as written by the packer, e.g. "media/snapshot-annotated.png". */
  name: string;
  /** Stored bytes — copied out so entries stay valid if the source buffer detaches. */
  data: Uint8Array;
}

/** Every malformed-archive condition funnels into this one catchable type. */
export class ZipReadError extends Error {}

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const STORE = 0;

const fail = (message: string): never => {
  throw new ZipReadError(message);
};

/**
 * Parse a STORE-mode ZIP into plain name/data entries.
 * Throws `ZipReadError` — and only that — on any malformed or foreign input.
 */
export function readStoreZip(input: Uint8Array | ArrayBuffer): ZipEntryData[] {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 22) fail('not a ZIP archive (too small)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();

  // End Of Central Directory: fixed 22-byte record + up to 64KiB of comment.
  let eocd = -1;
  const floor = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let i = bytes.byteLength - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail('not a ZIP archive (no end-of-central-directory record)');

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out: ZipEntryData[] = [];

  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== CDIR_SIG) {
      fail('corrupt central directory');
    }
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true); // compressed size == stored size
    const nameLen = view.getUint16(at + 28, true);
    const skip = view.getUint16(at + 30, true) + view.getUint16(at + 32, true); // extra + comment
    const local = view.getUint32(at + 42, true);
    if (at + 46 + nameLen > bytes.byteLength) fail('corrupt central directory');
    const name = text.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + skip;

    if (method !== STORE) fail(`unsupported compression method ${method} for '${name}'`);
    if (local + 30 > bytes.byteLength || view.getUint32(local, true) !== LFH_SIG) {
      fail(`corrupt local header for '${name}'`);
    }
    // The local header's own name/extra lengths decide where data starts —
    // they can differ from the central directory's.
    const start =
      local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + size > bytes.byteLength) fail(`truncated entry '${name}'`);
    out.push({ name, data: bytes.slice(start, start + size) });
  }
  return out;
}
