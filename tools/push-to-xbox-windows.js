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

  // PowerShell script:
  //   1. CredEnumerateW  — list all XblGrts credentials
  //   2. CryptUnprotectData (DPAPI) — decrypt each blob (blobs are DPAPI-encrypted by Gaming Services)
  //   3. Interpret decrypted bytes as UTF-16LE string
  //   4. Output JSON array of {name, blob} objects
  const ps1 = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
public class WinCred3 {
  [DllImport("advapi32", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredEnumerate(string filter, int flag, out int count, out IntPtr creds);
  [DllImport("advapi32", SetLastError=true)]
  public static extern bool CredFree(IntPtr buffer);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type;
    public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount;
    public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct DATA_BLOB {
    public uint cbData;
    public IntPtr pbData;
  }
  [DllImport("crypt32", SetLastError=true)]
  public static extern bool CryptUnprotectData(
    ref DATA_BLOB pDataIn, StringBuilder szDataDescr,
    IntPtr pOptionalEntropy, IntPtr pvReserved,
    IntPtr pPromptStruct, uint dwFlags,
    ref DATA_BLOB pDataOut);
  [DllImport("kernel32")]
  public static extern IntPtr LocalFree(IntPtr hMem);

  public static List<string[]> Enumerate() {
    int count; IntPtr p;
    var result = new List<string[]>();
    if (!CredEnumerate(null, 0, out count, out p)) return result;
    for (int i = 0; i < count; i++) {
      IntPtr credPtr = Marshal.ReadIntPtr(p, i * IntPtr.Size);
      var c = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
      string name = Marshal.PtrToStringUni(c.TargetName) ?? "";
      if (!name.Contains("Xbl")) continue;
      if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize == 0) continue;
      byte[] raw = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, raw, 0, (int)c.CredentialBlobSize);

      // Try DPAPI decrypt first
      string blob = null;
      try {
        var inBlob  = new DATA_BLOB { cbData = (uint)raw.Length };
        inBlob.pbData = Marshal.AllocHGlobal(raw.Length);
        Marshal.Copy(raw, 0, inBlob.pbData, raw.Length);
        var outBlob = new DATA_BLOB();
        bool ok = CryptUnprotectData(ref inBlob, null, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref outBlob);
        Marshal.FreeHGlobal(inBlob.pbData);
        if (ok && outBlob.pbData != IntPtr.Zero && outBlob.cbData > 0) {
          byte[] dec = new byte[outBlob.cbData];
          Marshal.Copy(outBlob.pbData, dec, 0, (int)outBlob.cbData);
          LocalFree(outBlob.pbData);
          blob = Encoding.Unicode.GetString(dec);
        }
      } catch {}

      // Fall back: interpret raw bytes directly as UTF-16LE (unencrypted)
      if (blob == null) blob = Encoding.Unicode.GetString(raw);

      // Base64-encode the blob so it survives JSON serialization safely
      string blobB64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(blob));
      result.Add(new string[]{ name, blobB64 });
    }
    CredFree(p);
    return result;
  }
}
'@ -Language CSharp

$items = [WinCred3]::Enumerate()
$out = @()
foreach ($item in $items) {
  $out += [PSCustomObject]@{ name = $item[0]; blobB64 = $item[1] }
}
if ($out.Count -eq 0) {
  Write-Output "[]"
} else {
  $out | ConvertTo-Json -Depth 2 -Compress
}
`;

  const output = runPowershellScript(ps1);
  if (DEBUG) console.log("[DEBUG] wincred raw output:", output.slice(0, 300));

  if (!output || output === "[]") return [];
  try {
    let parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) parsed = [parsed];
    // Decode blobB64 → blob string for each entry
    return parsed.map(c => ({
      name: c.name,
      blob: c.blobB64 ? Buffer.from(c.blobB64, "base64").toString("utf8") : (c.blob ?? ""),
    }));
  } catch (e) {
    if (DEBUG) console.error("[DEBUG] JSON parse error:", e.message, "\nOutput:", output.slice(0, 500));
    return [];
  }
}

// ── Parse Xbox token blob from Windows Credential Manager ─────────────────────
// XblGrts credentials store tokens in one of these formats:
//   1. JSON:  {"Token":"eyJ...","NotAfter":"2026-...","DisplayClaims":{...}}
//   2. JWT:   eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...  (base64url string)
//   3. XBL3.0 header string: XBL3.0 x=<uhs>;<jwt>
// All may have trailing null bytes or 'X' padding from the wincred blob size.
function parseXblTokenBlob(blob) {
  if (!blob) return null;
  // Strip trailing padding (null bytes read as Unicode may become empty chars, X padding, whitespace)
  const fixed = blob.replace(/\0/g, "").replace(/X+$/, "").trim();
  if (!fixed || fixed === "null" || fixed.length < 10) return null;

  // Format 3: already a full XBL3.0 Authorization header → extract JWT directly
  if (fixed.startsWith("XBL3.0 ")) {
    const jwt = fixed.replace(/^XBL3\.0\s+x=[^;]+;/, "").trim();
    if (jwt.startsWith("eyJ")) return { token: fixed, xblHeader: fixed, expiry: Date.now() + 3600_000 };
  }

  // Format 1: JSON blob
  if (fixed.startsWith("{")) {
    try {
      const parsed = JSON.parse(fixed);
      const td     = parsed.TokenData ?? parsed;
      const token  = td.Token ?? td.token ?? null;
      if (!token) return null;
      const expiry = td.NotAfter ? new Date(td.NotAfter).getTime() : Date.now() + 3600_000;
      // Check for embedded DisplayClaims (Xtoken may have uhs + xuid directly)
      const xui  = td.DisplayClaims?.xui?.[0] ?? parsed.DisplayClaims?.xui?.[0];
      return { token, expiry, uhs: xui?.uhs, xuid: xui?.xid, gtg: xui?.gtg };
    } catch {}
  }

  // Format 2: raw JWT string (base64url: starts with "eyJ")
  if (fixed.startsWith("eyJ")) {
    try {
      // Decode the JWT payload to get expiry and claims
      const parts = fixed.split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        const expiry  = payload.exp ? payload.exp * 1000 : Date.now() + 3600_000;
        return { token: fixed, expiry };
      }
    } catch {}
    // If payload decode fails, still return the token (assume valid)
    return { token: fixed, expiry: Date.now() + 3600_000 };
  }

  if (DEBUG) console.log(`  [DEBUG]   Unknown blob format (first 60): ${fixed.slice(0, 60)}`);
  return null;
}

// Extract the "type" segment from an XblGrts credential name.
// Name format: XblGrts|<accountId>|<titleId>|<env>|<sandbox>|<type>|<relyingParty>|...|[suffix]
// e.g. "XblGrts|506671725|00037FFEC60ED8C9|Production|RETAIL|Xtoken|http://xboxlive.com|"
function getXblGrtsType(name) {
  const parts = name.split("|");
  // type is always the 6th pipe-segment (index 5) in XblGrts format
  return parts.length > 5 ? parts[5].toLowerCase() : name.toLowerCase();
}

function getXblGrtsRelyingParty(name) {
  const parts = name.split("|");
  return parts.length > 6 ? parts[6].toLowerCase() : "";
}

function getXblGrtsAccountId(name) {
  const parts = name.split("|");
  return parts.length > 1 ? parts[1] : "";
}

// ── Authenticate using Windows Credential Manager tokens ──────────────────────
async function authenticateFromWincred() {
  console.log("  Reading Xbox tokens from Windows Credential Manager...");
  const creds = readWincredTokens();

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

  if (DEBUG) {
    console.log(`  [DEBUG] Found ${creds.length} Xbl credential(s):`);
    for (const c of creds) {
      const t = parseXblTokenBlob(c.blob);
      const blobPreview = (c.blob ?? "").slice(0, 80).replace(/\n/g, " ");
      console.log(`  [DEBUG]   ${c.name}`);
      console.log(`  [DEBUG]     blob(80): ${blobPreview}`);
      console.log(`  [DEBUG]     parsed:   ${t ? `token[${t.token.slice(0,20)}...] exp=${t.expiry}` : "NULL"}`);
    }
  }

  const now = Date.now();

  // ── Strategy 1: look for Xtoken for http://xboxlive.com (XSTS already done) ──
  // This is the most direct path — the Xbox app already exchanged tokens for us.
  // We need: uhs (user hash) + the Xtoken JWT → build XBL3.0 x=<uhs>;<token>
  // The uhs may be encoded in the JWT payload or in a paired Utoken.
  let xtokenHeader = null;
  let xtokenXuid   = null;
  let xtokenGtg    = null;

  // Collect all candidate Xtokens for xboxlive.com, prefer the one with a titleId set
  const xtokens = creds.filter(c => {
    const type = getXblGrtsType(c.name);
    const rp   = getXblGrtsRelyingParty(c.name);
    return type === "xtoken" && rp.includes("xboxlive.com");
  });

  if (xtokens.length > 0) {
    // Sort: prefer entries that have a titleId segment (they tend to be more specific)
    // and that have a parseable blob
    for (const cred of xtokens) {
      const t = parseXblTokenBlob(cred.blob);
      if (!t || !t.token) continue;
      if (t.expiry < now) {
        if (DEBUG) console.log(`  [DEBUG] Xtoken expired: ${cred.name.slice(0, 70)}`);
        continue;
      }

      // If the blob is already an XBL3.0 header string, use it directly
      if (t.xblHeader) {
        xtokenHeader = t.xblHeader;
        xtokenXuid   = t.xuid ?? "";
        xtokenGtg    = t.gtg  ?? "?";
        console.log(`  ✔ Xtoken (ready): ${cred.name.slice(0, 70)}`);
        break;
      }

      // Otherwise the blob is a JWT — we need the uhs to build the header.
      // Try to decode it from the JWT payload claims.
      let uhs  = t.uhs ?? null;
      let xuid = t.xuid ?? null;
      let gtg  = t.gtg  ?? null;

      if (!uhs) {
        // Try to extract from JWT payload directly
        try {
          const parts = t.token.split(".");
          if (parts.length >= 2) {
            const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
            uhs  = payload.uhs ?? payload.UserHash ?? null;
            xuid = payload.xid ?? payload.xuid ?? payload.sub ?? null;
            gtg  = payload.gtg ?? payload.gamertag ?? null;
          }
        } catch {}
      }

      if (!uhs) {
        // Look for a matching Utoken for the same account to get the uhs
        const accountId = getXblGrtsAccountId(cred.name);
        const utokenCred = creds.find(c2 => {
          return getXblGrtsType(c2.name) === "utoken" &&
                 getXblGrtsAccountId(c2.name) === accountId;
        });
        if (utokenCred) {
          const ut = parseXblTokenBlob(utokenCred.blob);
          if (ut?.token) {
            try {
              const parts = ut.token.split(".");
              if (parts.length >= 2) {
                const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
                uhs  = payload.uhs ?? payload.UserHash ?? null;
                xuid = xuid ?? payload.xid ?? payload.xuid ?? payload.sub ?? null;
              }
            } catch {}
          }
        }
      }

      if (uhs) {
        xtokenHeader = `XBL3.0 x=${uhs};${t.token}`;
        xtokenXuid   = xuid ?? "";
        xtokenGtg    = gtg  ?? "?";
        console.log(`  ✔ Xtoken (JWT+uhs): ${cred.name.slice(0, 70)}`);
        break;
      }

      if (DEBUG) console.log(`  [DEBUG] Xtoken found but could not determine uhs: ${cred.name.slice(0, 70)}`);
    }
  }

  if (xtokenHeader) {
    // Verify the token works + get authoritative xuid via the profile endpoint
    console.log("  Verifying Xtoken against Xbox Live...");
    const r = await httpsReq(
      "https://profile.xboxlive.com/users/me/profile/settings?settings=Gamertag",
      "GET",
      { "Authorization": xtokenHeader, "x-xbl-contract-version": "2", "Accept": "application/json" }
    );
    if (r.status === 200) {
      try {
        const profile = JSON.parse(r.body);
        const xuid = profile.profileUsers?.[0]?.id ?? xtokenXuid ?? "";
        const gtg  = profile.profileUsers?.[0]?.settings?.find(s => s.id === "Gamertag")?.value ?? xtokenGtg ?? "?";
        console.log(`  ✔ Authenticated via Xtoken: ${gtg} (XUID: ${xuid})`);
        return { fullHeader: xtokenHeader, xuid };
      } catch {}
    }
    if (DEBUG) console.log(`  [DEBUG] Xtoken profile verify: ${r.status} — ${r.body.slice(0, 200)}`);
    // If verification failed, fall through to Dtoken+Utoken exchange
    console.log("  ⚠ Xtoken verify failed — falling back to Dtoken+Utoken exchange...");
  }

  // ── Strategy 2: exchange Dtoken + Utoken → XSTS ───────────────────────────────
  let deviceToken = null;
  let userToken   = null;

  for (const cred of creds) {
    const type = getXblGrtsType(cred.name);
    const t    = parseXblTokenBlob(cred.blob);
    if (!t || !t.token) continue;
    if (t.expiry < now) continue;

    if (type === "dtoken") {
      if (!deviceToken) {
        deviceToken = t.token;
        console.log(`  ✔ Device token: ${cred.name.slice(0, 70)}`);
      }
    } else if (type === "utoken") {
      // Skip the placeholder all-A token
      if (t.token.replace(/A/g, "").length === 0) continue;
      if (!userToken) {
        userToken = t.token;
        console.log(`  ✔ User token:   ${cred.name.slice(0, 70)}`);
      }
    }
  }

  if (!deviceToken || !userToken) {
    const names = creds.map(c => "    " + c.name.slice(0, 90)).join("\n");
    const missing = [!deviceToken && "Dtoken", !userToken && "Utoken"].filter(Boolean).join(", ");
    throw new Error(
      `Could not find usable ${missing} credential(s).\n\n` +
      `Found ${creds.length} Xbl credential(s):\n${names}\n\n` +
      `FIXES TO TRY:\n` +
      `  1. Open Xbox app → sign out → sign back in → wait 30s → retry\n` +
      `  2. Launch Dead Island DE once from the Xbox app (Cloud Gaming works too)\n` +
      `  3. Run: node tools\\push-to-xbox-windows.js --list-saves --debug\n` +
      `     and share the output for diagnosis.`
    );
  }

  // Generate key pair for signing
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

  // Exchange Dtoken + Utoken → XSTS
  console.log("  Exchanging Dtoken+Utoken for XSTS token...");
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
    const msgs = {
      "2148916233": "No Xbox profile at xbox.com",
      "2148916238": "Child account needs family consent",
      "2148916235": "Account region not supported",
    };
    throw new Error(`XSTS failed ${r.status}: ${msgs[String(xerr)] ?? r.body.slice(0, 300)}`);
  }

  const xsts = JSON.parse(r.body);
  const xui  = xsts.DisplayClaims?.xui?.[0];
  const xuid = xui?.xid ?? "";
  console.log(`  ✔ Authenticated via XSTS exchange: ${xui?.gtg ?? "?"} (XUID: ${xuid})`);
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
  }, JSON.stringify({ size: data.length }));
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
  const parsed = JSON.parse(r.body);
  const blobs  = parsed.blobs ?? parsed.savedgames ?? parsed.items ?? [];
  console.log(`\n  Found ${blobs.length} save slot(s):\n`);
  for (const b of blobs) {
    const sz = b.size ? `${(b.size / 1024).toFixed(1)} KB` : "?";
    const dt = b.clientFileTime ? `  [${b.clientFileTime.slice(0, 10)}]` : "";
    console.log(`    ${b.fileName ?? b.displayName ?? b.name ?? "(unnamed)"}  ${sz}${dt}`);
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
