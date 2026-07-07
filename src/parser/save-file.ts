// src/parser/save-file.ts
// Dead Island DE — Top-level save file parser / serializer
//
// FORMAT (reverse-engineered from real Xbox Series X blobs, July 2026):
//
//  [gzip compressed outer blob]
//    → decompress → inner save bytes
//
//  Inner save bytes:
//   0x000 [u32 sentinel=0xFFFFFFFF]
//   0x004 [u32 unk0=0]
//   0x008 [u32 saveVersion=5]
//   0x00C [u32 unk1=12]
//   0x010 [u32 unk2=5]
//   0x014 [u32 level]
//   0x018 [u32 maxHP]
//   0x01C [u32 currHP]
//   0x020 [u32 unk3=0]
//   0x024 [u32 unk4=2]
//   0x028 [u32 unk5=12]
//   0x02C [u32 unk6=3]
//   0x030 → Location block (wstr16 strings)
//         mapName, checkpoint, spawnPoint, postSpawn(u32), charTypeKey
//         unk_byte0, charClassId, unk_u16, quickSlotCnt(u32), unk_inv(u32)
//         checkpoint2, unk_C(u32), unk_D(u32), money(u32), unk_E(u32)
//         saveYear(u16), saveMonth(u8), saveDay(u8), saveHour(u8), saveMinute(u8)
//         unk_F(u16), unk_G(u16), invSectCnt(u32), unk_pad(u8)
//   → Weapon quick slots: sentinel(u32=0xFFFFFFFF), count(u32), [WeaponItem × N]
//   → Inventory items (consumables/parts): count(u32), [InvItem × N]
//   → Skills data (fixed-size)
//   → Quest / collectibles data
//   → Map fog data

import * as zlib from "zlib";
import { Stream } from "./stream";

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface SaveHeader {
  sentinel: number;        // 0xFFFFFFFF
  saveVersion: number;     // 5
  level: number;           // 1–60
  maxHP: number;
  currHP: number;
  // raw unknowns preserved for round-trip
  _raw_unk: number[];      // 8 u32 values at 0x004–0x02C (unk0..unk6)
}

export interface SaveLocation {
  mapName: string;         // e.g. "ACT1A"
  checkpoint: string;      // e.g. "HubChapter_2_3_4_9"
  spawnPoint: string;      // e.g. "auto_SP_RH_Sinamoi_Hut"
  charTypeKey: string;     // e.g. "Type;SamB"
  charClassId: number;     // 0=Xian, 1=Logan, 2=SamB, 3=Purna
  checkpoint2: string;     // e.g. "ACT1A_Sinamoi_Busy"
  money: number;           // player wallet
  saveYear: number;
  saveMonth: number;
  saveDay: number;
  saveHour: number;
  saveMinute: number;
  quickSlotCount: number;
  // raw unknowns
  _raw: {
    postSpawn: number; unk_byte0: number; unk_u16: number;
    unk_inv: number; unk_C: number; unk_D: number; unk_E: number;
    unk_F: number; unk_G: number; invSectCnt: number; unk_pad: number;
  };
}

export interface WeaponItem {
  // 57-byte fixed preamble (spawn position + internal state)
  preamble: Buffer;        // 57 raw bytes preserved for round-trip
  itemId: string;          // e.g. "Melee_BoGen"
  craftplanId: string;     // e.g. "Craftplan_Naildcraft" or ""
  itemUID: number;         // per-item unique ID
  quantity: number;        // stack / ammo count
  durability: number;      // float e.g. 60.54
  itemLevel: number;       // tier / level
}

export interface InventoryItem {
  itemId: string;          // e.g. "CraftPart_MetalScrap"
  containerId: string;     // e.g. "None"
  itemUID: number;
  quantity: number;
  unk_f: number;           // float, often -1.0
  unk_pad: number;
}

export interface SkillEntry {
  skillIndex: number;
  unlocked: boolean;
}

/** Storage (chest/stash) item — same structure as WeaponItem but stored in rawTail */
export interface StorageItem {
  itemId: string;
  craftplanId: string;
  itemUID: number;
  quantity: number;
  durability: number;
  itemLevel: number;
}

/** Complete parsed save file */
export interface SaveFile {
  header: SaveHeader;
  location: SaveLocation;
  quickSlotSentinel: number;    // always 0xFFFFFFFF
  /** The currently held / equipped weapon (has a 57-byte spawn preamble) */
  heldWeapon: WeaponItem;
  /** Quick-slot weapons (no preamble, count = location.quickSlotCount) */
  quickSlots: WeaponItem[];
  /** 3 separator values between weapons and inventory section */
  _invSeparators: [number, number, number];
  inventory: InventoryItem[];
  /** Player storage/stash items (parsed from rawTail section 1) */
  storage: StorageItem[];
  /** Raw tail bytes — everything after the storage section until EOF */
  rawTail: Buffer;
  /** If set, the weapon/inventory section could not be fully parsed (e.g. prologue saves) */
  _parseError?: string;
}

// ─── Character class helpers ──────────────────────────────────────────────────

export const CHARACTER_CLASS: Record<number, string> = {
  0: "Xian Mei",
  1: "Logan Carter",
  2: "Sam B",
  3: "Purna",
};

export const CHARACTER_CLASS_BY_KEY: Record<string, number> = {
  "Type;XianMei": 0,
  "Type;Xian": 0,    // alternate spelling seen in some saves
  "Type;Logan": 1,
  "Type;SamB": 2,
  "Type;Purna": 3,
};

// ─── Decompression ───────────────────────────────────────────────────────────

/**
 * If the buffer starts with gzip magic (1F 8B), decompress it.
 * Otherwise returns the buffer unchanged.
 */
export function maybeDecompress(buf: Buffer): Buffer {
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    return zlib.gunzipSync(buf);
  }
  return buf;
}

/**
 * Re-compress a buffer using gzip (same compression as the game).
 */
export function gzipCompress(buf: Buffer): Buffer {
  return zlib.gzipSync(buf, { level: zlib.constants.Z_DEFAULT_COMPRESSION });
}

// ─── PREAMBLE SIZE CONSTANT ───────────────────────────────────────────────────

/**
 * Known preamble sizes for the held weapon across different save types:
 *   - 57 bytes: late-game ACT1A saves (save_1 format)
 *   - 82 bytes: early-game ACT1A saves (save_2 format, HubChapter_1)
 *   - 100 bytes: Hotel/Prologue saves (save_0 format)
 *
 * The preamble always starts with 24 fixed bytes (XYZ position + orient + 2 unk floats),
 * followed by a variable-length section that encodes slot info.
 * We auto-detect the correct preamble size at parse time.
 */
export const WEAPON_PREAMBLE_SIZE = 57; // default / legacy
export const KNOWN_PREAMBLE_SIZES = [57, 82, 100, 48, 36, 24, 64, 72, 88, 96];

/**
 * Detect the preamble size for the held weapon in a save buffer.
 * Scans ahead from the given offset for the first plausible WStr
 * that looks like a Dead Island item ID (Melee_, Firearm_, None, Fists, etc.)
 * Returns the detected preamble byte count, or -1 if not found.
 */
export function detectPreambleSize(buf: Buffer, preambleStart: number, maxSearch = 150): number {
  const VALID_PREFIXES = ["Melee_", "Firearm_", "CraftPart_", "Fists", "None", "Knife", "Ammo", "Car ", "Throwable_"];
  for (let off = preambleStart; off < preambleStart + maxSearch - 2; off++) {
    const len = buf.readUInt16LE(off);
    if (len === 0 || len > 80) continue;
    if (off + 2 + len > buf.length) continue;
    const s = buf.slice(off + 2, off + 2 + len).toString("utf8");
    if (VALID_PREFIXES.some(p => s.startsWith(p))) {
      return off - preambleStart;
    }
  }
  return -1;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a decompressed Dead Island DE save buffer.
 * Call `maybeDecompress(raw)` first if you have a raw atom blob.
 */
export function parseSaveFile(decompressed: Buffer): SaveFile {
  const s = Stream.from(decompressed);

  // ── Header ──────────────────────────────────────────────────────────────
  const sentinel = s.readUInt32();
  if (sentinel !== 0xFFFFFFFF) {
    throw new Error(`Invalid save sentinel: 0x${sentinel.toString(16).toUpperCase()}`);
  }

  const unkArr: number[] = [];
  unkArr.push(s.readUInt32()); // unk0 = 0
  const saveVersion = s.readUInt32();
  unkArr.push(s.readUInt32()); // unk1 = 12
  unkArr.push(s.readUInt32()); // unk2 = 5
  const level    = s.readUInt32();
  const maxHP    = s.readUInt32();
  const currHP   = s.readUInt32();
  unkArr.push(s.readUInt32()); // unk3 = 0
  unkArr.push(s.readUInt32()); // unk4 = 2
  unkArr.push(s.readUInt32()); // unk5 = 12
  unkArr.push(s.readUInt32()); // unk6 = 3

  const header: SaveHeader = {
    sentinel, saveVersion, level, maxHP, currHP, _raw_unk: unkArr,
  };

  // ── Location block ───────────────────────────────────────────────────────
  const mapName      = s.readWStr();
  const checkpoint   = s.readWStr();
  const spawnPoint   = s.readWStr();
  const postSpawn    = s.readUInt32();
  const charTypeKey  = s.readWStr();
  const unk_byte0    = s.readByte();
  const charClassId  = s.readByte();
  const unk_u16      = s.readUInt16();
  const quickSlotCount = s.readUInt32();
  const unk_inv      = s.readUInt32();
  const checkpoint2  = s.readWStr();
  const unk_C        = s.readUInt32();
  const unk_D        = s.readUInt32();
  const money        = s.readUInt32();
  const unk_E        = s.readUInt32();
  const saveYear     = s.readUInt16();
  const saveMonth    = s.readByte();
  const saveDay      = s.readByte();
  const saveHour     = s.readByte();
  const saveMinute   = s.readByte();
  const unk_F        = s.readUInt16();
  const unk_G        = s.readUInt16();
  const invSectCnt   = s.readUInt32();
  const unk_pad      = s.readByte();

  const location: SaveLocation = {
    mapName, checkpoint, spawnPoint, charTypeKey, charClassId,
    checkpoint2, money, saveYear, saveMonth, saveDay, saveHour, saveMinute,
    quickSlotCount,
    _raw: { postSpawn, unk_byte0, unk_u16, unk_inv, unk_C, unk_D, unk_E, unk_F, unk_G, invSectCnt, unk_pad },
  };

  // ── Weapon sections ──────────────────────────────────────────────────────
  // Save a snapshot of position BEFORE reading sentinel so we can fall back
  const weaponSectionStart = s.position;
  const quickSlotSentinel = s.readUInt32(); // 0xFFFFFFFF
  const wsCount = s.readUInt32();

  let heldWeapon: WeaponItem;
  const quickSlots: WeaponItem[] = [];
  let _invSeparators: [number, number, number] = [1, 0, 1];
  const inventory: InventoryItem[] = [];
  let parseError: string | null = null;

  try {
    // Auto-detect the preamble size for the held weapon.
    // Different save types have different preamble lengths:
    //   57 bytes  → late-game ACT1A (save_1)
    //   82 bytes  → early-game ACT1A HubChapter_1 (save_2)
    //   100 bytes → Hotel / Prologue (save_0)
    const bufSlice = s.getBuffer().slice(s.position);
    const detectedPreamble = detectPreambleSize(bufSlice, 0, 150);
    const preambleSize = detectedPreamble >= 0 ? detectedPreamble : WEAPON_PREAMBLE_SIZE;

    // Snapshot position to detect if this save uses a "standard" layout or not.
    // Standard layout = preamble size exactly matches WEAPON_PREAMBLE_SIZE (57) AND
    // the post-weapon separators are [1, 0, 1] and invCount is plausible.
    const isStandardLayout = (preambleSize === 57);

    if (isStandardLayout) {
      // ── Standard layout (save_1, late-game ACT1A) ──────────────────────
      const heldPreamble = s.readBytes(preambleSize);
      heldWeapon = {
        preamble:    heldPreamble,
        itemId:      s.readWStr(),
        craftplanId: s.readWStr(),
        itemUID:     s.readUInt32(),
        quantity:    s.readUInt32(),
        durability:  s.readFloat(),
        itemLevel:   s.readUInt32(),
      };

      for (let i = 0; i < wsCount; i++) {
        quickSlots.push({
          preamble:    Buffer.alloc(0),
          itemId:      s.readWStr(),
          craftplanId: s.readWStr(),
          itemUID:     s.readUInt32(),
          quantity:    s.readUInt32(),
          durability:  s.readFloat(),
          itemLevel:   s.readUInt32(),
        });
      }

      _invSeparators = [s.readUInt32(), s.readUInt32(), s.readUInt32()];
      const invCount = s.readUInt32();
      for (let i = 0; i < invCount; i++) {
        const itemId      = s.readWStr();
        const containerId = s.readWStr();
        const itemUID     = s.readUInt32();
        const quantity    = s.readUInt32();
        const unk_f       = s.readFloat();
        const unk_pad     = s.readUInt32();
        inventory.push({ itemId, containerId, itemUID, quantity, unk_f, unk_pad });
      }

    } else {
      // ── Non-standard layout (save_0 Hotel/Prologue, save_2 early-game) ──
      // These saves use a larger preamble and may have trailing bytes per weapon.
      // We parse the held weapon and as many quick-slots as cleanly possible,
      // but we don't attempt a lossless round-trip (basic edits still work).
      const heldPreamble = s.readBytes(preambleSize);
      heldWeapon = {
        preamble:    heldPreamble,
        itemId:      s.readWStr(),
        craftplanId: s.readWStr(),
        itemUID:     s.readUInt32(),
        quantity:    s.readUInt32(),
        durability:  s.readFloat(),
        itemLevel:   s.readUInt32(),
      };

      // Best-effort: read quick-slots until parse fails or we hit the inventory separator
      const RAW_BUF = s.getBuffer();
      // A trailing 0x00 byte may follow each weapon in these save formats
      const VALID_ID_RE = /^(Melee_|Firearm_|CraftPart_|Fists|None|Knife|Ammo|Car|Throwable_)/;
      for (let i = 0; i < wsCount; i++) {
        // Skip a possible 0x00 trailing byte
        while (s.position < s.length && RAW_BUF[s.position] === 0x00) {
          const nextLen = RAW_BUF.readUInt16LE(s.position + 1);
          if (nextLen > 0 && nextLen < 80) { s.readByte(); break; }
          break;
        }
        if (s.remaining < 6) break;
        const peekLen = RAW_BUF.readUInt16LE(s.position);
        if (peekLen === 0 || peekLen > 80) break; // likely hit separator/inventory area
        const peekStr = RAW_BUF.slice(s.position + 2, s.position + 2 + peekLen).toString("utf8");
        if (!VALID_ID_RE.test(peekStr) && peekStr !== "") break;

        quickSlots.push({
          preamble:    Buffer.alloc(0),
          itemId:      s.readWStr(),
          craftplanId: s.readWStr(),
          itemUID:     s.readUInt32(),
          quantity:    s.readUInt32(),
          durability:  s.readFloat(),
          itemLevel:   s.readUInt32(),
        });
      }

      // The rest of the weapon/inventory section goes into rawTail for this format.
      // This preserves byte-perfect integrity for basic edits (money/level/HP).
      // Set a soft parse error to indicate weapon editing is limited.
      parseError = `non-standard layout (preamble=${preambleSize}b) — basic edits work, weapon/inv editing limited`;
      // Reset to weaponSectionStart so rawTail has the whole section
      s.position = weaponSectionStart;
    }

  } catch (err: any) {
    // Parse failure — fall back: keep everything from weaponSectionStart as rawTail
    parseError = err.message;
    heldWeapon = { preamble: Buffer.alloc(0), itemId: "", craftplanId: "", itemUID: 0, quantity: 0, durability: 0, itemLevel: 0 };
    // Reset stream to save the weapon section as raw bytes
    s.position = weaponSectionStart;
  }

  // ── Raw tail — parse storage section first ───────────────────────────────
  const tailBuf = s.readToEnd();
  const storage: StorageItem[] = [];
  let rawTail: Buffer = tailBuf;

  // Only parse storage if the main weapon/inventory section was fully parsed (standard layout)
  if (!parseError) {
    try {
      const ts = Stream.from(tailBuf);

      // Storage section header: u32 separator (=1), u32 itemCount, u8 pad (=0)
      const storSep   = ts.readUInt32();
      const storCount = ts.readUInt32();
      const storPad   = ts.readByte();

      if (storSep === 1 && storCount > 0 && storCount < 100 && storPad === 0) {
        for (let i = 0; i < storCount; i++) {
          const itemId      = ts.readWStr();
          const craftplanId = ts.readWStr();
          const itemUID     = ts.readUInt32();
          const quantity    = ts.readUInt32();
          const durability  = ts.readFloat();
          const itemLevel   = ts.readUInt32();

          // Validate the read makes sense
          const durOk = durability === -1.0 || (durability >= 0 && durability <= 100);
          const qtyOk = quantity <= 99999;
          const lvlOk = itemLevel <= 20;
          if (!durOk || !qtyOk || !lvlOk) {
            // Storage parse failed — just use full tailBuf as rawTail
            storage.length = 0;
            break;
          }

          storage.push({ itemId, craftplanId, itemUID, quantity, durability, itemLevel });

          // Trailing 0x00 byte after each storage item
          if (ts.position < ts.length && ts.getBuffer()[ts.position] === 0x00) {
            ts.readByte();
          }
        }

        // If storage parsed successfully, the remaining bytes are the actual rawTail
        if (storage.length === storCount) {
          rawTail = ts.readToEnd();
        } else {
          storage.length = 0;
          rawTail = tailBuf;
        }
      }
    } catch {
      // Storage parse failed, keep full tailBuf as rawTail
      storage.length = 0;
      rawTail = tailBuf;
    }
  }

  return {
    header, location, quickSlotSentinel,
    heldWeapon: heldWeapon!,
    quickSlots,
    _invSeparators,
    inventory,
    storage,
    rawTail,
    _parseError: parseError ?? undefined,
  };
}

// ─── Serializer ──────────────────────────────────────────────────────────────

/**
 * Serialize a SaveFile back to uncompressed bytes.
 * Call `gzipCompress()` on the result to produce an uploadable atom blob.
 */
export function serializeSaveFile(save: SaveFile): Buffer {
  const s = Stream.reserve(16384);

  // Header
  s.writeUInt32(save.header.sentinel);
  s.writeUInt32(save.header._raw_unk[0]); // unk0
  s.writeUInt32(save.header.saveVersion);
  s.writeUInt32(save.header._raw_unk[1]); // unk1
  s.writeUInt32(save.header._raw_unk[2]); // unk2
  s.writeUInt32(save.header.level);
  s.writeUInt32(save.header.maxHP);
  s.writeUInt32(save.header.currHP);
  s.writeUInt32(save.header._raw_unk[3]); // unk3
  s.writeUInt32(save.header._raw_unk[4]); // unk4
  s.writeUInt32(save.header._raw_unk[5]); // unk5
  s.writeUInt32(save.header._raw_unk[6]); // unk6

  // Location block
  const loc = save.location;
  s.writeWStr(loc.mapName);
  s.writeWStr(loc.checkpoint);
  s.writeWStr(loc.spawnPoint);
  s.writeUInt32(loc._raw.postSpawn);
  s.writeWStr(loc.charTypeKey);
  s.writeByte(loc._raw.unk_byte0);
  s.writeByte(loc.charClassId);
  s.writeUInt16(loc._raw.unk_u16);
  s.writeUInt32(loc.quickSlotCount);
  s.writeUInt32(loc._raw.unk_inv);
  s.writeWStr(loc.checkpoint2);
  s.writeUInt32(loc._raw.unk_C);
  s.writeUInt32(loc._raw.unk_D);
  s.writeUInt32(loc.money);
  s.writeUInt32(loc._raw.unk_E);
  s.writeUInt16(loc.saveYear);
  s.writeByte(loc.saveMonth);
  s.writeByte(loc.saveDay);
  s.writeByte(loc.saveHour);
  s.writeByte(loc.saveMinute);
  s.writeUInt16(loc._raw.unk_F);
  s.writeUInt16(loc._raw.unk_G);
  s.writeUInt32(loc._raw.invSectCnt);
  s.writeByte(loc._raw.unk_pad);

  // Weapon sections + inventory
  // If the save had a parse error (e.g. prologue format), the rawTail includes these sections.
  if (!save._parseError) {
    s.writeUInt32(save.quickSlotSentinel);
    s.writeUInt32(save.quickSlots.length);

    // Held weapon (with preamble)
    const hw = save.heldWeapon;
    s.writeBytes(hw.preamble);
    s.writeWStr(hw.itemId);
    s.writeWStr(hw.craftplanId);
    s.writeUInt32(hw.itemUID);
    s.writeUInt32(hw.quantity);
    s.writeFloat(hw.durability);
    s.writeUInt32(hw.itemLevel);

    // Quick-slot weapons (no preamble)
    for (const w of save.quickSlots) {
      s.writeWStr(w.itemId);
      s.writeWStr(w.craftplanId);
      s.writeUInt32(w.itemUID);
      s.writeUInt32(w.quantity);
      s.writeFloat(w.durability);
      s.writeUInt32(w.itemLevel);
    }

    // Inventory separators
    s.writeUInt32(save._invSeparators[0]);
    s.writeUInt32(save._invSeparators[1]);
    s.writeUInt32(save._invSeparators[2]);

    // Inventory
    s.writeUInt32(save.inventory.length);
    for (const item of save.inventory) {
      s.writeWStr(item.itemId);
      s.writeWStr(item.containerId);
      s.writeUInt32(item.itemUID);
      s.writeUInt32(item.quantity);
      s.writeFloat(item.unk_f);
      s.writeUInt32(item.unk_pad);
    }
  } else {
    // Partial parse: the sentinel + wsCount + weapon/inventory data are all in rawTail
    // (rawTail was reset to include weaponSectionStart onwards)
    // We skip writing the sentinel/weapons/inventory blocks separately.
    // They are all in rawTail which will be written below.
  }

  // Storage section (only written when main weapon/inv was fully parsed)
  if (!save._parseError && save.storage && save.storage.length > 0) {
    s.writeUInt32(1);                          // separator = 1
    s.writeUInt32(save.storage.length);        // item count
    s.writeByte(0);                            // pad = 0
    for (const item of save.storage) {
      s.writeWStr(item.itemId);
      s.writeWStr(item.craftplanId);
      s.writeUInt32(item.itemUID);
      s.writeUInt32(item.quantity);
      s.writeFloat(item.durability);
      s.writeUInt32(item.itemLevel);
      s.writeByte(0);                          // trailing 0x00 per item
    }
  }

  // Raw tail (everything after storage: skills, quests, collectibles, map fog)
  s.writeBytes(save.rawTail);

  return s.getBuffer().slice(0, s.position);
}

// ─── High-level edit helpers ──────────────────────────────────────────────────

/** Set the player's wallet amount (max ~9,999,999) */
export function setMoney(save: SaveFile, amount: number): SaveFile {
  return { ...save, location: { ...save.location, money: amount >>> 0 } };
}

/** Set the player's level (1–60) */
export function setLevel(save: SaveFile, level: number): SaveFile {
  return { ...save, header: { ...save.header, level: Math.max(1, Math.min(60, level)) } };
}

/** Set player HP (both current and max) */
export function setHP(save: SaveFile, maxHP: number, currHP?: number): SaveFile {
  return {
    ...save,
    header: { ...save.header, maxHP: maxHP >>> 0, currHP: (currHP ?? maxHP) >>> 0 },
  };
}

/** Set the quantity of a specific inventory item (stackable) */
export function setInventoryItemQty(save: SaveFile, itemId: string, quantity: number): SaveFile {
  const inventory = save.inventory.map(item =>
    item.itemId === itemId ? { ...item, quantity: quantity >>> 0 } : item
  );
  return { ...save, inventory };
}

/** Set the durability of a quick-slot weapon */
export function setWeaponDurability(save: SaveFile, idx: number, durability: number): SaveFile {
  const quickSlots = save.quickSlots.map((w, i) =>
    i === idx ? { ...w, durability } : w
  );
  return { ...save, quickSlots };
}

/** Max out durability on all quick-slot weapons and held weapon */
export function maxAllWeaponDurability(save: SaveFile): SaveFile {
  const quickSlots = save.quickSlots.map(w => ({ ...w, durability: 100.0 }));
  const heldWeapon = { ...save.heldWeapon, durability: 100.0 };
  return { ...save, heldWeapon, quickSlots };
}

/** Update the held weapon (the currently equipped weapon with world position preamble) */
export function setHeldWeapon(save: SaveFile, item: Partial<WeaponItem>): SaveFile {
  return { ...save, heldWeapon: { ...save.heldWeapon, ...item } };
}

/** Replace a quick-slot weapon by index */
export function replaceQuickSlotWeapon(
  save: SaveFile, idx: number,
  itemId: string, craftplanId: string,
  level = 3, durability = 100.0, quantity = 1
): SaveFile {
  const quickSlots = save.quickSlots.map((w, i) =>
    i === idx ? { ...w, itemId, craftplanId, durability, quantity, itemLevel: level } : w
  );
  return { ...save, quickSlots };
}

/** Max out all stackable item quantities (999 each) */
export function maxAllInventory(save: SaveFile, maxQty = 999): SaveFile {
  const inventory = save.inventory.map(item => ({ ...item, quantity: maxQty }));
  return { ...save, inventory };
}

/** Set the quantity of a storage item */
export function setStorageItemQty(save: SaveFile, itemId: string, quantity: number): SaveFile {
  const storage = save.storage.map(item =>
    item.itemId === itemId ? { ...item, quantity: quantity >>> 0 } : item
  );
  return { ...save, storage };
}

/** Max out durability on all storage weapons */
export function maxStorageDurability(save: SaveFile): SaveFile {
  const storage = save.storage.map(w => ({
    ...w, durability: (w.durability < 0) ? w.durability : 100.0
  }));
  return { ...save, storage };
}

/** Add or update an item in the storage chest */
export function setStorageItem(
  save: SaveFile,
  itemId: string,
  craftplanId: string,
  quantity: number,
  durability: number,
  itemLevel: number,
  itemUID = 0
): SaveFile {
  const existing = save.storage.findIndex(it => it.itemId === itemId);
  const newItem: StorageItem = { itemId, craftplanId, itemUID, quantity, durability, itemLevel };
  if (existing >= 0) {
    const storage = save.storage.map((it, i) => i === existing ? newItem : it);
    return { ...save, storage };
  }
  return { ...save, storage: [...save.storage, newItem] };
}

