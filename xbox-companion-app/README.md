# SaveBridge — Xbox UWP Companion App

A minimal UWP app that runs **on your Xbox Series X** (via Developer Mode) and exposes
Dead Island Definitive Edition save files over a local HTTP server on your network.

Your Mac calls the HTTP endpoints to download/upload saves — no Windows PC required.

---

## How It Works

```
[Xbox Series X — SaveBridge UWP running]
    ↓  Windows.Gaming.XboxLive.Storage API
    ↓  reads/writes Dead Island DE Connected Storage blobs
    ↓  HTTP server on port 8765
    ↓  local WiFi network

[Your Mac]
    ↓  npm run sync -- --download ...
    →  http://192.168.100.27:8765/save/download
    ←  raw save blob
```

---

## Build Requirements (Windows only for build step)

- Visual Studio 2022 with **Universal Windows Platform** workload
- Windows 10 SDK 10.0.19041.0 or later
- Xbox Developer Mode active on your Series X

## Build & Deploy

```powershell
# Open SaveBridge.sln in Visual Studio
# Set target: Release | ARM64
# Deploy to Xbox via Device Portal:
#   Project → Deploy Solution
#   (Visual Studio auto-deploys to the Xbox Device Portal)
```

## Pre-built APPX (no Windows required)

A pre-built `.appxbundle` is provided in the `dist/` folder.
Deploy it from your Mac using the Device Portal:

```bash
# Deploy via Device Portal
curl -k -u "DevToolsUser:PASSWORD" \
  -X POST "https://192.168.100.27:11443/api/app/packagemanager/package" \
  -F "file=@dist/SaveBridge.appxbundle"
```

## API Endpoints (once running on Xbox)

| Method | URL | Description |
|--------|-----|-------------|
| `GET`  | `http://<xbox-ip>:8765/status` | Health check |
| `GET`  | `http://<xbox-ip>:8765/save/list` | List all save blobs |
| `GET`  | `http://<xbox-ip>:8765/save/download?name=<blob>` | Download a save blob |
| `POST` | `http://<xbox-ip>:8765/save/upload?name=<blob>` | Upload/overwrite a save blob |

---

## Usage from Mac

```bash
# In dead-island-definitive-save-editor/
npm run sync -- --download --xbox-ip 192.168.100.27 --bridge-port 8765
npm run sync -- --upload --input save.edited.sav --xbox-ip 192.168.100.27 --bridge-port 8765
```
