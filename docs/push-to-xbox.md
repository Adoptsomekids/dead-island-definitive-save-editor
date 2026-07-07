# Pushing Edited Saves Back to Xbox Live

## Why `--cs-push` Still Returns 403

Xbox's Connected Storage **write** API enforces a platform restriction:

```json
{ "code": 2016, "description": "Access is denied due to platform restriction policies." }
```

**Reading** saves works fine with our ProofOfPossession device token.  
**Writing** requires a *higher-privilege* device token that is only issued by the official Xbox Live SDK running on a Windows PC (stored in Windows Credential Manager as `Xbl|...Dtoken`).

---

## ✅ Working Method: xbcsmgr on Windows

[xbcsmgr](https://github.com/billynothingelse/xbcsmgr) is a Windows tool that reads the pre-existing Xbox SDK device token from Windows Credential Manager and can **upload** saves directly.

### Step-by-step

1. **Edit your save on Mac** (all of this works from macOS):
   ```bash
   npx ts-node tools/save-sync.ts --login
   npx ts-node tools/save-sync.ts --cs-pull --out ./saves --full
   npx ts-node tools/save-sync.ts --edit --input ./saves/save_1.sav.bin \
     --money 9999999 --level 60 --max-durability \
     --unlock-collectibles --clear-fog --unlock-skills
   # Output: ./saves/save_1.sav_edited.bin
   ```

2. **Transfer `save_1.sav_edited.bin` to your Windows PC** (USB, AirDrop, OneDrive, etc.)

3. **On Windows** — ensure the Xbox app is installed and you're signed in with the **same account** as your Xbox. This populates the Windows Credential Manager with the required device tokens.

4. **Download xbcsmgr** from [https://github.com/billynothingelse/xbcsmgr/releases](https://github.com/billynothingelse/xbcsmgr/releases) and run it.

5. In xbcsmgr:
   - Sign in if prompted
   - Navigate to **Dead Island Definitive Edition**
   - Select save slot `save_1`
   - Click **Upload / Replace** and select your `save_1.sav_edited.bin`
   - Confirm upload

6. **On your Xbox Series X** — launch Dead Island: Definitive Edition and load the save. The game pulls the latest cloud save automatically.

---

## Alternative: Xbox App on Windows + Manual WGS Replace

If xbcsmgr doesn't list Dead Island, you can replace saves directly in the WGS folder:

1. Open **Xbox app** on Windows → sync your saves
2. Navigate to:
   ```
   %LOCALAPPDATA%\Packages\Microsoft.GamingApp_8wekyb3d8bbwe\SystemAppData\wgs\
   ```
3. Find your XUID folder → find Dead Island's SCID folder (`db860100-d780-4e17-8685-ad130052ea64`)
4. Replace the blob binary with your edited `save_1.sav_edited.bin`
5. Trigger a sync via Xbox app

> ⚠️ **Always back up the originals before replacing!**

---

## Alternative: Xbox Dev Mode + SaveBridge

If you have your Xbox in **Developer Mode**:

1. Deploy the SaveBridge UWP from `xbox-savebridge/dist/`
2. Find your Xbox IP (Settings → Advanced → IP Address)
3. Run:
   ```bash
   npx ts-node tools/save-sync.ts --cs-download --xbox-ip 192.168.x.x
   # edit, then upload back:
   npx ts-node tools/save-sync.ts --bridge-upload --xbox-ip 192.168.x.x \
     --input ./saves/save_1.sav_edited.bin
   ```

---

## Workaround: Xbox USB Save Transfer (Xbox Backup)

Some Xbox games support USB save backup via **Manage game and add-ons → Saved data → Copy**:

1. On Xbox: Settings → System → Storage → select your internal storage → Dead Island DE → Copy to external USB
2. Connect USB to Mac, edit the save
3. Copy back to USB → plug into Xbox → restore

> **Note:** Dead Island DE uses cloud-synced connected storage which may override USB saves on next launch. Start the game in **offline mode** first, then load.

---

## Roadmap: Native macOS Push

We are investigating a way to obtain a higher-privilege device token from macOS. The leading approaches:

- **Xbox Companion app client ID** (`49e950aa-840a-4d52-8b9b-ef7d3c8b02b1`) — may issue write-capable XSTS
- **XSAPI device code flow** — Xbox Live SDK auth used by official tools
- **Relay server** — a Windows helper that uses its Credential Manager tokens to proxy our write requests

Track progress: [GitHub Issues](https://github.com/Adoptsomekids/dead-island-definitive-save-editor/issues)
