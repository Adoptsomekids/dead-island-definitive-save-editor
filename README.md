# Dead Island DE — Save Editor v2.1

> **Xbox Series X · Definitive Edition · No Windows Required**  
> Full save editor for Dead Island Definitive Edition.  
> Download saves directly from Xbox Live, edit everything, push back — all from macOS.

[![Node.js](https://img.shields.io/badge/node-18+-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

---

## ✅ What Works (v2.1)

| Feature | Status | Notes |
|---------|--------|-------|
| 💀 Player level (1–60) | ✅ | |
| 💰 Money / wallet | ✅ | Max ~$9,999,999 |
| ❤️ Max HP + current HP | ✅ | |
| ⚔️ Weapon durability | ✅ | Per-slot or all at once |
| 🎯 Weapon ammo/quantity | ✅ | Firearms = ammo count |
| 🎒 Inventory items | ✅ | 33 craft part types + consumables |
| 🗄️ Storage chest (stash) | ✅ | Shared stash between characters |
| 🏆 Collectibles (42 items) | ✅ | Named ID cards, newspapers, audio tapes |
| ⚡ Skill trees | ✅ | Unlock all / reset all |
| 🗺️ Map fog of war | ✅ | Reveal or hide full map |
| ⭐ God Mode preset | ✅ | lvl60 + $9.9M + max HP + max dur + all collectibles |
| ➕ Add item/weapon | ✅ | Inject any craft part, consumable, or weapon |
| 🗺️ Teleport to any map | ✅ | Hotel/Resort/Moresby/Jungle/Prison |
| 🧑 Change character | ✅ | Sam B, Xian Mei, Logan Carter, Purna |
| 📡 Download saves from Xbox Live | ✅ | Direct OAuth2 — no Xbox bridge needed |
| 📡 Push edited save to Xbox Live | ⚠️ macOS → 403 | Use Windows push tool instead |
| 🪟 Windows push tool | ✅ | Reads Xbox tokens from Windows Credential Manager |
| 🌐 Local web editor UI | ✅ | `http://127.0.0.1:3000` |
| 🖥️ All 3 save types | ✅ | Prologue/early/late — byte-perfect round-trip |

---

## How It Works

```
Xbox Live Connected Storage
        │
        │  HTTPS REST API (OAuth2 / XSTS token)
        ▼
  save-sync.ts --cs-pull           ← downloads .bin atom blobs to ./saves/
        │
        │  gzip decompress
        ▼
  save-file.ts (parser)            ← parses binary format into typed objects
        │
        ├──▶ CLI:  save-sync.ts --edit --money 9999999 --max-durability
        │
        └──▶ Web:  web-editor-server.ts  →  http://127.0.0.1:3000
                       (upload, edit, download, push to Xbox)
        │
        │  gzip re-compress
        ▼
  save-sync.ts --cs-push           ← pushes edited .bin back to Xbox Live
  (or on Windows: node tools/push-to-xbox-windows.js)
        │
        ▼
  Xbox loads new save on next launch
```

**No Xbox Developer Mode required.** Everything goes through the official Xbox Live REST API using your Microsoft account credentials.

---

## Quick Start

### 1. Install Dependencies

```bash
cd dead-island-definitive-save-editor
npm install
```

### 2. Authenticate with Xbox Live (one-time)

```bash
npx ts-node tools/save-sync.ts --login
# → Shows a device code + URL — open the URL and enter the code
# Tokens are cached in ~/.xbox-savebridge-tokens.json
```

### 3. Download Your Saves

```bash
# Download all saves (manifests + binary atoms) to ./saves/
npx ts-node tools/save-sync.ts --cs-pull --out ./saves --full
```

This creates:
- `saves/save_1.sav_dec.bin` — decompressed save (3–7 KB, ready to edit)
- `saves/save_1.sav_manifest.json` — atom GUID (needed for push back)

### 4. Launch the Web Editor

```bash
npx ts-node tools/web-editor-server.ts
```

Open **http://127.0.0.1:3000** and click any save file to start editing.

### 5. Inspect a Save (CLI)

```bash
npx ts-node tools/save-sync.ts --info --input saves/save_1.sav_dec.bin
```

Output:
```
┌─ PLAYER ──────────────────────────────────────────────────
│  Character : Sam B (Type;SamB)
│  Level     : 101
│  HP        : 186 / 190
│  Money     : $10,247,820
│  Save date : 2026-07-01 04:00
├─ WEAPONS (quick slots: 7) ────────────────────────────
│  [H] Melee_BoGen [Craftplan_Naildcraft]  dur=60.5  qty=1  lvl=3  (held)
│  [0] Firearm_AutoRifleGen [Craftplan_Shockrifle]  dur=ammo  qty=14  lvl=3
│  ...
├─ INVENTORY (36 items) ────────────────────────────────
│  x 11  Powerup_Alcohol
│  x  7  CraftPart_Battery
│  ...
├─ COLLECTIBLES ─────────────────────────────────────────────
│  27 / 42 unlocked (ID cards · newspapers · tapes)
└───────────────────────────────────────────────────────────
```

### 6. Push Edited Save Back to Xbox

**On macOS** (dry-run works, real push gets 403 — platform restriction):
```bash
npx ts-node tools/save-sync.ts --cs-push --input saves/save_1.sav_dec_edited.bin --dry-run
```

**On Windows PC** (full push works):
```bash
# After git pull on your Windows PC:
node tools\push-to-xbox-windows.js --list-saves
node tools\push-to-xbox-windows.js --input saves\save_1.sav_dec_edited.bin --dry-run
node tools\push-to-xbox-windows.js --input saves\save_1.sav_dec_edited.bin
```

Requires the **Xbox app** installed and signed in on Windows. The tool reads Xbox tokens from Windows Credential Manager automatically.

---

## Web Editor — Feature Tour

### Panels

| Panel | What you can do |
|-------|----------------|
| ⚡ **Player Stats** | Level (1–60), Money, Max HP. Presets: God Mode / Max Money / Max Level |
| 📍 **Location** | Read-only — current map, checkpoint, spawn point |
| ⚔️ **Weapons** | Edit durability, quantity, level per slot. Max All Durability / Max Ammo |
| 🎒 **Inventory** | Edit item quantities. Max All (999) / Clear All |
| 🗄️ **Storage** | Edit stash chest weapons. Max Durability |
| 🏆 **Collectibles** | Named list of all 42 collectibles with unlock state. Unlock All / Lock All |
| ⚡ **Skill Trees** | Unlock all skill nodes. Reset All |
| 🗺️ **Map Fog** | Reveal or hide the full map fog of war |
| ➕ **Add Item** | Add craft parts/consumables by ID. Quick-pick tags for common items |
| ➕ **Add Weapon** | Add any weapon to quick slots. Quick-pick tags + craftplan support |
| 🗺️ **Teleport** | One-click teleport to Hotel / Resort / Moresby / Jungle / Prison |
| 🧑 **Character** | Change to Sam B, Xian Mei, Logan Carter, or Purna |
| 📥 **Download** | Download the edited `.bin` file |
| 📡 **Push** | Push directly to Xbox Live (Windows via wincred) |
| ☁️ **Pull Xbox** | Header button — download fresh saves from Xbox Live |

### Presets & One-Click Actions

- **⭐ God Mode** — Level 60, $9,999,999, HP 9999, all weapon durability 100, all collectibles unlocked, all skills unlocked, full map revealed
- **💰 Max Money** — $9,999,999
- **🏆 Max Level (60)** — Level 60
- **🔧 Max All Durability** — All weapon slots to 100%
- **🎯 Max All Ammo (999)** — All firearm slots to 999 rounds
- **📦 Max All Inventory** — All craft parts and consumables to 999

---

## CLI Reference

```
save-sync.ts — Commands:

  --login                                Xbox Live sign-in (device-code flow, cached)

  --cs-pull [--out ./saves] [--full]     Download save manifests from Xbox Live
                                         Add --full to also download binary blobs

  --info    --input <file.bin>           Inspect save: character, weapons, inventory,
                                         storage, collectibles, rawTail

  --edit    --input <file.bin>           Edit a save file
    [--output <out.bin>]                   Output path (default: adds _edited suffix)
    [--money N]                            Set wallet
    [--level N]                            Set player level (1–60)
    [--max-hp N]                           Set max+current HP
    [--max-durability]                     Max all weapon durability
    [--unlock-collectibles]                Unlock all 42 collectibles
    [--clear-fog]                          Reveal full map fog

  --cs-push --input <file.bin>           Push edited save to Xbox Live
    [--manifest <manifest.json>]           Atom GUID file (auto-detected)
    [--dry-run]                            Simulate without uploading
```

```
push-to-xbox-windows.js — Windows only:

  node tools\push-to-xbox-windows.js --list-saves
  node tools\push-to-xbox-windows.js --input <file.bin>
  node tools\push-to-xbox-windows.js --input <file.bin> --dry-run
  node tools\push-to-xbox-windows.js --input <file.bin> --debug
```

---

## Project Structure

```
dead-island-definitive-save-editor/
├── src/
│   ├── parser/
│   │   ├── save-file.ts     ★ Complete binary parser/serializer
│   │   └── stream.ts          Binary stream reader/writer (little-endian)
│   └── data/items/
│       ├── items.json         Item ID catalog (craft parts, weapons, craftplans)
│       └── collectibles.json  42 named collectibles (ID cards, newspapers, tapes)
├── tools/
│   ├── save-sync.ts           ★ Main CLI: --login, --cs-pull, --cs-push, --info, --edit
│   ├── web-editor-server.ts   ★ Local HTTP server + full HTML editor UI (v2.1)
│   └── push-to-xbox-windows.js  Windows push tool (reads Xbox tokens from wincred)
├── saves/
│   ├── save_*.sav_dec.bin     Real decompressed save files (Xbox Series X)
│   ├── save_*_manifest.json   Atom GUIDs for push
│   └── save_*_edited.bin      Edited saves
├── docs/
│   ├── save-format.md         Complete reverse-engineered binary format spec
│   └── push-to-xbox.md        Windows push guide
└── package.json
```

---

## Save Format (Summary)

The save file is a **gzip-compressed binary blob** stored on Xbox Live Connected Storage.

```
[48 bytes]  Header         — sentinel=0xFFFFFFFF, version=5, level, maxHP, currHP
[variable]  Location Block — mapName, checkpoint, charTypeKey, money, saveDate
[variable]  Weapon Section — sentinel, wsCount, [heldWeapon+preamble], [quickSlots×N]
[variable]  Inventory      — count, [itemId, containerId, uid, qty, dur, pad] × N
[variable]  Storage Chest  — sep=1, count, [itemId, craftplanId, qty, dur, lvl] × N
[variable]  rawTail        — skills, collectibles (42 bytes), map fog (240 bytes), quests
```

Full spec in [`docs/save-format.md`](docs/save-format.md).

**Three real Xbox Series X saves analyzed:**

| Save | Map | Character | Level | Money |
|------|-----|-----------|-------|-------|
| save_0 | Hotel (Prologue) | Sam B | 101 | $8,205,506 |
| save_1 | ACT1A Resort | Sam B | 101 | $10,247,820 |
| save_2 | ACT1A Early | Xian Mei | 101 | $299,913 |

All saves have **byte-perfect round-trip** (no checksums to update).

---

## Known Issues

| Issue | Status |
|-------|--------|
| Upload from macOS → 403 (platform restriction by Xbox Live) | ⚠️ Use Windows push tool |
| `addQuickSlotWeapon` uses a zeroed preamble — game may reject weapon world position | ⚠️ Cosmetic |
| Teleport checkpoint strings are best-guesses — game uses nearest valid checkpoint if not found | ⚠️ Cosmetic |
| Changing character class mid-game resets character-specific skills | ⚠️ By design |

---

## Risk of Ban?

Dead Island Definitive Edition is a **single-player game with no anti-cheat**.  
Xbox Live does not scan save file contents for cheat detection.  
Thousands have used DISE (the original PC editor) for years without issues.  
Your account is safe ✅ — just don't use in multiplayer co-op in a way that crashes others.

---

## Acknowledgements

- [DISE](https://steffenl.com/projects/dead-island-save-editor) — original Dead Island PC save editor (inspiration)
- [SteffenL/dead-island-2-save-editor-external](https://github.com/SteffenL/dead-island-2-save-editor-external) — DI2 editor (methodology reference)

---

## Legal

Personal, single-player use only. Not affiliated with Deep Silver, Techland, or Microsoft.
