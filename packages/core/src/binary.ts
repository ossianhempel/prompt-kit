export function isBinaryBuffer(buffer: Uint8Array): boolean {
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}
