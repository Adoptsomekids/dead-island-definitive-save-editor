#!/usr/bin/env ts-node
// tools/save-sync.ts
// ─────────────────────────────────────────────────────────────────────────────
// Download / upload Dead Island Definitive Edition Connected Storage saves
// directly from Xbox Live — no app on the Xbox needed.
//
// AUTHENTICATION FLOW (from microsoft/xbox-live-developer-tools):
//   1. MSA device-code login  → access_token  (scope: Xboxlive.signin)
//   2. XASU exchange          → XToken (user token)  @ user.auth.xboxlive.com
//   3. XSTS exchange          → XSTS token           @ xsts.auth.xboxlive.com
//   4. REST calls with header: Authorization: XBL3.0 x={userHash};{xstsToken}
//
// CONNECTED STORAGE REST ENDPOINTS:
//   GET  https://titlestorage.xboxlive.com/connectedstorage/users/xuid({xuid})/scids/{scid}
//   GET  https://titlestorage.xboxlive.com/connectedstorage/users/xuid({xuid})/scids/{scid}/{container},{blob},binary
//
// USAGE:
//   # First time: login (opens browser for MSA device-code flow)
//   npx ts-node tools/save-sync.ts --login
//
//   # List all save containers
//   npx ts-node tools/save-sync.ts --list
//
//   # Download all blobs to ./saves/
//   npx ts-node tools/save-sync.ts --download
//
//   # Download specific container/blob
//   npx ts-node tools/save-sync.ts --download --container save0 --blob data
//
//   # Upload a blob back
//   npx ts-node tools/save-sync.ts --upload --container save0 --blob data --input ./save0_data.bin
//
// ENV VARS (override):
//   XBOX_SCID        — default: db860100-d780-4e17-8685-ad130052ea64 (Dead Island DE)
//   XBOX_XUID        — your XUID (auto-detected after login)
//   SAVES_DIR        — output directory (default: ./saves)
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from "fs";
import * as path from "path";
import * as os   from "os";
import * as https from "https";
import * as http  from "http";

// ── Constants ─────────────────────────────────────────────────────────────────

const DEAD_ISLAND_SCID = process.env.XBOX_SCID ?? "db860100-d780-4e17-8685-ad130052ea64";
const SAVES_DIR        = process.env.SAVES_DIR ?? "./saves";

// Microsoft's official public client-id for Xbox Live signin
// (same as MsalTestAuthContext.cs in xbox-live-developer-tools)
const MSA_CLIENT_ID    = "b1eab458-325b-45a5-9692-ad6079c1eca8";
const MSA_TENANT       = "consumers";
const MSA_SCOPES       = "Xboxlive.signin Xboxlive.offline_access offline_access";

const XASU_ENDPOINT    = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_ENDPOINT    = "https://xsts.auth.xboxlive.com/xsts/authorize";
const TS_ENDPOINT      = "https://titlestorage.xboxlive.com";

// Token cache file
const CACHE_FILE = path.join(os.homedir(), ".xbox-savebridge-tokens.json");

// ── Argument parsing ───────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const getArg  = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : undefined; };
const hasFlag = (f: string) => args.includes(f);

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function httpsRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string | Buffer
): Promise<{ status: number; body: string; rawBody: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts: https.RequestOptions = {
      hostname: u.hostname,
      port: u.port ? parseInt(u.port) : 443,
      path: u.pathname + u.search,
      method,
      headers: {
        ...headers,
        ...(body ? { "Content-Length": Buffer.byteLength(body).toString() } : {}),
      },
      rejectUnauthorized: true,
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
  msaRefreshToken?: string;
  msaAccessToken?: string;
  msaExpiry?: number;       // epoch ms
  xstsToken?: string;
  xstsExpiry?: number;      // epoch ms
  userHash?: string;
  xuid?: string;
  gamertag?: string;
}

function loadCache(): TokenCache {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as TokenCache;
    }
  } catch { /* ignore */ }
  return {};
}

function saveCache(c: TokenCache): void {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}

// ── MSA Device-Code flow ───────────────────────────────────────────────────────

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
}

interface TokenResponse {
  access_token:  string;
  refresh_token?: string;
  expires_in:    number;
  token_type:    string;
}

async function msaDeviceCodeLogin(): Promise<TokenResponse> {
  // Step 1: request device code
  const dcBody = new URLSearchParams({
    client_id: MSA_CLIENT_ID,
    scope:     MSA_SCOPES,
  }).toString();

  const dcResp = await httpsRequest(
    `https://login.microsoftonline.com/${MSA_TENANT}/oauth2/v2.0/devicecode`,
    "POST",
    { "Content-Type": "application/x-www-form-urlencoded" },
    dcBody
  );
  if (dcResp.status !== 200) throw new Error(`Device code request failed ${dcResp.status}: ${dcResp.body}`);
  const dc: DeviceCodeResponse = JSON.parse(dcResp.body);

  console.log("\n─────────────────────────────────────────────────");
  console.log("  Xbox Live Login Required");
  console.log("─────────────────────────────────────────────────");
  console.log(`  1. Open: ${dc.verification_uri}`);
  console.log(`  2. Enter code: ${dc.user_code}`);
  console.log(`  3. Sign in with your Microsoft/Xbox account`);
  console.log("─────────────────────────────────────────────────\n");

  // Step 2: poll until user completes auth
  const deadline = Date.now() + dc.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, (dc.interval + 1) * 1000));

    const pollBody = new URLSearchParams({
      client_id:   MSA_CLIENT_ID,
      grant_type:  "urn:ietf:params:oauth:grant-type:device_code",
      device_code: dc.device_code,
    }).toString();

    const pollResp = await httpsRequest(
      `https://login.microsoftonline.com/${MSA_TENANT}/oauth2/v2.0/token`,
      "POST",
      { "Content-Type": "application/x-www-form-urlencoded" },
      pollBody
    );

    if (pollResp.status === 200) {
      const tok: TokenResponse = JSON.parse(pollResp.body);
      console.log("✔ Microsoft login successful!\n");
      return tok;
    }

    const err = JSON.parse(pollResp.body);
    if (err.error === "authorization_pending") {
      process.stdout.write(".");
      continue;
    }
    if (err.error === "authorization_declined") throw new Error("Login declined by user.");
    if (err.error === "expired_token") throw new Error("Login timed out. Run --login again.");
    throw new Error(`Poll error: ${pollResp.body}`);
  }
  throw new Error("Device code expired. Run --login again.");
}

async function msaRefreshToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id:     MSA_CLIENT_ID,
    grant_type:    "refresh_token",
    refresh_token: refreshToken,
    scope:         MSA_SCOPES,
  }).toString();

  const resp = await httpsRequest(
    `https://login.microsoftonline.com/${MSA_TENANT}/oauth2/v2.0/token`,
    "POST",
    { "Content-Type": "application/x-www-form-urlencoded" },
    body
  );
  if (resp.status !== 200) throw new Error(`Token refresh failed ${resp.status}: ${resp.body}`);
  return JSON.parse(resp.body) as TokenResponse;
}

// ── Xbox Live XASU / XSTS token exchange ──────────────────────────────────────

interface XasTokenResponse {
  Token: string;
  DisplayClaims?: { xui?: Array<{ uhs?: string; xid?: string; gtg?: string }> };
  NotAfter?: string;
}

async function fetchXasuToken(msaAccessToken: string): Promise<XasTokenResponse> {
  const body = JSON.stringify({
    Properties: {
      AuthMethod: "RPS",
      SiteName:   "user.auth.xboxlive.com",
      RpsTicket:  `d=${msaAccessToken}`,
    },
    RelyingParty: "http://auth.xboxlive.com",
    TokenType:    "JWT",
  });

  const resp = await httpsRequest(
    XASU_ENDPOINT, "POST",
    { "Content-Type": "application/json", "Accept": "application/json" },
    body
  );
  if (resp.status !== 200) throw new Error(`XASU token failed ${resp.status}: ${resp.body}`);
  return JSON.parse(resp.body) as XasTokenResponse;
}

async function fetchXstsToken(xasuToken: string): Promise<XasTokenResponse> {
  const body = JSON.stringify({
    Properties: {
      SandboxId:  "RETAIL",
      UserTokens: [xasuToken],
    },
    RelyingParty: "http://xboxlive.com",
    TokenType:    "JWT",
  });

  const resp = await httpsRequest(
    XSTS_ENDPOINT, "POST",
    { "Content-Type": "application/json", "Accept": "application/json" },
    body
  );
  if (resp.status !== 200) {
    // 401 with specific XErr codes means the account needs something
    if (resp.status === 401) {
      try {
        const err = JSON.parse(resp.body);
        const xerr = err.XErr ?? err.xerr;
        const msgs: Record<string, string> = {
          "2148916233": "This Microsoft account has no Xbox profile. Go to xbox.com to create one.",
          "2148916238": "This account is a child account and requires family settings approval.",
          "2148916235": "Xbox Live is not available in your region.",
        };
        throw new Error(`XSTS auth failed: ${msgs[String(xerr)] ?? `XErr=${xerr}`}`);
      } catch (e: any) { if (e.message.includes("XSTS")) throw e; }
    }
    throw new Error(`XSTS token failed ${resp.status}: ${resp.body}`);
  }
  return JSON.parse(resp.body) as XasTokenResponse;
}

// ── Get valid XSTS auth header (with refresh if needed) ───────────────────────

async function getAuthHeader(): Promise<{ header: string; xuid: string; gamertag: string }> {
  let cache = loadCache();

  // Try cached XSTS if not expired (with 5-min buffer)
  if (cache.xstsToken && cache.xstsExpiry && Date.now() < cache.xstsExpiry - 300_000) {
    return {
      header:   `XBL3.0 x=${cache.userHash};${cache.xstsToken}`,
      xuid:     cache.xuid ?? "",
      gamertag: cache.gamertag ?? "",
    };
  }

  // Try refreshing MSA token
  let msaAccessToken: string;
  if (cache.msaRefreshToken) {
    process.stdout.write("Refreshing Xbox Live token... ");
    try {
      const tok = await msaRefreshToken(cache.msaRefreshToken);
      msaAccessToken = tok.access_token;
      cache.msaRefreshToken = tok.refresh_token ?? cache.msaRefreshToken;
      cache.msaAccessToken  = tok.access_token;
      cache.msaExpiry       = Date.now() + tok.expires_in * 1000;
      console.log("✔");
    } catch {
      console.log("refresh failed, need re-login");
      cache = {};
    }
  }

  if (!msaAccessToken!) {
    throw new Error(
      "Not logged in to Xbox Live.\n" +
      "Run first:  npx ts-node tools/save-sync.ts --login"
    );
  }

  // XASU exchange
  process.stdout.write("Exchanging XASU token... ");
  const xasu = await fetchXasuToken(msaAccessToken!);
  console.log("✔");

  // XSTS exchange
  process.stdout.write("Exchanging XSTS token... ");
  const xsts = await fetchXstsToken(xasu.Token);
  console.log("✔");

  const xui      = xsts.DisplayClaims?.xui?.[0];
  const userHash = xui?.uhs ?? "";
  const xuid     = xui?.xid ?? process.env.XBOX_XUID ?? "";
  const gamertag = xui?.gtg ?? "";

  // Cache it
  const expiry = xsts.NotAfter ? new Date(xsts.NotAfter).getTime() : Date.now() + 3600_000;
  cache.xstsToken  = xsts.Token;
  cache.xstsExpiry = expiry;
  cache.userHash   = userHash;
  cache.xuid       = xuid;
  cache.gamertag   = gamertag;
  saveCache(cache);

  return { header: `XBL3.0 x=${userHash};${xsts.Token}`, xuid, gamertag };
}

// ── Connected Storage REST client ─────────────────────────────────────────────

interface BlobInfo {
  fileName:    string;  // "containerName/blobName,binary"
  displayName?: string;
  size:         number;
  etag?:        string;
}

interface ListResponse {
  blobs?:      BlobInfo[];
  pagingInfo?: { continuationToken?: string; totalItems?: number };
}

async function csListBlobs(
  auth: string, xuid: string, scid: string, path_ = ""
): Promise<BlobInfo[]> {
  const all: BlobInfo[] = [];
  let continuation = "";

  do {
    const qs = continuation ? `?continuationToken=${encodeURIComponent(continuation)}` : "";
    const url = `${TS_ENDPOINT}/connectedstorage/users/xuid(${xuid})/scids/${scid}/${path_}${qs}`;
    const resp = await httpsRequest(url, "GET", {
      "Authorization":       auth,
      "x-xbl-contract-version": "1",
      "Accept":              "application/json",
    });

    if (resp.status === 404) break; // no saves yet
    if (resp.status !== 200) throw new Error(`List blobs failed ${resp.status}: ${resp.body.slice(0, 300)}`);

    const data: ListResponse = JSON.parse(resp.body);
    if (data.blobs) all.push(...data.blobs);
    continuation = data.pagingInfo?.continuationToken ?? "";
  } while (continuation);

  return all;
}

async function csDownloadBlob(
  auth: string, xuid: string, scid: string, blobPath: string
): Promise<Buffer> {
  // blobPath should be like "containerName/blobName,binary"
  const url = `${TS_ENDPOINT}/connectedstorage/users/xuid(${xuid})/scids/${scid}/${blobPath}`;
  const resp = await httpsRequest(url, "GET", {
    "Authorization":          auth,
    "x-xbl-contract-version": "1",
    "Accept-Encoding":        "gzip",
  });

  if (resp.status !== 200) throw new Error(`Download failed ${resp.status}: ${resp.body.slice(0, 300)}`);
  return resp.rawBody;
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function cmdLogin(): Promise<void> {
  const tok = await msaDeviceCodeLogin();

  process.stdout.write("Getting Xbox user token (XASU)... ");
  const xasu = await fetchXasuToken(tok.access_token);
  console.log("✔");

  process.stdout.write("Getting Xbox XSTS token... ");
  const xsts = await fetchXstsToken(xasu.Token);
  console.log("✔");

  const xui      = xsts.DisplayClaims?.xui?.[0];
  const userHash = xui?.uhs ?? "";
  const xuid     = xui?.xid ?? "";
  const gamertag = xui?.gtg ?? "";
  const expiry   = xsts.NotAfter ? new Date(xsts.NotAfter).getTime() : Date.now() + 3600_000;

  const cache: TokenCache = {
    msaAccessToken:  tok.access_token,
    msaRefreshToken: tok.refresh_token,
    msaExpiry:       Date.now() + tok.expires_in * 1000,
    xstsToken:  xsts.Token,
    xstsExpiry: expiry,
    userHash,
    xuid,
    gamertag,
  };
  saveCache(cache);

  console.log("\n✔ Logged in successfully!");
  console.log(`  Gamertag : ${gamertag || "(not available)"}`);
  console.log(`  XUID     : ${xuid}`);
  console.log(`  Token expires: ${new Date(expiry).toLocaleString()}`);
  console.log(`  Credentials cached at: ${CACHE_FILE}\n`);
}

async function cmdList(): Promise<void> {
  const { header, xuid, gamertag } = await getAuthHeader();
  console.log(`\nXbox account: ${gamertag} (XUID: ${xuid})`);
  console.log(`SCID: ${DEAD_ISLAND_SCID}`);
  console.log("Listing Connected Storage blobs...\n");

  const blobs = await csListBlobs(header, xuid, DEAD_ISLAND_SCID);

  if (blobs.length === 0) {
    console.log("No save blobs found. Make sure Dead Island DE has been run at least once.");
    return;
  }

  console.log(`Found ${blobs.length} blob(s):\n`);
  for (const b of blobs) {
    const kb = (b.size / 1024).toFixed(1);
    console.log(`  ${b.fileName}  (${kb} KB)`);
  }
  console.log(`\nRun --download to save all blobs to ${SAVES_DIR}/`);
}

async function cmdDownload(): Promise<void> {
  const { header, xuid, gamertag } = await getAuthHeader();
  const filterContainer = getArg("--container");
  const filterBlob      = getArg("--blob");
  const output          = getArg("--output");

  console.log(`\nXbox account: ${gamertag} (XUID: ${xuid})`);
  console.log(`SCID: ${DEAD_ISLAND_SCID}\n`);

  const blobs = await csListBlobs(header, xuid, DEAD_ISLAND_SCID);
  if (blobs.length === 0) {
    console.log("No save blobs found. Play Dead Island DE at least once to create a save.");
    return;
  }

  // Filter if container/blob specified
  const targets = blobs.filter(b => {
    if (!filterContainer && !filterBlob) return true;
    const [name] = b.fileName.split(",");
    const parts  = name.split("/");
    if (filterContainer && !parts[0]?.includes(filterContainer)) return false;
    if (filterBlob      && !parts[1]?.includes(filterBlob))      return false;
    return true;
  });

  if (targets.length === 0) {
    console.log(`No blobs match the filter. Available:\n${blobs.map(b => `  ${b.fileName}`).join("\n")}`);
    return;
  }

  fs.mkdirSync(SAVES_DIR, { recursive: true });
  let downloaded = 0;

  for (const blob of targets) {
    // fileName format: "containerName/blobName,binary" or "containerName/blobName,json"
    const blobPath = blob.fileName.includes(",") ? blob.fileName : `${blob.fileName},binary`;
    const [namePart] = blobPath.split(",");
    const safeName   = namePart.replace(/[/\\]/g, "_");
    const outFile    = output ?? path.join(SAVES_DIR, `${safeName}.bin`);

    process.stdout.write(`  Downloading ${blobPath} ... `);
    try {
      const data = await csDownloadBlob(header, xuid, DEAD_ISLAND_SCID, blobPath);
      fs.writeFileSync(outFile, data);
      console.log(`✔  ${data.length.toLocaleString()} bytes → ${outFile}`);
      downloaded++;
    } catch (e: any) {
      console.log(`✗  ${e.message}`);
    }
  }

  console.log(`\n✔ Downloaded ${downloaded}/${targets.length} blob(s) to ${path.resolve(SAVES_DIR)}/`);
  console.log("Next: open the .bin files with the save editor to edit them.");
}

async function cmdUpload(): Promise<void> {
  const inputPath = getArg("--input");
  const container = getArg("--container");
  const blob      = getArg("--blob");

  if (!inputPath || !container || !blob) {
    console.error("Usage: --upload --input <file.bin> --container <name> --blob <name>");
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const { header, xuid, gamertag } = await getAuthHeader();
  console.log(`\nXbox account: ${gamertag} (XUID: ${xuid})`);

  const data    = fs.readFileSync(inputPath);
  const blobUrl = `${TS_ENDPOINT}/connectedstorage/users/xuid(${xuid})/scids/${DEAD_ISLAND_SCID}/${container}/${blob},binary`;

  process.stdout.write(`Uploading ${inputPath} (${data.length.toLocaleString()} bytes) → ${container}/${blob} ... `);
  const resp = await httpsRequest(blobUrl, "PUT", {
    "Authorization":          header,
    "x-xbl-contract-version": "1",
    "Content-Type":           "application/octet-stream",
  }, data);

  if (resp.status === 200 || resp.status === 204) {
    console.log("✔ Upload successful!");
    console.log("\nIMPORTANT: On your Xbox, quit Dead Island DE completely before");
    console.log("launching again so it picks up the new save from Xbox Live cloud.");
  } else {
    throw new Error(`Upload failed ${resp.status}: ${resp.body.slice(0, 300)}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (hasFlag("--login")) {
    await cmdLogin();
    return;
  }

  if (hasFlag("--list")) {
    await cmdList();
    return;
  }

  if (hasFlag("--download")) {
    await cmdDownload();
    return;
  }

  if (hasFlag("--upload")) {
    await cmdUpload();
    return;
  }

  // Default: show help
  console.log(`
Xbox Live Connected Storage Sync — Dead Island Definitive Edition
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FIRST TIME SETUP (one-time):
  npx ts-node tools/save-sync.ts --login

COMMANDS:
  --login                  Sign in with your Microsoft/Xbox account (device-code flow)
  --list                   List all Dead Island DE save blobs in Connected Storage
  --download               Download all save blobs to ${SAVES_DIR}/
  --download               --container <name> --blob <name>   (specific blob)
  --download               --output <file.bin>                (single blob to file)
  --upload                 --container <name> --blob <name> --input <file.bin>

ENV VARS:
  XBOX_SCID=${DEAD_ISLAND_SCID}  (Dead Island DE)
  SAVES_DIR=${SAVES_DIR}

CREDENTIALS are cached at: ${CACHE_FILE}
  `.trim());
}

main().catch((err: Error) => {
  console.error("\n✗ Error:", err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
