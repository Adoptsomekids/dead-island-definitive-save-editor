# Dead Island Definitive Edition — Save File Format

> **Fully reverse-engineered from real Xbox Series X save blobs (July 2026).**  
> All values are **little-endian** unless noted.  
> Source: `src/parser/save-file.ts`

---

## Overview

Dead Island DE saves are stored on **Xbox Live Connected Storage** as binary atom blobs.

```
Xbox Live:  save_1.sav  (atom GUID: 972875C7-F554-4CBB-855D-1D2BFAA706F0)
                │
                │  gzip-compressed
                ▼
            save_1.sav_dec.bin  (6569 bytes, inner save)
```

**Three real saves analyzed:**

| File | Size (raw) | Size (dec) | Map | Character | Level | Money |
|------|-----------|------------|-----|-----------|-------|-------|
| save_0.sav | 837 B | 3660 B | Hotel (Prologue) | Sam B | 101 | $8,205,506 |
| save_1.sav | 1785 B | 6569 B | ACT1A Resort | Sam B | 101 | $10,247,820 |
| save_2.sav | 854 B | 4132 B | ACT1A Early | Xian Mei | 101 | $299,913 |

---

## Full Binary Layout

### 1. Outer Wrapper — GZip

```
[raw atom blob]  →  zlib.gunzipSync()  →  [inner save bytes]
```

The inner save file is always a flat binary, no outer container format.

---

### 2. File Header — 48 bytes (0x000–0x02F)

| Offset | Size | Type | Value | Notes |
|--------|------|------|-------|-------|
| 0x000 | 4 | u32 | `0xFFFFFFFF` | **Sentinel / magic** |
| 0x004 | 4 | u32 | `0` | Unknown (always 0) |
| 0x008 | 4 | u32 | `5` | **Save format version** (always 5 in DE) |
| 0x00C | 4 | u32 | `12` | Unknown |
| 0x010 | 4 | u32 | `5` | Unknown |
| 0x014 | 4 | u32 | `level` | ✏️ **Player level** (1–60) |
| 0x018 | 4 | u32 | `maxHP` | ✏️ **Max health points** |
| 0x01C | 4 | u32 | `currHP` | ✏️ **Current health** |
| 0x020 | 4 | u32 | `0` | Unknown |
| 0x024 | 4 | u32 | `2` | Unknown |
| 0x028 | 4 | u32 | `12` | Unknown |
| 0x02C | 4 | u32 | `3` | Unknown |

---

### 3. Location Block — variable length (starts at 0x030)

All strings use **wstr16**: `[u16 length][UTF-8 bytes × length]`.

| Field | Type | Example | Notes |
|-------|------|---------|-------|
| mapName | wstr16 | `"ACT1A"` | Current map zone |
| checkpoint | wstr16 | `"HubChapter_2_3_4_9"` | Checkpoint name |
| spawnPoint | wstr16 | `"auto_SP_RH_Sinamoi_Hut"` | Spawn ID |
| postSpawn | u32 | `4` | Unknown |
| charTypeKey | wstr16 | `"Type;SamB"` | Character key |
| unk_byte0 | u8 | `0` | Unknown |
| charClassId | u8 | `2` | 0=Xian, 1=Logan, 2=SamB, 3=Purna |
| unk_u16 | u16 | `0` | Unknown |
| quickSlotCnt | u32 | `7` | Quick-slot count (may differ from wsCount) |
| unk_inv | u32 | `5` | Unknown |
| checkpoint2 | wstr16 | `"ACT1A_Sinamoi_Busy"` | Internal checkpoint |
| unk_C | u32 | `12` | Unknown |
| unk_D | u32 | `6` | Unknown |
| **money** | u32 | `10247820` | ✏️ **Player wallet** |
| unk_E | u32 | `0` | Unknown |
| saveYear | u16 | `2026` | Save timestamp |
| saveMonth | u8 | `7` | |
| saveDay | u8 | `4` | |
| saveHour | u8 | `4` | |
| saveMinute | u8 | `0` | |
| unk_F | u16 | `16` | Unknown |
| unk_G | u16 | `22` | Unknown |
| invSectCnt | u32 | `8` | Section count flag |
| unk_pad | u8 | `0` | Padding |

---

### 4. Weapon Section

Immediately follows the location block:

```
[u32 = 0xFFFFFFFF]  ← weapon section sentinel
[u32 wsCount]       ← number of quick-slot weapons (NOT including held weapon)
[HeldWeapon]        ← currently equipped weapon (has a spawn preamble)
[QuickSlot × wsCount] ← quick-slot weapons (no preamble)
```

#### 4a. Held Weapon Preamble

The held weapon starts with a **variable-length preamble** before the item data.  
The preamble encodes the weapon's world position + orientation + slot state.

| Save Type | Preamble Size | Notes |
|-----------|--------------|-------|
| Late-game ACT1A (save_1) | **57 bytes** | Standard, fully parsed |
| Early-game ACT1A HubChapter_1 (save_2) | **82 bytes** | Best-effort parse |
| Hotel / Prologue (save_0) | **73 bytes** | Best-effort parse |

The preamble size is **auto-detected** by the parser by scanning for the first valid item ID wstr16.

**Preamble structure (first 24 bytes are always fixed):**
```
[f32 posX]       world spawn X
[f32 posY]       world spawn Y
[f32 posZ]       world spawn Z
[f32 orient]     orientation float
[u32 unk0]       = 0
[f32 unk1]       ≈ 0.37 (internal float)
... (variable bytes follow depending on save type)
```

#### 4b. WeaponItem Structure (after preamble, or for quick-slots)

```
wstr16  itemId        e.g. "Melee_BoGen", "Firearm_AutoRifleGen"
wstr16  craftplanId   e.g. "Craftplan_Naildcraft", "" (empty for unmodded)
u32     itemUID       per-item unique ID (random)
u32     quantity      stack/ammo count
f32     durability    0.0–100.0 for melee; -1.0 for firearms (ammo-based)
u32     itemLevel     tier / upgrade level (0–10)
```

---

### 5. Inventory Section (Craft Parts / Consumables)

Immediately follows the weapon section:

```
[u32 = 1]       separator
[u32 = 0]       separator
[u32 = 1]       separator
[u32 invCount]  number of inventory items
[InvItem × invCount]
```

**InvItem structure:**
```
wstr16  itemId        e.g. "CraftPart_MetalScrap"
wstr16  containerId   = "None" for all observed saves
u32     itemUID       = 0 for stackables
u32     quantity      ✏️ editable — stack count (0–999)
f32     unk_f         = -1.0 for stackables
u32     unk_pad       = 0
```

---

### 6. Storage Chest Section

Immediately follows inventory. This is the **shared stash chest** between characters.

```
[u32 = 1]        separator
[u32 storCount]  number of stored items
[u8 = 0]         padding
[StorageItem × storCount × each followed by u8 = 0]
```

**StorageItem structure** (same fields as WeaponItem, no preamble):
```
wstr16  itemId
wstr16  craftplanId
u32     itemUID
u32     quantity   ✏️ editable
f32     durability ✏️ editable
u32     itemLevel  ✏️ editable
[u8 = 0]  trailing separator byte
```

**Real data (save_1):**
- `[0]` Melee_StickGen / Craftplan_Naildcraft — qty:1 dur:68.67 lvl:3
- `[1]` Melee_Fists / None — qty:1 dur:-1.00 lvl:0
- `[2–4]` Melee_StickGen × 3

---

### 7. rawTail — Skills / Quests / Collectibles / Map Fog

Everything after the storage chest is preserved as `rawTail` bytes.  
**Not yet parsed** — bytes are preserved unchanged for byte-perfect round-trip.

Known content (from string search in save_1 rawTail, 4115 bytes):
- `+0x000`: Section header (u32=2 — skill tree count?)
- `+0x030`: Zeroed region (≈48 bytes — empty skill flags?)
- `+0x03e`: Non-zero region — skill points, tree values
- `+0x3f2`: `HubChapter_2_3_4_9` — quest checkpoint/progress
- `+0xc8d`: `act1a` — map identifier

---

## Character Class IDs

| charClassId | charTypeKey | Character |
|-------------|-------------|-----------|
| 0 | `Type;Xian` or `Type;XianMei` | Xian Mei |
| 1 | `Type;Logan` | Logan Carter |
| 2 | `Type;SamB` | Sam B |
| 3 | `Type;Purna` | Purna |

---

## Map Zone IDs

| mapName | Location |
|---------|----------|
| `Hotel` | Hotel Prologue |
| `ACT1A` | Resort — Act 1 |
| `ACT2A` | City of Moresby — Act 2 |
| `ACT3A` | Jungle — Act 3 |
| `ACT4A` | Prison — Act 4 |

---

## Known Item IDs (from real Xbox save_1)

### Weapons (itemId)
```
Melee_BoGen           Blunt weapon (Bo staff)
Melee_StickGen        Stick weapon
Melee_BatGen          Baseball bat
Melee_Fists           Unarmed
Melee_Paddle          Paddle (prologue/early)
Firearm_AutoRifleGen  Auto rifle
Firearm_ShotgunShortGen  Short shotgun
```

### Craftplans (craftplanId)
```
Craftplan_Naildcraft       Nailbat mod
Craftplan_Shockrifle       Shock rifle mod
Craftplan_Strikershotgun   Striker shotgun mod
```

### Craft Parts (inventory itemId)
```
CraftPart_MetalScrap      CraftPart_Wire         CraftPart_BatteryLarge
CraftPart_Battery         CraftPart_ElectronicScrap  CraftPart_Nails
CraftPart_Tape            CraftPart_Belt         CraftPart_Glue
CraftPart_Soap            CraftPart_GasForLighter    CraftPart_Lighter
CraftPart_CircularBlade   CraftPart_Clamp        CraftPart_Rag
CraftPart_BarbedWire      CraftPart_EngineParts  CraftPart_Magnet
CraftPart_Gear            CraftPart_Watch        CraftPart_Deodorant
CraftPart_LargeNail       CraftPart_Oleander     CraftPart_DrugsUnit
CraftPart_Bandages        CraftPart_Painkillers  CraftPart_Lp4000Battery
CraftPart_Flares          CraftPart_Water        CraftPart_Phone
CraftPart_Detergent       CraftPart_LemonJuice   CraftPart_Meat
```

### Consumables
```
Powerup_Alcohol            Food_Can
Throwable_Molotov          Medkit_HealthPackMedium
Car Part
```

---

## Round-Trip Verification

| Save | Original | Edited | Byte Diffs | Result |
|------|---------|--------|------------|--------|
| save_0.sav_dec.bin | 3660 B | 3660 B | 3 (money) | ✅ PERFECT |
| save_1.sav_dec.bin | 6569 B | 6569 B | 0 (unedited) / 26 (god mode) | ✅ PERFECT |
| save_2.sav_dec.bin | 4132 B | 4132 B | 3 (money) | ✅ PERFECT |

No checksum validation was found in the game — edits are accepted without CRC updates.

---

## Re-serialization Notes

1. **Re-compress** the inner bytes with gzip before uploading: `zlib.gzipSync(innerBytes)`
2. **No checksum** — the game does not validate a CRC/hash on the save data
3. **Money field**: located at `header(48) + location_block_variable_offset + money_field_offset`  
   Use the parser rather than hardcoded offsets as the location block is variable-length
4. **Weapon durability**: `f32` field, use `100.0` for max; firearms use `-1.0` (ammo-based)
5. **Firearm ammo**: edit the `quantity` field (not durability) for firearm slots
