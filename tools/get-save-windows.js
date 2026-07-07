#!/usr/bin/env node
// get-save-windows.js
// Run on Windows PC with Xbox app installed to download DI DE save atoms.
// Uses Gaming Services device token from Windows Credential Manager.
//
// Usage (Windows):
//   node tools/get-save-windows.js
//   node tools/get-save-windows.js --out C:\saves
//
// Requirements:
//   - Xbox app installed and signed in as the Xbox account
//   - Node.js installed on Windows
//   - Run after launching the Xbox app at least once

const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const crypto = require("crypto");

// ── Known save atoms (from manifests pulled on Mac) ────────────────────────
const XUID   = "2535409375459619";
const SCID   = "db860100-d780-4e17-8685-ad130052ea64";
const PFN    = "DeepSilver.DeadIslandDefinitiveEdition_hmv7qcest37me";
const ATOMS  = [
  { name: "PROFILE_DATA", guid: "BDE638D4-8379-4867-A706-4E05EEAA0CBD", size: 2304 },
  { name: "save_0.sav",   guid: "807F953E-558B-4281-A5A6-278E83A725CF", size: 837  },
  { name: "save_1.sav",   guid: "972875C7-F554-4CBB-855D-1D2BFAA706F0", size: 1785 },
  { name: "save_2.sav",   guid: "DF0878BC-275C-41AD-AE76-85B642308BFF", size: 854  },
];

// ── Auth constants ──────────────────────────────────────────────────────────
const MSA_CLIENT_ID  = "b1eab458-325b-45a5-9692-ad6079c1eca8";
const MSA_TENANT     = "consumers";
const MSA_SCOPES     = "Xboxlive.signin Xboxlive.offline_access offline_access";
const CACHE_FILE     = path.join(os.homedir(), ".xbox-savebridge-tokens.json");
const DEVICE_URL     = "https://device.auth.xboxlive.com/device/authenticate";
const TITLE_URL      = "https://title.auth.xboxlive.com/title/authenticate";
const XSTS_URL       = "https://xsts.auth.xboxlive.com/xsts/authorize";
const TS_BASE        = "https://titlestorage.xboxlive.com";

const args   = process.argv.slice(2);
const outDir = args[args.indexOf("--out") + 1] ?? "./saves";

// ── Helpers ─────────────────────────────────────────────────────────────────

function req(url, method, headers, body) {
  return new Promise((res, rej) => {
    const u    = new URL(url);
    const bodyB = body ? Buffer.from(body) : Buffer.alloc(0);
    const opts = {
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method,
      headers: { ...headers, "Content-Length": bodyB.length }
    };
    const r = https.request(opts, (resp) => {
      const c = [];
      resp.on("data", d => c.push(d));
      resp.on("end", () => res({ status: resp.statusCode, body: Buffer.concat(c) }));
    });
    r.on("error", rej);
    if (bodyB.length) r.write(bodyB);
    r.end();
  });
}

function loadCache() {
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch {}
  return {};
}

function saveCache(c) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}

// ── Windows Credential Manager ── read Gaming Services device token ──────────

function readWinCredential(targetFilter) {
  // Try to read from Windows Credential Manager using PowerShell
  // Gaming Services caches the device token under a key like:
  // XBL:devicetoken or MicrosoftXboxLiveIdentityService:device
  try {
    const { execSync } = require("child_process");
    const ps = `
[void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials.PasswordVault, ContentType=WindowsRuntime]
try {
  $vault = [Windows.Security.Credentials.PasswordVault]::new()
  $creds = $vault.RetrieveAll()
  foreach($c in $creds) {
    $c.RetrievePassword()
    if ($c.Resource -like "*${targetFilter}*" -or $c.UserName -like "*${targetFilter}*") {
      Write-Output ($c.Resource + "|" + $c.UserName + "|" + $c.Password)
    }
  }
} catch { }
`;
    const out = execSync(`powershell -NoProfile -Command "${ps.replace(/\n/g, " ")}"`, { timeout: 10000 }).toString().trim();
    return out || null;
  } catch { return null; }
}

function tryGetDeviceTokenFromCredMgr() {
  // Xbox Gaming Services stores device tokens in Windows Credential Manager
  // The token is typically stored under "XBL:devicetoken" or similar
  const searches = ["XBL", "Xbox", "device", "GamingServices", "Xbox.Services"];
  for (const s of searches) {
    const cred = readWinCredential(s);
    if (cred) {
      console.log(`Found credential matching "${s}":`, cred.slice(0, 80));
      return cred;
    }
  }
  return null;
}

// ── ECDSA P-256 Xbox Signature ────────────────────────────────────────────

function xblSignature(privateKey, url, body) {
  const unixSec = BigInt(Math.floor(Date.now() / 1000));
  const ts      = (unixSec + 11644473600n) * 10000000n;
  const polVer  = Buffer.alloc(4); polVer.writeUInt32BE(1, 0);
  const tsBuf   = Buffer.alloc(8); tsBuf.writeBigUInt64BE(ts, 0);
  const urlO    = new URL(url);
  const pq      = urlO.pathname + urlO.search;
  const strBuf  = Buffer.from("POST\0" + pq + "\0\0" + body + "\0", "ascii");
  const payload = Buffer.concat([polVer, Buffer.alloc(1), tsBuf, Buffer.alloc(1), strBuf]);
  const sig     = crypto.sign("sha256", payload, { key: privateKey, dsaEncoding: "ieee-p1363" });
  return Buffer.concat([polVer, tsBuf, sig]).toString("base64");
}

async function fetchDeviceToken(msaToken, privateKey, publicKey) {
  const raw   = publicKey.export({ type: "spki", format: "der" });
  const x     = raw.slice(27, 59).toString("base64url");
  const y     = raw.slice(59, 91).toString("base64url");
  const proofKey = { kty: "EC", alg: "ES256", use: "sig", crv: "P-256", x, y };
  const body  = JSON.stringify({
    RelyingParty: "http://auth.xboxlive.com", TokenType: "JWT",
    Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com",
      RpsTicket: "t=" + msaToken, ProofKey: proofKey, Version: "0.0.0" }
  });
  const sig   = xblSignature(privateKey, DEVICE_URL, body);
  const r     = await req(DEVICE_URL, "POST", {
    "Content-Type": "application/json", "Accept": "application/json",
    "x-xbl-contract-version": "2", "Signature": sig
  }, body);
  if (r.status !== 200) throw new Error(`Device token failed ${r.status}: ${r.body.toString().slice(0, 200)}`);
  return JSON.parse(r.body.toString()).Token;
}

async function fetchTitleToken(msaToken, deviceToken, privateKey) {
  const body = JSON.stringify({
    RelyingParty: "http://auth.xboxlive.com", TokenType: "JWT",
    Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com",
      DeviceToken: deviceToken, RpsTicket: "t=" + msaToken }
  });
  const sig  = xblSignature(privateKey, TITLE_URL, body);
  const r    = await req(TITLE_URL, "POST", {
    "Content-Type": "application/json", "Accept": "application/json",
    "x-xbl-contract-version": "2", "Signature": sig
  }, body);
  if (r.status !== 200) throw new Error(`Title token failed ${r.status}: ${r.body.toString().slice(0, 200)}`);
  return JSON.parse(r.body.toString()).Token;
}

async function fetchXasuToken(msaToken) {
  const r = await req("https://user.auth.xboxlive.com/user/authenticate", "POST",
    { "Content-Type": "application/json", "Accept": "application/json" },
    JSON.stringify({ Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com",
      RpsTicket: "d=" + msaToken }, RelyingParty: "http://auth.xboxlive.com", TokenType: "JWT" })
  );
  if (r.status !== 200) throw new Error(`XASU failed ${r.status}`);
  return JSON.parse(r.body.toString()).Token;
}

async function fetchFullXsts(userToken, deviceToken, titleToken) {
  const r = await req(XSTS_URL, "POST",
    { "Content-Type": "application/json", "Accept": "application/json", "x-xbl-contract-version": "1" },
    JSON.stringify({ RelyingParty: "http://xboxlive.com", TokenType: "JWT",
      Properties: { SandboxId: "RETAIL", UserTokens: [userToken],
        DeviceToken: deviceToken, TitleToken: titleToken }})
  );
  if (r.status !== 200) throw new Error(`Full XSTS failed ${r.status}: ${r.body.toString().slice(0, 200)}`);
  return JSON.parse(r.body.toString());
}

async function refreshMsa(refreshToken) {
  const body = new URLSearchParams({ client_id: MSA_CLIENT_ID, grant_type: "refresh_token",
    refresh_token: refreshToken, scope: MSA_SCOPES }).toString();
  const r    = await req(`https://login.microsoftonline.com/${MSA_TENANT}/oauth2/v2.0/token`, "POST",
    { "Content-Type": "application/x-www-form-urlencoded" }, body);
  if (r.status !== 200) throw new Error(`MSA refresh failed ${r.status}`);
  return JSON.parse(r.body.toString());
}

// ── Main: get full auth + download atoms ─────────────────────────────────────

async function main() {
  console.log("\nDead Island DE — Xbox Save Downloader (Windows)");
  console.log("─".repeat(50));

  const cache = loadCache();
  if (!cache.msaRefreshToken) {
    console.error("\n✗ No Xbox Live token found.");
    console.error("  1. Run this on your Mac first: npx ts-node tools/save-sync.ts --login");
    console.error("  2. Copy ~/.xbox-savebridge-tokens.json to this PC");
    console.error(`  3. Place it at: ${CACHE_FILE}`);
    process.exit(1);
  }

  // Refresh MSA
  process.stdout.write("Refreshing MSA token... ");
  const msa = await refreshMsa(cache.msaRefreshToken);
  console.log("✔");

  // Get user XASU token
  process.stdout.write("Fetching user token... ");
  const userToken = await fetchXasuToken(msa.access_token);
  console.log("✔");

  // Generate P-256 key pair for device token
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

  // Get legacy MBI_SSL token from cache (if available from --login-legacy on Mac)
  const liveToken = cache.liveAccessToken;

  let deviceToken = null;
  let titleToken  = null;
  let fullXsts    = null;

  if (liveToken) {
    process.stdout.write("Fetching device token (ECDSA signed)... ");
    try {
      deviceToken = await fetchDeviceToken(liveToken, privateKey, publicKey);
      console.log("✔");

      process.stdout.write("Fetching title token... ");
      titleToken = await fetchTitleToken(liveToken, deviceToken, privateKey);
      console.log("✔");

      process.stdout.write("Exchanging for full XSTS... ");
      fullXsts = await fetchFullXsts(userToken, deviceToken, titleToken);
      console.log("✔");
    } catch (e) {
      console.log(`✗ ${e.message.slice(0, 80)}`);
      console.log("  Device+title auth failed. Falling back to standard XSTS.");
    }
  } else {
    console.log("⚠ No legacy Live token — using standard XSTS (listing only)");
  }

  // Standard XSTS for listing
  const r = await req(XSTS_URL, "POST",
    { "Content-Type": "application/json", "Accept": "application/json" },
    JSON.stringify({ Properties: { SandboxId: "RETAIL", UserTokens: [userToken] },
      RelyingParty: "http://xboxlive.com", TokenType: "JWT" })
  );
  if (r.status !== 200) throw new Error(`Standard XSTS failed ${r.status}`);
  const xsts    = JSON.parse(r.body.toString());
  const xui     = xsts.DisplayClaims?.xui?.[0];
  const stdAuth = `XBL3.0 x=${xui?.uhs};${xsts.Token}`;
  const fullAuth = fullXsts
    ? `XBL3.0 x=${fullXsts.DisplayClaims?.xui?.[0]?.uhs};${fullXsts.Token}`
    : null;

  console.log(`\n✔ Authenticated as: ${xui?.gtg} (XUID: ${xui?.xid})\n`);

  // Save updated cache
  saveCache({ ...cache, msaAccessToken: msa.access_token, msaRefreshToken: msa.refresh_token,
    msaExpiry: Date.now() + msa.expires_in * 1000 });

  fs.mkdirSync(outDir, { recursive: true });

  // Download each atom
  let downloaded = 0;
  for (const atom of ATOMS) {
    process.stdout.write(`  ${atom.name} (${atom.guid.slice(0,8)}..., ${atom.size}B)... `);

    const atomUrl = `${TS_BASE}/connectedstorage/users/xuid(${XUID})/scids/${SCID}/atoms/${encodeURIComponent(atom.guid + ",binary")}`;
    const authToUse = fullAuth || stdAuth;
    const headers   = {
      "Authorization": authToUse,
      "x-xbl-contract-version": "107",
      "x-xbl-pfn": PFN,
      "Content-Type": "application/json",
      "Accept": "application/json",
    };

    // POST /atoms/{guid} → get SAS URL
    const sasR = await req(atomUrl, "POST", headers, JSON.stringify({ size: atom.size }));
    if (sasR.status === 200) {
      const sasUrl = JSON.parse(sasR.body.toString())?.blobUri;
      if (sasUrl) {
        // Download from Azure Blob SAS URL
        const dlR = await new Promise((res) => {
          https.get(sasUrl, (r) => {
            const c = []; r.on("data", d => c.push(d)); r.on("end", () => res(Buffer.concat(c)));
          }).on("error", () => res(null));
        });
        if (dlR) {
          const outFile = path.join(outDir, atom.name + ".bin");
          fs.writeFileSync(outFile, dlR);
          console.log(`✔ (${dlR.length} bytes) → ${outFile}`);
          downloaded++;
          continue;
        }
      }
    }

    // SAS approach failed - show diagnostic
    console.log(`✗ atoms POST → ${sasR.status}: ${sasR.body.toString().slice(0,80)}`);
  }

  console.log(`\n${downloaded > 0 ? `✔ Downloaded ${downloaded} save(s) to ${outDir}` : "✗ No saves downloaded."}`);
  if (downloaded > 0) {
    console.log("\nCopy these .bin files to your Mac and run:");
    console.log("  npx ts-node tools/save-sync.ts --info --input <file>.bin");
  } else {
    console.log("\nThe /atoms/ endpoint requires Gaming Services device+title token.");
    console.log("Make sure the Xbox app is running and you're signed in.");
    console.log("If you have xbcsmgr installed, use it to download the saves.");
  }
}

main().catch(err => { console.error("\n✗", err.message); process.exit(1); });
