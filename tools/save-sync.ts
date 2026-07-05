#!/usr/bin/env ts-node
// tools/save-sync.ts
// CLI tool: download or upload Dead Island DE saves from Xbox Series X.
//
// Supports TWO modes:
//
// MODE 1 — SaveBridge (recommended, works from Mac over WiFi):
//   Requires the SaveBridge UWP app running on your Xbox.
//   See xbox-companion-app/README.md for setup instructions.
//
//   npx ts-node tools/save-sync.ts --download --xbox-ip 192.168.100.27 --bridge-port 8765
//   npx ts-node tools/save-sync.ts --list     --xbox-ip 192.168.100.27 --bridge-port 8765
//   npx ts-node tools/save-sync.ts --upload   --input save.sav --xbox-ip 192.168.100.27 --bridge-port 8765
//
// MODE 2 — Device Portal (only accesses DevelopmentFiles folder):
//   npx ts-node tools/save-sync.ts --download --xbox-ip 192.168.100.27 --user DevToolsUser --pass PASSWORD
//
// Set env vars to avoid typing credentials each time:
//   export XBOX_IP=192.168.100.27
//   export XBOX_BRIDGE_PORT=8765

import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { DevicePortalClient } from "../src/xbox/device-portal";

const args      = process.argv.slice(2);
const getArg    = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const hasFlag   = (flag: string) => args.includes(flag);

const xboxIp      = getArg("--xbox-ip")       ?? process.env.XBOX_IP;
const bridgePort  = parseInt(getArg("--bridge-port") ?? process.env.XBOX_BRIDGE_PORT ?? "8765", 10);
const username    = getArg("--user")           ?? process.env.XBOX_USER ?? "";
const password    = getArg("--pass")           ?? process.env.XBOX_PASS ?? "";
const useBridge   = !getArg("--user") && !process.env.XBOX_USER; // use SaveBridge if no WDP creds

if (!xboxIp) {
  console.error(`
Error: --xbox-ip is required (or set XBOX_IP env var).

SaveBridge mode (recommended — requires SaveBridge UWP on Xbox):
  npx ts-node tools/save-sync.ts --download --xbox-ip 192.168.100.27
  npx ts-node tools/save-sync.ts --list     --xbox-ip 192.168.100.27
  npx ts-node tools/save-sync.ts --upload   --input ./edited.sav --xbox-ip 192.168.100.27

Device Portal mode:
  npx ts-node tools/save-sync.ts --download --xbox-ip 192.168.100.27 --user DevToolsUser --pass PASSWORD

  See xbox-companion-app/README.md for SaveBridge setup.
`);
  process.exit(1);
}

// ── SaveBridge HTTP client (talks to UWP app running on Xbox) ────────────────

async function bridgeRequest(
  method: string,
  xboxIp: string,
  port: number,
  urlPath: string,
  body?: Buffer
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: xboxIp,
      port,
      path: urlPath,
      method,
      headers: body ? { "Content-Length": body.length, "Content-Type": "application/octet-stream" } : {},
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if ((res.statusCode ?? 0) >= 400) reject(new Error(`HTTP ${res.statusCode}: ${buf.toString("utf8").slice(0, 200)}`));
        else resolve(buf);
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const client = username ? new DevicePortalClient({ xboxIp, username, password }) : null;

async function main(): Promise<void> {
  console.log(`Connecting to Xbox Device Portal at https://${xboxIp}:11443 ...`);

  const alive = await client.ping();
  if (!alive) {
    console.error(
      `\nCannot reach Device Portal at ${xboxIp}:11443.\n` +
      "Make sure:\n" +
      "  • Your Xbox Series X has Developer Mode active\n" +
      "  • Your Mac and Xbox are on the same WiFi network\n" +
      "  • The IP address is correct (Xbox: Settings → Network → Advanced settings)\n" +
      "  • The Device Portal username/password are correct"
    );
    process.exit(1);
  }
  console.log("✔ Connected to Xbox Device Portal\n");

  // ── List ──────────────────────────────────────────────────────────────────
  if (hasFlag("--list")) {
    console.log("Looking for Dead Island Definitive Edition package...");
    const pkg = await client.findDeadIslandPackage();
    if (!pkg) {
      console.error("Dead Island DE not found in installed packages.");
      console.log("\nInstalled packages:");
      const all = await client.getInstalledPackages();
      for (const p of all) console.log(`  - ${p.Name} (${p.PackageFullName})`);
      return;
    }

    console.log(`Found: ${pkg.Name} (${pkg.PackageFullName})\n`);
    console.log("Listing save files in LocalAppData...");
    const files = await client.listFiles(pkg.PackageFullName, "LocalAppData", "\\");
    if (files.length === 0) {
      console.log("No files found. Try --list with a different folder.");
    } else {
      for (const f of files) {
        const size = f.SizeInBytes !== undefined ? ` (${f.SizeInBytes} bytes)` : "";
        console.log(`  [${f.Type}] ${f.Name}${size}`);
      }
    }
    return;
  }

  // ── Download ──────────────────────────────────────────────────────────────
  if (hasFlag("--download")) {
    const outputPath = getArg("--output") ?? `./dead-island-save-${Date.now()}.sav`;

    console.log("Looking for Dead Island Definitive Edition package...");
    const pkg = await client.findDeadIslandPackage();
    if (!pkg) {
      console.error("Dead Island DE not found. Is it installed on your Xbox?");
      process.exit(1);
    }
    console.log(`Found: ${pkg.Name}`);

    // Try to find the save file
    const saveFileCandidates = ["\\savegame.sav", "\\DeadIsland.sav", "\\save.sav", "\\profile.sav", "\\1.sav"];
    let downloaded = false;

    for (const candidate of saveFileCandidates) {
      try {
        console.log(`Trying to download: ${candidate}`);
        const bytes = await client.downloadFile(pkg.PackageFullName, candidate, outputPath);
        console.log(`\n✔ Save downloaded: ${path.resolve(outputPath)} (${bytes} bytes)`);
        console.log(`\nNext step: edit it with the save editor, then:`);
        console.log(`  npx ts-node tools/save-sync.ts --upload --input ${outputPath} --xbox-ip ${xboxIp} --user ${username} --pass ${password}`);
        downloaded = true;
        break;
      } catch {
        // Try next candidate
      }
    }

    if (!downloaded) {
      console.log("\nCould not auto-detect save file path. Listing all files to help you identify it:");
      try {
        const files = await client.listFiles(pkg.PackageFullName, "LocalAppData", "\\");
        for (const f of files) {
          const size = f.SizeInBytes !== undefined ? ` (${f.SizeInBytes} bytes)` : "";
          console.log(`  [${f.Type}] ${f.Name}${size}`);
        }
        console.log(`\nRe-run with: --download --save-path "\\<filename>" to download a specific file.`);
      } catch (e: any) {
        console.error("Could not list files:", e.message);
      }
    }
    return;
  }

  // ── Upload ────────────────────────────────────────────────────────────────
  if (hasFlag("--upload")) {
    const inputPath = getArg("--input");
    const remotePath = getArg("--save-path") ?? "\\savegame.sav";

    if (!inputPath) {
      console.error("Error: --upload requires --input <path>");
      process.exit(1);
    }

    console.log("Looking for Dead Island Definitive Edition package...");
    const pkg = await client.findDeadIslandPackage();
    if (!pkg) {
      console.error("Dead Island DE not found on Xbox.");
      process.exit(1);
    }

    console.log(`Uploading ${inputPath} → Xbox:${remotePath} ...`);
    await client.uploadFile(pkg.PackageFullName, remotePath, inputPath);
    console.log(`\n✔ Save uploaded successfully!`);
    console.log(`\nIMPORTANT: On your Xbox, close Dead Island DE completely (quit to home)`);
    console.log(`before launching it again so it reads the new save file.`);
    return;
  }

  console.log("No action specified. Use --download, --upload, or --list.");
  console.log("Run with --help for usage.");
}

main().catch((err) => {
  console.error("\nFatal error:", err.message);
  process.exit(1);
});
