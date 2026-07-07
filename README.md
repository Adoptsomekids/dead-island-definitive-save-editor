# Dead Island DE — Save Editor

> **Xbox Series X · Definitive Edition · No Windows Required**  
> Full save editor for Dead Island Definitive Edition.  
> Download saves directly from Xbox Live, edit everything, push back — all from macOS.

[![Node.js](https://img.shields.io/badge/node-18+-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

---

## ✅ What Works Right Now

| Feature | Status | Notes |
|---------|--------|-------|
| 💀 Player level (1–60) | ✅ Working | |
| 💰 Money / wallet | ✅ Working | Max ~$9,999,999 |
| ❤️ Max HP (current + max) | ✅ Working | |
| ⚔️ Weapon durability | ✅ Working | Per-slot or all at once |
| 🎯 Weapon ammo/quantity | ✅ Working | Firearms = ammo count |
| 🎒 Inventory items (craft parts, consumables) | ✅ Working | 36+ item types |
| 🗄️ Storage chest (stash) | ✅ Working | Weapons stored in the shared chest |
| 📡 Download saves from Xbox Live | ✅ Working | Direct OAuth2 — no Xbox bridge needed |
| 📡 Push edited save back to Xbox Live | ✅ Working | `--cs-push` command |
| 🌐 Local web editor UI | ✅ Working | `http://127.0.0.1:3000` |
| 🖥️ All 3 save types (prologue/early/late) | ✅ Working | Perfect byte-for-byte round-trip |
| 🗺️ Map fog / skills / collectibles | 🔬 Research | rawTail preserved — not yet editable |

---

## How It Works (Architecture)

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
        │
        ▼
  Xbox loads new save on next launch
```

**No Xbox Developer Mode required.** Everything goes through the official Xbox Live REST API using your Microsoft account credentials (the same ones you use to sign in on Xbox).

---

## Quick Start

### 1. Install Dependencies

```bash
cd dead-island-definitive-save-editor
npm install
```

### 2. Authenticate with Xbox Live (one-time)

```bash
# Standard login (works for listing saves + manifest download)
npx ts-node tools/save-sync.ts --login
# → Opens browser with a code — sign in with your Xbox account

# Legacy login (needed for full binary atom download/upload)
npx ts-node tools/save-sync.ts --login-legacy
# → Opens a login page — sign in again (same account)
# Tokens are cached in ~/.xbox-savebridge-tokens.json
```

### 3. Download Your Saves

```bash
# Download all save manifests + binary atoms to ./saves/
npx ts-node tools/save-sync.ts --cs-pull --out ./saves --full
```

This creates files like:
- `saves/save_1.sav_dec.bin` — decompressed save (3–7 KB, ready to edit)
- `saves/save_1.sav_manifest.json` — atom GUID (needed for push)

### 4. Launch the Web Editor

```bash
npx ts-node tools/web-editor-server.ts --port=3000 --saves=./saves
```

Open **http://127.0.0.1:3000** in your browser. Click any save file on the left to start editing.

### 5. Or Use the CLI

```bash
# Inspect a save
npx ts-node tools/save-sync.ts --inspect --input saves/save_1.sav_dec.bin

# Edit: money + god mode + max durability
npx ts-node tools/save-sync.ts --edit \
  --input saves/save_1.sav_dec.bin \
  --money 9999999 --level 60 --max-hp 9999 --max-durability \
  --output saves/save_1_MAXED.bin

# God mode preset (level 60 + $9.9M + HP 9999 + max durability)
# (use --edit with all flags above)
```

### 6. Push Edited Save Back to Xbox

```bash
npx ts-node tools/save-sync.ts --cs-push \
  --input saves/save_1.sav_dec_edited.bin
  # --manifest is auto-detected from filename
```

Then **launch Dead Island on your Xbox** — the game will load the save from cloud storage automatically.

---

## Web Editor Tour

```
┌─────────────────────────────────────────────────────────────┐
│  💀 Dead Island DE — Save Editor  v2.0                      │
├──────────────┬──────────────────────────────────────────────┤
│ Save Files   │  🥁 Sam B                                     │
│              │  Type;SamB · Resort – Act 1 · 2026-07-01     │
│ save_0…bin   │  ┌──────┐ ┌───────────┐ ┌──────────┐        │
│ save_1…bin ◀ │  │ 101  │ │ $10,247,820│ │ 186/190  │        │
│ save_2…bin   │  │Level │ │   Money   │ │    HP    │        │
│              │  └──────┘ └───────────┘ └──────────┘        │
│ Upload Save  │                                               │
│              │  ⚡ Player Stats  [Apply] [God Mode] [Max $]  │
│              │  ⚔️  Weapons (7 slots + held)                  │
│              │  🎒 Inventory (36 items)                       │
│              │  🗄️  Storage Chest (5 weapons)                 │
│              │  📍 Location info                              │
│              │  📥 Download ⬇  |  📡 Push to Xbox            │
└──────────────┴──────────────────────────────────────────────┘
```

**Features in the UI:**
- Click any `.bin` file on the left sidebar to load it
- **Upload Save** button (header) — drag & drop a `.bin` file from your computer
- **God Mode** preset — sets level=60, money=$9.9M, HP=9999, all durability=100 in one click
- **Max All Durability** — all quick-slot weapons to 100%
- **Max All Ammo (999)** — all firearms to 999 rounds
- **Max Inventory (999)** — all craft parts/consumables to max stack
- **Download .bin** — save the edited file to your computer
- **Dry Run** — simulates a push to Xbox without actually uploading
- **Push to Xbox Live** — sends the save directly to cloud storage

---

## CLI Reference

```
save-sync.ts — All commands:

  --login                                Xbox Live sign-in (MSA device-code flow)
  --login-legacy                         Legacy Xbox Live login (needed for binary download)

  --cs-pull [--out ./saves] [--full]     Download save manifests from Xbox Live
                                         Add --full to also download binary atom data

  --cs-push --input <file.bin>           Push edited save back to Xbox Live
    [--manifest <manifest.json>]           Manifest file (auto-detected if omitted)
    [--dry-run]                            Simulate without uploading

  --inspect --input <file.bin>           Display full save contents (character, weapons, inventory)

  --edit --input <file.bin>              Edit a save file
    [--output <out.bin>]                   Output file (default: adds _edited suffix)
    [--money N]                            Set wallet (e.g. 9999999)
    [--level N]                            Set player level (1–60)
    [--max-hp N]                           Set max+current HP
    [--max-durability]                     Max all weapon durability
    [--max-inventory]                      Set all inventory items to 999
    [--item <ItemId> --item-qty N]         Set specific item quantity

  --list-steam                           Find Steam save files (macOS)
  --bridge --xbox-ip <ip>                SaveBridge status (Dev Mode only)
```

---

## Project Structure

```
dead-island-definitive-save-editor/
├── src/
│   └── parser/
│       ├── save-file.ts     ★ Complete binary parser/serializer (real Xbox format)
│       └── stream.ts        ★ Binary stream reader/writer (little-endian)
├── tools/
│   ├── save-sync.ts         ★ Main CLI: --login, --cs-pull, --cs-push, --inspect, --edit
│   └── web-editor-server.ts ★ Local HTTP server + full HTML editor UI
├── saves/
│   ├── save_*.sav_dec.bin   Real decompressed save files (Xbox Series X)
│   ├── save_*_manifest.json Atom GUIDs for push
│   └── save_*_edited.bin    Edited saves
├── docs/
│   └── save-format.md       Complete reverse-engineered binary format spec
├── tests/                   Jest unit tests
└── package.json
```

---

## Save Format (Summary)

The save file is a **gzip-compressed binary blob** stored on Xbox Live Connected Storage.  
After decompression, the layout is:

```
[48 bytes] Header         — sentinel=0xFFFFFFFF, version=5, level, maxHP, currHP
[variable] Location Block — mapName, checkpoint, charTypeKey, money, saveDate
[variable] Weapon Section — sentinel=0xFFFFFFFF, wsCount, [held+preamble], [quickSlots×N]
[variable] Inventory      — count, [itemId, containerId, uid, qty, dur, pad] × N
[variable] Storage Chest  — sep=1, count, pad=0, [itemId, craftplanId, ...] × N
[variable] rawTail         — skills, quests, collectibles, map fog (preserved, not yet parsed)
```

Full details in [`docs/save-format.md`](docs/save-format.md).

---

## Supported Saves

| Save | Map | Character | Status |
|------|-----|-----------|--------|
| save_0 | Hotel (Prologue) | Sam B | ✅ Basic edits, preamble=73b |
| save_1 | ACT1A Resort | Sam B | ✅ Full parse, preamble=57b |
| save_2 | ACT1A Early | Xian Mei | ✅ Basic edits, preamble=82b |

All saves have **byte-perfect round-trip** (edited file is identical to original except for intended changes).

---

## Risk of Ban?

Dead Island Definitive Edition is a **single-player game**.  
The online component is limited to:
- Co-op matchmaking (finding other players' sessions)
- Leaderboards

**There is no anti-cheat in Dead Island DE.** Rockstar, Activision, EA — they have anti-cheat. Deep Silver/Techland did not implement one for this game. Thousands of people have used DISE (the original PC save editor) for years without bans.

**However:**
- Do not use edited saves in multiplayer co-op if it crashes others' games
- The game does not validate save data server-side
- Xbox Live itself does not scan save file contents for cheat detection
- Your account is safe ✅

---

## Acknowledgements

- [DISE](https://steffenl.com/projects/dead-island-save-editor) — original Dead Island PC save editor (inspiration)
- [libvantage](https://github.com/Adoptsomekids/libvantage) — binary stream I/O framework patterns
- [SteffenL/dead-island-2-save-editor-external](https://github.com/SteffenL/dead-island-2-save-editor-external) — DI2 editor reference

---

## Legal

This project is for **personal, single-player use only**.  
Not affiliated with Deep Silver, Techland, or Microsoft.  
Use responsibly — do not use in competitive/ranked settings.
