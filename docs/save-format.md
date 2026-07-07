# Dead Island Definitive Edition — Save File Format

> Reverse-engineered from real Xbox Series X save blobs (July 2026).
> All values are **little-endian** unless noted.

---

## Outer Wrapper (GZip / Compressed atom)

The raw atom blob fetched from Xbox Live Connected Storage (`titlestorage.xboxlive.com`)
is a **gzip-compressed** container. After decompression you get the inner save file below.

```
[raw atom]  →  gzip decompress  →  [inner save bytes]
```

---

## Inner Save File Layout

### 1. File Header — 0x030 bytes

| Offset | Size | Type   | Value      | Notes                                         |
|--------|------|--------|------------|-----------------------------------------------|
| 0x000  | 4    | i32    | 0xFFFFFFFF | Sentinel / magic (-1)                         |
| 0x004  | 4    | u32    | 0          | Unknown (always 0)                            |
| 0x008  | 4    | u32    | 5          | Save format version (always 5 in DE)          |
| 0x00C  | 4    | u32    | 12         | Unknown (always 12)                           |
| 0x010  | 4    | u32    | 5          | Unknown (always 5)                            |
| 0x014  | 4    | u32    | level      | **Player level** (1–60)                       |
| 0x018  | 4    | u32    | maxHP      | Max health points (scaled integer)            |
| 0x01C  | 4    | u32    | currHP     | Current health points                         |
| 0x020  | 4    | u32    | 0          | Unknown                                       |
| 0x024  | 4    | u32    | 2          | Unknown                                       |
| 0x028  | 4    | u32    | 12         | Unknown                                       |
| 0x02C  | 4    | u32    | 3          | Unknown                                       |

### 2. Location Block — variable length (starts at 0x030)

All strings in this section use **uint16 LE length prefix** followed by UTF-8 bytes.

| Field        | Type   | Example                        | Notes                            |
|--------------|--------|--------------------------------|----------------------------------|
| mapName      | wstr16 | `"ACT1A"`                      | Current map zone                 |
| checkpoint   | wstr16 | `"HubChapter_2_3_4_9"`         | Active checkpoint name           |
| spawnPoint   | wstr16 | `"auto_SP_RH_Sinamoi_Hut"`     | Spawn point ID                   |
| postSpawn    | u32    | 4                              | Unknown flag                     |
| charTypeKey  | wstr16 | `"Type;SamB"`                  | Character identifier string      |
| unk_byte0    | u8     | 0                              | Unknown                          |
| charClassId  | u8     | 2                              | 0=Xian, 1=Logan, 2=SamB, 3=Purna |
| unk_u16      | u16    | 0                              | Unknown (always 0)               |
| quickSlotCnt | u32    | 7                              | Number of weapon quick slots     |
| unk_inv      | u32    | 5                              | Unknown (inv-related)            |
| checkpoint2  | wstr16 | `"ACT1A_Sinamoi_Busy"`         | Internal checkpoint name         |
| unk_C        | u32    | 12                             | Unknown                          |
| unk_D        | u32    | 6                              | Unknown                          |
| **money**    | u32    | 10247820                       | **Player wallet (cash/money)**   |
| unk_E        | u32    | 0                              | Unknown                          |
| saveYear     | u16    | 2026                           | Save date — year                 |
| saveMonth    | u8     | 7                              | Save date — month                |
| saveDay      | u8     | 4 (unused/0?)                  | Save date — day                  |
| saveHour     | u8     | 4                              | Save date — hour                 |
| saveMinute   | u8     | 0                              | Save date — minute               |
| unk_F        | u16    | 16                             | Unknown                          |
| unk_G        | u16    | 22                             | Unknown                          |
| invSectCnt   | u32    | 8                              | Inventory section count          |
| unk_pad      | u8     | 0                              | Padding byte                     |

### 3. Weapon Quick Slots — starts at sentinel

Immediately follows the location block:

```
[FF FF FF FF]   ← sentinel (no active quick-slot override)
[u32]           ← number of quick-slot weapon items (e.g., 7)
[Item × N]      ← each item is a WeaponItem (see below)
```

### 4. WeaponItem Structure

Each weapon item starts with a **57-byte fixed header** followed by two wstr16 strings:

| Field       | Size | Type   | Notes                                  |
|-------------|------|--------|----------------------------------------|
| posX        | 4    | f32    | World position X (spawn location)     |
| posY        | 4    | f32    | World position Y                       |
| posZ        | 4    | f32    | World position Z                       |
| orientation | 4    | f32    | Orientation float                      |
| unk0        | 4    | u32    | Unknown                                |
| unk1        | 4    | f32    | Unknown float (≈0.37)                  |
| unk2        | 4    | u32    | Unknown (= 9?)                         |
| unk3        | 4    | u16+u16| Unknown pair                           |
| unk4        | 4    | u32    | Unknown                                |
| unk5        | 4    | u32    | Unknown                                |
| unk6        | 4    | u32    | Unknown                                |
| unk7        | 4    | u32    | Unknown                                |
| unk8        | 4    | u32    | Unknown                                |
| unk9        | 1    | u8     | Padding / flag                         |
| **itemId**  | var  | wstr16 | Item type ID (e.g., `"Melee_BoGen"`)  |
| **craftId** | var  | wstr16 | Craftplan ID (e.g., `"Craftplan_Naildcraft"`) |
| itemUID     | 4    | u32    | Item unique ID (per-item random value) |
| quantity    | 4    | u32    | Stack size / ammo count                |
| durability  | 4    | f32    | Durability 0.0–100.0+ (e.g., 60.54)  |
| itemLevel   | 4    | u32    | Item level / tier (e.g., 3)           |

### 5. Inventory Items (stackables/consumables)

After weapon quick slots, a section count header appears followed by inventory items:

```
[u32 count]
[Item × count]
```

Inventory item structure:
```
wstr16 itemId       e.g. "CraftPart_MetalScrap"
wstr16 containerStr e.g. "None"  (container/holder ID, or "None")
u32    itemUID      unique item ID
u32    quantity     stack count (integer)
f32    unk_f        float field (often 0xBF800000 = -1.0 for stackables)
u32    unk_pad      padding / flags
```

### 6. Skills Section

After inventory, a skills block contains skill tree data.
Each skill entry is: `u32 skillIndex`, `u8 isUnlocked (0 or 1)`.

### 7. Collectibles / Quests Section

Contains:
- Quest progress flags (bit arrays)
- ID card / news / tape unlock status
- Map fog data (bit field per map)

### 8. Profile Data (PROFILE_DATA blob)

The PROFILE_DATA blob is a separate save file with a different structure:
- Player stats (kills, deaths, XP, play time)
- DLC unlock flags
- Multiplayer settings
- Achievement/trophy state
- Character cosmetics

---

## Character Class IDs

| ID | Character   |
|----|-------------|
| 0  | Xian Mei    |
| 1  | Logan Carter |
| 2  | Sam B       |
| 3  | Purna       |

## Map Zone IDs

| mapName   | Location            |
|-----------|---------------------|
| `ACT1A`   | Resort (Act 1)      |
| `ACT2A`   | City of Moresby     |
| `ACT3A`   | Jungle              |
| `ACT4A`   | Prison              |
| `Hotel`   | Hotel (Prologue)    |

---

## Known Item IDs (partial)

### Weapons
- `Melee_BoGen` — Blunt weapon (generic)
- `Melee_StickGen` — Stick (generic)
- `Melee_BatGen` — Baseball bat
- `Melee_Fists` — Unarmed / fists
- `Melee_Paddle` — Paddle
- `Firearm_AutoRifleGen` — Auto rifle
- `Firearm_ShotgunShortGen` — Short shotgun

### Craftplans
- `Craftplan_Naildcraft` — Nailbat
- `Craftplan_Shockrifle` — Shock rifle
- `Craftplan_Strikershotgun` — Striker shotgun

### Craft Parts (stackable items)
- `CraftPart_MetalScrap`
- `CraftPart_Wire`
- `CraftPart_BatteryLarge`
- `CraftPart_Battery`
- `CraftPart_ElectronicScrap`
- `CraftPart_Nails`
- `CraftPart_Tape`
- `CraftPart_Belt`
- `CraftPart_Glue`
- `CraftPart_Soap`
- `CraftPart_GasForLighter`
- `CraftPart_Lighter`
- `CraftPart_CircularBlade`
- `CraftPart_Clamp`
- `CraftPart_Rag`
- `CraftPart_BarbedWire`
- `CraftPart_EngineParts`
- `CraftPart_Magnet`
- `CraftPart_Gear`
- `CraftPart_Watch`
- `CraftPart_Deodorant`
- `CraftPart_LargeNail`
- `CraftPart_Oleander`
- `CraftPart_DrugsUnit`
- `CraftPart_Bandages`
- `CraftPart_Painkillers`
- `CraftPart_Lp4000Battery`

### Consumables / Throwables / Misc
- `Powerup_Alcohol`
- `Food_Can`
- `CraftPart_Water`
- `Throwable_Molotov`
- `Medkit_HealthPackMedium`
- `Car Part`

---

## Notes on Save Re-serialization

1. The outer blob is gzip-compressed — you must re-compress after editing.
2. The checksum (if any) is not yet identified; the game may use a CRC on the inner data.
3. The `money` field at offset (header + location block + 0x18 from checkpoint2 end) can be
   directly edited to set the player's wallet amount.
4. Quick-slot weapons use item-type string IDs from the game's internal item database.
