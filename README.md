# Dead Island Definitive Edition — Save Editor

> Xbox Series X save editor for **Dead Island Definitive Edition**.
> Edit inventory, skills, map fog, collectibles, player stats and more.
> **Works natively on macOS** — no Windows required.

---

## Features

| Feature | Status |
|---------|--------|
| 📦 Inventory management (items, weapons, mods) | 🚧 In progress |
| 🧠 Skills respec & unlock all | ✅ Done |
| 🏆 Collectibles unlock (ID cards, news, tapes, blueprints) | ✅ Done |
| 💀 God mode (max health) | ✅ Done |
| ♾️ Max durability on all items | ✅ Done |
| 🎮 Level to 60 + max skill points | ✅ Done |
| 💰 Max cash | ✅ Done |
| 📡 Download save from Xbox Series X over WiFi (Device Portal) | ✅ Done |
| 📡 Upload edited save back to Xbox over WiFi | ✅ Done |
| 🗺️ Map fog of war clear/reveal | 🚧 In progress |

---

## Supported Games

- ✅ Dead Island: Definitive Edition (Xbox Series X / Xbox One)
- ⬜ Dead Island: Riptide Definitive Edition *(planned)*

---

## Prerequisites

- **Node.js** 18+ and **npm** 9+
- **TypeScript** 5+
- Xbox Series X with **Developer Mode** active (see [How to Extract Your Save](#how-to-extract-your-xbox-save))

> **Note:** Horizon, Modio, and Xbox Backup Creator are Xbox 360-only tools.
> They do NOT work with Xbox Series X saves. This project uses the official
> Xbox Device Portal API instead, which works over WiFi from any OS including macOS.

---

## Quick Start

```bash
# Install dependencies
npm install

# Download your save from Xbox (see setup below first)
npm run sync -- --download --xbox-ip 192.168.1.X --user YOUR_USER --pass YOUR_PASS

# Edit the save
npm run dev -- --input ./dead-island-save-*.sav --god-mode --max-level --unlock-skills

# Upload the edited save back to Xbox
npm run sync -- --upload --input ./dead-island-save-*.sav.edited --xbox-ip 192.168.1.X --user YOUR_USER --pass YOUR_PASS
```

---

## How to Extract Your Xbox Save

### ✅ The Only Reliable Method: Xbox Developer Mode + Device Portal

Xbox Series X **does not allow saving to USB** and there is no Xbox App for macOS.
The only cross-platform solution is the **Xbox Device Portal** — an HTTP server
built into the console that you access over your local WiFi network.

#### One-Time Setup (~15 minutes, costs $19 USD)

1. On your PC or Mac, go to **[dev.xbox.com](https://dev.xbox.com)** and sign in with your Microsoft account.
2. Register as a developer (one-time $19 USD fee, gives you unlimited Dev Mode activations).
3. On your Xbox Series X: **Settings → System → Developer settings → Developer Mode**.
4. Follow the prompts — the console will install the Dev Mode app and reboot.
5. **Your retail games still work** — Dev Mode and Retail Mode coexist.
6. When in Dev Mode, open the **Xbox Device Portal** app on the console.
7. Note the URL shown (e.g. `https://192.168.1.X:11443`) and set a username/password.

#### Daily Use (after setup)

```bash
# 1. Make sure your Mac and Xbox are on the same WiFi
# 2. Download your save:
npx ts-node tools/save-sync.ts --download \
  --xbox-ip 192.168.1.X \
  --user YOUR_DEVICE_PORTAL_USER \
  --pass YOUR_DEVICE_PORTAL_PASS

# Or set env vars to avoid typing credentials:
export XBOX_IP=192.168.1.X
export XBOX_USER=admin
export XBOX_PASS=mypassword
npx ts-node tools/save-sync.ts --download

# 3. Edit and re-upload (see CLI Usage below)
```

#### Or use the npm shortcut:
```bash
npm run sync -- --download --xbox-ip 192.168.1.X --user admin --pass mypass
```

---

## CLI Usage

```bash
# Edit a downloaded save
npx ts-node src/index.ts --input ./save.sav --output ./save.edited.sav [flags]

# Flags:
#   --god-mode            Set health to 99999
#   --max-level           Set level to 60, max XP and skill points
#   --max-cash            Set cash to 9,999,999
#   --unlock-skills       Unlock all skills in every tree
#   --reset-skills        Reset skill trees and refund all points
#   --max-durability      Set all items to full durability
#   --unlock-collectibles Unlock all ID cards, news, tapes, blueprints
#   --dump                Print save contents (no modification)
```

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
│   │   ├── device-portal.ts   # Xbox Device Portal HTTP client (macOS/WiFi)
│   │   ├── container.ts       # Xbox 360 STFS container parser
│   │   └── stfs.ts            # STFS package reader (Xbox 360 format)
│   └── data/
│       ├── items/             # Item ID → name mappings (JSON)
│       ├── skills/            # Skill tree definitions (JSON)
│       └── blueprints/        # Blueprint/collectible IDs (JSON)
├── tools/
│   ├── save-sync.ts           # Download/upload saves via Xbox Device Portal (WiFi)
│   └── extract-container.ts   # CLI tool: unpack Xbox 360 STFS container → raw save
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
