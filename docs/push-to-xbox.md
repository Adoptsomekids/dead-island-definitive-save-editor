# Pushing Edited Saves to Xbox — Dead Island DE

## Current Status (v28)

| Method | Status | Notes |
|--------|--------|-------|
| `--cs-push` from macOS | ❌ 403 | Platform restriction on Xbox Live write API |
| SaveBridge `/cs/upload` (XDKS.1) | ❌ Timeout | Dev sandbox — DI SCID not authorized |
| SaveBridge `/cs/upload` (RETAIL) | ✅ **Working** | Requires sandbox switch (see below) |
| xbcsmgr on Windows | ✅ Working | Windows-only, needs Xbox app + Credential Manager tokens |

---

## ✅ Method 1: SaveBridge v28 `/cs/upload` — Recommended (Dev Mode)

This uses `GameSaveProvider.SubmitUpdatesAsync` running on the Xbox itself to write directly to Dead Island's Connected Storage. It requires your Xbox to be in **RETAIL sandbox** temporarily.

### Step 1 — Switch Xbox to RETAIL sandbox

On Xbox, **one of two ways**:

**Option A — Dev Home** (fastest, no reboot needed in some firmware):
1. Launch **Dev Home** app on Xbox
2. Go to **Sandbox** tab
3. Change from `XDKS.1` to `RETAIL`
4. Press **Apply** — Xbox will reboot

**Option B — Settings** (always works):
1. Xbox Settings → **System** → **Console info**
2. Scroll to **Reset console**
3. Choose **Reset and keep my games & apps**
4. After reboot, go to Settings → **System** → **Developer settings**
5. Set Sandbox ID to `RETAIL` → **Save**

> ⚠️ In RETAIL sandbox, the **Dev Home** and some dev tools won't work. SaveBridge will still run because it's sideloaded. Switch back to `XDKS.1` after the push.

### Step 2 — Verify SaveBridge is running after reboot

```bash
curl -s http://192.168.100.27:8765/status
# Expected: {"status":"ok","port":8765,"build":"v28-js"}
```

If not running, launch it via Device Portal:
```bash
CSRF=$(curl -sk -u "DevToolsUser:tNJ^VW9BK_v2;" \
  "https://192.168.100.27:11443/api/os/info" -D - -o /dev/null 2>/dev/null \
  | grep -o 'CSRF-Token=[^ ]*' | cut -d= -f2 | tr -d '\r')

curl -sk -u "DevToolsUser:tNJ^VW9BK_v2;" -X POST \
  "https://192.168.100.27:11443/api/taskmanager/app?appid=QWRvcHRzb21la2lkcy5TYXZlQnJpZGdlX3p2MGExdG0xZ2J6OWEhQXBw" \
  -H "X-CSRF-Token: $CSRF" -H "Content-Length: 0"
```

### Step 3 — List containers to confirm RETAIL sandbox

```bash
curl -s "http://192.168.100.27:8765/cs/list" | python3 -m json.tool
```

In RETAIL sandbox with DI synced, you'll see containers like:
```json
{
  "scid": "db860100-d780-4e17-8685-ad130052ea64",
  "containers": [
    { "name": "GameSave", "displayName": "GameSave", "totalSize": 5370 }
  ]
}
```

> If `containers: []` — either DI hasn't been launched on this Xbox yet (launch it once to create the cloud save slot), or the sandbox is still XDKS.1.

### Step 4 — Push the edited save

```bash
cd /Users/emilio-ibm/Documents/MOD/BOB/Adopt/Dead\ Island/dead-island-definitive-save-editor

# List containers first (auto-detects container name)
npx ts-node --transpile-only tools/bridge-push.ts --list

# Push edited save_1
npx ts-node --transpile-only tools/bridge-push.ts \
  --input saves/save_1.sav_edited.bin \
  --xbox-ip 192.168.100.27

# If you know the container name from --list:
npx ts-node --transpile-only tools/bridge-push.ts \
  --input saves/save_1.sav_edited.bin \
  --container "GameSave" \
  --blob "save_1.sav" \
  --xbox-ip 192.168.100.27
```

Or push directly with curl:
```bash
curl -s -X POST \
  "http://192.168.100.27:8765/cs/upload?container=GameSave&blob=save_1.sav" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@saves/save_1.sav_edited.bin" | python3 -m json.tool
```

Expected success response:
```json
{
  "ok": true,
  "bytes": 1614,
  "container": "GameSave",
  "blob": "save_1.sav",
  "scid": "db860100-d780-4e17-8685-ad130052ea64",
  "note": "Written to Connected Storage. If Xbox is in RETAIL sandbox, DI will load this on next launch."
}
```

### Step 5 — Launch Dead Island DE

Start Dead Island: Definitive Edition on Xbox. The game will sync from Connected Storage and load your edited save with:
- Level 60
- $9,900,000 cash
- God Mode

### Step 6 — Switch back to XDKS.1

```bash
# Via Dev Home after confirming save works, or:
# Settings → System → Developer settings → Sandbox ID → XDKS.1 → Save
```

---

## ✅ Method 2: xbcsmgr on Windows (no sandbox switch needed)

[xbcsmgr](https://github.com/billynothingelse/xbcsmgr) runs in RETAIL context from Windows and uses the Xbox app's credential tokens.

1. Edit save on Mac → transfer `saves/save_1.sav_edited.bin` to Windows PC
2. Windows: Install Xbox app, sign in with **Adopted Kz** account
3. Download xbcsmgr → navigate to Dead Island DE → replace save_1 → upload
4. Launch DI on Xbox

---

## Why `--cs-push` from macOS Returns 403

The Xbox Live Connected Storage **write** endpoint (`POST /connectedstorage/...`) enforces a platform restriction:

```json
{ "code": 2016, "description": "Access is denied due to platform restriction policies." }
```

Writing requires a device token obtained through the official Xbox Live SDK on Windows, stored in Windows Credential Manager. The macOS device code flow gets a user-only XSTS token which is insufficient for writes.

The SaveBridge `/cs/upload` approach bypasses this — `GameSaveProvider.SubmitUpdatesAsync` runs **on the Xbox itself** and has the correct platform context automatically.

---

## Save File Reference

| File | Description |
|------|-------------|
| `saves/save_1.sav.bin` | Original (gzip, 1785 B) |
| `saves/save_1.sav_dec.bin` | Decompressed original |
| `saves/save_1.sav_dec_edited.bin` | Edited decompressed |
| `saves/save_1.sav_edited.bin` | **TARGET** — edited + gzip (1614 B) ← push this |
| `saves/save_1.sav_manifest.json` | Atom GUID: `972875C7-F554-4CBB-855D-1D2BFAA706F0` |

XUID: `2535409375459619` | SCID: `db860100-d780-4e17-8685-ad130052ea64`
