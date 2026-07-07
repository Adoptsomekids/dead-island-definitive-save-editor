#!/usr/bin/env node
// tools/push-to-xbox-windows.js
// ─────────────────────────────────────────────────────────────────────────────
// Dead Island DE — Windows Push Helper
//
// Reads Xbox Live tokens from Windows Credential Manager (stored by the Xbox
// app / Gaming Services) and uploads an edited save back to Xbox Live.
//
// REQUIREMENTS:
//   - Windows 10/11 with Xbox app installed and signed in
//   - Node.js 18+ (https://nodejs.org)
//   - Must have launched Dead Island DE on Xbox at least once to sync saves
//
// USAGE (run in PowerShell or CMD on your Windows PC):
//   node tools\push-to-xbox-windows.js --list-saves
//   node tools\push-to-xbox-windows.js --input saves\save_1.sav_edited.bin --dry-run
//   node tools\push-to-xbox-windows.js --input saves\save_1.sav_edited.bin
//
// FULL WORKFLOW:
//   1. On Mac — download + edit:
//      npx ts-node tools/save-sync.ts --cs-pull --out ./saves --full
//      npx ts-node tools/save-sync.ts --edit --input ./saves/save_1.sav.bin \
//        --money 9999999 --level 60 --max-durability --unlock-collectibles --clear-fog
//
//   2. Copy saves\save_1.sav_edited.bin + saves\save_1.sav_manifest.json to Windows
//      (or just git pull this repo on Windows — all files are included)
//
//   3. On Windows — push back to Xbox Live:
//      node tools\push-to-xbox-windows.js --input saves\save_1.sav_edited.bin
//
//   4. Launch Dead Island DE on Xbox → load the save (cloud syncs automatically)
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

const https        = require("https");
const http         = require("http");
const fs           = require("fs");
const path         = require("path");
const crypto       = require("crypto");
const os           = require("os");
const { execSync, spawnSync } = require("child_process");
const zlib         = require("zlib");

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
const DEBUG      = hasFlag("--debug") || !!process.env.DEBUG;

// ── HTTP helper ────────────────────────────────────────────────────────────────
function httpsReq(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const lib  = u.protocol === "https:" ? https : http;
    const bodyBuf = body instanceof Buffer ? body : (body ? Buffer.from(body) : undefined);
    const opts = {
      hostname: u.hostname,
      port: u.port ? parseInt(u.port) : (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: { ...headers, ...(bodyBuf ? { "Content-Length": bodyBuf.length } : {}) },
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        raw: Buffer.concat(chunks),
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── ECDSA P-256 Xbox Live Signature ───────────────────────────────────────────
function xblSign(privateKey, url, authToken, bodyStr) {
  const unixSec = BigInt(Math.floor(Date.now() / 1000));
  const ticks   = (unixSec + 11644473600n) * 10000000n;
  const polVer  = Buffer.alloc(4); polVer.writeUInt32BE(1, 0);
  const tsBuf   = Buffer.alloc(8); tsBuf.writeBigUInt64BE(ticks, 0);
  const u       = new URL(url);
  const strPart = `POST\0${u.pathname}${u.search}\0${authToken}\0${bodyStr}\0`;
  const payload = Buffer.concat([polVer, Buffer.alloc(1), tsBuf, Buffer.alloc(1), Buffer.from(strPart, "ascii")]);
  const sig     = crypto.sign("sha256", payload, { key: privateKey, dsaEncoding: "ieee-p1363" });
  return Buffer.concat([polVer, tsBuf, sig]).toString("base64");
}

// ── Windows Credential Manager — write PS1 to temp file, execute with -File ───
// This avoids ALL quote-escaping issues with inline -Command execution.
function runPowershellScript(scriptContent) {
  const tmpFile = path.join(os.tmpdir(), `di_wincred_${Date.now()}.ps1`);
  try {
    // Write UTF-8 with BOM (PowerShell prefers BOM for UTF-8 files)
    fs.writeFileSync(tmpFile, "\ufeff" + scriptContent, "utf8");
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",   // ← bypass script restrictions for this one file
      "-File", tmpFile,
    ], { encoding: "utf8", timeout: 20000, windowsHide: true });
    if (DEBUG && result.stderr) process.stderr.write("PS stderr: " + result.stderr + "\n");
    return (result.stdout ?? "").trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function readWincredTokens() {
  if (os.platform() !== "win32") {
    throw new Error("This script must run on Windows — it reads Xbox tokens from Windows Credential Manager.");
  }

  // PowerShell script that uses P/Invoke to call advapi32 CredEnumerateW
  // Written to a temp .ps1 file to avoid all quote-escaping problems
  const ps1 = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
public class WinCred2 {
  [DllImport("advapi32", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredEnumerate(string filter, int flag, out int count, out IntPtr creds);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }
  public static List<string[]> Enumerate() {
    int count;
    IntPtr p;
    var result = new List<string[]>();
    if (!CredEnumerate(null, 0, out count, out p)) return result;
    for (int i = 0; i < count; i++) {
      IntPtr credPtr = Marshal.ReadIntPtr(p, i * IntPtr.Size);
      var c = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
      string name = Marshal.PtrToStringUni(c.TargetName) ?? "";
      if (!name.Contains("Xbl")) continue;
      if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize == 0) continue;
      byte[] blobBytes = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, blobBytes, 0, (int)c.CredentialBlobSize);
      string blob = Encoding.Unicode.GetString(blobBytes);
      result.Add(new string[]{ name, blob });
    }
    return result;
  }
}
'@ -Language CSharp

$items = [WinCred2]::Enumerate()
$out = @()
foreach ($item in $items) {
  $out += [PSCustomObject]@{ name = $item[0]; blob = $item[1] }
}
if ($out.Count -eq 0) {
  Write-Output "[]"
} else {
  $out | ConvertTo-Json -Depth 2
}
`;

  const output = runPowershellScript(ps1);
  if (DEBUG) console.log("[DEBUG] wincred raw output:", output.slice(0, 500));

  if (!output || output === "[]") return [];
  try {
    let parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) parsed = [parsed];
    return parsed;
  } catch (e) {
    if (DEBUG) console.error("[DEBUG] JSON parse error:", e.message, "\nOutput:", output.slice(0, 500));
    return [];
  }
}

// ── Parse Xbox token JSON from wincred blob ────────────────────────────────────
function parseXblToken(blob) {
  try {
    // May have trailing 'X' characters — strip them
    const fixed  = (blob ?? "").trimEnd().replace(/X+$/, "").trim();
    if (!fixed || fixed === "null") return null;
    const parsed = JSON.parse(fixed);
    const td     = parsed.TokenData ?? parsed;
    const token  = td.Token ?? td.token ?? null;
    if (!token) return null;
    const expiry = td.NotAfter ? new Date(td.NotAfter).getTime() : Date.now() + 3600_000;
    return { token, expiry };
  } catch { return null; }
}

// ── Authenticate using Windows Credential Manager tokens ──────────────────────
async function authenticateFromWincred() {
  console.log("  Reading Xbox tokens from Windows Credential Manager...");
  const creds = readWincredTokens();

  if (DEBUG) {
    console.log(`  [DEBUG] Found ${creds.length} Xbl credential(s)`);
    for (const c of creds) console.log(`  [DEBUG]   ${c.name}`);
  }

  if (creds.length === 0) {
    throw new Error(
      "No Xbox tokens found in Windows Credential Manager.\n\n" +
      "FIX: Make sure ALL of the following are true:\n" +
      "  1. Xbox app is installed (from Microsoft Store)\n" +
      "  2. You are signed in to the Xbox app with account 'Adopted Kz'\n" +
      "  3. You launched Dead Island DE from the Xbox app at least once\n" +
      "     (so Gaming Services can cache the tokens)\n\n" +
      "After doing the above, wait ~30 seconds then run this script again.\n" +
      "If still failing, run with --debug for more details."
    );
  }

  let deviceToken = null;
  let userToken   = null;
  const now       = Date.now();

  for (const cred of creds) {
    const t = parseXblToken(cred.blob);
    if (!t || !t.token) {
      if (DEBUG) console.log(`  [DEBUG]   Could not parse blob for: ${cred.name}`);
      continue;
    }
    if (t.expiry && t.expiry < now) {
      console.log(`    (expired: ${cred.name.slice(0, 70)})`);
      continue;
    }
    const nameLC = cred.name.toLowerCase();
    if (nameLC.includes("dtoken") || nameLC.includes("devicetoken")) {
      deviceToken = t.token;
      console.log(`  ✔ Device token: ${cred.name.slice(0, 70)}`);
    } else if (nameLC.includes("utoken") || nameLC.includes("usertoken")) {
      if (t.token === "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") continue;
      userToken = t.token;
      console.log(`  ✔ User token:   ${cred.name.slice(0, 70)}`);
    }
  }

  if (!deviceToken && !userToken) {
    // Dump all found names to help diagnose
    const names = creds.map(c => "    " + c.name.slice(0, 80)).join("\n");
    throw new Error(
      "Found Xbox credentials but none contain a device or user token.\n" +
      "Found credential names:\n" + names + "\n\n" +
      "The token blobs may use a different format than expected.\n" +
      "Run with --debug to see the raw output."
    );
  }

  if (!deviceToken) {
    throw new Error(
      "No Xbox device token (Dtoken) found.\n" +
      "The device token is needed to write to Xbox Connected Storage.\n" +
      "Make sure Gaming Services is installed and you're signed in to the Xbox app.\n" +
      "Try: sign out of Xbox app → sign back in → launch a game briefly → retry."
    );
  }

  if (!userToken) {
    throw new Error("No Xbox user token (Utoken) found. Sign in to the Xbox app and retry.");
  }

  // Generate key pair for signing
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

  // Exchange user + device tokens → XSTS
  console.log("  Exchanging for XSTS token...");
  const xstsBody = JSON.stringify({
    RelyingParty: "http://xboxlive.com",
    TokenType: "JWT",
    Properties: { SandboxId: "RETAIL", UserTokens: [userToken], DeviceToken: deviceToken },
  });
  const sig = xblSign(privateKey, "https://xsts.auth.xboxlive.com/xsts/authorize", "", xstsBody);
  const r   = await httpsReq("https://xsts.auth.xboxlive.com/xsts/authorize", "POST", {
    "Content-Type": "application/json", "Accept": "application/json",
    "x-xbl-contract-version": "1", "Signature": sig,
  }, xstsBody);

  if (r.status !== 200) {
    const xerr = (() => { try { return JSON.parse(r.body)?.XErr; } catch { return undefined; } })();
    const msgs = { "2148916233": "No Xbox profile at xbox.com", "2148916238": "Child account needs family consent" };
    throw new Error(`XSTS failed ${r.status}: ${msgs[String(xerr)] ?? r.body.slice(0, 300)}`);
  }

  const xsts = JSON.parse(r.body);
  const xui  = xsts.DisplayClaims?.xui?.[0];
  const xuid = xui?.xid ?? "";
  console.log(`  ✔ Authenticated: ${xui?.gtg ?? "?"} (XUID: ${xuid})`);
  return { fullHeader: `XBL3.0 x=${xui?.uhs};${xsts.Token}`, xuid };
}

// ── 4-phase upload pipeline ────────────────────────────────────────────────────
async function uploadAtom(fullHeader, xuid, data, saveName, atomName) {
  const newAtomUuid = crypto.randomUUID().toUpperCase();
  const BLOCK_SIZE  = 4 * 1024 * 1024; // 4 MB

  // Phase 1: GetBlobUri — POST /atoms/{uuid}  (plain UUID, no ",binary")
  process.stdout.write(`  [1/4] Requesting upload slot (${newAtomUuid.slice(0, 8)}...)... `);
  const p1url = `${TS}/connectedstorage/users/xuid(${xuid})/scids/${SCID}/atoms/${encodeURIComponent(newAtomUuid)}`;
  const p1 = await httpsReq(p1url, "POST", {
    "Authorization": fullHeader, "x-xbl-contract-version": "107",
    "Content-Type": "application/json", "Accept": "application/json", "x-xbl-pfn": PFN,
  }, `{size: ${data.length}}`);
  if (p1.status !== 200 && p1.status !== 201) {
    throw new Error(`GetBlobUri failed ${p1.status}: ${p1.body.slice(0, 400)}`);
  }
  const blobUri = JSON.parse(p1.body).BlobUri ?? JSON.parse(p1.body).blobUri;
  if (!blobUri) throw new Error(`No BlobUri in response: ${p1.body.slice(0, 200)}`);
  console.log(`✔`);
  if (DEBUG) console.log(`  [DEBUG] SAS URL: ${blobUri.slice(0, 100)}...`);

  // Phase 2: upload blocks to Azure (no Xbox auth — SAS token in URL)
  const blockIds    = [];
  const totalBlocks = Math.ceil(data.length / BLOCK_SIZE);
  for (let i = 0; i < totalBlocks; i++) {
    const chunk = data.slice(i * BLOCK_SIZE, Math.min((i + 1) * BLOCK_SIZE, data.length));
    // blockId = 4-byte LE int → base64 (matches C# BitConverter.GetBytes(int))
    const idBuf = Buffer.allocUnsafe(4); idBuf.writeInt32LE(i, 0);
    const blockId = idBuf.toString("base64");
    blockIds.push(blockId);

    // Insert "comp=block&blockId=X&" right after "?" in the SAS URL
    const qIdx    = blobUri.indexOf("?");
    const blockUrl = qIdx === -1
      ? blobUri + `?comp=block&blockId=${encodeURIComponent(blockId)}`
      : blobUri.slice(0, qIdx + 1) + `comp=block&blockId=${encodeURIComponent(blockId)}&` + blobUri.slice(qIdx + 1);

    process.stdout.write(`  [2/4] Uploading block ${i + 1}/${totalBlocks} (${chunk.length.toLocaleString()} B)... `);
    const p2 = await httpsReq(blockUrl, "PUT", {
      "Content-Type": "application/octet-stream", "Connection": "Keep-Alive",
      "x-ms-blob-type": "BlockBlob",
    }, chunk);
    if (p2.status < 200 || p2.status >= 300) {
      throw new Error(`Block upload failed ${p2.status}: ${p2.body.slice(0, 200)}`);
    }
    console.log(`✔`);
  }

  // Phase 3: CommitAtom — POST /atoms/{uuid}?commit=true  (plain UUID)
  process.stdout.write(`  [3/4] Committing atom... `);
  const p3url  = `${TS}/connectedstorage/users/xuid(${xuid})/scids/${SCID}/atoms/${encodeURIComponent(newAtomUuid)}?commit=true`;
  const p3body = JSON.stringify({ BlockIds: blockIds, Size: data.length });
  const p3 = await httpsReq(p3url, "POST", {
    "Authorization": fullHeader, "x-xbl-contract-version": "107",
    "Content-Type": "application/json", "Accept": "application/json", "x-xbl-pfn": PFN,
  }, p3body);
  if (p3.status !== 200 && p3.status !== 201 && p3.status !== 204) {
    throw new Error(`CommitAtom failed ${p3.status}: ${p3.body.slice(0, 300)}`);
  }
  console.log(`✔`);

  // Phase 4: UpdateBlob — POST /savedgames/{name}?clientFileTime=...&displayName={name}
  process.stdout.write(`  [4/4] Updating savedgame manifest... `);
  const clientFileTime = new Date().toISOString().replace(/(\.\d{3})Z$/, ".0000000+00:00");
  const p4url  = `${TS}/connectedstorage/users/xuid(${xuid})/scids/${SCID}/savedgames/${encodeURIComponent(saveName)}?clientFileTime=${encodeURIComponent(clientFileTime)}&displayName=${encodeURIComponent(saveName)}`;
  const p4body = JSON.stringify({ Atoms: [{ Name: atomName, Atom: newAtomUuid + ",binary" }] });
  const p4 = await httpsReq(p4url, "POST", {
    "Authorization": fullHeader, "x-xbl-contract-version": "107",
    "Content-Type": "application/json", "Accept": "application/json", "x-xbl-pfn": PFN,
  }, p4body);
  if (p4.status !== 200 && p4.status !== 201 && p4.status !== 204) {
    throw new Error(`UpdateSavedGame failed ${p4.status}: ${p4.body.slice(0, 300)}`);
  }
  console.log(`✔`);

  return newAtomUuid;
}

// ── --list-saves ───────────────────────────────────────────────────────────────
async function cmdListSaves() {
  console.log("\n  Dead Island DE — List Saves from Xbox Live");
  console.log("  " + "─".repeat(42));
  const { fullHeader, xuid } = await authenticateFromWincred();
  const url = `${TS}/connectedstorage/users/xuid(${xuid})/scids/${SCID}?maxItems=50`;
  const r   = await httpsReq(url, "GET", {
    "Authorization": fullHeader, "x-xbl-contract-version": "107", "x-xbl-pfn": PFN,
  });
  if (r.status !== 200) throw new Error(`List saves failed ${r.status}: ${r.body.slice(0, 200)}`);
  const blobs = JSON.parse(r.body).blobs ?? [];
  console.log(`\n  Found ${blobs.length} save slot(s):\n`);
  for (const b of blobs) {
    const sz = b.size ? `${(b.size / 1024).toFixed(1)} KB` : "?";
    const dt = b.clientFileTime ? `  [${b.clientFileTime.slice(0, 10)}]` : "";
    console.log(`    ${b.fileName ?? b.displayName ?? "(unnamed)"}  ${sz}${dt}`);
  }
  console.log();
}

// ── --input (push) ─────────────────────────────────────────────────────────────
async function cmdPush() {
  if (!INPUT) {
    console.log(`
Dead Island DE — Windows Save Push Tool
────────────────────────────────────────
Usage:
  node tools\\push-to-xbox-windows.js --list-saves
  node tools\\push-to-xbox-windows.js --input saves\\save_1.sav_edited.bin --dry-run
  node tools\\push-to-xbox-windows.js --input saves\\save_1.sav_edited.bin

Options:
  --input <file>        Edited save file (.bin) to push
  --manifest <file>     Manifest JSON (auto-detected if omitted)
  --dry-run             Show what would be uploaded, don't actually push
  --list-saves          List your current saves from Xbox Live
  --debug               Show verbose debug output
`);
    process.exit(0);
  }

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║   Dead Island DE — Push Save to Xbox Live  (Windows)        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`  Input   : ${INPUT}`);
  if (DRY_RUN) console.log(`  Mode    : DRY RUN (no actual upload)`);

  if (!fs.existsSync(INPUT)) { console.error(`\n✗ File not found: ${INPUT}`); process.exit(1); }

  // Prepare bytes (auto-compress if needed)
  const rawBytes  = fs.readFileSync(INPUT);
  const isGzipped = rawBytes[0] === 0x1f && rawBytes[1] === 0x8b;
  let uploadBytes;
  if (isGzipped) {
    console.log(`  Format  : gzip-compressed (${rawBytes.length.toLocaleString()} bytes)`);
    uploadBytes = rawBytes;
  } else {
    console.log(`  Format  : raw — re-compressing with gzip...`);
    uploadBytes = zlib.gzipSync(rawBytes, { level: 9 });
    console.log(`  Re-gzip : ${rawBytes.length.toLocaleString()} → ${uploadBytes.length.toLocaleString()} bytes`);
  }

  // Resolve manifest (auto-detect from filename)
  let manifestPath = MANIFEST;
  if (!manifestPath) {
    const base = path.basename(INPUT)
      .replace(/_edited/gi, "").replace(/_dec/gi, "").replace(/_MAXED/g, "").replace(/\.bin$/i, "");
    const dir  = path.dirname(INPUT);
    const candidates = [
      path.join(dir,         base + "_manifest.json"),
      path.join(dir,         base + ".sav_manifest.json"),
      path.join("saves",     base + "_manifest.json"),
      path.join("saves",     base + ".sav_manifest.json"),
    ];
    for (const c of candidates) { if (fs.existsSync(c)) { manifestPath = c; break; } }
    if (!manifestPath) {
      console.error(`\n✗ Could not find manifest file. Tried:\n${candidates.map(c => "    " + c).join("\n")}`);
      console.error(`  Pass --manifest <path> explicitly.`);
      process.exit(1);
    }
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const atoms    = manifest.atoms ?? [];
  if (!atoms.length) { console.error(`✗ Manifest has no atoms: ${manifestPath}`); process.exit(1); }

  const saveName = path.basename(manifestPath).replace(/_manifest\.json$/i, "");
  const atomName = atoms[0].name;

  console.log(`  Manifest: ${manifestPath}`);
  console.log(`  SaveName: ${saveName}  (slot the game will load)`);
  console.log(`  AtomName: ${atomName}`);
  console.log(`  Old GUID: ${atoms[0].atom}  (${atoms[0].size} B)`);
  console.log(`  New size: ${uploadBytes.length.toLocaleString()} bytes`);

  if (DRY_RUN) {
    console.log(`\n  ✔ Dry run — would push ${uploadBytes.length} bytes as "${atomName}" into slot "${saveName}"\n`);
    return;
  }

  // Authenticate
  console.log("\n  Authenticating...");
  const { fullHeader, xuid } = await authenticateFromWincred();

  // Upload
  console.log("\n  Uploading via 4-phase pipeline...");
  const newGuid = await uploadAtom(fullHeader, xuid, uploadBytes, saveName, atomName);

  // Update local manifest with new GUID
  fs.writeFileSync(manifestPath, JSON.stringify({
    atoms: [{ name: atomName, atom: newGuid, size: uploadBytes.length }]
  }, null, 2));

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  ✔  Save pushed to Xbox Live successfully!                   ║
╚══════════════════════════════════════════════════════════════╝

  Old GUID : ${atoms[0].atom}
  New GUID : ${newGuid}
  Size     : ${uploadBytes.length.toLocaleString()} bytes
  Manifest : updated → ${manifestPath}

  ★  Launch Dead Island DE on your Xbox.
     The game pulls from cloud storage automatically.
     Load your save — you should see level 60, $9,999,999 etc.
`);
}

// ── Entry point ────────────────────────────────────────────────────────────────
async function main() {
  if (LIST_SAVES) { await cmdListSaves(); return; }
  await cmdPush();
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  if (DEBUG) console.error(e.stack);
  process.exit(1);
});
