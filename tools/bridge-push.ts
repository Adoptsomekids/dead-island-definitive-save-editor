#!/usr/bin/env ts-node
// tools/bridge-push.ts
// ─────────────────────────────────────────────────────────────────────────────
// Push an edited Dead Island DE save to Xbox via SaveBridge /cs/upload
//
// PREREQUISITE: Xbox must be in RETAIL sandbox for this to write to DI's save slot.
//   Settings → System → Console info → Reset console → keep games, change sandbox to RETAIL
//   (Or use: Settings → System → Developer settings → Sandbox ID → type RETAIL → Save)
//
// USAGE:
//   npx ts-node --transpile-only tools/bridge-push.ts \
//     --input saves/save_1.sav_edited.bin \
//     --container GameSave \
//     --blob save_1.sav \
//     --xbox-ip 192.168.100.27
//
// OPTIONS:
//   --input    Path to edited .bin file (gzip-compressed)   [required]
//   --xbox-ip  Xbox IP address                              [default: 192.168.100.27]
//   --container Connected Storage container name             [default: auto-detect]
//   --blob     Blob name inside container                   [default: auto-detect from filename]
//   --port     SaveBridge port                              [default: 8765]
//   --list     List current containers on Xbox before push
//   --dry-run  Show what would be pushed without pushing
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from "fs";
import * as path from "path";
import * as http from "http";

// ── Args ──────────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const getArg    = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : undefined; };
const hasFlag   = (f: string) => args.includes(f);

const XBOX_IP   = getArg("--xbox-ip")  ?? process.env.XBOX_IP ?? "192.168.100.27";
const PORT      = parseInt(getArg("--port") ?? "8765");
const INPUT     = getArg("--input");
const CONTAINER = getArg("--container");
const BLOB      = getArg("--blob");
const LIST_ONLY = hasFlag("--list");
const DRY_RUN   = hasFlag("--dry-run");
const BRIDGE    = `http://${XBOX_IP}:${PORT}`;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 15000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject).on("timeout", () => reject(new Error("HTTP timeout")));
  });
}

function httpPost(url: string, body: Buffer, contentType = "application/octet-stream"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port ? parseInt(u.port) : 80,
      path: u.pathname + u.search, method: "POST",
      headers: { "Content-Type": contentType, "Content-Length": body.length },
      timeout: 30000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject).on("timeout", () => reject(new Error("HTTP timeout")));
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Check SaveBridge is alive
  console.log(`\n🔌 Connecting to SaveBridge at ${BRIDGE}...`);
  let statusResp: { status: number; body: string };
  try {
    statusResp = await httpGet(`${BRIDGE}/status`);
  } catch (e: any) {
    console.error(`❌ Cannot reach SaveBridge: ${e.message}`);
    console.error(`   Make sure SaveBridge is running on Xbox at ${XBOX_IP}:${PORT}`);
    process.exit(1);
  }
  const sb = JSON.parse(statusResp.body);
  console.log(`✅ SaveBridge ${sb.build} running on port ${sb.port}`);

  if (sb.build !== "v28-js") {
    console.warn(`⚠️  Expected v28-js (has /cs/upload). Got ${sb.build} — upload may fail.`);
    console.warn(`   Run: npx ts-node tools/bridge-push.ts to deploy v28 first.`);
  }

  // 2. List containers (if requested or no container specified)
  let container = CONTAINER;
  let blobName  = BLOB;

  const listContainers = LIST_ONLY || !container;
  if (listContainers) {
    console.log(`\n📋 Listing Connected Storage containers...`);
    const listResp = await httpGet(`${BRIDGE}/cs/list`);
    const listData = JSON.parse(listResp.body);

    if (listData.containers && listData.containers.length > 0) {
      console.log(`\n   Found ${listData.containers.length} container(s) in SCID ${listData.scid}:\n`);
      listData.containers.forEach((c: any, i: number) => {
        console.log(`   [${i}] "${c.name}"  displayName="${c.displayName}"  size=${c.totalSize}`);
      });
      if (!container && listData.containers.length > 0) {
        container = listData.containers[0].name;
        console.log(`\n   → Auto-selected container: "${container}"`);
      }
    } else {
      console.log(`\n   ⚠️  No containers found (scid=${listData.scid})`);
      if (listData.error) console.log(`   Error: ${listData.error}`);
      console.log(`\n   This usually means Xbox is in XDKS.1 (Dev Mode) sandbox.`);
      console.log(`   DI saves are in RETAIL sandbox.`);
      console.log(`\n   ╔══════════════════════════════════════════════════════════╗`);
      console.log(`   ║  ACTION REQUIRED: Switch Xbox to RETAIL sandbox           ║`);
      console.log(`   ║                                                            ║`);
      console.log(`   ║  Xbox Settings → System → Console info →                  ║`);
      console.log(`   ║  Reset console → Keep games & apps → Sandbox = RETAIL     ║`);
      console.log(`   ║                                                            ║`);
      console.log(`   ║  OR: Dev settings → Sandbox ID → type RETAIL → Save       ║`);
      console.log(`   ║  (Dev Home app may no longer work after this)              ║`);
      console.log(`   ╚══════════════════════════════════════════════════════════╝\n`);

      if (!container) {
        // Still allow push with default container name (will create new in current sandbox)
        container = "GameSave";
        console.log(`   Using default container name: "${container}"`);
        console.log(`   (Will write to current sandbox — switch to RETAIL for DI to load it)\n`);
      }
    }
  }

  if (LIST_ONLY) {
    console.log(`\n✅ Done (--list only). Run without --list to push.\n`);
    return;
  }

  // 3. Resolve input file
  if (!INPUT) {
    console.error(`\n❌ --input required. Example:`);
    console.error(`   npx ts-node tools/bridge-push.ts --input saves/save_1.sav_edited.bin`);
    process.exit(1);
  }

  const inputPath = path.resolve(INPUT);
  if (!fs.existsSync(inputPath)) {
    console.error(`❌ File not found: ${inputPath}`);
    process.exit(1);
  }

  const fileBytes = fs.readFileSync(inputPath);

  // Auto-detect blob name from filename if not specified
  if (!blobName) {
    // saves/save_1.sav_edited.bin → "save_1.sav"
    const base = path.basename(inputPath);
    const m = base.match(/^(save_\d+\.sav|PROFILE_DATA)/i);
    blobName = m ? m[1] : base.replace(/_edited\.bin$/, "").replace(/\.bin$/, "");
    console.log(`   Auto-detected blob name: "${blobName}"`);
  }

  console.log(`\n📦 Push summary:`);
  console.log(`   File:      ${inputPath} (${fileBytes.length} bytes)`);
  console.log(`   Container: "${container}"`);
  console.log(`   Blob:      "${blobName}"`);
  console.log(`   Bridge:    ${BRIDGE}/cs/upload`);

  // Verify gzip header
  if (fileBytes[0] === 0x1f && fileBytes[1] === 0x8b) {
    console.log(`   Format:    ✅ gzip compressed (correct for DI saves)`);
  } else {
    console.warn(`   Format:    ⚠️  NOT gzip — DI expects gzip-compressed saves`);
    console.warn(`              Use save_1.sav_edited.bin (compressed), not save_1.sav_dec_edited.bin`);
  }

  if (DRY_RUN) {
    console.log(`\n✅ Dry run complete. Remove --dry-run to execute push.\n`);
    return;
  }

  // 4. Push via /cs/upload
  console.log(`\n⬆️  Pushing to Xbox Connected Storage...`);
  const uploadUrl = `${BRIDGE}/cs/upload?container=${encodeURIComponent(container!)}&blob=${encodeURIComponent(blobName)}`;

  let uploadResp: { status: number; body: string };
  try {
    uploadResp = await httpPost(uploadUrl, fileBytes);
  } catch (e: any) {
    console.error(`\n❌ Upload failed: ${e.message}`);
    process.exit(1);
  }

  let result: any;
  try { result = JSON.parse(uploadResp.body); } catch { result = { raw: uploadResp.body }; }

  if (uploadResp.status === 200 && result.ok) {
    console.log(`\n✅ SUCCESS! Save written to Connected Storage.`);
    console.log(`   Container: ${result.container}`);
    console.log(`   Blob:      ${result.blob}`);
    console.log(`   Bytes:     ${result.bytes}`);
    console.log(`   SCID:      ${result.scid}`);
    if (result.note) console.log(`   Note:      ${result.note}`);
    console.log(`\n🎮 Launch Dead Island DE on Xbox to load the edited save.`);
    console.log(`   Expected: Level 60, $9,900,000, God Mode\n`);
  } else {
    console.error(`\n❌ Upload returned status ${uploadResp.status}`);
    console.error(JSON.stringify(result, null, 2));
    if (result.error?.includes("sandbox") || result.error?.includes("XDKS")) {
      console.error(`\n   💡 Sandbox mismatch — switch Xbox to RETAIL sandbox first.`);
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
