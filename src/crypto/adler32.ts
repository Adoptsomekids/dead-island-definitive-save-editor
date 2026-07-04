// src/crypto/adler32.ts
// Adler-32 checksum — pure TypeScript implementation

const MOD_ADLER = 65521;
const NMAX = 3800;

/**
 * Compute Adler-32 checksum of a buffer.
 * @param buffer - Input data
 * @param initial - Initial checksum value (default 1)
 */
export function adler32(buffer: Buffer, initial: number = 1): number {
  let a = initial & 0xffff;
  let b = (initial >>> 16) & 0xffff;
  let i = 0;
  const len = buffer.length;

  while (i < len) {
    const end = Math.min(i + NMAX, len);
    while (i < end) {
      a += buffer[i++];
      b += a;
    }
    a %= MOD_ADLER;
    b %= MOD_ADLER;
  }

  return ((b << 16) | a) >>> 0;
}
