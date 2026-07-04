# Dead Island Definitive Edition — Save Editor

> Xbox Series X save editor for **Dead Island Definitive Edition**.  
> Edit inventory, skills, map fog, collectibles, player stats and more.

---

## Features

| Feature | Status |
|---------|--------|
| 📦 Inventory management (items, weapons, mods) | 🚧 In progress |
| 🧠 Skills respec & unlock all | 🚧 In progress |
| 🗺️ Map fog of war clear/reveal | 🚧 In progress |
| 🏆 Collectibles unlock (ID cards, news, tapes) | 🚧 In progress |
| 💀 God mode / infinite stamina toggles | 🚧 In progress |
| ♾️ Infinite ammo / durability | 🚧 In progress |
| 🎮 Xbox Series X save extraction via [Xbox Backup Creator](https://www.360haven.com) | 📋 Planned |
| 💾 Re-inject edited save back to Xbox profile | 📋 Planned |

---

## Supported Games

- ✅ Dead Island: Definitive Edition (Xbox Series X / Xbox One)
- ⬜ Dead Island: Riptide Definitive Edition *(planned)*

---

## Prerequisites

- **Node.js** 18+ and **npm** 9+
- **TypeScript** 5+
- (Optional) [Horizon](https://www.wemod.com/horizon) or [Xbox Backup Creator](https://www.xbox-scene.info) to extract `.sav` files from your Xbox profile

---

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run CLI editor
npm run dev -- --input path/to/save.sav --output path/to/output.sav
```

---

## How to Extract Your Xbox Save

### Method 1 — Xbox App (PC)
1. On PC open the **Xbox App** → find Dead Island Definitive Edition.
2. Cloud saves sync to `%LOCALAPPDATA%\Packages\*.DeadIsland*\SystemAppData\wgs\`.
3. Copy the binary save blob from that directory.

### Method 2 — Xbox Backup Creator / Horizon
1. Put Xbox into **Developer Mode** or use a modded profile tool.
2. Use **Horizon** (Windows) to browse your profile and extract the save container.
3. The `.sav` / container binary is the file this editor reads.

### Method 3 — USB Transfer (Xbox One / Series X)
1. On Xbox: **Settings → System → Storage → Transfer → USB**.
2. Transfer your Dead Island save to a USB drive.
3. Read the drive on PC — files are in `Xbox360/000D000\...` or `Content/...` paths.
4. Extract the inner save blob with this editor's `tools/extract-container.ts`.

---

## Project Structure

```
dead-island-definitive-save-editor/
├── src/
│   ├── index.ts               # CLI entry point
│   ├── parser/
│   │   ├── stream.ts          # Binary stream reader/writer
│   │   ├── save-file.ts       # Top-level save file parser
│   │   ├── player.ts          # Player data block
│   │   ├── inventory.ts       # Inventory / item parsing
│   │   ├── skills.ts          # Skill tree parsing
│   │   ├── map.ts             # Map fog-of-war data
│   │   └── collectibles.ts    # Collectibles state
│   ├── editor/
│   │   ├── save-editor.ts     # High-level editor API
│   │   ├── inventory-editor.ts
│   │   ├── skills-editor.ts
│   │   └── player-editor.ts
│   ├── crypto/
│   │   ├── crc32.ts           # CRC-32 checksum
│   │   └── adler32.ts         # Adler-32 checksum
│   ├── xbox/
│   │   ├── container.ts       # Xbox save container parser
│   │   └── stfs.ts            # STFS package reader (360/One format)
│   └── data/
│       ├── items/             # Item ID → name mappings (JSON)
│       ├── skills/            # Skill tree definitions (JSON)
│       └── blueprints/        # Blueprint/collectible IDs (JSON)
├── tools/
│   └── extract-container.ts   # CLI tool: unpack Xbox container → raw save
├── tests/
├── docs/
│   ├── save-format.md         # Reverse-engineered save file format spec
│   └── xbox-container.md      # Xbox container format notes
├── scripts/
│   └── dump-save.ts           # Hex dump / analysis helper
├── package.json
└── tsconfig.json
```

---

## Save Format Research

See [`docs/save-format.md`](docs/save-format.md) for the reverse-engineered binary layout of Dead Island DE save files.

Key observations:
- Little-endian byte order
- Header contains magic bytes + version + CRC32 checksum
- Player data section is optionally zstd-compressed
- Inventory stored as a length-prefixed item array
- Each item: `[id: uint32][durability: float][quantity: uint16][slot: uint8][mods: uint32[4]]`

---

## Contributing

PRs welcome. Please open an issue first to discuss major changes.

---

## Legal Notice

This tool is for **personal use only**. Modifying save files for online/multiplayer cheating may violate the game's terms of service. Use responsibly.

---

## Acknowledgements

- [DISE](https://steffenl.com/projects/dead-island-save-editor) — original Dead Island save editor inspiration
- [libvantage](https://github.com/Adoptsomekids/libvantage) — binary stream I/O and editor framework patterns
- [SteffenL/dead-island-2-save-editor-external](https://github.com/SteffenL/dead-island-2-save-editor-external) — build system and compression approach reference
