// src/parser/save-file.ts
// Dead Island DE — Top-level save file parser / serializer

import { Stream } from "./stream";
import { crc32 } from "../crypto/crc32";
import { parsePlayerData, writePlayerData, PlayerData } from "./player";
import { parseSkills, writeSkills, SkillsData } from "./skills";
import { parseInventory, writeInventory, InventoryData } from "./inventory";
import { parseCollectibles, writeCollectibles, CollectiblesData } from "./collectibles";

// Magic: "DISE" in little-endian ASCII
export const SAVE_MAGIC = 0x45534944;
export const SAVE_VERSION = 1;

export const FLAG_ZSTD_COMPRESSED = 0x01;

export interface SaveFile {
  version: number;
  platformFlags: number;
  flags: number;
  player: PlayerData;
  skills: SkillsData;
  inventory: InventoryData;
  collectibles: CollectiblesData;
}

/**
 * Parse a Dead Island DE save file from a raw buffer.
 * Handles optional zstd decompression.
 */
export async function parseSaveFile(rawBuffer: Buffer): Promise<SaveFile> {
  const header = new Stream(rawBuffer);

  const magic = header.readUInt32();
  if (magic !== SAVE_MAGIC) {
    throw new Error(
      `Invalid save file magic: expected 0x${SAVE_MAGIC.toString(16).toUpperCase()}, ` +
      `got 0x${magic.toString(16).toUpperCase()}`
    );
  }

  const version = header.readUInt32();
  const platformFlags = header.readUInt32();
  const storedChecksum = header.readUInt32();
  const dataSize = header.readUInt32();
  const flags = header.readUInt32();

  let dataBuffer = header.readBytes(dataSize);

  // Decompress if needed
  if (flags & FLAG_ZSTD_COMPRESSED) {
    const { decompress } = await import("fzstd");
    const decompressed = decompress(dataBuffer);
    dataBuffer = Buffer.from(decompressed);
  }

  // Validate checksum
  const computedChecksum = crc32(dataBuffer);
  if (computedChecksum !== storedChecksum) {
    throw new Error(
      `CRC32 mismatch: expected 0x${storedChecksum.toString(16)}, ` +
      `computed 0x${computedChecksum.toString(16)}`
    );
  }

  const data = new Stream(dataBuffer);
  const player = parsePlayerData(data);
  const skills = parseSkills(data);
  const inventory = parseInventory(data);
  const collectibles = parseCollectibles(data);

  return { version, platformFlags, flags, player, skills, inventory, collectibles };
}

/**
 * Serialize a SaveFile back to a binary buffer.
 */
export async function serializeSaveFile(save: SaveFile): Promise<Buffer> {
  // Build data section
  const data = Stream.reserve(4096);
  writePlayerData(data, save.player);
  writeSkills(data, save.skills);
  writeInventory(data, save.inventory);
  writeCollectibles(data, save.collectibles);

  let dataBuffer = data.getBuffer().slice(0, data.position);

  // NOTE: Re-compression is not yet implemented (fzstd is decompress-only).
  // Saves that were originally compressed are written back uncompressed;
  // we clear the compression flag so the checksum is valid on reload.
  const flags = save.flags & ~FLAG_ZSTD_COMPRESSED;

  const checksum = crc32(dataBuffer);

  // Build header + data
  const out = Stream.reserve(24 + dataBuffer.length);
  out.writeUInt32(SAVE_MAGIC);
  out.writeUInt32(save.version);
  out.writeUInt32(save.platformFlags);
  out.writeUInt32(checksum);
  out.writeUInt32(dataBuffer.length);
  out.writeUInt32(flags);
  out.writeBytes(dataBuffer);

  return out.getBuffer().slice(0, out.position);
}
