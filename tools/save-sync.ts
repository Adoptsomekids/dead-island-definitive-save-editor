#!/usr/bin/env ts-node
// tools/save-sync.ts
// ─────────────────────────────────────────────────────────────────────────────
// Dead Island Definitive Edition — Save File Sync Tool
//
// HOW TO GET YOUR XBOX SERIES X SAVE FILE
// ────────────────────────────────────────
// Option A — cs-pull (recommended, no Xbox needed):
//   Uses device+title+XSTS token chain to pull from Xbox Live Connected Storage
//   (titlestorage.xboxlive.com) directly to your Mac — no SaveBridge required.
//     npx ts-node tools/save-sync.ts --login                 # one-time auth
//     npx ts-node tools/save-sync.ts --cs-pull               # list containers
//     npx ts-node tools/save-sync.ts --cs-pull --out ./saves # download blobs
//
// Option B — SaveBridge (Xbox in Dev Mode):
//   Sideloaded JS UWP app running on your Xbox that exposes HTTP on port 8765.
//   Deploy it from https://github.com/Adoptsomekids/xbox-savebridge then:
//     npx ts-node tools/save-sync.ts --bridge --xbox-ip 192.168.x.x
//     npx ts-node tools/save-sync.ts --cs-download --xbox-ip 192.168.x.x [--out ./saves]
//
// Option C — Windows PC + Xbox App:
//   The Xbox app syncs saves to:
//   %LOCALAPPDATA%\Packages\Microsoft.GamingApp_8wekyb3d8bbwe\SystemAppData\wgs\
//   Copy the container blobs to your Mac, then:
//     npx ts-node tools/save-sync.ts --bridge-import --wgs <path>
//
// Option D — Steam (PC):
//   npx ts-node tools/save-sync.ts --list-steam
//
// USAGE:
//   npx ts-node tools/save-sync.ts --login                             # Xbox Live login (token cache)
//   npx ts-node tools/save-sync.ts --cs-pull [--out ./saves] [--scid SCID]  # ★ pull saves from Xbox Live
//   npx ts-node tools/save-sync.ts --cs-push --input <file> [--blob-name <name>]  # push save to Xbox Live
//   npx ts-node tools/save-sync.ts --bridge           --xbox-ip <ip>  # SaveBridge status + containers
//   npx ts-node tools/save-sync.ts --cs-list          --xbox-ip <ip>  # same as --bridge
//   npx ts-node tools/save-sync.ts --cs-download      --xbox-ip <ip> [--out ./saves]
//   npx ts-node tools/save-sync.ts --bridge-import --wgs <path>       # import from PC Xbox app WGS folder
//   npx ts-node tools/save-sync.ts --import  --input <file>           # import/inspect a save
//   npx ts-node tools/save-sync.ts --info    --input <file>           # show save info
//   npx ts-node tools/save-sync.ts --list-steam                       # find Steam saves automatically
//   npx ts-node tools/save-sync.ts --list                             # list via REST (dev sandboxes only)
// ─────────────────────────────────────────────────────────────────────────────

import * as fs     from "fs";
import * as path   from "path";
import * as os     from "os";
import * as https  from "https";
import * as http   from "http";
import * as crypto from "crypto";
import * as child_process from "child_process";

// ── Constants ──────────────────────────────────────────────────────────────────

const DEAD_ISLAND_SCID    = process.env.XBOX_SCID  ?? "db860100-d780-4e17-8685-ad130052ea64";
const DEAD_ISLAND_TITLEID = "433850"; // Steam App ID (also used in Xbox paths)
const DEAD_ISLAND_PFN     = "DeepSilver.DeadIslandDefinitiveEdition_hmv7qcest37me";
const SAVES_DIR           = process.env.SAVES_DIR  ?? "./saves";

// MSA client id from microsoft/xbox-live-developer-tools (MsalTestAuthContext.cs)
const MSA_CLIENT_ID  = "b1eab458-325b-45a5-9692-ad6079c1eca8";
const MSA_TENANT     = "consumers";
const MSA_SCOPES     = "Xboxlive.signin Xboxlive.offline_access offline_access";

// Legacy Xbox Live client — used for device token auth
// login.live.com + service::user.auth.xboxlive.com::MBI_SSL scope
const LIVE_CLIENT_ID    = "000000004c12ae6f";
const LIVE_SCOPE        = "service::user.auth.xboxlive.com::MBI_SSL";
const LIVE_TOKEN_URL    = "https://login.live.com/oauth20_token.srf";
const LIVE_AUTH_URL     = "https://login.live.com/oauth20_authorize.srf";
const LIVE_REDIRECT_URI = "https://login.live.com/oauth20_desktop.srf";

const XASU_ENDPOINT   = "https://user.auth.xboxlive.com/user/authenticate";
const DEVICE_ENDPOINT = "https://device.auth.xboxlive.com/device/authenticate";
const TITLE_ENDPOINT  = "https://title.auth.xboxlive.com/title/authenticate";
const XSTS_ENDPOINT   = "https://xsts.auth.xboxlive.com/xsts/authorize";
const TS_ENDPOINT     = "https://titlestorage.xboxlive.com";
const CACHE_FILE      = path.join(os.homedir(), ".xbox-savebridge-tokens.json");

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
  // legacy login.live.com token (for device+title token auth)
  liveAccessToken?: string; liveRefreshToken?: string; liveExpiry?: number;
  // full-auth chain tokens (device+title+XSTS)
  userToken?: string;
  deviceToken?: string; deviceTokenExpiry?: number;
  titleToken?: string; titleTokenExpiry?: number;
  fullXstsToken?: string; fullXstsExpiry?: number;
  fullUserHash?: string;
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

// ── Legacy MSA (login.live.com) — needed for device token ─────────────────────

/** Open a browser and start a local helper page to capture the legacy MSA token
 *  (login.live.com, client 000000004c12ae6f, scope service::MBI_SSL).
 *  Uses implicit token flow with the registered desktop redirect URI.
 *  The local page extracts the access_token from the URL fragment. */
async function legacyLiveLogin(): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const localPort = 7777;
  const localRedirect = `http://localhost:${localPort}/live_callback`;
  const desktopUri = "https://login.live.com/oauth20_desktop.srf";

  // We use implicit flow (response_type=token) with the registered desktop redirect.
  // After login, login.live.com redirects to oauth20_desktop.srf#access_token=...
  // We host a local page that the user visits to extract the token from the URL they were redirected to.
  const authUrl = LIVE_AUTH_URL + "?" + new URLSearchParams({
    client_id:     LIVE_CLIENT_ID,
    response_type: "token",
    redirect_uri:  desktopUri,   // ← registered redirect URI
    scope:         LIVE_SCOPE,
    display:       "touch",
    locale:        "en",
  }).toString();

  const helpPage = `<!DOCTYPE html>
<html><head><title>Xbox Live Auth Helper</title>
<style>body{font-family:monospace;padding:20px;background:#1a1a1a;color:#81c784;}</style>
</head><body>
<h2>Xbox Live Auth Helper</h2>
<p>After signing in to Microsoft, you will be redirected to a page like:<br>
<code>https://login.live.com/oauth20_desktop.srf#access_token=...</code></p>
<p><strong>Copy the FULL URL from your browser's address bar after login, then paste it below:</strong></p>
<textarea id="url" style="width:100%;height:80px;background:#222;color:#aaa;font-size:12px;" placeholder="Paste the full redirect URL here (https://login.live.com/oauth20_desktop.srf#access_token=...)"></textarea>
<br><br>
<button onclick="submit()" style="padding:8px 16px;background:#3b82d4;color:white;border:none;cursor:pointer">Extract Token</button>
<pre id="result" style="margin-top:20px;"></pre>
<script>
function submit() {
  var url = document.getElementById('url').value.trim();
  if (!url.includes('access_token=')) { document.getElementById('result').textContent = 'No access_token found in URL!'; return; }
  // Parse fragment
  var frag = url.split('#')[1] || '';
  var params = {};
  frag.split('&').forEach(function(p) { var kv = p.split('='); params[kv[0]] = decodeURIComponent(kv[1] || ''); });
  if (!params.access_token) { document.getElementById('result').textContent = 'Could not parse access_token!'; return; }
  // Send to local server
  fetch('/token', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({access_token: params.access_token, expires_in: parseInt(params.expires_in||'3600'), token_type: params.token_type})
  }).then(function(r){ return r.text(); }).then(function(t) {
    document.getElementById('result').textContent = t;
  }).catch(function(e){ document.getElementById('result').textContent = 'Error: '+e; });
}
</script>
</body></html>`;

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("  Legacy Xbox Live Login (for device token / full save download)");
  console.log("─────────────────────────────────────────────────────────────");
  console.log("  Step 1: Sign in at this URL (opens in browser):");
  console.log(`\n  ${authUrl}\n`);
  console.log("  Step 2: After signing in, copy the FULL redirect URL");
  console.log("          (it will look like: https://login.live.com/oauth20_desktop.srf#access_token=...)");
  console.log(`  Step 3: Paste it into the helper page at: http://localhost:${localPort}/`);
  console.log("─────────────────────────────────────────────────────────────\n");

  // Try to open the browser (sign-in URL first)
  try {
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    child_process.spawn(openCmd, [authUrl], { detached: true, stdio: "ignore" });
  } catch { /* ignore */ }
  // Small delay then open helper page
  setTimeout(() => {
    try {
      const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      child_process.spawn(openCmd, [`http://localhost:${localPort}/`], { detached: true, stdio: "ignore" });
    } catch {}
  }, 2000);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlObj = new URL(req.url ?? "/", `http://localhost:${localPort}`);

      if (urlObj.pathname === "/" || urlObj.pathname === "") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(helpPage);
        return;
      }

      if (urlObj.pathname === "/token" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!body.access_token) {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("No access_token");
              return;
            }
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("✔ Token received! You can close this window.\n\nCheck your terminal — download will start shortly.");
            server.close();
            console.log("✔ Legacy login successful!\n");
            resolve({ access_token: body.access_token, expires_in: body.expires_in ?? 3600 });
          } catch (e) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Parse error");
            reject(e);
          }
        });
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(localPort, "localhost", () => {
      console.log(`Helper page ready at: http://localhost:${localPort}/`);
      console.log("Waiting for token...");
    });
    server.on("error", reject);
    setTimeout(() => {
      server.close();
      reject(new Error("Legacy login timed out. Run --login-legacy again."));
    }, 300_000); // 5 min timeout
  });
}

/** Refresh the legacy live token. */
async function refreshLegacyToken(refreshToken: string): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const r = await httpsRequest(LIVE_TOKEN_URL, "POST",
    { "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (XboxReplay; XboxLiveAuth/3.0) AppleWebKit/537.36" },
    new URLSearchParams({
      client_id:     LIVE_CLIENT_ID,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
      scope:         LIVE_SCOPE,
      redirect_uri:  LIVE_REDIRECT_URI,
    }).toString()
  );
  if (r.status !== 200) throw new Error(`Legacy token refresh failed ${r.status}: ${r.body.slice(0, 200)}`);
  return JSON.parse(r.body);
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

// ── Full auth chain: Device + Title + XSTS (xbcsmgr method) ──────────────────
// This is required to access ERA game connected storage (XGameSave) at:
//   titlestorage.xboxlive.com/connectedstorage/users/xuid(...)/scids/...
// The plain user XSTS token returns 403 NoAccess. Only the full triple-token
// bundle (device + title + user in one XSTS) has the required entitlement.

/** Generate an ECDSA P-256 Xbox Live Signature header value.
 *  Layout (big-endian):
 *   [4] policy version = 1
 *   [1] null separator
 *   [8] Windows timestamp (100-ns ticks since 1601-01-01)
 *   [1] null separator
 *   "POST\0{path+query}\0{authToken}\0{body}\0"
 *  Signed with SHA-256 ECDSA (P-256), output:
 *   [4] policy version (BE)
 *   [8] Windows timestamp (BE)
 *   [r 32 bytes][s 32 bytes]  (raw IEEE P1363 format, not DER)
 */
function xblSignature(
  privateKey: crypto.KeyObject,
  method: string,
  url: string,
  authToken: string,
  body: string
): string {
  // Windows FILETIME: 100-ns ticks since 1601-01-01
  // Match xbcsmgr exactly: (unixSeconds + 11644473600) * 10000000
  const unixSeconds = BigInt(Math.floor(Date.now() / 1000));
  const nowTicks    = (unixSeconds + 11644473600n) * 10000000n;

  const policyVer = Buffer.alloc(4);
  policyVer.writeUInt32BE(1, 0);
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigUInt64BE(nowTicks, 0);

  const urlObj     = new URL(url);
  const pathQuery  = urlObj.pathname + urlObj.search;

  const strPart = `${method.toUpperCase()}\0${pathQuery}\0${authToken}\0${body}\0`;
  const strBuf  = Buffer.from(strPart, "ascii");

  // Payload: [4] policyVer [1] 0x00 [8] ts [1] 0x00 [strPart bytes]
  const payload = Buffer.concat([
    policyVer, Buffer.alloc(1),
    tsBuf,     Buffer.alloc(1),
    strBuf
  ]);

  // Sign with raw ECDSA — Node returns DER-encoded ASN.1 r,s — we need IEEE P1363 (raw r||s)
  const derSig  = crypto.sign("sha256", payload, { key: privateKey, dsaEncoding: "ieee-p1363" });

  // Output: [4] policyVer [8] ts [64] r||s
  const out = Buffer.concat([policyVer, tsBuf, derSig]);
  return out.toString("base64");
}

/** Make a signed POST to an Xbox Live auth endpoint.
 *  The "Signature" header is required by device/title endpoints. */
async function signedXblPost(
  url: string,
  body: object,
  authToken: string,
  privateKey: crypto.KeyObject,
  extraHeaders: Record<string, string> = {}
): Promise<XToken> {
  const bodyStr = JSON.stringify(body);
  const sig     = xblSignature(privateKey, "POST", url, authToken, bodyStr);
  const r = await httpsRequest(url, "POST", {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "x-xbl-contract-version": "2",
    "Signature": sig,
    ...extraHeaders,
  }, bodyStr);
  if (r.status !== 200) throw new Error(`${url} → ${r.status}: ${r.body.slice(0, 300)}`);
  return JSON.parse(r.body);
}

/** Obtain a Device token. Requires an MSA access token + a fresh ECDSA key pair.
 *  The proof-key public coordinates are embedded in the request so the server
 *  can verify the Signature on future calls. */
async function fetchDeviceToken(
  msaToken: string,
  privateKey: crypto.KeyObject,
  publicKey: crypto.KeyObject
): Promise<XToken> {
  // Export the raw x,y coordinates from the public key
  const raw    = publicKey.export({ type: "spki", format: "der" });
  // SPKI for P-256 is 91 bytes: 26-byte header + 1 uncompressed flag + 32 x + 32 y
  const x = raw.slice(27, 59).toString("base64url");
  const y = raw.slice(59, 91).toString("base64url");

  const proofKey = { kty: "EC", alg: "ES256", use: "sig", crv: "P-256", x, y };

  return signedXblPost(DEVICE_ENDPOINT, {
    RelyingParty: "http://auth.xboxlive.com",
    TokenType: "JWT",
    Properties: {
      AuthMethod: "RPS",
      SiteName: "user.auth.xboxlive.com",
      RpsTicket: `t=${msaToken}`,
      ProofKey: proofKey,
      Version: "0.0.0",
    }
  }, "", privateKey);
}

/** Obtain a Title token using the device token. */
async function fetchTitleToken(
  msaToken: string,
  deviceToken: string,
  privateKey: crypto.KeyObject
): Promise<XToken> {
  return signedXblPost(TITLE_ENDPOINT, {
    RelyingParty: "http://auth.xboxlive.com",
    TokenType: "JWT",
    Properties: {
      AuthMethod: "RPS",
      SiteName: "user.auth.xboxlive.com",
      DeviceToken: deviceToken,
      RpsTicket: `t=${msaToken}`,
    }
  }, deviceToken, privateKey);
}

/** Exchange user+device+title tokens for a full XSTS token with connected-storage access. */
async function fetchFullXsts(
  userToken: string,
  deviceToken: string,
  titleToken: string
): Promise<XToken> {
  const r = await httpsRequest(XSTS_ENDPOINT, "POST",
    { "Content-Type": "application/json", "Accept": "application/json", "x-xbl-contract-version": "1" },
    JSON.stringify({
      RelyingParty: "http://xboxlive.com",
      TokenType: "JWT",
      Properties: {
        SandboxId: "RETAIL",
        UserTokens: [userToken],
        DeviceToken: deviceToken,
        TitleToken: titleToken,
      }
    })
  );
  if (r.status !== 200) {
    const xerr = (() => { try { return JSON.parse(r.body)?.XErr; } catch { return undefined; } })();
    const msgs: Record<string, string> = {
      "2148916233": "No Xbox profile — create one at xbox.com",
      "2148916238": "Child account — needs family approval",
      "2148916229": "Title access denied for this sandbox",
    };
    throw new Error(`Full XSTS failed ${r.status}: ${msgs[String(xerr)] ?? r.body.slice(0, 200)}`);
  }
  return JSON.parse(r.body);
}

/** Build a fresh ECDSA P-256 key pair (ephemeral per session, like xbcsmgr). */
function generateP256KeyPair(): { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject } {
  return crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

/** Get the legacy MSA (login.live.com) access token, refreshing if needed.
 *  Throws if no live token is cached — user must run --login-legacy first. */
async function getLiveMsaToken(): Promise<string> {
  let cache = loadCache();
  if (cache.liveAccessToken && cache.liveExpiry && Date.now() < cache.liveExpiry - 300_000) {
    return cache.liveAccessToken;
  }
  if (!cache.liveRefreshToken) {
    throw new Error(
      "Legacy Xbox Live token not found.\n" +
      "Run: npx ts-node tools/save-sync.ts --login-legacy\n" +
      "(opens a browser — sign in with the same account as your Xbox)"
    );
  }
  process.stdout.write("Refreshing legacy Live token... ");
  const tok = await refreshLegacyToken(cache.liveRefreshToken);
  cache.liveAccessToken = tok.access_token;
  cache.liveRefreshToken = tok.refresh_token ?? cache.liveRefreshToken;
  cache.liveExpiry = Date.now() + tok.expires_in * 1000;
  saveCache(cache);
  console.log("✔");
  return tok.access_token;
}

/** Get (or refresh) the full device+title+user XSTS chain.
 *  Requires: --login (standard) AND --login-legacy (for device token).
 *  Tokens are cached in the same ~/.xbox-savebridge-tokens.json. */
async function getFullAuthHeader(): Promise<{ header: string; xuid: string; gamertag: string }> {
  let cache = loadCache();
  if (cache.fullXstsToken && cache.fullXstsExpiry && Date.now() < cache.fullXstsExpiry - 300_000) {
    return {
      header: `XBL3.0 x=${cache.fullUserHash};${cache.fullXstsToken}`,
      xuid: cache.xuid ?? "",
      gamertag: cache.gamertag ?? "",
    };
  }

  // Ensure we have a valid MSA access token (modern MSAL for user token)
  if (!cache.msaRefreshToken && !cache.msaAccessToken) {
    throw new Error("Not logged in.\nRun: npx ts-node tools/save-sync.ts --login");
  }

  let msaAccess = cache.msaAccessToken ?? "";
  const msaExpired = !cache.msaExpiry || Date.now() > cache.msaExpiry - 300_000;

  if (msaExpired || !msaAccess) {
    if (!cache.msaRefreshToken) throw new Error("MSA token expired. Run --login again.");
    process.stdout.write("Refreshing MSA token... ");
    const tok = await httpsRequest(
      `https://login.microsoftonline.com/${MSA_TENANT}/oauth2/v2.0/token`, "POST",
      { "Content-Type": "application/x-www-form-urlencoded" },
      new URLSearchParams({
        client_id: MSA_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: cache.msaRefreshToken,
        scope: MSA_SCOPES,
      }).toString()
    );
    if (tok.status !== 200) throw new Error("MSA token refresh failed. Run --login again.");
    const t = JSON.parse(tok.body);
    msaAccess = t.access_token;
    cache.msaAccessToken = msaAccess;
    cache.msaRefreshToken = t.refresh_token ?? cache.msaRefreshToken;
    cache.msaExpiry = Date.now() + t.expires_in * 1000;
    saveCache(cache);
    console.log("✔");
  }

  // Step 1: User token (uses modern MSAL token, d= prefix)
  process.stdout.write("Fetching user token... ");
  const userTok = await fetchXasuToken(msaAccess);
  const userToken = userTok.Token;
  console.log("✔");

  // Step 2: Device + Title tokens — require legacy MBI_SSL token (t= prefix)
  const { privateKey, publicKey } = generateP256KeyPair();
  const liveToken = await getLiveMsaToken();

  process.stdout.write("Fetching device token (ECDSA signed)... ");
  const deviceTok = await fetchDeviceToken(liveToken, privateKey, publicKey);
  const deviceToken = deviceTok.Token;
  console.log("✔");

  process.stdout.write("Fetching title token... ");
  const titleTok = await fetchTitleToken(liveToken, deviceToken, privateKey);
  const titleToken = titleTok.Token;
  console.log("✔");

  // Step 3: Full XSTS with all three
  process.stdout.write("Exchanging for full XSTS... ");
  const xsts    = await fetchFullXsts(userToken, deviceToken, titleToken);
  const xui     = xsts.DisplayClaims?.xui?.[0];
  const expiry  = xsts.NotAfter ? new Date(xsts.NotAfter).getTime() : Date.now() + 3600_000;
  console.log("✔");

  cache = {
    ...cache,
    userToken,
    deviceToken,
    deviceTokenExpiry: Date.now() + 3600_000,
    titleToken,
    titleTokenExpiry: Date.now() + 3600_000,
    fullXstsToken: xsts.Token,
    fullXstsExpiry: expiry,
    fullUserHash: xui?.uhs,
    // update user info from this claim if available
    xuid: xui?.xid ?? cache.xuid,
    gamertag: xui?.gtg ?? cache.gamertag,
  };
  saveCache(cache);

  return {
    header: `XBL3.0 x=${xui?.uhs};${xsts.Token}`,
    xuid: xui?.xid ?? cache.xuid ?? "",
    gamertag: xui?.gtg ?? cache.gamertag ?? "",
  };
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

// ── Connected Storage REST helpers ────────────────────────────────────────────

/** List all blobs/containers in a SCID's connected storage.
 *  With the full device+title+XSTS chain this works for RETAIL saves. */
async function csListBlobs(auth: string, xuid: string, scid: string, pfn?: string): Promise<Array<{fileName: string; size: number; clientFileTime?: string; displayName?: string}>> {
  const url  = `${TS_ENDPOINT}/connectedstorage/users/xuid(${xuid})/scids/${scid}/`;
  const headers: Record<string, string> = {
    "Authorization": auth,
    "x-xbl-contract-version": "107",
    "Accept": "application/json",
  };
  if (pfn) headers["x-xbl-pfn"] = pfn;
  const resp = await httpsRequest(url, "GET", headers);
  if (resp.status === 403) throw new Error(
    `403 Access Denied — cannot list Connected Storage for SCID ${scid}\n` +
    "Response: " + resp.body.slice(0, 300)
  );
  if (resp.status === 404) return [];
  if (resp.status !== 200) throw new Error(`List failed ${resp.status}: ${resp.body.slice(0, 300)}`);
  const parsed = JSON.parse(resp.body);
  // response may have .blobs or .savedgames depending on endpoint
  return parsed?.blobs ?? parsed?.savedgames ?? parsed?.items ?? [];
}

/** Download a single blob atom from connected storage. */
async function csDownloadBlob(auth: string, xuid: string, scid: string, blobPath: string, pfn?: string): Promise<Buffer> {
  const url  = `${TS_ENDPOINT}/connectedstorage/users/xuid(${xuid})/scids/${scid}/${blobPath}`;
  const headers: Record<string, string> = {
    "Authorization": auth,
    "x-xbl-contract-version": "107",
    "Accept": "*/*",
  };
  if (pfn) headers["x-xbl-pfn"] = pfn;
  const resp = await httpsRequest(url, "GET", headers);
  if (resp.status !== 200) throw new Error(`Download failed ${resp.status} for ${blobPath}: ${resp.body.slice(0, 200)}`);
  return resp.rawBody;
}

// ── Save file inspector ────────────────────────────────────────────────────────

function inspectSave(filePath: string): void {
  if (!fs.existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1); }
  const raw = fs.readFileSync(filePath);

  // Import parser
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    parseSaveFile, maybeDecompress, CHARACTER_CLASS, CHARACTER_CLASS_BY_KEY
  } = require("../src/parser/save-file");

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║   Dead Island DE — Save Inspector                        ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`\nFile: ${filePath}`);
  console.log(`Size: ${raw.length.toLocaleString()} bytes (compressed)`);

  let decompressed: Buffer;
  try {
    decompressed = maybeDecompress(raw);
    console.log(`Decompressed: ${decompressed.length.toLocaleString()} bytes`);
  } catch (e: any) {
    console.log(`Decompression failed: ${e.message} — trying raw`);
    decompressed = raw;
  }

  let save: any;
  try {
    save = parseSaveFile(decompressed);
  } catch (e: any) {
    console.error(`\n✗ Parse failed: ${e.message}`);
    console.log(`\nFirst 64 bytes (hex):\n${raw.slice(0, 64).toString("hex").replace(/(.{32})/g, "$1\n")}`);
    return;
  }

  const h = save.header;
  const loc = save.location;
  // Determine character name from charTypeKey string (most reliable)
  const charFromKey = CHARACTER_CLASS_BY_KEY?.[loc.charTypeKey];
  const charName = charFromKey !== undefined
    ? CHARACTER_CLASS[charFromKey]
    : (CHARACTER_CLASS[loc.charClassId] ?? `Unknown(${loc.charClassId})`);

  console.log(`\n┌─ PLAYER ──────────────────────────────────────────────────`);
  console.log(`│  Character : ${charName} (${loc.charTypeKey})`);
  console.log(`│  Level     : ${h.level}`);
  console.log(`│  HP        : ${h.currHP} / ${h.maxHP}`);
  console.log(`│  Money     : $${loc.money.toLocaleString()}`);
  console.log(`│  Save date : ${loc.saveYear}-${String(loc.saveMonth).padStart(2,"0")}-${String(loc.saveDay||1).padStart(2,"0")} ${String(loc.saveHour).padStart(2,"0")}:${String(loc.saveMinute).padStart(2,"0")}`);
  console.log(`│  Save ver. : ${h.saveVersion}`);
  console.log(`├─ LOCATION ────────────────────────────────────────────────`);
  console.log(`│  Map       : ${loc.mapName}`);
  console.log(`│  Checkpoint: ${loc.checkpoint}`);
  console.log(`│  Spawn     : ${loc.spawnPoint}`);
  console.log(`│  Chk2      : ${loc.checkpoint2}`);
  if (save._parseError) {
    console.log(`│  ⚠ Partial parse (${save._parseError.slice(0, 60)})`);
    console.log(`│  This save uses a different format (prologue/early game).`);
    console.log(`│  Basic edits (money, level, HP) still work.`);
  }
  console.log(`├─ WEAPONS (quick slots: ${save.quickSlots.length}) ────────────────────────────`);
  for (let i = 0; i < save.quickSlots.length; i++) {
    const w = save.quickSlots[i];
    const dur = w.durability.toFixed(1);
    const craft = w.craftplanId ? ` [${w.craftplanId}]` : "";
    console.log(`│  [${i}] ${w.itemId}${craft}  dur=${dur}  qty=${w.quantity}  lvl=${w.itemLevel}`);
  }
  console.log(`├─ INVENTORY (${save.inventory.length} items) ────────────────────────────────`);
  const invFiltered = save.inventory.filter((it: any) => it.quantity > 0 && it.itemId);
  for (const item of invFiltered.slice(0, 30)) {
    console.log(`│  x${String(item.quantity).padStart(3)}  ${item.itemId}`);
  }
  if (invFiltered.length > 30) console.log(`│  ... and ${invFiltered.length - 30} more`);
  console.log(`└───────────────────────────────────────────────────────────`);
  console.log(`\nTip: Edit this save with:`);
  console.log(`  npx ts-node tools/save-sync.ts --edit --input "${filePath}" --money 9999999 --level 60`);
}

// ── Edit a save file ──────────────────────────────────────────────────────────

async function cmdEdit(): Promise<void> {
  const inputFile = getArg("--input");
  if (!inputFile) { console.error("--input <file.bin> required"); process.exit(1); }
  if (!fs.existsSync(inputFile)) { console.error(`File not found: ${inputFile}`); process.exit(1); }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    parseSaveFile, serializeSaveFile, maybeDecompress, gzipCompress,
    setMoney, setLevel, setHP, setInventoryItemQty, maxAllWeaponDurability
  } = require("../src/parser/save-file");

  const raw = fs.readFileSync(inputFile);
  const wasGzipped = raw[0] === 0x1f && raw[1] === 0x8b;
  const decompressed = maybeDecompress(raw);
  let save = parseSaveFile(decompressed);

  let changed = false;

  const moneyArg = getArg("--money");
  if (moneyArg !== undefined) {
    const m = parseInt(moneyArg, 10);
    if (isNaN(m) || m < 0) { console.error("--money must be a positive integer"); process.exit(1); }
    save = setMoney(save, m);
    console.log(`✔ Set money → $${m.toLocaleString()}`);
    changed = true;
  }

  const levelArg = getArg("--level");
  if (levelArg !== undefined) {
    const l = parseInt(levelArg, 10);
    if (isNaN(l) || l < 1 || l > 60) { console.error("--level must be 1–60"); process.exit(1); }
    save = setLevel(save, l);
    console.log(`✔ Set level → ${l}`);
    changed = true;
  }

  const maxHPArg = getArg("--max-hp");
  if (maxHPArg !== undefined) {
    const hp = parseInt(maxHPArg, 10);
    save = setHP(save, hp, hp);
    console.log(`✔ Set HP → ${hp}`);
    changed = true;
  }

  if (hasFlag("--max-durability")) {
    save = maxAllWeaponDurability(save);
    console.log(`✔ Maxed durability on all ${save.quickSlots.length} weapons`);
    changed = true;
  }

  const itemArg = getArg("--item-qty");
  const itemIdArg = getArg("--item");
  if (itemArg !== undefined && itemIdArg !== undefined) {
    const qty = parseInt(itemArg, 10);
    save = setInventoryItemQty(save, itemIdArg, qty);
    console.log(`✔ Set ${itemIdArg} → qty ${qty}`);
    changed = true;
  }

  if (hasFlag("--max-inventory")) {
    const { maxAllInventory } = require("../src/parser/save-file");
    save = maxAllInventory(save);
    console.log(`✔ Maxed all ${save.inventory.length} inventory item quantities to 999`);
    changed = true;
  }

  if (!changed) {
    console.log("No edits specified. Use --money N, --level N, --max-hp N, --max-durability, --max-inventory, --item X --item-qty N");
    return;
  }

  // Serialize and re-compress
  const outBytes = serializeSaveFile(save);
  const finalBytes = wasGzipped ? gzipCompress(outBytes) : outBytes;

  // Output file
  const outFile = getArg("--output") ?? inputFile.replace(/\.bin$/, "_edited.bin").replace(/([^.]+)$/, "edited_$1");
  fs.writeFileSync(outFile, finalBytes);
  console.log(`\n✔ Written: ${outFile} (${finalBytes.length.toLocaleString()} bytes)`);
  console.log(`  (${wasGzipped ? "re-gzipped" : "raw bytes"} output)`);
  console.log(`\nTo upload back to Xbox, use the --cs-push command (coming soon).`);
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

// ── cs-pull: pull saves directly from Xbox Live ────────────────────────────────
// Phase 1: List blobs via standard XSTS + x-xbl-pfn header (no device token needed)
// Phase 2: Resolve atom manifests via /savedgames/{name} (standard XSTS)
// Phase 3: Download atom binaries via POST /atoms/{guid} → Azure SAS URL
//          (requires device+title token — run --login-legacy first for Phase 3)

/** Get a standard XSTS auth header (no device/title token). */
async function getStandardAuthHeader(): Promise<{ header: string; xuid: string; gamertag: string }> {
  let cache = loadCache();
  if (cache.xstsToken && cache.xstsExpiry && Date.now() < cache.xstsExpiry - 300_000) {
    return { header: `XBL3.0 x=${cache.userHash};${cache.xstsToken}`, xuid: cache.xuid ?? "", gamertag: cache.gamertag ?? "" };
  }
  if (!cache.msaRefreshToken && !cache.msaAccessToken) {
    throw new Error("Not logged in.\nRun: npx ts-node tools/save-sync.ts --login");
  }
  let msaAccess = cache.msaAccessToken ?? "";
  const msaExpired = !cache.msaExpiry || Date.now() > cache.msaExpiry - 300_000;
  if (msaExpired || !msaAccess) {
    if (!cache.msaRefreshToken) throw new Error("Token expired. Run --login.");
    process.stdout.write("Refreshing MSA... ");
    const tok = await httpsRequest(
      `https://login.microsoftonline.com/${MSA_TENANT}/oauth2/v2.0/token`, "POST",
      { "Content-Type": "application/x-www-form-urlencoded" },
      new URLSearchParams({ client_id: MSA_CLIENT_ID, grant_type: "refresh_token",
        refresh_token: cache.msaRefreshToken, scope: MSA_SCOPES }).toString()
    );
    if (tok.status !== 200) throw new Error("Token refresh failed. Run --login.");
    const t = JSON.parse(tok.body);
    msaAccess = t.access_token;
    cache = { ...cache, msaAccessToken: msaAccess, msaRefreshToken: t.refresh_token ?? cache.msaRefreshToken,
      msaExpiry: Date.now() + t.expires_in * 1000 };
    saveCache(cache);
    console.log("✔");
  }
  process.stdout.write("Getting XSTS... ");
  const xasu = await fetchXasuToken(msaAccess);
  const xsts = await fetchXstsToken(xasu.Token);
  const xui  = xsts.DisplayClaims?.xui?.[0];
  const expiry = xsts.NotAfter ? new Date(xsts.NotAfter).getTime() : Date.now() + 3600_000;
  cache = { ...cache, xstsToken: xsts.Token, xstsExpiry: expiry,
    userHash: xui?.uhs, xuid: xui?.xid, gamertag: xui?.gtg };
  saveCache(cache);
  console.log("✔");
  return { header: `XBL3.0 x=${xui?.uhs};${xsts.Token}`, xuid: xui?.xid ?? "", gamertag: xui?.gtg ?? "" };
}

/** Get Azure Blob SAS URL for downloading an atom — requires device+title XSTS token. */
async function getAtomDownloadUrl(
  fullHeader: string,
  xuid: string,
  scid: string,
  atomGuid: string,
  size: number,
  pfn: string
): Promise<string> {
  const url = `${TS_ENDPOINT}/connectedstorage/users/xuid(${xuid})/scids/${scid}/atoms/${encodeURIComponent(atomGuid + ",binary")}`;
  const r = await httpsRequest(url, "POST",
    { "Authorization": fullHeader, "x-xbl-contract-version": "107",
      "Content-Type": "application/json", "Accept": "application/json", "x-xbl-pfn": pfn },
    JSON.stringify({ size })
  );
  if (r.status !== 200) throw new Error(`atoms POST failed ${r.status}: ${r.body.slice(0, 200)}`);
  const blobUri = JSON.parse(r.body)?.blobUri;
  if (!blobUri) throw new Error(`No blobUri in response: ${r.body.slice(0, 100)}`);
  return blobUri;
}

/** Download binary from Azure Blob Storage SAS URL. */
function downloadFromSasUrl(sasUrl: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(sasUrl);
    const lib = urlObj.protocol === "https:" ? https : http;
    const req = (lib as typeof https).request({ hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.end();
  });
}

async function cmdCsPull(): Promise<void> {
  const outDir  = getArg("--out");
  const scid    = getArg("--scid") ?? DEAD_ISLAND_SCID;
  const pfn     = getArg("--pfn") ?? DEAD_ISLAND_PFN;
  const fullDownload = hasFlag("--full");

  console.log(`\nDead Island DE — Connected Storage Pull`);
  console.log(`${"─".repeat(45)}`);
  console.log(`SCID : ${scid}`);
  console.log(`PFN  : ${pfn}`);
  console.log("");

  // Phase 1: standard auth (works for listing)
  const { header: stdHeader, xuid, gamertag } = await getStandardAuthHeader();
  console.log(`✔ Authenticated as: ${gamertag} (XUID: ${xuid})\n`);

  // Phase 2: list blobs with x-xbl-pfn header
  console.log("Listing Connected Storage blobs (standard XSTS + x-xbl-pfn)...");
  const blobs = await csListBlobs(stdHeader, xuid, scid, pfn);

  if (blobs.length === 0) {
    console.log("\n  No blobs found for this SCID.");
    console.log("  Launch Dead Island DE on your Xbox and save the game first.");
    return;
  }

  console.log(`\nFound ${blobs.length} blob(s):\n`);
  for (const b of blobs) {
    const sz = b.size ? `${(b.size / 1024).toFixed(1)} KB` : "(no size)";
    const dt = (b as any).clientFileTime ? `  [${(b as any).clientFileTime.slice(0,10)}]` : "";
    console.log(`  ${b.fileName ?? b.displayName ?? "(unnamed)"}  ${sz}${dt}`);
  }

  if (!outDir) {
    console.log(`\nTo download save manifests (atom GUIDs):`);
    console.log(`  npx ts-node tools/save-sync.ts --cs-pull --out ./saves`);
    console.log(`\nTo download actual binary save data (requires --login-legacy first):`);
    console.log(`  npx ts-node tools/save-sync.ts --login-legacy`);
    console.log(`  npx ts-node tools/save-sync.ts --cs-pull --out ./saves --full`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  // Phase 3: for each blob, get the savedgame manifest and download atoms
  let savedFiles = 0;
  for (const blob of blobs) {
    const blobName = blob.fileName ?? blob.displayName ?? "";
    if (!blobName) continue;

    // Get the atom manifest via /savedgames/{name}
    const saveName = blobName.replace(/,savedgame$/i, "");
    const manifestUrl = `${TS_ENDPOINT}/connectedstorage/users/xuid(${xuid})/scids/${scid}/savedgames/${encodeURIComponent(saveName)}`;
    const manifestR = await httpsRequest(manifestUrl, "GET", {
      "Authorization": stdHeader, "x-xbl-contract-version": "107",
      "Accept": "application/json", "x-xbl-pfn": pfn
    });
    if (manifestR.status !== 200) {
      console.log(`  ✗ Manifest for ${saveName}: ${manifestR.status}`);
      continue;
    }
    const manifest = JSON.parse(manifestR.body);
    const atoms: Array<{name: string; atom: string; size: number}> = manifest.atoms ?? [];

    // Save the manifest
    const manifestFile = path.join(outDir, saveName.replace(/[\\/:*?"<>|]/g, "_") + "_manifest.json");
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    console.log(`  ✔ ${saveName} manifest → ${manifestFile}`);

    if (!fullDownload) {
      for (const a of atoms) {
        console.log(`     Atom: ${a.name}  GUID: ${a.atom}  (${(a.size/1024).toFixed(1)} KB)`);
      }
      continue;
    }

    // Full download: get SAS URL for each atom and download binary
    // This requires the full device+title token
    let fullHeader: string;
    try {
      const fullAuth = await getFullAuthHeader();
      fullHeader = fullAuth.header;
    } catch (e: any) {
      console.log(`\n  ⚠ Full atom download requires legacy login:`);
      console.log(`    npx ts-node tools/save-sync.ts --login-legacy`);
      console.log(`    Then: --cs-pull --out ./saves --full`);
      return;
    }

    for (const a of atoms) {
      try {
        process.stdout.write(`    Downloading atom ${a.name} (${(a.size/1024).toFixed(1)} KB)... `);
        const sasUrl = await getAtomDownloadUrl(fullHeader, xuid, scid, a.atom, a.size, pfn);
        const binData = await downloadFromSasUrl(sasUrl);
        const outFile = path.join(outDir, saveName.replace(/[\\/:*?"<>|]/g, "_") + "_" + a.name.replace(/[\\/:*?"<>|]/g, "_") + ".bin");
        fs.writeFileSync(outFile, binData);
        console.log(`✔  (${binData.length.toLocaleString()} bytes) → ${outFile}`);
        savedFiles++;
      } catch (e: any) {
        console.log(`✗  ${(e as Error).message.slice(0, 100)}`);
      }
    }
  }

  if (!fullDownload) {
    console.log(`\n✔ Saved ${blobs.length} manifest(s) to ${outDir}`);
    console.log(`  Manifests contain the atom GUIDs for each save slot.`);
    console.log(`  To download the actual binary save data:`);
    console.log(`    npx ts-node tools/save-sync.ts --login-legacy`);
    console.log(`    npx ts-node tools/save-sync.ts --cs-pull --out ${outDir} --full`);
  } else {
    console.log(`\n✔ Downloaded ${savedFiles} save atom(s) to ${outDir}`);
    console.log(`\nTo inspect: npx ts-node tools/save-sync.ts --info --input <blob_file>`);
    console.log(`To edit:    npx ts-node src/cli.ts --input <blob_file> --god-mode`);
  }
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function cmdLogin(): Promise<void> {
  const tok = await msaDeviceCodeLogin();
  const xasu = await fetchXasuToken(tok.access_token);
  const xsts = await fetchXstsToken(xasu.Token);
  const xui = xsts.DisplayClaims?.xui?.[0];
  const expiry = xsts.NotAfter ? new Date(xsts.NotAfter).getTime() : Date.now() + 3600_000;
  const existing = loadCache();
  saveCache({ ...existing, msaAccessToken: tok.access_token, msaRefreshToken: tok.refresh_token,
    msaExpiry: Date.now() + tok.expires_in * 1000, xstsToken: xsts.Token, xstsExpiry: expiry,
    userHash: xui?.uhs, xuid: xui?.xid, gamertag: xui?.gtg });
  console.log("✔ Logged in!");
  console.log(`  Gamertag : ${xui?.gtg ?? "(none)"}`);
  console.log(`  XUID     : ${xui?.xid ?? "(none)"}`);
  console.log(`  Cached at: ${CACHE_FILE}`);
  console.log("\n✔ Run --cs-pull to list your save files (no extra steps needed).");
  console.log("  For full binary download, also run --login-legacy.");
}

async function cmdLoginLegacy(): Promise<void> {
  const existing = loadCache();
  const tok = await legacyLiveLogin();
  saveCache({ ...existing,
    liveAccessToken: tok.access_token,
    liveRefreshToken: tok.refresh_token,
    liveExpiry: Date.now() + tok.expires_in * 1000,
  });
  console.log("✔ Legacy Xbox Live token cached!");
  console.log(`  Cached at: ${CACHE_FILE}`);
  console.log("\n✔ You can now run --cs-pull --out ./saves --full to download binary save data.");
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

// ── cs-push helpers ────────────────────────────────────────────────────────────

/**
 * Request a writable SAS URL to upload a new atom to Xbox title storage.
 * Uses: POST /connectedstorage/users/xuid({xuid})/scids/{scid}/atoms
 * Body: { size: N }
 * Returns: { atomGuid: string; blobUri: string }
 */
async function getAtomUploadUrl(
  fullHeader: string,
  xuid: string,
  scid: string,
  size: number,
  pfn: string
): Promise<{ atomGuid: string; blobUri: string }> {
  const url = `${TS_ENDPOINT}/connectedstorage/users/xuid(${xuid})/scids/${scid}/atoms`;
  const r = await httpsRequest(url, "POST",
    {
      "Authorization": fullHeader,
      "x-xbl-contract-version": "107",
      "Content-Type": "application/json",
      "Accept": "application/json",
      "x-xbl-pfn": pfn,
    },
    JSON.stringify({ size })
  );
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`atoms POST (upload) failed ${r.status}: ${r.body.slice(0, 300)}`);
  }
  const body = JSON.parse(r.body);
  const atomGuid = body.atomGuid ?? body.atom ?? body.id;
  const blobUri  = body.blobUri ?? body.uploadUri;
  if (!blobUri)  throw new Error(`No blobUri in upload response: ${r.body.slice(0, 200)}`);
  if (!atomGuid) throw new Error(`No atomGuid in upload response: ${r.body.slice(0, 200)}`);
  return { atomGuid, blobUri };
}

/**
 * Upload binary bytes to an Azure Blob Storage SAS URL via PUT.
 */
function uploadToSasUrl(sasUrl: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(sasUrl);
    const lib    = urlObj.protocol === "https:" ? require("https") : require("http");
    const req = lib.request(
      {
        hostname: urlObj.hostname,
        path:     urlObj.pathname + urlObj.search,
        method:   "PUT",
        headers: {
          "Content-Length": data.length,
          "Content-Type":   "application/octet-stream",
          "x-ms-blob-type": "BlockBlob",
        },
      },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`SAS PUT failed ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/**
 * Commit an updated savedgame manifest to Xbox title storage.
 * Uses: PUT /connectedstorage/users/xuid({xuid})/scids/{scid}/savedgames/{saveName}
 * Body: { atoms: [ { name: atomName, atom: atomGuid, size: N } ] }
 */
async function commitSavedGame(
  fullHeader: string,
  xuid: string,
  scid: string,
  saveName: string,
  atomName: string,
  atomGuid: string,
  size: number,
  pfn: string
): Promise<void> {
  const url  = `${TS_ENDPOINT}/connectedstorage/users/xuid(${xuid})/scids/${scid}/savedgames/${encodeURIComponent(saveName)}`;
  const body = JSON.stringify({ atoms: [{ name: atomName, atom: atomGuid, size }] });
  const r    = await httpsRequest(url, "PUT",
    {
      "Authorization": fullHeader,
      "x-xbl-contract-version": "107",
      "Content-Type": "application/json",
      "Accept": "application/json",
      "x-xbl-pfn": pfn,
    },
    body
  );
  if (r.status !== 200 && r.status !== 204) {
    throw new Error(`savedgames PUT failed ${r.status}: ${r.body.slice(0, 300)}`);
  }
}

// ── --cs-push ─────────────────────────────────────────────────────────────────
/**
 * Push an edited save file back to Xbox Live Connected Storage.
 *
 * Usage:
 *   npx ts-node tools/save-sync.ts --cs-push \
 *     --input ./saves/save_1.sav_dec_edited.bin \
 *     --manifest ./saves/save_1.sav_manifest.json
 *
 * The manifest identifies which savedgame slot to overwrite.
 * If --manifest is not specified, the tool will auto-detect it
 * by stripping _edited/_dec suffixes from the input filename.
 *
 * The input file can be either:
 *   - decompressed (.sav_dec.bin)  → will be gzip-compressed before upload
 *   - already gzip-compressed      → uploaded as-is
 */
async function cmdCsPush(): Promise<void> {
  const inputFile    = getArg("--input");
  const manifestArg  = getArg("--manifest");
  const scid         = getArg("--scid") ?? DEAD_ISLAND_SCID;
  const pfn          = getArg("--pfn")  ?? DEAD_ISLAND_PFN;
  const dryRun       = hasFlag("--dry-run");

  if (!inputFile) {
    console.error("Usage: --cs-push --input <edited.bin> [--manifest <manifest.json>]");
    process.exit(1);
  }

  console.log(`\nDead Island DE — Connected Storage Push`);
  console.log(`${"─".repeat(45)}`);
  console.log(`Input  : ${inputFile}`);
  if (dryRun) console.log(`DRY RUN: will not actually upload`);

  // ── Step 1: Read & prepare the save bytes ────────────────────────────────────
  const rawBytes = fs.readFileSync(inputFile);
  const isGzipped = rawBytes[0] === 0x1f && rawBytes[1] === 0x8b;

  let uploadBytes: Buffer;
  if (isGzipped) {
    console.log(`Format : already gzip-compressed (${rawBytes.length.toLocaleString()} bytes)`);
    uploadBytes = rawBytes;
  } else {
    // Decompress to verify it's a valid save, then re-compress
    const { maybeDecompress, gzipCompress } = require("../src/parser/save-file");
    const dec = maybeDecompress(rawBytes); // no-op since not gzipped
    // Quick sanity: first 4 bytes must be 0xFFFFFFFF sentinel
    const sentinel = dec.readUInt32LE(0);
    if (sentinel !== 0xFFFFFFFF) {
      throw new Error(`Invalid save file — bad sentinel: 0x${sentinel.toString(16).toUpperCase()}`);
    }
    uploadBytes = gzipCompress(rawBytes);
    console.log(`Format : decompressed → re-compressed (${rawBytes.length} → ${uploadBytes.length} bytes)`);
  }

  // ── Step 2: Resolve the manifest ────────────────────────────────────────────
  let manifestPath = manifestArg;
  if (!manifestPath) {
    // Auto-detect: strip _edited/_dec/_MAXED/_EDITED suffix variations
    const baseName = path.basename(inputFile)
      .replace(/_edited/gi, "")
      .replace(/_dec/gi, "")
      .replace(/_MAXED/g, "")
      .replace(/\.bin$/, "")
      .trim();
    const dir = path.dirname(inputFile);
    // Try several candidate manifest names
    const candidates = [
      path.join(dir, baseName + "_manifest.json"),
      path.join(dir, baseName + ".sav_manifest.json"),
      // if inputFile is in saves/ look there
      path.join(SAVES_DIR, baseName + "_manifest.json"),
      path.join(SAVES_DIR, baseName + ".sav_manifest.json"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) { manifestPath = c; break; }
    }
    if (!manifestPath) {
      console.error(`\n✗ Could not auto-detect manifest file.`);
      console.error(`  Tried:\n${candidates.map(c => "    " + c).join("\n")}`);
      console.error(`  Pass --manifest <path> explicitly.`);
      process.exit(1);
    }
  }

  const manifest   = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const atoms: Array<{name: string; atom: string; size: number}> = manifest.atoms ?? [];
  if (atoms.length === 0) throw new Error(`Manifest has no atoms: ${manifestPath}`);

  // Derive the savedgame name from the manifest path
  const manifestBase = path.basename(manifestPath);
  const saveName     = manifestBase.replace(/_manifest\.json$/i, "");
  const atomName     = atoms[0].name; // e.g. "save_1.sav"

  console.log(`Manifest: ${manifestPath}`);
  console.log(`SaveName: ${saveName}`);
  console.log(`AtomName: ${atomName}`);
  console.log(`Old GUID: ${atoms[0].atom}  (${atoms[0].size} bytes)`);
  console.log(`New size: ${uploadBytes.length} bytes`);

  if (dryRun) {
    console.log(`\n✔ Dry run complete — would upload ${uploadBytes.length} bytes as atom "${atomName}" to save "${saveName}"`);
    return;
  }

  // ── Step 3: Authenticate ────────────────────────────────────────────────────
  console.log(`\nAuthenticating...`);
  let fullHeader: string;
  let xuid: string;
  let gamertag: string;

  try {
    const fullAuth = await getFullAuthHeader();
    fullHeader = fullAuth.header;
    xuid       = fullAuth.xuid;
    gamertag   = fullAuth.gamertag;
  } catch (e: any) {
    console.error(`\n✗ Full authentication required for upload.`);
    console.error(`  Run: npx ts-node tools/save-sync.ts --login-legacy`);
    console.error(`  Then retry --cs-push`);
    throw e;
  }

  console.log(`✔ Authenticated as: ${gamertag} (XUID: ${xuid})`);

  // ── Step 4: Get upload SAS URL for new atom ──────────────────────────────────
  console.log(`\nRequesting upload slot for new atom...`);
  const { atomGuid: newAtomGuid, blobUri } = await getAtomUploadUrl(
    fullHeader, xuid, scid, uploadBytes.length, pfn
  );
  console.log(`✔ New atom GUID: ${newAtomGuid}`);
  console.log(`  Upload URL:    ${blobUri.slice(0, 60)}...`);

  // ── Step 5: Upload bytes to Azure Blob SAS URL ───────────────────────────────
  process.stdout.write(`\nUploading ${uploadBytes.length.toLocaleString()} bytes to Azure Blob... `);
  await uploadToSasUrl(blobUri, uploadBytes);
  console.log(`✔`);

  // ── Step 6: Commit the savedgame manifest ────────────────────────────────────
  process.stdout.write(`Committing savedgame "${saveName}" → atom "${newAtomGuid}"... `);
  await commitSavedGame(fullHeader, xuid, scid, saveName, atomName, newAtomGuid, uploadBytes.length, pfn);
  console.log(`✔`);

  // ── Step 7: Update local manifest ────────────────────────────────────────────
  const updatedManifest = { atoms: [{ name: atomName, atom: newAtomGuid, size: uploadBytes.length }] };
  fs.writeFileSync(manifestPath, JSON.stringify(updatedManifest, null, 2));
  console.log(`\nUpdated manifest: ${manifestPath}`);

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  ✔  Save pushed to Xbox Live!                                ║
╚══════════════════════════════════════════════════════════════╝

  Old atom GUID : ${atoms[0].atom}
  New atom GUID : ${newAtomGuid}
  Size          : ${uploadBytes.length.toLocaleString()} bytes

  ★  Launch Dead Island on your Xbox and load the save.
     The game reads from cloud storage automatically.
`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (hasFlag("--login"))         { await cmdLogin();        return; }
  if (hasFlag("--login-legacy"))  { await cmdLoginLegacy();  return; }
  if (hasFlag("--cs-pull"))       { await cmdCsPull();       return; }
  if (hasFlag("--cs-push"))       { await cmdCsPush();       return; }
  if (hasFlag("--list"))          { await cmdList();         return; }
  if (hasFlag("--list-steam"))    { cmdListSteam();          return; }
  if (hasFlag("--bridge"))        { await cmdBridge();       return; }
  if (hasFlag("--cs-list"))       { await cmdCsList();       return; }
  if (hasFlag("--cs-download"))   { await cmdCsDownload();   return; }
  if (hasFlag("--bridge-import")) { await cmdBridgeImport(); return; }
  if (hasFlag("--edit"))          { await cmdEdit();         return; }

  const inputFile = getArg("--input");
  if (hasFlag("--inspect") || hasFlag("--info") || hasFlag("--import")) {
    if (!inputFile) { console.error("--input <file> required"); process.exit(1); }
    inspectSave(inputFile);
    return;
  }

  console.log(`
Dead Island DE — Save Sync + Editor Tool
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

★ STEP 1 — Download your save from Xbox Live:
    npx ts-node tools/save-sync.ts --login
    npx ts-node tools/save-sync.ts --login-legacy
    npx ts-node tools/save-sync.ts --cs-pull --out ./saves --full

★ STEP 2 — Inspect the save:
    npx ts-node tools/save-sync.ts --inspect --input ./saves/save_1.sav_dec.bin

★ STEP 3 — Edit the save:
    npx ts-node tools/save-sync.ts --edit --input ./saves/save_1.sav_dec.bin \\
      --money 9999999 --level 60 --max-durability --output ./saves/save_1_edited.bin

★ STEP 4 — Push edited save back to Xbox Live:
    npx ts-node tools/save-sync.ts --cs-push \\
      --input ./saves/save_1.sav_dec_edited.bin \\
      --manifest ./saves/save_1.sav_manifest.json

    (Or omit --manifest and it will auto-detect from the filename)

DOWNLOAD COMMANDS:
  --login                                 Xbox Live sign-in (one-time, cached)
  --login-legacy                          Legacy Xbox Live login (needed for --full)
  --cs-pull [--out ./saves]               Pull save manifests from Xbox Live
  --cs-pull --out ./saves --full          ★ Pull + download binary save atoms
  --cs-push --input <edited.bin>          ★ Push edited save back to Xbox Live
    [--manifest <manifest.json>]            Manifest from --cs-pull (auto-detected if omitted)
    [--dry-run]                             Simulate upload without actually pushing
  --bridge  [--xbox-ip <ip>]              SaveBridge status + container list
  --cs-download [--xbox-ip <ip>] [--out]  Download via SaveBridge
  --bridge-import --wgs <path>            Import from Windows PC WGS folder
  --list-steam                            Find Steam save files

INSPECT / EDIT COMMANDS:
  --inspect --input <file.bin>            Inspect & display save data
  --edit    --input <file.bin>            Edit a save file
    [--output <file.bin>]                   Output file (default: _edited suffix)
    [--money N]                             Set wallet to N (e.g. 9999999)
    [--level N]                             Set player level (1–60)
    [--max-hp N]                            Set max+current HP to N
    [--max-durability]                      Max out all weapon durability
    [--item <ItemId> --item-qty N]          Set stackable item quantity

SCID    : ${DEAD_ISLAND_SCID}
PFN     : ${DEAD_ISLAND_PFN}
Xbox IP : ${XBOX_IP}:${BRIDGE_PORT}
  `.trim());
}

main().catch((err: Error) => {
  console.error("\n✗", err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
