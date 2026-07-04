# Xbox Save Container Format

> Notes on Xbox STFS (Secure Transacted File System) container format used on
> Xbox 360, Xbox One, and Xbox Series X.

---

## What Is STFS?

STFS is the container format used to package Xbox Live content and save game data.
Dead Island Definitive Edition save files are stored inside STFS packages within your Xbox profile.

## Container Types

| Magic | Type | Description |
|-------|------|-------------|
| `CON ` | Console-signed | Modded/unsigned content (requires console private key) |
| `LIVE` | Xbox Live signed | Official signed content |
| `PIRS` | MS-signed | Microsoft marketplace content |

## Header Layout

```
Offset  Size   Description
0x0000  4      Magic ("CON ", "LIVE", "PIRS")
0x0004  0x228  Certificate block
0x022C  0x114  Signature
0x0340  0x228  Content metadata
  0x0340  0x10   License descriptor
  0x0350  0x14   Content SHA1
  0x0364  0x04   Header size
  0x0368  0x04   Content type
  0x036C  0x04   Metadata version
  0x0370  0x08   Content size (bytes)
  0x0378  0x04   Media ID
  0x037C  0x04   Version
  0x0380  0x04   Base version
  0x0384  0x04   Title ID           ← Dead Island DE = 0x534307D4
  0x0388  0x01   Platform
  0x0389  0x01   Executable type
  0x038A  0x04   Disc number
  0x038E  0x04   Disc in set
  0x0392  0x04   Savegame ID
  0x0396  0x05   Console ID (profile)
  0x039B  0x08   Profile ID (XUID)
  0x03A9  ...   File table setup
  0x0411  0x100  Display name (UTF-16BE, 128 chars)
  0x0511  0x100  Display description (UTF-16BE)
  0x0611  0x04   Publisher
  ...
```

## Extracting Saves

### Option A — Horizon (Windows)
1. Download [Horizon](https://www.wemod.com/horizon) (free).
2. Connect your Xbox USB drive or modded profile storage.
3. Open the profile → navigate to Dead Island → right-click save → **Extract**.
4. The extracted blob is the raw save file for this editor.

### Option B — Xbox App (PC) — Cloud Sync
1. Open Xbox App → enable cloud saves for Dead Island DE.
2. Cloud save path on Windows:
   `%LOCALAPPDATA%\Packages\Microsoft.GamingApp_8wekyb3d8bbwe\SystemAppData\wgs\`
3. Inside you'll find STFS containers — run `tools/extract-container.ts` on them.

### Option C — Transfer Mode (USB)
1. On Xbox: **Settings → System → Storage → Move/Copy → USB**.
2. Copy Dead Island DE saved games.
3. USB layout: `Xbox360/000D000\{ProfileID}\FFFE07D1\00000001\{titleID}\`

### Option D — Developer Mode
1. Enable Xbox Series X developer mode ($19 fee via Dev Portal).
2. Use Xbox Device Portal (browser) to browse filesystem.
3. Navigate to `D:\DLC\{titleID}\` to find save files.

---

## Re-Signing

After modifying a `CON`-signed container, you must re-sign it:
- **Horizon** (Windows): rehash + resign with your profile's console certificate.
- **Velocity** (open source C#): `Velocity rehash resign <container>`.

LIVE/PIRS-signed containers cannot be self-signed — they require Xbox Live servers.
