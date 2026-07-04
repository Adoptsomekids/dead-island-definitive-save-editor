// src/xbox/stfs.ts
// Xbox STFS (Secure Transacted File System) container reader
// Supports Xbox 360 / Xbox One / Xbox Series X profile container format.
// Used to extract the raw save blob from an Xbox profile package.

import { Stream, SeekOrigin } from "../parser/stream";
import { crc32 } from "../crypto/crc32";

// STFS magic constants
export const CON_MAGIC  = 0x434f4e20; // "CON "  — signed by console
export const LIVE_MAGIC = 0x4c495645; // "LIVE"  — signed by Xbox Live
export const PIRS_MAGIC = 0x50495253; // "PIRS"  — signed by Microsoft

export interface StfsHeader {
  magic: number;
  contentType: number;
  titleId: number;
  displayName: string;
  packageSize: number;
}

export interface StfsEntry {
  name: string;
  size: number;
  offset: number;
  isDirectory: boolean;
}

/**
 * Parse the STFS package header from an Xbox container buffer.
 * Returns the header fields and a list of file entries.
 */
export function parseStfsHeader(buffer: Buffer): StfsHeader {
  const s = new Stream(buffer);

  const magic = s.readUInt32(false); // big-endian on Xbox
  if (magic !== CON_MAGIC && magic !== LIVE_MAGIC && magic !== PIRS_MAGIC) {
    throw new Error(
      `Not an STFS package: magic 0x${magic.toString(16).toUpperCase()}`
    );
  }

  // Certificate block starts at 0x004 (360 bytes for CON, different for LIVE/PIRS)
  // Content metadata block starts at 0x0340 on all variants
  s.seek(0x0340);

  const licenseDescriptor = s.readBytes(0x10); // 16 bytes license area (skip)
  const contentId = s.readBytes(0x14);         // SHA1 of header (skip)
  const headerSize = s.readUInt32(false);
  const contentType = s.readUInt32(false);

  // 0x0380: title ID
  s.seek(0x0360);
  const titleId = s.readUInt32(false);

  // 0x0411: display name (UTF-16BE, 128 chars)
  s.seek(0x0411);
  const displayNameBytes = s.readBytes(256);
  const displayName = displayNameBytes.swap16().toString("utf16le").replace(/\0/g, "").trim();

  // Package size / file count heuristics not yet fully reverse-engineered;
  // real implementation requires full STFS table parsing.
  const packageSize = buffer.length;

  return { magic, contentType, titleId, displayName, packageSize };
}

/**
 * Extract the first file blob from an STFS container that matches a name substring.
 * NOTE: Full STFS table parsing is complex; this is a simplified heuristic
 * that locates the file entry table at the known offsets and reads file data.
 * For production use, a full STFS library (e.g. C# Velocity) is recommended.
 */
export function extractFileByName(buffer: Buffer, nameSubstring: string): Buffer | null {
  // The file entry table in STFS is at block 0 of the hash table.
  // Block size = 0x1000 (4096). Table at offset 0xA000 for most saves.
  const TABLE_OFFSET = 0xA000;
  const ENTRY_SIZE = 0x40;
  const MAX_ENTRIES = 64;

  const s = new Stream(buffer);

  for (let i = 0; i < MAX_ENTRIES; i++) {
    const entryOffset = TABLE_OFFSET + i * ENTRY_SIZE;
    if (entryOffset + ENTRY_SIZE > buffer.length) break;

    s.seek(entryOffset);
    const nameBytes = s.readBytes(0x28);
    const nameLen = nameBytes.indexOf(0);
    const name = nameBytes.slice(0, nameLen >= 0 ? nameLen : 0x28).toString("ascii");

    if (name.toLowerCase().includes(nameSubstring.toLowerCase())) {
      // File size at +0x28 (3 bytes), block offset at +0x2F
      s.seek(entryOffset + 0x28);
      const sizeHi = s.readByte();
      const sizeMid = s.readByte();
      const sizeLo = s.readByte();
      const fileSize = (sizeHi << 16) | (sizeMid << 8) | sizeLo;

      s.seek(entryOffset + 0x2F);
      const blockHi = s.readByte();
      const blockMid = s.readByte();
      const blockLo = s.readByte();
      const firstBlock = (blockHi << 16) | (blockMid << 8) | blockLo;

      const dataOffset = 0xC000 + firstBlock * 0x1000; // data area offset
      if (dataOffset + fileSize <= buffer.length) {
        return buffer.slice(dataOffset, dataOffset + fileSize);
      }
    }
  }

  return null;
}
