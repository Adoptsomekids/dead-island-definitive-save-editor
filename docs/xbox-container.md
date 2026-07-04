# Xbox Save Container Format

> Notes on Xbox STFS (Secure Transacted File System) container format and
> methods to extract/inject save files from Xbox One / Xbox Series X.

---

## ⚠️ Important: Xbox 360 vs Xbox Series X

**Xbox 360** allowed copying saves to USB freely. Tools like **Horizon** and
**Modio** could read those USB containers on Windows. These tools are
**Xbox 360 only** and do NOT work with Xbox One or Xbox Series X.

**Xbox Series X** (and Xbox One) lock saves differently:
- The "Move to USB" option copies game installs, not saves
- Save files are stored internally and tied to your Xbox Live profile
- Microsoft does not expose a public cloud save download API
- The **only viable extraction path** is via **Xbox Developer Mode**

---

## Method A — Xbox Developer Mode + Device Portal (✅ Works on macOS)

This is the recommended method. It works from any browser or HTTP client —
including macOS — over your local WiFi network.

### One-time setup (costs $19 USD)

1. Go to [dev.xbox.com](https://dev.xbox.com) and register as a developer.
2. On your Xbox Series X: **Settings → System → Developer settings → Activate Developer Mode**.
3. The console will reboot into a split mode where both retail games AND dev mode coexist.
4. Set a username and password for the Device Portal when prompted.

### Using the Device Portal

Once in Dev Mode, your Xbox exposes a local REST API. Find the IP of your
Xbox under **Settings → General → Network settings → Advanced settings**.

```
http://<xbox-ip>:11443
```

Open that URL from your Mac browser — you'll get a full web UI to manage the console.

### REST API endpoints (callable from macOS terminal or our tool)

```bash
XBOX_IP=192.168.1.X
USER=your-dev-portal-user
PASS=your-dev-portal-password

# List installed packages (games)
curl -k -u "$USER:$PASS" "https://$XBOX_IP:11443/api/app/packagemanager/packages"

# List file system (game save area)
curl -k -u "$USER:$PASS" "https://$XBOX_IP:11443/ext/app/filesysteminfo"

# Download a specific file
curl -k -u "$USER:$PASS" "https://$XBOX_IP:11443/api/filesystem/apps/file?knownfolderid=LocalAppData&packagefullname=<pfn>&filename=<path>" -o save.sav
```

The `save-sync` tool in this project (`src/xbox/device-portal.ts`) automates
this workflow — see README for usage.

---

## Method B — Xbox Cloud Saves via Windows Xbox App (requires Windows)

On **Windows** only:
1. Open Xbox App → enable cloud saves for Dead Island DE.
2. Saves sync to:
   `%LOCALAPPDATA%\Packages\Microsoft.GamingApp_8wekyb3d8bbwe\SystemAppData\wgs\`
3. Inside you'll find STFS containers — run `tools/extract-container.ts` on them.

**Not available on macOS** — there is no Xbox App for macOS.

---

## Method C — USB Transfer (Xbox 360 ONLY — does NOT apply to Series X)

> ⚠️ This method works for Xbox 360 saves only.
> On Xbox Series X, USB only transfers game installs — not save files.

1. On Xbox 360: **Settings → System → Storage → Move/Copy → USB**.
2. Read the USB on PC with **Horizon** (Windows) or **Modio** (Windows).

---

## STFS Container Format (for Xbox 360 saves)

Xbox 360 STFS packages use this layout (relevant if you ever work with 360 saves):

```
Offset  Size   Description
0x0000  4      Magic ("CON ", "LIVE", "PIRS") — Big-Endian
0x0004  0x228  Certificate block
0x022C  0x114  Signature
0x0340  0x04   License descriptor length
0x0360  0x04   Title ID    (Dead Island 360 = 0x534307D4)
0x0411  0x100  Display name (UTF-16BE)
```

| Magic | Signing | Notes |
|-------|---------|-------|
| `CON ` | Console-signed | Moddable with console private key |
| `LIVE` | Xbox Live-signed | Cannot be self-signed |
| `PIRS` | Microsoft-signed | Cannot be self-signed |

---

## Re-Signing (Xbox 360 only)

After modifying a `CON`-signed 360 container, re-sign with:
- **Horizon** (Windows): rehash + resign with your profile's console certificate
- **Velocity** (open source C#): `Velocity rehash resign <container>`

LIVE/PIRS containers cannot be re-signed offline — they require Xbox Live servers.
Xbox Series X saves are LIVE-signed and handled entirely server-side by Microsoft.
