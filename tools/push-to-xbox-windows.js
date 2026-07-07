#!/usr/bin/env node
// tools/push-to-xbox-windows.js
// ─────────────────────────────────────────────────────────────────────────────
// Dead Island DE — Windows Push Helper
//
// Reads Xbox Live tokens from Windows Credential Manager (put there by the
// Xbox app / Gaming Services) and uploads an edited save to Xbox Live.
//
// REQUIREMENTS:
//   - Windows 10/11 with Xbox app installed and signed in
//   - Node.js 18+ (download from https://nodejs.org)
//   - The Xbox app must have synced your Dead Island saves at least once
//
// USAGE (run this on your Windows PC):
//   node push-to-xbox-windows.js --input save_1.sav_edited.bin
//   node push-to-xbox-windows.js --input save_1.sav_edited.bin --manifest save_1.sav_manifest.json
//   node push-to-xbox-windows.js --list-saves        # list your current saves from Xbox Live
//   node push-to-xbox-windows.js --dry-run --input save_1.sav_edited.bin
//
// HOW TO USE:
//   1. On your Mac, edit and download the save:
//      npx ts-node tools/save-sync.ts --cs-pull --out ./saves --full
//      npx ts-node tools/save-sync.ts --edit --input ./saves/save_1.sav.bin \
//        --money 9999999 --level 60 --max-durability --unlock-collectibles --clear-fog
//
//   2. Copy save_1.sav_edited.bin + save_1.sav_manifest.json to your Windows PC
//
//   3. On Windows, open PowerShell and run:
//      node push-to-xbox-windows.js --input save_1.sav_edited.bin
//
//   4. Launch Dead Island DE on Xbox and load the save
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

const https         = require("https");
const http          = require("http");
const fs            = require("fs");
const path          = require("path");
const crypto        = require("crypto");
const os            = require("os");
const { execSync }  = require("child_process");
const zlib          = require("zlib");

// ── Constants ──────────────────────────────────────────────────────────────────
const SCID = "db860100-d780-4e17-8685-ad130052ea64";
const PFN  = "DeepSilver.DeadIslandDefinitiveEdition_hmv7qcest37me";
const TS   = "https://titlestorage.xboxlive.com";

// ── Argument parsing ───────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const getArg     = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const hasFlag    = (f) => args.includes(f);
const INPUT      = getArg("--input");
const MANIFEST   = getArg("--manifest");
const DRY_RUN    = hasFlag("--dry-run");
const LIST_SAVES = hasFlag("--list-saves");

// ── HTTP helper ────────────────────────────────────────────────────────────────
function httpsReq(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const lib  = u.protocol === "https:" ? https : http;
    const opts = {
      hostname: u.hostname, port: u.port ? parseInt(u.port) : (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: { ...headers, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}) },
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks), body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : body);
    req.end();
  });
}

// ── ECDSA P-256 signature (Xbox Live Signature header) ─────────────────────────
function xblSign(privateKey, url, authToken, bodyStr) {
  const unixSec  = BigInt(Math.floor(Date.now() / 1000));
  const ticks    = (unixSec + 11644473600n) * 10000000n;
  const polVer   = Buffer.alloc(4); polVer.writeUInt32BE(1, 0);
  const tsBuf    = Buffer.alloc(8); tsBuf.writeBigUInt64BE(ticks, 0);
  const u        = new URL(url);
  const strPart  = `POST\0${u.pathname}${u.search}\0${authToken}\0${bodyStr}\0`;
  const payload  = Buffer.concat([polVer, Buffer.alloc(1), tsBuf, Buffer.alloc(1), Buffer.from(strPart, "ascii")]);
  const sig      = crypto.sign("sha256", payload, { key: privateKey, dsaEncoding: "ieee-p1363" });
  return Buffer.concat([polVer, tsBuf, sig]).toString("base64");
}

async function signedPost(url, body, authToken, privateKey, extraHeaders = {}) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const sig     = xblSign(privateKey, url, authToken, bodyStr);
  return httpsReq(url, "POST", {
    "Content-Type": "application/json", "Accept": "application/json",
    "x-xbl-contract-version": "2", "Signature": sig, ...extraHeaders,
  }, bodyStr);
}

// ── Windows Credential Manager reader ─────────────────────────────────────────
// Uses PowerShell to enumerate Windows Credential Manager entries.
// The Xbox app / Gaming Services stores device + user tokens under keys like:
//   Xbl|S-1-15-2-...|...Dtoken   (device token)
//   Xbl|S-1-15-2-...|...Utoken   (user token)
function readWindowsCredentials() {
  if (os.platform() !== "win32") {
    throw new Error("This script must run on Windows — it reads Xbox tokens from Windows Credential Manager.");
  }

  console.log("  Reading Xbox tokens from Windows Credential Manager...");
  const ps = `
[void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials.PasswordVault, ContentType=WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault
try {
  $creds = $vault.RetrieveAll()
  $result = @()
  foreach ($c in $creds) {
    if ($c.Resource -like '*Xbl*') {
      $c.RetrievePassword()
      $result += [PSCustomObject]@{ Resource=$c.Resource; UserName=$c.UserName; Password=$c.Password }
    }
  }
  $result | ConvertTo-Json -Depth 3
} catch { Write-Output '[]' }
`;

  let output;
  try {
    output = execSync(`powershell -NoProfile -Command "${ps.replace(/\n/g, " ").replace(/"/g, '\\"')}"`, {
      encoding: "utf8", timeout: 10000,
    });
  } catch {
    // Fallback: try advapi32 via cmdkey
    output = "[]";
  }

  let parsed = [];
  try { parsed = JSON.parse(output.trim() || "[]"); } catch { parsed = []; }
  if (!Array.isArray(parsed)) parsed = [parsed];
  return parsed;
}

// ── Alternative: dump wincred via cmdkey + PowerShell advapi32 ────────────────
function readWincredTokens() {
  if (os.platform() !== "win32") {
    throw new Error("Windows only.");
  }

  // PowerShell script that P/Invokes advapi32 CredEnumerateW  
  const ps = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
public class WinCred {
  [DllImport("advapi32", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredEnumerate(string filter, int flag, out int count, out IntPtr creds);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type;
    public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  public static List<string[]> Enumerate() {
    int count; IntPtr p;
    var result = new List<string[]>();
    if (!CredEnumerate(null, 0, out count, out p)) return result;
    for (int i = 0; i < count; i++) {
      var credPtr = Marshal.ReadIntPtr(p, i * Marshal.SizeOf(typeof(IntPtr)));
      var c = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
      var name = Marshal.PtrToStringUni(c.TargetName) ?? "";
      if (!name.Contains("Xbl")) continue;
      if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize == 0) continue;
      var blob = Marshal.PtrToStringAnsi(c.CredentialBlob) ?? "";
      result.Add(new string[]{ name, blob });
    }
    return result;
  }
}
"@ -Language CSharp
$items = [WinCred]::Enumerate()
$out = @()
foreach ($item in $items) { $out += [PSCustomObject]@{ name=$item[0]; blob=$item[1] } }
$out | ConvertTo-Json -Depth 2
`;

  try {
    const output = execSync(`powershell -NoProfile -Command "${ps.replace(/[\r\n]+/g, " ").replace(/"/g, '\\"')}"`, {
      encoding: "utf8", timeout: 15000, windowsHide: true,
    });
    let parsed = [];
    try { parsed = JSON.parse(output.trim() || "[]"); } catch { parsed = []; }
    if (!Array.isArray(parsed)) parsed = [parsed];
    return parsed;
  } catch (e) {
    console.warn("  Warning: Could not read wincred via advapi32:", e.message);
    return [];
  }
}

// ── Parse Xbox token from wincred blob ────────────────────────────────────────
function parseXblToken(blob) {
  // Format: JSON with TokenData.Token field (may have trailing 'X')
  try {
    const fixed   = blob.trimEnd().replace(/X+$/, "");
    const parsed  = JSON.parse(fixed);
    const td      = parsed.TokenData ?? parsed;
    const expiry  = td.NotAfter ? new Date(td.NotAfter).getTime() : 0;
    return { token: td.Token ?? td.token, expiry };
  } catch { return null; }
}

// ── Authenticate using Windows Credential Manager tokens ──────────────────────
async function authenticateFromWincred() {
  const creds = readWincredTokens();

  if (creds.length === 0) {
    throw new Error(
      "No Xbox tokens found in Windows Credential Manager.\n" +
      "Make sure the Xbox app is installed and you're signed in.\n" +
      "Also launch Dead Island DE at least once to sync saves."
    );
  }

  console.log(`  Found ${creds.length} Xbl credential(s) in Windows Credential Manager`);

  let deviceToken = null;
  let userToken   = null;
  const now       = Date.now();

  for (const cred of creds) {
    const t = parseXblToken(cred.blob);
    if (!t || !t.token) continue;
    if (t.expiry && t.expiry < now) {
      console.log(`    (skipping expired token: ${cred.name.slice(0, 60)})`);
      continue;
    }
    if (cred.name.includes("Dtoken") || cred.name.toLowerCase().includes("device")) {
      deviceToken = t.token;
      console.log(`  ✔ Device token found (${cred.name.slice(0, 60)}...)`);
    } else if (cred.name.includes("Utoken") || cred.name.toLowerCase().includes("user")) {
      // Skip the dummy all-A token
      if (t.token === "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") continue;
      userToken = t.token;
      console.log(`  ✔ User token found (${cred.name.slice(0, 60)}...)`);
    }
  }

  if (!deviceToken) {
    throw new Error(
      "No Xbox device token (Dtoken) found in Windows Credential Manager.\n" +
      "This token is created by Gaming Services when you sign in to Xbox app.\n" +
      "Make sure you:\n" +
      "  1. Have the Xbox app installed (from Microsoft Store)\n" +
      "  2. Are signed in with the same Microsoft account as your Xbox\n" +
      "  3. Have launched a game at least once while signed in\n" +
      "\n" +
      "If you just installed the Xbox app, sign out and sign back in,\n" +
      "then launch Dead Island DE and let it sync before running this script."
    );
  }

  if (!userToken) {
    throw new Error(
      "No Xbox user token (Utoken) found in Windows Credential Manager.\n" +
      "Please sign in to the Xbox app and try again."
    );
  }

  // Generate ECDSA key pair for XSTS signing
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

  // Exchange user + device tokens for XSTS
  console.log("  Exchanging tokens for XSTS...");
  const xstsBody = JSON.stringify({
    RelyingParty: "http://xboxlive.com",
    TokenType: "JWT",
    Properties: {
      SandboxId: "RETAIL",
      UserTokens: [userToken],
      DeviceToken: deviceToken,
    },
  });
  const sig = xblSign(privateKey, "https://xsts.auth.xboxlive.com/xsts/authorize", "", xstsBody);
  const r = await httpsReq("https://xsts.auth.xboxlive.com/xsts/authorize", "POST", {
    "Content-Type": "application/json", "Accept": "application/json",
    "x-xbl-contract-version": "1", "Signature": sig,
  }, xstsBody);

  if (r.status !== 200) {
    const xerr = (() => { try { return JSON.parse(r.body)?.XErr; } catch { return undefined; } })();
    const msgs = {
      "2148916233": "No Xbox profile — go to xbox.com and create one",
      "2148916238": "Child account — needs family consent",
    };
    throw new Error(`XSTS failed ${r.status}: ${msgs[String(xerr)] ?? r.body.slice(0, 200)}`);
  }

  const xsts = JSON.parse(r.body);
  const xui  = xsts.DisplayClaims?.xui?.[0];
  const fullHeader = `XBL3.0 x=${xui?.uhs};${xsts.Token}`;
  const xuid = xui?.xid ?? "";

  console.log(`  ✔ XSTS obtained — Gamertag: ${xui?.gtg ?? "?"} (XUID: ${xuid})`);
  return { fullHeader, xuid, privateKey };
}

// ── Upload pipeline ────────────────────────────────────────────────────────────
async function uploadAtom(fullHeader, xuid, data, saveName, atomName) {
  const newAtomUuid  = crypto.randomUUID().toUpperCase();
  const BLOCK_SIZE   = 4 * 1024 * 1024; // 4 MB max (xbcsmgr default)

  // Phase 1: GetBlobUri — POST /atoms/{uuid} (plain UUID, no ,binary)
  process.stdout.write(`  [1/4] Requesting upload slot (atom ${newAtomUuid.slice(0, 8)}...)... `);
  const blobUriUrl = `${TS}/connectedstorage/users/xuid(${xuid})/scids/${SCID}/atoms/${encodeURIComponent(newAtomUuid)}`;
  const p1 = await httpsReq(blobUriUrl, "POST", {
    "Authorization": fullHeader, "x-xbl-contract-version": "107",
    "Content-Type": "application/json", "Accept": "application/json", "x-xbl-pfn": PFN,
  }, `{size: ${data.length}}`);
  if (p1.status !== 200 && p1.status !== 201) {
    throw new Error(`GetBlobUri failed ${p1.status}: ${p1.body.slice(0, 300)}`);
  }
  const blobUri = (JSON.parse(p1.body)).BlobUri ?? JSON.parse(p1.body).blobUri;
  if (!blobUri) throw new Error(`No BlobUri in response: ${p1.body.slice(0, 200)}`);
  console.log(`✔`);
  console.log(`      SAS URL: ${blobUri.slice(0, 80)}...`);

  // Phase 2: upload blocks to Azure
  const blockIds    = [];
  const totalBlocks = Math.ceil(data.length / BLOCK_SIZE);
  for (let i = 0; i < totalBlocks; i++) {
    const chunk = data.slice(i * BLOCK_SIZE, Math.min((i + 1) * BLOCK_SIZE, data.length));
    // blockId = BitConverter.GetBytes(int) → base64 (4-byte LE)
    const idBuf = Buffer.allocUnsafe(4); idBuf.writeInt32LE(i, 0);
    const blockId = idBuf.toString("base64");
    blockIds.push(blockId);

    // Insert comp=block&blockId=... right after '?' in the SAS URL
    const qIdx     = blobUri.indexOf("?");
    const blockUrl = qIdx === -1
      ? blobUri + `?comp=block&blockId=${encodeURIComponent(blockId)}`
      : blobUri.slice(0, qIdx + 1) + `comp=block&blockId=${encodeURIComponent(blockId)}&` + blobUri.slice(qIdx + 1);

    process.stdout.write(`  [2/4] Uploading block ${i + 1}/${totalBlocks} (${chunk.length.toLocaleString()} B)... `);
    const p2 = await httpsReq(blockUrl, "PUT", {
      "Content-Length": chunk.length, "Content-Type": "application/octet-stream",
      "Connection": "Keep-Alive", "x-ms-blob-type": "BlockBlob",
    }, chunk);
    if (p2.status < 200 || p2.status >= 300) {
      throw new Error(`Block upload failed ${p2.status}: ${p2.body.slice(0, 200)}`);
    }
    console.log(`✔`);
  }

  // Phase 3: CommitAtom — POST /atoms/{uuid}?commit=true (plain UUID, no ,binary)
  process.stdout.write(`  [3/4] Committing atom... `);
  const commitUrl  = `${TS}/connectedstorage/users/xuid(${xuid})/scids/${SCID}/atoms/${encodeURIComponent(newAtomUuid)}?commit=true`;
  const commitBody = JSON.stringify({ BlockIds: blockIds, Size: data.length });
  const p3 = await httpsReq(commitUrl, "POST", {
    "Authorization": fullHeader, "x-xbl-contract-version": "107",
    "Content-Type": "application/json", "Accept": "application/json", "x-xbl-pfn": PFN,
  }, commitBody);
  if (p3.status !== 200 && p3.status !== 201 && p3.status !== 204) {
    throw new Error(`CommitAtom failed ${p3.status}: ${p3.body.slice(0, 300)}`);
  }
  console.log(`✔`);

  // Phase 4: UpdateBlob — POST /savedgames/{name}?clientFileTime=...&displayName={name}
  process.stdout.write(`  [4/4] Updating savedgame manifest... `);
  const clientFileTime = new Date().toISOString().replace(/(\.\d{3})Z$/, ".0000000+00:00");
  const updateUrl  = `${TS}/connectedstorage/users/xuid(${xuid})/scids/${SCID}/savedgames/${encodeURIComponent(saveName)}?clientFileTime=${encodeURIComponent(clientFileTime)}&displayName=${encodeURIComponent(saveName)}`;
  const updateBody = JSON.stringify({ Atoms: [{ Name: atomName, Atom: newAtomUuid + ",binary" }] });
  const p4 = await httpsReq(updateUrl, "POST", {
    "Authorization": fullHeader, "x-xbl-contract-version": "107",
    "Content-Type": "application/json", "Accept": "application/json", "x-xbl-pfn": PFN,
  }, updateBody);
  if (p4.status !== 200 && p4.status !== 201 && p4.status !== 204) {
    throw new Error(`UpdateSavedGame failed ${p4.status}: ${p4.body.slice(0, 300)}`);
  }
  console.log(`✔`);

  return newAtomUuid;
}

// ── List current saves ─────────────────────────────────────────────────────────
async function cmdListSaves() {
  console.log("\n  Dead Island DE — List Saves from Xbox Live");
  console.log("  " + "─".repeat(42));
  console.log("  Reading Windows Credential Manager tokens...");
  const { fullHeader, xuid } = await authenticateFromWincred();

  const url = `${TS}/connectedstorage/users/xuid(${xuid})/scids/${SCID}?maxItems=50`;
  const r = await httpsReq(url, "GET", {
    "Authorization": fullHeader, "x-xbl-contract-version": "107", "x-xbl-pfn": PFN,
  });
  if (r.status !== 200) throw new Error(`List saves failed ${r.status}: ${r.body.slice(0, 200)}`);
  const data = JSON.parse(r.body);
  const blobs = data.blobs ?? [];
  console.log(`\n  Found ${blobs.length} save slot(s):\n`);
  for (const b of blobs) {
    const sz = b.size ? `${(b.size / 1024).toFixed(1)} KB` : "?";
    const dt = b.clientFileTime ? `  [${b.clientFileTime.slice(0, 10)}]` : "";
    console.log(`    ${b.fileName ?? b.displayName ?? "(unnamed)"}  ${sz}${dt}`);
  }
}

// ── Main push command ──────────────────────────────────────────────────────────
async function cmdPush() {
  if (!INPUT) {
    console.error("Usage: node push-to-xbox-windows.js --input <edited.bin> [--manifest <manifest.json>] [--dry-run]");
    process.exit(1);
  }

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║   Dead Island DE — Push Edited Save to Xbox Live (Windows)  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`  Input   : ${INPUT}`);
  if (DRY_RUN) console.log(`  DRY RUN : will not actually upload\n`);

  // Read and validate save file
  if (!fs.existsSync(INPUT)) { console.error(`✗ File not found: ${INPUT}`); process.exit(1); }
  const rawBytes  = fs.readFileSync(INPUT);
  const isGzipped = rawBytes[0] === 0x1f && rawBytes[1] === 0x8b;

  let uploadBytes;
  if (isGzipped) {
    console.log(`  Format  : gzip-compressed (${rawBytes.length.toLocaleString()} bytes)`);
    uploadBytes = rawBytes;
  } else {
    console.log(`  Format  : decompressed — re-compressing...`);
    uploadBytes = zlib.gzipSync(rawBytes, { level: 9 });
    console.log(`  Re-gzip : ${rawBytes.length.toLocaleString()} → ${uploadBytes.length.toLocaleString()} bytes`);
  }

  // Resolve manifest
  let manifestPath = MANIFEST;
  if (!manifestPath) {
    const base       = path.basename(INPUT).replace(/_edited/gi, "").replace(/_dec/gi, "").replace(/\.bin$/i, "");
    const candidates = [
      path.join(path.dirname(INPUT), base + "_manifest.json"),
      path.join(path.dirname(INPUT), base + ".sav_manifest.json"),
    ];
    for (const c of candidates) { if (fs.existsSync(c)) { manifestPath = c; break; } }
    if (!manifestPath) {
      console.error(`\n✗ Could not auto-detect manifest. Tried:\n${candidates.map(c => "    " + c).join("\n")}`);
      console.error(`  Pass --manifest <path> explicitly.`);
      process.exit(1);
    }
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const atoms    = manifest.atoms ?? [];
  if (atoms.length === 0) { console.error(`✗ Manifest has no atoms: ${manifestPath}`); process.exit(1); }

  const saveName  = path.basename(manifestPath).replace(/_manifest\.json$/i, "");
  const atomName  = atoms[0].name;

  console.log(`  Manifest: ${manifestPath}`);
  console.log(`  SaveName: ${saveName}`);
  console.log(`  Old GUID: ${atoms[0].atom}  (${atoms[0].size} B)`);
  console.log(`  New size: ${uploadBytes.length.toLocaleString()} bytes`);

  if (DRY_RUN) {
    console.log(`\n  ✔ Dry run — would upload ${uploadBytes.length.toLocaleString()} bytes`);
    console.log(`    as atom "${atomName}" into save slot "${saveName}"`);
    return;
  }

  // Authenticate
  console.log("\n  Authenticating from Windows Credential Manager...");
  const { fullHeader, xuid } = await authenticateFromWincred();

  // Upload
  console.log(`\n  Uploading via 4-phase pipeline...`);
  const newGuid = await uploadAtom(fullHeader, xuid, uploadBytes, saveName, atomName);

  // Update manifest
  const updated = { atoms: [{ name: atomName, atom: newGuid, size: uploadBytes.length }] };
  fs.writeFileSync(manifestPath, JSON.stringify(updated, null, 2));

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  ✔  Save pushed to Xbox Live successfully!                   ║
╚══════════════════════════════════════════════════════════════╝

  Old GUID : ${atoms[0].atom}
  New GUID : ${newGuid}
  Size     : ${uploadBytes.length.toLocaleString()} bytes

  ★  Launch Dead Island DE on your Xbox and load the save.
     The game syncs from cloud automatically on startup.
`);
}

// ── Entry point ────────────────────────────────────────────────────────────────
async function main() {
  if (LIST_SAVES) { await cmdListSaves(); return; }
  await cmdPush();
}

main().catch((e) => {
  console.error(`\n✗ Error: ${e.message}`);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
