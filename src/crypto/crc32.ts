// src/crypto/crc32.ts
// CRC-32 checksum wrapper

import * as crc from "crc-32";

/**
 * Compute CRC-32 checksum of a buffer (or a slice of it).
 * Returns an unsigned 32-bit integer.
 */
export function crc32(
  buffer: Buffer,
  offset: number = 0,
  length?: number,
  seed: number = 0
): number {
  const slice =
    length !== undefined
      ? buffer.slice(offset, offset + length)
      : offset > 0
      ? buffer.slice(offset)
      : buffer;
  // crc-32 returns a signed int; convert to unsigned
  return (crc.buf(slice, seed) >>> 0);
}
