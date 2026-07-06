#!/usr/bin/env ts-node
// tools/save-sync.ts
// ─────────────────────────────────────────────────────────────────────────────
// Dead Island Definitive Edition — Save File Sync Tool
//
// HOW TO GET YOUR XBOX SERIES X SAVE FILE
// ────────────────────────────────────────
// Option A — SaveBridge (recommended): sideloaded JS UWP app running on your
//   Xbox in Dev Mode that exposes an HTTP API on port 8765.
//   Deploy it from https://github.com/Adoptsomekids/xbox-savebridge then:
//     npx ts-node tools/save-sync.ts --bridge --xbox-ip 192.168.x.x
//     npx ts-node tools/save-sync.ts --bridge-download --xbox-ip 192.168.x.x
//
//   /cs/list and /cs/download use GameSaveProvider (requires Xbox Live online).
//   When Xbox Live is available, use:
//     npx ts-node tools/save-sync.ts --cs-list --xbox-ip 192.168.x.x
//     npx ts-node tools/save-sync.ts --cs-download --xbox-ip 192.168.x.x [--out ./saves]
//
// Option B — Windows PC + Xbox App:
//   The Xbox app syncs saves to:
//   %LOCALAPPDATA%\Packages\Microsoft.GamingApp_8wekyb3d8bbwe\SystemAppData\wgs\
//   Copy the container blobs to your Mac, then:
//     npx ts-node tools/save-sync.ts --import --input <blob_file>
//
// Option C — Steam (PC):
//   npx ts-node tools/save-sync.ts --list-steam
//
// Option D — PlayStation (PS4/PS5):
//   Use Apollo Save Tool, then --import
//
// USAGE:
//   npx ts-node tools/save-sync.ts --bridge           --xbox-ip <ip>  # list SaveBridge status + /cs containers
//   npx ts-node tools/save-sync.ts --cs-list          --xbox-ip <ip>  # list DI save containers via GameSaveProvider
//   npx ts-node tools/save-sync.ts --cs-download      --xbox-ip <ip> [--out ./saves]  # download all blobs
//   npx ts-node tools/save-sync.ts --import  --input <file>           # import/inspect a save
//   npx ts-node tools/save-sync.ts --info    --input <file>           # show save info
//   npx ts-node tools/save-sync.ts --list-steam                       # find Steam saves automatically
//   npx ts-node tools/save-sync.ts --login                            # Xbox Live login (token cache)
//   npx ts-node tools/save-sync.ts --list                             # list Xbox Live containers (dev only)
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from "fs";
import * as path from "path";
import * as os   from "os";
import * as https from "https";
import * as http  from "http";

// ── Constants ──────────────────────────────────────────────────────────────────

const DEAD_ISLAND_SCID    = process.env.XBOX_SCID  ?? "db860100-d780-4e17-8685-ad130052ea64";
const DEAD_ISLAND_TITLEID = "433850"; // Steam App ID (also used in Xbox paths)
const SAVES_DIR           = process.env.SAVES_DIR  ?? "./saves";

// MSA client id from microsoft/xbox-live-developer-tools (MsalTestAuthContext.cs)
const MSA_CLIENT_ID  = "b1eab458-325b-45a5-9692-ad6079c1eca8";
const MSA_TENANT     = "consumers";
const MSA_SCOPES     = "Xboxlive.signin Xboxlive.offline_access offline_access";
const XASU_ENDPOINT  = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_ENDPOINT  = "https://xsts.auth.xboxlive.com/xsts/authorize";
const TS_ENDPOINT    = "https://titlestorage.xboxlive.com";
const CACHE_FILE     = path.join(os.homedir(), ".xbox-savebridge-tokens.json");

// ── Argument parsing ───────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const getArg    = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : undefined; };
const hasFlag   = (f: string) => args.includes(f);
const XBOX_IP   = getArg("--xbox-ip") ?? process.env.XBOX_IP ?? "192.168.100.27";
const BRIDGE_PORT = 8765;

// ── HTTP helper ────────────────────────────────────────────────────────────────

function httpsRequest(
  url: string, method: string,
  headers: Record<string, string>,
  body?: string | Buffer
): Promise<{ status: number; body: string; rawBody: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts: https.RequestOptions = {
      hostname: u.hostname, port: u.port ? parseInt(u.port) : 443,
      path: u.pathname + u.search, method,
      headers: { ...headers, ...(body ? { "Content-Length": Buffer.byteLength(body).toString() } : {}) },
    };
    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const rawBody = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, body: rawBody.toString("utf8"), rawBody });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Token cache ────────────────────────────────────────────────────────────────

interface TokenCache {
  msaRefreshToken?: string; msaAccessToken?: string; msaExpiry?: number;
  xstsToken?: string; xstsExpiry?: number;
  userHash?: string; xuid?: string; gamertag?: string;
}
const loadCache = (): TokenCache => {
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch {}
  return {};
};
const saveCache = (c: TokenCache) => fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });

// ── MSA device-code login ──────────────────────────────────────────────────────

async function msaDeviceCodeLogin(): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const dcResp = await httpsRequest(
    `https://login.microsoftonline.com/${MSA_TENANT}/oauth2/v2.0/devicecode`, "POST",
    { "Content-Type": "application/x-www-form-urlencoded" },
    new URLSearchParams({ client_id: MSA_CLIENT_ID, scope: MSA_SCOPES }).toString()
  );
  if (dcResp.status !== 200) throw new Error(`Device code failed ${dcResp.status}: ${dcResp.body}`);
  const dc = JSON.parse(dcResp.body);

  console.log("\n─────────────────────────────────────────────────");
  console.log("  Xbox Live Login");
  console.log("─────────────────────────────────────────────────");
  console.log(`  1. Open: ${dc.verification_uri}`);
  console.log(`  2. Enter code: ${dc.user_code}`);
  console.log(`  3. Sign in with your Microsoft/Xbox account`);
  console.log("─────────────────────────────────────────────────\n");

  const deadline = Date.now() + dc.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, (dc.interval + 1) * 1000));
    const r = await httpsRequest(
      `https://login.microsoftonline.com/${MSA_TENANT}/oauth2/v2.0/token`, "POST",
      { "Content-Type": "application/x-www-form-urlencoded" },
      new URLSearchParams({ client_id: MSA_CLIENT_ID, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: dc.device_code }).toString()
    );
    if (r.status === 200) { console.log("✔ Login successful!\n"); return JSON.parse(r.body); }
    const e = JSON.parse(r.body);
    if (e.error === "authorization_pending") { process.stdout.write("."); continue; }
    if (e.error === "authorization_declined") throw new Error("Login declined.");
    throw new Error(`Poll error: ${r.body}`);
  }
  throw new Error("Device code expired. Run --login again.");
}

// ── XASU / XSTS token exchange ────────────────────────────────────────────────

interface XToken { Token: string; DisplayClaims?: { xui?: Array<{ uhs?: string; xid?: string; gtg?: string }> }; NotAfter?: string; }

async function fetchXasuToken(msaToken: string): Promise<XToken> {
  const r = await httpsRequest(XASU_ENDPOINT, "POST",
    { "Content-Type": "application/json", "Accept": "application/json" },
    JSON.stringify({ Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: `d=${msaToken}` }, RelyingParty: "http://auth.xboxlive.com", TokenType: "JWT" })
  );
  if (r.status !== 200) throw new Error(`XASU failed ${r.status}: ${r.body}`);
  return JSON.parse(r.body);
}

async function fetchXstsToken(xasuToken: string): Promise<XToken> {
  const r = await httpsRequest(XSTS_ENDPOINT, "POST",
    { "Content-Type": "application/json", "Accept": "application/json" },
    JSON.stringify({ Properties: { SandboxId: "RETAIL", UserTokens: [xasuToken] }, RelyingParty: "http://xboxlive.com", TokenType: "JWT" })
  );
  if (r.status !== 200) {
    if (r.status === 401) {
      const xerr = JSON.parse(r.body)?.XErr;
      const msgs: Record<string, string> = { "2148916233": "No Xbox profile — create one at xbox.com", "2148916238": "Child account — needs family approval" };
      throw new Error(`XSTS failed: ${msgs[String(xerr)] ?? `XErr=${xerr}`}`);
    }
    throw new Error(`XSTS failed ${r.status}: ${r.body}`);
  }
  return JSON.parse(r.body);
}

async function getAuthHeader(): Promise<{ header: string; xuid: string; gamertag: string }> {
  let cache = loadCache();
  if (cache.xstsToken && cache.xstsExpiry && Date.now() < cache.xstsExpiry - 300_000) {
    return { header: `XBL3.0 x=${cache.userHash};${cache.xstsToken}`, xuid: cache.xuid ?? "", gamertag: cache.gamertag ?? "" };
  }
  if (!cache.msaRefreshToken) throw new Error("Not logged in.\nRun: npx ts-node tools/save-sync.ts --login");
  process.stdout.write("Refreshing Xbox token... ");
  const tok = await httpsRequest(`https://login.microsoftonline.com/${MSA_TENANT}/oauth2/v2.0/token`, "POST",
    { "Content-Type": "application/x-www-form-urlencoded" },
    new URLSearchParams({ client_id: MSA_CLIENT_ID, grant_type: "refresh_token", refresh_token: cache.msaRefreshToken, scope: MSA_SCOPES }).toString()
  );
  if (tok.status !== 200) throw new Error("Token refresh failed. Run --login again.");
  const t = JSON.parse(tok.body);
  cache.msaAccessToken = t.access_token;
  cache.msaRefreshToken = t.refresh_token ?? cache.msaRefreshToken;
  const xasu = await fetchXasuToken(t.access_token);
  const xsts = await fetchXstsToken(xasu.Token);
  const xui  = xsts.DisplayClaims?.xui?.[0];
  cache = { ...cache, xstsToken: xsts.Token, xstsExpiry: xsts.NotAfter ? new Date(xsts.NotAfter).getTime() : Date.now() + 3600_000, userHash: xui?.uhs, xuid: xui?.xid, gamertag: xui?.gtg };
  saveCache(cache);
  console.log("✔");
  return { header: `XBL3.0 x=${cache.userHash};${cache.xstsToken}`, xuid: cache.xuid ?? "", gamertag: cache.gamertag ?? "" };
}

// ── SaveBridge HTTP helpers ────────────────────────────────────────────────────

function bridgeGet(ip: string, urlPath: string): Promise<{ status: number; body: string; rawBody: Buffer }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: ip, port: BRIDGE_PORT, path: urlPath, method: "GET",
      timeout: 30_000,
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => { const rawBody = Buffer.concat(chunks); resolve({ status: res.statusCode ?? 0, body: rawBody.toString("utf8"), rawBody }); });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`Bridge request timed out: ${urlPath}`)); });
    req.end();
  });
}

async function bridgeStatus(ip: string): Promise<void> {
  const r = await bridgeGet(ip, "/status");
  if (r.status !== 200) throw new Error(`SaveBridge not reachable at ${ip}:${BRIDGE_PORT} (HTTP ${r.status})`);
  const s = JSON.parse(r.body);
  console.log(`  SaveBridge : ${ip}:${BRIDGE_PORT}`);
  console.log(`  Build      : ${s.build}`);
  console.log(`  Status     : ${s.status}`);
}

// ── Connected Storage list (NOTE: 403 on RETAIL — dev sandboxes only) ─────────

async function csListBlobs(auth: string, xuid: string, scid: string): Promise<Array<{fileName: string; size: number}>> {
  const url  = `${TS_ENDPOINT}/connectedstorage/users/xuid(${xuid})/scids/${scid}/`;
  const resp = await httpsRequest(url, "GET", { "Authorization": auth, "x-xbl-contract-version": "1", "Accept": "application/json" });
  if (resp.status === 403) throw new Error(
    "403 Access Denied — Xbox Live Connected Storage REST API is restricted to developer sandboxes.\n" +
    "It cannot access RETAIL saves. See README for extraction instructions."
  );
  if (resp.status === 404) return [];
  if (resp.status !== 200) throw new Error(`List failed ${resp.status}: ${resp.body.slice(0, 200)}`);
  return JSON.parse(resp.body)?.blobs ?? [];
}

// ── Save file inspector ────────────────────────────────────────────────────────

function inspectSave(filePath: string): void {
  if (!fs.existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1); }
  const buf  = fs.readFileSync(filePath);
  const size = buf.length;
  console.log(`\nFile: ${filePath} (${size.toLocaleString()} bytes)`);
  console.log(`\nFirst 64 bytes (hex):`);
  console.log(buf.slice(0, 64).toString("hex").replace(/(.{32})/g, "$1\n"));

  // Check for known magic bytes
  const magic = buf.readUInt32BE(0);
  const magicStr = buf.slice(0, 4).toString("ascii").replace(/[^\x20-\x7e]/g, ".");
  console.log(`\nMagic: 0x${magic.toString(16).toUpperCase().padStart(8, "0")}  "${magicStr}"`);

  if (magic === 0x44495345) console.log("✔ DISE format detected (Dead Island save)");
  else if (buf.slice(0, 3).toString("hex") === "434f4e") console.log("→ Possibly CON/LIVE Xbox 360 STFS container");
  else if (buf.slice(0, 4).toString("hex") === "58427332") console.log("→ Xbox Series X Connected Storage blob (XBs2)");
  else console.log("→ Unknown format — may need further analysis");

  console.log(`\nNext steps:`);
  console.log(`  npx ts-node src/cli.ts --input "${filePath}" --god-mode --max-level`);
}

// ── Steam save finder ──────────────────────────────────────────────────────────

function findSteamSaves(): string[] {
  const steamPaths = [
    path.join(os.homedir(), "Library/Application Support/Steam/userdata"), // macOS
    path.join(os.homedir(), ".steam/steam/userdata"),                       // Linux
  ];
  const found: string[] = [];
  for (const base of steamPaths) {
    if (!fs.existsSync(base)) continue;
    try {
      for (const user of fs.readdirSync(base)) {
        const saveDir = path.join(base, user, DEAD_ISLAND_TITLEID, "remote/out/save");
        if (fs.existsSync(saveDir)) {
          const files = fs.readdirSync(saveDir).filter(f => f.endsWith(".sav") || f.endsWith(".sar"));
          for (const f of files) found.push(path.join(saveDir, f));
        }
      }
    } catch { /* ignore */ }
  }
  return found;
}

// ── SaveBridge bridge-import (from PC Xbox app WGS folder) ───────────────────

async function cmdBridgeImport(): Promise<void> {
  const outDir = getArg("--out") ?? "./saves";
  const wgsBase = getArg("--wgs");

  if (!wgsBase) {
    console.log(`
Xbox Series X Save Import — via Windows PC Xbox App
════════════════════════════════════════════════════

The Xbox Series X stores saves in Connected Storage (WGS), which syncs to
the Xbox app on Windows. The save files live at:

  %LOCALAPPDATA%\\Packages\\Microsoft.GamingApp_8wekyb3d8bbwe\\SystemAppData\\wgs\\
  <XUID>\\<ContainerGuid>\\<BlobGuid>

Steps:
  1. On a Windows PC, install the Xbox app and sign in as Adopted Kz
  2. The app will sync your Dead Island DE saves automatically
  3. Open the folder above in Explorer and find the DI containers
     (look for a folder matching XUID 2535409375459619)
  4. Copy the entire wgs folder to your Mac, e.g.: ~/Desktop/di_wgs
  5. Run: npx ts-node tools/save-sync.ts --bridge-import --wgs ~/Desktop/di_wgs

Or if you have direct access to the WGS path:
  npx ts-node tools/save-sync.ts --bridge-import \\
    --wgs "/mnt/c/Users/<user>/AppData/Local/Packages/Microsoft.GamingApp_8wekyb3d8bbwe/SystemAppData/wgs"
    `);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`\nImporting WGS saves from: ${wgsBase}\n`);

  if (!fs.existsSync(wgsBase)) {
    console.error(`Path not found: ${wgsBase}`);
    process.exit(1);
  }

  let totalBlobs = 0;
  for (const xuid of fs.readdirSync(wgsBase)) {
    const xuidDir = path.join(wgsBase, xuid);
    if (!fs.statSync(xuidDir).isDirectory()) continue;

    // Look for containers.index
    const indexPath = path.join(xuidDir, "containers.index");
    if (!fs.existsSync(indexPath)) continue;

    console.log(`XUID: ${xuid}`);
    const outXuid = path.join(outDir, xuid);
    fs.mkdirSync(outXuid, { recursive: true });

    for (const containerGuid of fs.readdirSync(xuidDir)) {
      const containerDir = path.join(xuidDir, containerGuid);
      if (!fs.statSync(containerDir).isDirectory()) continue;

      const blobs = fs.readdirSync(containerDir).filter(f => !f.endsWith(".index"));
      if (blobs.length === 0) continue;

      console.log(`  Container: ${containerGuid} (${blobs.length} blob(s))`);
      const outContainer = path.join(outXuid, containerGuid);
      fs.mkdirSync(outContainer, { recursive: true });

      for (const blob of blobs) {
        const src = path.join(containerDir, blob);
        const dst = path.join(outContainer, blob + ".bin");
        fs.copyFileSync(src, dst);
        const stat = fs.statSync(src);
        console.log(`    ✔ ${blob}  (${stat.size.toLocaleString()} bytes) → ${dst}`);
        totalBlobs++;
      }
    }
  }

  if (totalBlobs === 0) {
    console.log("No blobs found. Check the --wgs path points to the WGS root folder.");
    return;
  }
  console.log(`\n✔ Imported ${totalBlobs} blob(s) to ${outDir}`);
  console.log(`\nTo inspect: npx ts-node tools/save-sync.ts --info --input <blob_file>`);
  console.log(`To edit:    npx ts-node src/cli.ts --input <blob_file> --god-mode`);
}

// ── SaveBridge commands ────────────────────────────────────────────────────────

async function cmdBridge(): Promise<void> {
  console.log(`\nSaveBridge Status (Xbox IP: ${XBOX_IP})\n${"─".repeat(45)}`);
  await bridgeStatus(XBOX_IP);

  console.log("\n/cs/list — querying GameSaveProvider...");
  const r = await bridgeGet(XBOX_IP, "/cs/list");
  if (r.status !== 200) {
    console.log(`  Error (HTTP ${r.status}): ${r.body.slice(0, 300)}`);
    return;
  }
  const data = JSON.parse(r.body);
  if (data.error) {
    console.log(`  GameSaveProvider error: ${data.error}`);
    console.log(`  SCID: ${data.scid}`);
    console.log("\n  ⚠  Xbox Live must be online for /cs/list to work.");
    console.log("  Try again when the Xbox is fully signed in to Xbox Live.");
    return;
  }
  const containers: Array<{name: string; displayName: string; totalSize: number}> = data.containers ?? [];
  if (containers.length === 0) {
    console.log("  No containers found (Dead Island may not have been played yet or saves not synced).");
    return;
  }
  console.log(`\nSCID: ${data.scid}`);
  console.log(`Containers (${containers.length}):\n`);
  for (const c of containers) {
    console.log(`  ${c.name}  "${c.displayName}"  (${(c.totalSize / 1024).toFixed(1)} KB)`);
  }
  console.log(`\nTo download all blobs:\n  npx ts-node tools/save-sync.ts --cs-download --xbox-ip ${XBOX_IP}`);
}

async function cmdCsList(): Promise<void> {
  await cmdBridge(); // same command for now
}

async function cmdCsDownload(): Promise<void> {
  const outDir = getArg("--out") ?? "./saves";
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\nDownloading DI saves via SaveBridge (${XBOX_IP}:${BRIDGE_PORT})\n${"─".repeat(45)}`);
  await bridgeStatus(XBOX_IP);

  console.log("\nFetching container list...");
  const listR = await bridgeGet(XBOX_IP, "/cs/list");
  if (listR.status !== 200) throw new Error(`/cs/list failed: ${listR.body.slice(0, 200)}`);
  const listData = JSON.parse(listR.body);
  if (listData.error) throw new Error(`GameSaveProvider: ${listData.error}\nXbox Live must be online.`);

  const containers: Array<{name: string; displayName: string}> = listData.containers ?? [];
  if (containers.length === 0) { console.log("No containers found."); return; }

  console.log(`Found ${containers.length} container(s). Downloading blobs...\n`);
  let totalFiles = 0;
  for (const c of containers) {
    // Each container has blobs — we need to enumerate them via /cs/list details
    // For now download the known blob names or probe with a blob list endpoint
    const encodedContainer = encodeURIComponent(c.name);

    // Try common Dead Island blob names
    const blobNames = ["header", "game", "save", "data", "profile", "0", "1", "2", "3"];
    const containerDir = path.join(outDir, c.name.replace(/[\\/:*?"<>|]/g, "_"));
    fs.mkdirSync(containerDir, { recursive: true });

    for (const blob of blobNames) {
      const dlR = await bridgeGet(XBOX_IP, `/cs/download?container=${encodedContainer}&blob=${encodeURIComponent(blob)}`);
      if (dlR.status === 200) {
        const outFile = path.join(containerDir, blob + ".bin");
        fs.writeFileSync(outFile, dlR.rawBody);
        console.log(`  ✔ ${c.name}/${blob}  (${dlR.rawBody.length.toLocaleString()} bytes) → ${outFile}`);
        totalFiles++;
      }
    }
  }
  if (totalFiles === 0) {
    console.log("No blobs downloaded — try --bridge to see container names first, then probe blob names.");
    return;
  }
  console.log(`\n✔ Downloaded ${totalFiles} blob(s) to ${outDir}`);
  console.log(`\nTo inspect: npx ts-node tools/save-sync.ts --info --input <blob_file>`);
  console.log(`To edit:    npx ts-node src/cli.ts --input <blob_file> --god-mode`);
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function cmdLogin(): Promise<void> {
  const tok = await msaDeviceCodeLogin();
  const xasu = await fetchXasuToken(tok.access_token);
  const xsts = await fetchXstsToken(xasu.Token);
  const xui = xsts.DisplayClaims?.xui?.[0];
  const expiry = xsts.NotAfter ? new Date(xsts.NotAfter).getTime() : Date.now() + 3600_000;
  saveCache({ msaAccessToken: tok.access_token, msaRefreshToken: tok.refresh_token, msaExpiry: Date.now() + tok.expires_in * 1000, xstsToken: xsts.Token, xstsExpiry: expiry, userHash: xui?.uhs, xuid: xui?.xid, gamertag: xui?.gtg });
  console.log("✔ Logged in!");
  console.log(`  Gamertag : ${xui?.gtg ?? "(none)"}`);
  console.log(`  XUID     : ${xui?.xid ?? "(none)"}`);
  console.log(`  Cached at: ${CACHE_FILE}`);
  console.log("\nNote: Xbox Live Connected Storage REST API is restricted to dev sandboxes.");
  console.log("Your credentials are cached for future use, but --list will return 403 for RETAIL saves.");
  console.log("See README for how to extract Xbox Series X saves via USB.");
}

async function cmdList(): Promise<void> {
  const { header, xuid, gamertag } = await getAuthHeader();
  console.log(`\nAccount: ${gamertag} (XUID: ${xuid})`);
  console.log(`SCID: ${DEAD_ISLAND_SCID}`);
  console.log("\nNote: This API only works for developer sandboxes, not RETAIL saves.\n");
  const blobs = await csListBlobs(header, xuid, DEAD_ISLAND_SCID);
  if (blobs.length === 0) { console.log("No blobs found."); return; }
  for (const b of blobs) console.log(`  ${b.fileName}  (${(b.size/1024).toFixed(1)} KB)`);
}

function cmdListSteam(): void {
  console.log("Searching for Dead Island Definitive Edition Steam saves...\n");
  const saves = findSteamSaves();
  if (saves.length === 0) {
    console.log("No Steam saves found.");
    console.log(`Expected location: ~/Library/Application Support/Steam/userdata/<user>/${DEAD_ISLAND_TITLEID}/remote/out/save/`);
    return;
  }
  console.log(`Found ${saves.length} save file(s):\n`);
  for (const s of saves) {
    const stat = fs.statSync(s);
    console.log(`  ${s}  (${(stat.size/1024).toFixed(1)} KB, modified ${stat.mtime.toLocaleDateString()})`);
  }
  console.log(`\nTo inspect: npx ts-node tools/save-sync.ts --info --input "${saves[0]}"`);
  console.log(`To edit:    npx ts-node src/cli.ts --input "${saves[0]}" --god-mode`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (hasFlag("--login"))         { await cmdLogin();        return; }
  if (hasFlag("--list"))          { await cmdList();         return; }
  if (hasFlag("--list-steam"))    { cmdListSteam();          return; }
  if (hasFlag("--bridge"))        { await cmdBridge();       return; }
  if (hasFlag("--cs-list"))       { await cmdCsList();       return; }
  if (hasFlag("--cs-download"))   { await cmdCsDownload();   return; }
  if (hasFlag("--bridge-import")) { await cmdBridgeImport(); return; }

  const inputFile = getArg("--input");
  if (hasFlag("--info") || hasFlag("--import")) {
    if (!inputFile) { console.error("--input <file> required"); process.exit(1); }
    inspectSave(inputFile);
    return;
  }

  console.log(`
Dead Island DE — Save Sync Tool
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HOW TO GET YOUR XBOX SERIES X SAVE FILE:

  ★ Option A — SaveBridge (recommended):
    Your Xbox is running SaveBridge on port ${BRIDGE_PORT}.
    When Xbox Live is online:
      npx ts-node tools/save-sync.ts --bridge       --xbox-ip ${XBOX_IP}
      npx ts-node tools/save-sync.ts --cs-download  --xbox-ip ${XBOX_IP} --out ./saves

  Option B — Windows PC + Xbox App:
    %LOCALAPPDATA%\\Packages\\Microsoft.GamingApp_8wekyb3d8bbwe\\SystemAppData\\wgs\\
    npx ts-node tools/save-sync.ts --info --input <blob_file>

  Option C — Steam (PC):
    npx ts-node tools/save-sync.ts --list-steam

COMMANDS:
  --bridge  [--xbox-ip <ip>]              SaveBridge status + container list
  --cs-list [--xbox-ip <ip>]              Same as --bridge
  --cs-download [--xbox-ip <ip>] [--out]  Download all save blobs to ./saves
  --login                                 Xbox Live login (token cache)
  --list                                  List containers via REST (dev sandboxes only)
  --list-steam                            Find Steam save files
  --info --input <f>                      Inspect save file format
  --import --input <f>                    Same as --info

SCID    : ${DEAD_ISLAND_SCID}
Xbox IP : ${XBOX_IP}:${BRIDGE_PORT}
  `.trim());
}

main().catch((err: Error) => {
  console.error("\n✗", err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
