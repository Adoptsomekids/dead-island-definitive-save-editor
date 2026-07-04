# Dead Island Definitive Edition — Save File Format

> Research notes from reverse engineering the Dead Island DE save file binary format.
> Platform: Xbox Series X / Xbox One (and PC via Steam).

---

## Header (offset 0x0000)

| Offset | Size | Type   | Description                        |
|--------|------|--------|------------------------------------|
| 0x0000 | 4    | uint32 | Magic: `0x44495345` ("DISE")       |
| 0x0004 | 4    | uint32 | Save version                       |
| 0x0008 | 4    | uint32 | Platform flags (0=PC, 1=Xbox, 2=PS)|
| 0x000C | 4    | uint32 | CRC32 of the data section          |
| 0x0010 | 4    | uint32 | Total data section size (bytes)    |
| 0x0014 | 4    | uint32 | Flags (bit 0 = zstd compressed)    |

---

## Player Data Block

| Offset | Size | Type    | Description              |
|--------|------|---------|--------------------------|
| +0x00  | 4    | uint32  | Block size               |
| +0x04  | 4    | uint32  | Character class (0-3)    |
| +0x08  | 4    | float32 | Player health            |
| +0x0C  | 4    | float32 | Max health               |
| +0x10  | 4    | uint32  | Experience points        |
| +0x14  | 4    | uint32  | Level (1-60)             |
| +0x18  | 4    | uint32  | Skill points available   |
| +0x1C  | 4    | float32 | Cash/money               |
| +0x20  | 16   | bytes   | Player GUID              |
| +0x30  | 64   | string  | Player name (null-term)  |

---

## Inventory Block

### Block Header
| Offset | Size | Type   | Description       |
|--------|------|--------|-------------------|
| +0x00  | 4    | uint32 | Block size        |
| +0x04  | 4    | uint32 | Item count        |
| +0x08  | 4    | uint32 | Storage item count|

### Item Entry (repeated × item count)
| Offset | Size | Type    | Description                    |
|--------|------|---------|--------------------------------|
| +0x00  | 4    | uint32  | Item ID (see data/items/)      |
| +0x04  | 4    | float32 | Durability (0.0 – 1.0)         |
| +0x08  | 2    | uint16  | Quantity / ammo                |
| +0x0A  | 1    | uint8   | Quick-slot assignment (0xFF=none)|
| +0x0B  | 1    | uint8   | Flags                          |
| +0x0C  | 4    | uint32  | Mod slot 1 (item ID or 0)      |
| +0x10  | 4    | uint32  | Mod slot 2 (item ID or 0)      |
| +0x14  | 4    | uint32  | Mod slot 3 (item ID or 0)      |
| +0x18  | 4    | uint32  | Mod slot 4 (item ID or 0)      |
| +0x1C  | 4    | float32 | Weapon level / upgrade tier    |

---

## Skills Block

| Offset | Size | Type   | Description                       |
|--------|------|--------|-----------------------------------|
| +0x00  | 4    | uint32 | Block size                        |
| +0x04  | 4    | uint32 | Fury tree — bitmask (32 skills)   |
| +0x08  | 4    | uint32 | Power tree — bitmask              |
| +0x0C  | 4    | uint32 | Survival tree — bitmask           |
| +0x10  | 4    | uint32 | Points spent — Fury               |
| +0x14  | 4    | uint32 | Points spent — Power              |
| +0x18  | 4    | uint32 | Points spent — Survival           |

---

## Map / Fog of War Block

| Offset | Size   | Type   | Description                          |
|--------|--------|--------|--------------------------------------|
| +0x00  | 4      | uint32 | Block size                           |
| +0x04  | 4      | uint32 | Map ID                               |
| +0x08  | N      | bytes  | Fog bitmap (1 bit per tile, row-major)|

---

## Collectibles Block

| Offset | Size | Type   | Description                            |
|--------|------|--------|----------------------------------------|
| +0x00  | 4    | uint32 | Block size                             |
| +0x04  | 4    | uint32 | ID cards unlocked bitmask (64 cards)   |
| +0x08  | 4    | uint32 | News items unlocked bitmask (32 items) |
| +0x0C  | 4    | uint32 | Tapes unlocked bitmask (32 tapes)      |
| +0x10  | 4    | uint32 | Blueprints unlocked bitmask (128 BPs)  |
| +0x14  | 12   | uint32[3] | Blueprints unlocked ext. bitmask    |

---

## Notes

- All integers are **little-endian**.
- Strings are null-terminated UTF-8.
- The data section (after header) may be **zstd-compressed** when flag bit 0 is set.
- CRC32 is computed over the raw (post-decompression) data section.
- These offsets are **preliminary** and require validation against live save dumps.
- Use `scripts/dump-save.ts` to hex-dump a save and cross-reference field values.
