/**
 * Blob download wiring (main thread) — used by the modal's "Download .bugpack"
 * action. Kept out of the loader chunk: only the lazy capture/modal path
 * imports this.
 */
export function downloadBytes(filename: string, bytes: Uint8Array | Blob, type = 'application/zip'): void {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as unknown as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
