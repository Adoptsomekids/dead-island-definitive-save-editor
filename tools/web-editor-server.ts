#!/usr/bin/env ts-node
// tools/web-editor-server.ts
// Dead Island DE — Local HTTP save editor server  (v2)
//
// Usage:
//   npx ts-node tools/web-editor-server.ts [--port=3000] [--saves=./saves]
//
// Endpoints:
//   GET  /                     → HTML UI
//   GET  /api/saves            → list of editable save files (JSON)
//   GET  /api/parse?file=X     → parse a save file (JSON)
//   POST /api/edit             → apply edits, write *_edited.bin (JSON)
//   GET  /api/download?file=X  → binary download of a save file
//   POST /api/upload           → upload a new save file (multipart/form-data)
//   POST /api/push-xbox        → push edited file back to Xbox Live (dry-run or real)

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import * as zlib from "zlib";
import * as https from "https";

const {
  parseSaveFile,
  serializeSaveFile,
  maybeDecompress,
  gzipCompress,
  setMoney,
  setLevel,
  setHP,
  maxAllWeaponDurability,
  maxAllInventory,
  setInventoryItemQty,
  replaceQuickSlotWeapon,
  maxStorageDurability,
  setStorageItemQty,
  parseCollectibles,
  unlockAllCollectibles,
  lockAllCollectibles,
  clearMapFog,
  fillMapFog,
  unlockAllSkills,
  resetAllSkills,
  CHARACTER_CLASS,
  CHARACTER_CLASS_BY_KEY,
} = require("../src/parser/save-file");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT  = parseInt(process.argv.find(a => a.startsWith("--port="))?.split("=")[1] ?? "3000", 10);
const SAVES = path.resolve(
  process.argv.find(a => a.startsWith("--saves="))?.split("=")[1]
  ?? process.env.SAVES_DIR
  ?? path.join(__dirname, "../saves")
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Only show real save files (save_N_dec.bin or save_N.sav_dec.bin), not metadata/GUID/profile */
function listSaveFiles(): Array<{name: string; size: number; mtime: number}> {
  if (!fs.existsSync(SAVES)) return [];
  return fs.readdirSync(SAVES)
    .filter(f => {
      // Accept: save_N_dec.bin, save_N.sav_dec.bin, save_N_edited_dec.bin
      // Reject: PROFILE_*, *GUID*, *_manifest.json, duplicates with double extension
      if (!f.endsWith(".bin")) return false;
      if (f.startsWith("PROFILE")) return false;
      if (f.includes("GUID")) return false;
      if (/^save_\d+\.sav_save/.test(f)) return false; // double-extension artifact
      if (!f.includes("save")) return false;
      return true;
    })
    .map(f => {
      const stat = fs.statSync(path.join(SAVES, f));
      return { name: f, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse a save file and return a JSON-friendly object */
function parseSave(filePath: string): any {
  const raw = fs.readFileSync(filePath);
  const dec = maybeDecompress(raw);
  const save = parseSaveFile(dec);

  const charFromKey = CHARACTER_CLASS_BY_KEY?.[save.location.charTypeKey];
  const charName = charFromKey !== undefined
    ? CHARACTER_CLASS[charFromKey]
    : (CHARACTER_CLASS[save.location.charClassId] ?? `Unknown`);

  return {
    fileName:    path.basename(filePath),
    filePath,
    isGzipped:   raw[0] === 0x1f && raw[1] === 0x8b,
    parseError:  save._parseError ?? null,
    level:       save.header.level,
    maxHP:       save.header.maxHP,
    currHP:      save.header.currHP,
    charName,
    charTypeKey: save.location.charTypeKey,
    charClassId: save.location.charClassId,
    mapName:     save.location.mapName,
    checkpoint:  save.location.checkpoint,
    spawnPoint:  save.location.spawnPoint,
    checkpoint2: save.location.checkpoint2,
    money:       save.location.money,
    saveDate:    `${save.location.saveYear}-${String(save.location.saveMonth).padStart(2,"0")}-${String(save.location.saveDay||1).padStart(2,"0")}`,
    saveTime:    `${String(save.location.saveHour).padStart(2,"0")}:${String(save.location.saveMinute).padStart(2,"0")}`,
    heldWeapon: {
      itemId:      save.heldWeapon?.itemId ?? "",
      craftplanId: save.heldWeapon?.craftplanId ?? "",
      durability:  save.heldWeapon?.durability ?? 0,
      quantity:    save.heldWeapon?.quantity ?? 0,
      itemLevel:   save.heldWeapon?.itemLevel ?? 0,
    },
    quickSlots: (save.quickSlots as any[]).map((w: any) => ({
      itemId:      w.itemId,
      craftplanId: w.craftplanId,
      durability:  w.durability,
      quantity:    w.quantity,
      itemLevel:   w.itemLevel,
    })),
    inventory: (save.inventory as any[]).map((it: any) => ({
      itemId:   it.itemId,
      quantity: it.quantity,
    })),
    storage: (save.storage as any[]).map((it: any) => ({
      itemId:      it.itemId,
      craftplanId: it.craftplanId,
      quantity:    it.quantity,
      durability:  it.durability,
      itemLevel:   it.itemLevel,
    })),
    collectibles:     parseCollectibles(save.rawTail),
    collectiblesCount: parseCollectibles(save.rawTail).filter((v: boolean) => v).length,
    rawTailSize: save.rawTail?.length ?? 0,
  };
}

/** Apply edits to a save file and write the result */
function applyEdits(
  filePath: string,
  edits: any
): { success: boolean; message: string; outPath: string } {
  const raw = fs.readFileSync(filePath);
  const wasGzipped = raw[0] === 0x1f && raw[1] === 0x8b;
  const dec = maybeDecompress(raw);
  let save = parseSaveFile(dec);
  const changes: string[] = [];

  if (edits.money !== undefined) {
    save = setMoney(save, parseInt(edits.money, 10));
    changes.push(`money → $${parseInt(edits.money,10).toLocaleString()}`);
  }
  if (edits.level !== undefined) {
    save = setLevel(save, parseInt(edits.level, 10));
    changes.push(`level → ${edits.level}`);
  }
  if (edits.maxHP !== undefined) {
    save = setHP(save, parseInt(edits.maxHP, 10), parseInt(edits.currHP ?? edits.maxHP, 10));
    changes.push(`HP → ${edits.maxHP}`);
  }
  if (edits.maxDurability) {
    save = maxAllWeaponDurability(save);
    changes.push("all weapon durability → 100");
  }
  if (edits.maxInventory) {
    save = maxAllInventory(save);
    changes.push("all inventory → 999");
  }
  if (edits.inventory && Array.isArray(edits.inventory)) {
    for (const { itemId, quantity } of edits.inventory) {
      save = setInventoryItemQty(save, itemId, parseInt(quantity, 10));
      changes.push(`${itemId} qty → ${quantity}`);
    }
  }
  if (edits.maxStorageDurability) {
    save = maxStorageDurability(save);
    changes.push("all storage weapon durability → 100");
  }
  if (edits.storage && Array.isArray(edits.storage)) {
    for (const { itemId, quantity } of edits.storage) {
      save = setStorageItemQty(save, itemId, parseInt(quantity, 10));
      changes.push(`storage:${itemId} qty → ${quantity}`);
    }
  }
  if (edits.weapons && Array.isArray(edits.weapons)) {
    for (const { idx, itemId, craftplanId, durability, level, quantity } of edits.weapons) {
      save = replaceQuickSlotWeapon(
        save, parseInt(idx, 10), itemId, craftplanId ?? "",
        parseInt(level, 10), parseFloat(durability), parseInt(quantity, 10)
      );
      changes.push(`weapon[${idx}] dur → ${durability}`);
    }
  }
  if (edits.unlockCollectibles) {
    save = unlockAllCollectibles(save);
    changes.push("all collectibles unlocked (ID cards + newspapers + tapes)");
  }
  if (edits.lockCollectibles) {
    save = lockAllCollectibles(save);
    changes.push("all collectibles locked");
  }
  if (edits.clearMapFog) {
    save = clearMapFog(save);
    changes.push("map fog cleared — full map revealed");
  }
  if (edits.fillMapFog) {
    save = fillMapFog(save);
    changes.push("map fog filled — map hidden");
  }
  if (edits.unlockSkills) {
    save = unlockAllSkills(save);
    changes.push("all skill tree nodes unlocked");
  }
  if (edits.resetSkills) {
    save = resetAllSkills(save);
    changes.push("all skill tree nodes reset to 0");
  }

  const outBytes  = serializeSaveFile(save);
  const finalBytes = wasGzipped ? gzipCompress(outBytes) : outBytes;

  // Clean output path: strip any existing _edited suffix then add one
  const base    = path.basename(filePath).replace(/_edited/g, "");
  const stem    = base.replace(/\.bin$/, "");
  const outName = `${stem}_edited.bin`;
  const outPath = path.join(SAVES, outName);
  fs.writeFileSync(outPath, finalBytes);

  return { success: true, message: changes.join(", ") || "No changes", outPath: outName };
}

/** Parse a multipart/form-data body — minimal implementation for file uploads */
function parseMultipart(
  contentType: string,
  body: Buffer
): { filename: string; data: Buffer } | null {
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) return null;
  const boundary = Buffer.from("--" + boundaryMatch[1]);
  const parts: Buffer[] = [];
  let start = 0;
  while (start < body.length) {
    const idx = body.indexOf(boundary, start);
    if (idx === -1) break;
    const partStart = idx + boundary.length;
    const next = body.indexOf(boundary, partStart);
    const partEnd = next === -1 ? body.length : next;
    parts.push(body.slice(partStart, partEnd));
    start = partEnd;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;
    const header = part.slice(0, headerEnd).toString();
    const fnMatch = header.match(/filename="([^"]+)"/);
    if (!fnMatch) continue;
    const filename = fnMatch[1];
    // data starts after \r\n\r\n, ends before trailing \r\n
    let data = part.slice(headerEnd + 4);
    if (data.slice(-2).toString() === "\r\n") data = data.slice(0, -2);
    return { filename, data };
  }
  return null;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url ?? "/", true);
  const pathname  = parsedUrl.pathname ?? "/";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── GET /api/saves ─────────────────────────────────────────────────────────
  if (pathname === "/api/saves" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(listSaveFiles()));
    return;
  }

  // ── GET /api/parse ─────────────────────────────────────────────────────────
  if (pathname === "/api/parse" && req.method === "GET") {
    const fname = parsedUrl.query.file as string;
    const full  = path.join(SAVES, path.basename(fname));
    if (!fs.existsSync(full)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "File not found" })); return;
    }
    try {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(parseSave(full)));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/edit ─────────────────────────────────────────────────────────
  if (pathname === "/api/edit" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { file, edits } = JSON.parse(body);
        const full = path.join(SAVES, path.basename(file));
        if (!fs.existsSync(full)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "File not found" })); return;
        }
        const result = applyEdits(full, edits);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /api/download ──────────────────────────────────────────────────────
  if (pathname === "/api/download" && req.method === "GET") {
    const fname = parsedUrl.query.file as string;
    const full  = path.join(SAVES, path.basename(fname));
    if (!fs.existsSync(full)) {
      res.writeHead(404); res.end("Not found"); return;
    }
    const data = fs.readFileSync(full);
    res.writeHead(200, {
      "Content-Type":        "application/octet-stream",
      "Content-Disposition": `attachment; filename="${path.basename(fname)}"`,
      "Content-Length":      data.length,
    });
    res.end(data);
    return;
  }

  // ── POST /api/upload ───────────────────────────────────────────────────────
  if (pathname === "/api/upload" && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks);
        const ct   = req.headers["content-type"] ?? "";
        const parsed = parseMultipart(ct, body);
        if (!parsed) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Could not parse multipart body" })); return;
        }
        const safeName = path.basename(parsed.filename).replace(/[^a-zA-Z0-9._-]/g, "_");
        const outPath  = path.join(SAVES, safeName);
        fs.writeFileSync(outPath, parsed.data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, name: safeName, size: parsed.data.length }));
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── POST /api/push-xbox ────────────────────────────────────────────────────
  // Spawns save-sync.ts --cs-push as a child process (reuses all auth logic)
  if (pathname === "/api/push-xbox" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { file, manifest, dryRun } = JSON.parse(body);
        const full     = path.join(SAVES, path.basename(file));
        const tsNode   = path.join(__dirname, "../node_modules/.bin/ts-node");
        const syncTool = path.join(__dirname, "./save-sync.ts");

        if (!fs.existsSync(full)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "File not found" })); return;
        }

        const args: string[] = [
          "--transpile-only", syncTool,
          "--cs-push", "--input", full,
        ];
        if (manifest) {
          const mfull = path.join(SAVES, path.basename(manifest));
          args.push("--manifest", mfull);
        }
        if (dryRun) args.push("--dry-run");

        const { spawn } = require("child_process");
        const child = spawn(tsNode, args, { cwd: path.join(__dirname, "..") });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        child.on("close", (code: number) => {
          if (code === 0) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, output: stdout }));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: stderr || stdout }));
          }
        });
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /api/manifests ─────────────────────────────────────────────────────
  if (pathname === "/api/manifests" && req.method === "GET") {
    if (!fs.existsSync(SAVES)) { res.writeHead(200, { "Content-Type": "application/json" }); res.end("[]"); return; }
    const manifests = fs.readdirSync(SAVES)
      .filter(f => f.endsWith("_manifest.json"))
      .map(f => ({ name: f }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(manifests));
    return;
  }

  // ── GET / → HTML editor ────────────────────────────────────────────────────
  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getEditorHTML());
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║   💀 Dead Island DE — Save Editor  v2.0                      ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  console.log(`\n  ★  Open browser → http://127.0.0.1:${PORT}`);
  console.log(`  ★  Saves folder  → ${SAVES}`);
  console.log(`\n  Ctrl+C to stop.\n`);
});

// ── HTML UI ────────────────────────────────────────────────────────────────────
function getEditorHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dead Island DE — Save Editor</title>
<style>
:root {
  --bg:        #0d0d0f;
  --bg2:       #13131a;
  --bg3:       #1a1a24;
  --border:    #252530;
  --accent:    #c0392b;
  --accent2:   #e74c3c;
  --accent-glow: rgba(192,57,43,0.35);
  --text:      #e8e8ec;
  --text2:     #9999aa;
  --text3:     #55555f;
  --green:     #27ae60;
  --yellow:    #f39c12;
  --blue:      #2980b9;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; overflow-x: hidden; }

/* ── Header ── */
.hdr { background: linear-gradient(135deg, #1a0505 0%, #0d0d0f 60%); padding: 18px 28px; display: flex; align-items: center; gap: 14px; border-bottom: 2px solid var(--accent); position: sticky; top: 0; z-index: 50; backdrop-filter: blur(4px); }
.hdr-logo { font-size: 36px; filter: drop-shadow(0 0 8px rgba(231,76,60,0.6)); }
.hdr-title { font-size: 22px; font-weight: 800; color: var(--accent2); letter-spacing: -0.02em; text-shadow: 0 0 20px var(--accent-glow); }
.hdr-sub   { font-size: 12px; color: var(--text3); margin-top: 3px; }
.hdr-actions { margin-left: auto; display: flex; gap: 10px; align-items: center; }

/* ── Layout ── */
.layout { display: grid; grid-template-columns: 270px 1fr; gap: 0; min-height: calc(100vh - 66px); }
.sidebar { border-right: 1px solid var(--border); padding: 16px 12px; display: flex; flex-direction: column; gap: 8px; background: var(--bg2); }
.sidebar-head { font-size: 10px; font-weight: 700; color: var(--text3); text-transform: uppercase; letter-spacing: 0.12em; padding: 0 6px 8px; border-bottom: 1px solid var(--border); margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
.main   { padding: 20px 24px; overflow-y: auto; }

/* ── File Cards ── */
.file-card { background: var(--bg3); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; cursor: pointer; transition: all 0.15s; }
.file-card:hover { border-color: #4a2020; background: #1c1020; }
.file-card.active { border-color: var(--accent); background: #1f0d0d; box-shadow: 0 0 10px var(--accent-glow); }
.fc-name { font-size: 12px; font-weight: 600; color: #ff9999; word-break: break-all; margin-bottom: 3px; }
.fc-meta { font-size: 10px; color: var(--text3); display: flex; justify-content: space-between; }
.fc-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 9px; font-weight: 700; text-transform: uppercase; }
.fc-badge.edited  { background: rgba(39,174,96,0.2);  color: #2ecc71; border: 1px solid #27ae60; }
.fc-badge.partial { background: rgba(243,156,18,0.2); color: #f39c12; border: 1px solid #e67e22; }

/* ── Panels ── */
.panel { background: var(--bg3); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin-bottom: 16px; }
.panel-hdr { background: linear-gradient(90deg, #1a0808, var(--bg3)); padding: 10px 16px; font-size: 11px; font-weight: 700; color: var(--accent2); text-transform: uppercase; letter-spacing: 0.1em; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
.panel-body { padding: 16px; }

/* ── Char Card ── */
.char-card { display: flex; align-items: center; gap: 16px; background: linear-gradient(135deg, #1f0808, #12101a); border: 1px solid #3a1a1a; border-radius: 10px; padding: 16px 20px; margin-bottom: 16px; }
.char-avatar { font-size: 52px; filter: drop-shadow(0 2px 8px rgba(0,0,0,0.8)); }
.char-info { flex: 1; }
.char-name { font-size: 22px; font-weight: 900; color: #ff6666; letter-spacing: -0.02em; }
.char-sub  { font-size: 11px; color: var(--text3); margin-top: 4px; }
.stat-chips { display: flex; gap: 10px; flex-wrap: wrap; margin-left: auto; }
.chip { background: #0d0d0f; border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; text-align: center; min-width: 80px; }
.chip-val { font-size: 24px; font-weight: 800; color: var(--accent2); line-height: 1; }
.chip-val.money { font-size: 16px; color: var(--yellow); }
.chip-val.hp    { font-size: 16px; color: var(--green); }
.chip-lbl { font-size: 10px; color: var(--text3); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.05em; }

/* ── Forms ── */
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; }
.field  { display: flex; flex-direction: column; gap: 5px; }
.field label { font-size: 10px; font-weight: 700; color: var(--text3); text-transform: uppercase; letter-spacing: 0.08em; }
.field input, .field select { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; color: var(--text); font-size: 13px; transition: border-color 0.15s; width: 100%; }
.field input:focus, .field select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow); }
.hint { font-size: 10px; color: var(--text3); }

/* ── Buttons ── */
.btn { padding: 8px 16px; border-radius: 7px; border: none; cursor: pointer; font-size: 12px; font-weight: 700; transition: all 0.15s; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.btn-primary   { background: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--accent2); box-shadow: 0 0 14px var(--accent-glow); }
.btn-secondary { background: var(--bg); color: var(--text2); border: 1px solid var(--border); }
.btn-secondary:hover { border-color: #666; color: #fff; }
.btn-success { background: var(--green); color: #fff; }
.btn-success:hover { background: #2ecc71; }
.btn-warn    { background: #7f4800; color: #ffa; border: 1px solid #b36200; }
.btn-warn:hover { background: #a05800; }
.btn-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
.btn-sm { padding: 4px 10px; font-size: 11px; border-radius: 5px; }

/* ── Weapons ── */
.weapon-row { display: grid; grid-template-columns: 28px 1fr 90px 70px 70px; gap: 10px; align-items: center; background: #0f0f14; border: 1px solid var(--border); border-radius: 7px; padding: 10px 12px; margin-bottom: 6px; }
.weapon-row.held { background: #150a0a; border-color: #3a1a1a; }
.wep-slot { font-size: 11px; color: var(--text3); font-weight: 800; }
.wep-info {}
.wep-id   { font-size: 12px; color: #ff9999; font-weight: 700; }
.wep-plan { font-size: 10px; color: var(--text3); margin-top: 2px; }
.wep-qty  { font-size: 11px; color: var(--text2); margin-top: 2px; }
.wep-input { background: var(--bg); border: 1px solid var(--border); border-radius: 5px; padding: 5px 8px; color: var(--text); font-size: 12px; width: 100%; text-align: center; }
.wep-input:focus { outline: none; border-color: var(--accent); }
.wep-lbl { font-size: 9px; color: var(--text3); text-align: center; margin-bottom: 2px; text-transform: uppercase; }

/* ── Inventory ── */
.inv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 7px; }
.inv-item { background: #0f0f14; border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; display: flex; align-items: center; gap: 8px; }
.inv-icon { font-size: 16px; flex-shrink: 0; }
.inv-name { font-size: 11px; color: var(--text2); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inv-qty  { width: 58px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 4px 6px; color: var(--text); font-size: 12px; text-align: right; flex-shrink: 0; }
.inv-qty:focus { outline: none; border-color: var(--accent); }

/* ── Location ── */
.loc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
.loc-box { background: #0f0f14; border: 1px solid var(--border); border-radius: 7px; padding: 10px 14px; }
.loc-val { font-size: 13px; font-weight: 700; color: #ffaaaa; }
.loc-lbl { font-size: 10px; color: var(--text3); margin-top: 3px; text-transform: uppercase; letter-spacing: 0.06em; }

/* ── Toast ── */
.toast { position: fixed; bottom: 28px; right: 28px; max-width: 380px; background: #0d1f0d; border: 1px solid var(--green); color: #7fff7f; padding: 12px 18px; border-radius: 8px; font-size: 12px; line-height: 1.5; opacity: 0; transition: opacity 0.25s, transform 0.25s; transform: translateY(10px); z-index: 999; white-space: pre-wrap; }
.toast.show { opacity: 1; transform: translateY(0); }
.toast.error { background: #1f0808; border-color: var(--accent); color: #ff8888; }

/* ── Upload area ── */
.upload-area { border: 2px dashed var(--border); border-radius: 8px; padding: 20px; text-align: center; color: var(--text3); font-size: 12px; cursor: pointer; transition: all 0.2s; }
.upload-area:hover, .upload-area.drag { border-color: var(--accent); color: var(--accent2); background: #1a0808; }

/* ── Warning ── */
.warn-box { background: rgba(243,156,18,0.1); border: 1px solid #7f5000; border-radius: 6px; padding: 10px 14px; font-size: 11px; color: #f39c12; margin-bottom: 14px; display: flex; gap: 8px; }

/* ── Misc ── */
.loading { text-align: center; padding: 60px 0; color: var(--text3); font-size: 16px; }
.empty   { text-align: center; padding: 80px 0; color: var(--text3); font-size: 14px; }
.divider { height: 1px; background: var(--border); margin: 16px 0; }
code { background: #1a1a24; padding: 2px 6px; border-radius: 4px; font-size: 11px; color: #ff9999; font-family: 'SF Mono', Consolas, monospace; }

@media (max-width: 860px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar { border-right: none; border-bottom: 1px solid var(--border); }
  .grid-3 { grid-template-columns: 1fr 1fr; }
}
</style>
</head>
<body>

<!-- Header -->
<div class="hdr">
  <div class="hdr-logo">💀</div>
  <div>
    <div class="hdr-title">Dead Island DE — Save Editor</div>
    <div class="hdr-sub">Xbox Series X · Definitive Edition · v2.0</div>
  </div>
  <div class="hdr-actions">
    <label class="btn btn-secondary btn-sm" style="cursor:pointer;" title="Upload a .bin save file">
      📂 Upload Save
      <input type="file" id="upload-input" accept=".bin" style="display:none" onchange="uploadSave(this)">
    </label>
    <button class="btn btn-secondary btn-sm" onclick="loadFileList()" title="Refresh file list">🔄</button>
  </div>
</div>

<!-- Layout -->
<div class="layout">

  <!-- Sidebar -->
  <div class="sidebar">
    <div class="sidebar-head">
      <span>Save Files</span>
      <span id="file-count" style="color:var(--text3);font-size:10px;"></span>
    </div>
    <div id="file-list">
      <div class="loading" style="padding:20px;font-size:12px;">Loading...</div>
    </div>
  </div>

  <!-- Main editor area -->
  <div class="main" id="main">
    <div class="empty">
      <div style="font-size:48px;margin-bottom:16px;">🎮</div>
      <div style="font-weight:700;margin-bottom:8px;">Select a save file to begin editing</div>
      <div style="font-size:12px;color:var(--text3);line-height:1.8;">
        Upload a <code>.bin</code> save file using the button above<br>
        or run <code>npx ts-node tools/save-sync.ts --cs-pull</code><br>
        to download saves from Xbox Live
      </div>
    </div>
  </div>

</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
// ─────────────────────────────────────────────────────────────────────────────
let currentFile = null;
let currentSave = null;

// Item display helpers
const ITEM_ICONS = {
  CraftPart: '🔧', Powerup: '💊', Throwable: '💣', Medkit: '❤️',
  Food: '🥫', Firearm: '🔫', Melee: '⚔️', Ammo: '🎯', Car: '🚗',
};
function itemIcon(id) {
  for (const [k,v] of Object.entries(ITEM_ICONS)) if (id.startsWith(k)) return v;
  return '📦';
}
function itemLabel(id) {
  return id
    .replace(/^CraftPart_/, '')
    .replace(/^Powerup_/, '')
    .replace(/^Throwable_/, '')
    .replace(/^Medkit_/, '')
    .replace(/^Food_/, '')
    .replace(/Gen$/, '')
    .replace(/_/g, ' ');
}
const MAP_NAMES = {
  Hotel:'Hotel (Prologue)', ACT1A:'Resort – Act 1', ACT2A:'Moresby – Act 2',
  ACT3A:'Jungle – Act 3', ACT4A:'Prison – Act 4',
};
const CHAR_AVATARS = { 'Sam B':'🥁', 'Xian Mei':'⚔️', 'Logan Carter':'🎯', 'Purna':'🔫' };

// ─────────────────────────────────────────────────────────────────────────────
async function loadFileList() {
  const res   = await fetch('/api/saves');
  const files = await res.json();
  const el    = document.getElementById('file-list');
  document.getElementById('file-count').textContent = files.length + ' files';

  if (files.length === 0) {
    el.innerHTML = \`<div style="color:var(--text3);font-size:11px;padding:12px 6px;text-align:center;line-height:1.8;">
      No save files found.<br>Upload a <code>.bin</code> file or<br>run <code>--cs-pull</code></div>\`;
    return;
  }

  el.innerHTML = '';
  for (const f of files) {
    const isEdited  = f.name.includes('_edited');
    const isPartial = false; // will update after parse
    const card = document.createElement('div');
    card.className = 'file-card' + (f.name === currentFile ? ' active' : '');
    card.dataset.name = f.name;
    card.innerHTML = \`
      <div class="fc-name">\${f.name}</div>
      <div class="fc-meta">
        <span>\${(f.size/1024).toFixed(1)} KB</span>
        \${isEdited ? '<span class="fc-badge edited">edited</span>' : ''}
      </div>\`;
    card.onclick = () => loadSave(f.name, card);
    el.appendChild(card);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function loadSave(fileName, cardEl) {
  // Update active state
  document.querySelectorAll('.file-card').forEach(c => c.classList.remove('active'));
  if (cardEl) cardEl.classList.add('active');

  document.getElementById('main').innerHTML = '<div class="loading">⏳ Parsing save file...</div>';
  currentFile = fileName;

  try {
    const res  = await fetch('/api/parse?file=' + encodeURIComponent(fileName));
    const save = await res.json();
    if (save.error) { showToast(save.error, true); return; }
    currentSave = save;
    renderEditor(save);
  } catch (e) { showToast(e.message, true); }
}

// ─────────────────────────────────────────────────────────────────────────────
function renderEditor(save) {
  const avatar = CHAR_AVATARS[save.charName] ?? '🎮';
  const mapLabel = MAP_NAMES[save.mapName] ?? save.mapName;

  let html = \`
  <!-- Char card -->
  <div class="char-card">
    <div class="char-avatar">\${avatar}</div>
    <div class="char-info">
      <div class="char-name">\${save.charName}</div>
      <div class="char-sub">\${save.charTypeKey} · \${mapLabel} · Saved \${save.saveDate} \${save.saveTime}</div>
    </div>
    <div class="stat-chips">
      <div class="chip"><div class="chip-val">\${save.level}</div><div class="chip-lbl">Level</div></div>
      <div class="chip"><div class="chip-val money">\$\${save.money.toLocaleString()}</div><div class="chip-lbl">Money</div></div>
      <div class="chip"><div class="chip-val hp">\${save.currHP}/\${save.maxHP}</div><div class="chip-lbl">HP</div></div>
    </div>
  </div>\`;

  // Partial parse warning
  if (save.parseError) {
    html += \`<div class="warn-box">⚠️ <span>Partial parse — weapon &amp; inventory editing unavailable for this save (prologue/early format). Basic edits (level, money, HP) still work.<br><small>\${save.parseError}</small></span></div>\`;
  }

  // ── Player Stats ────────────────────────────────────────────────────────────
  html += \`
  <div class="panel">
    <div class="panel-hdr">⚡ Player Stats</div>
    <div class="panel-body">
      <div class="grid-3">
        <div class="field">
          <label>Level (1 – 60)</label>
          <input type="number" id="ed-level" value="\${save.level}" min="1" max="60">
        </div>
        <div class="field">
          <label>Money (max ~9,999,999)</label>
          <input type="number" id="ed-money" value="\${save.money}" min="0" max="99999999">
        </div>
        <div class="field">
          <label>Max HP</label>
          <input type="number" id="ed-maxhp" value="\${save.maxHP}" min="1" max="9999">
        </div>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="applyPlayerEdits()">💾 Apply</button>
        <button class="btn btn-warn"    onclick="applyPreset('god')">⭐ God Mode</button>
        <button class="btn btn-secondary" onclick="applyPreset('maxmoney')">💰 Max Money</button>
        <button class="btn btn-secondary" onclick="applyPreset('maxlevel')">🏆 Max Level (60)</button>
      </div>
    </div>
  </div>\`;

  // ── Location ────────────────────────────────────────────────────────────────
  html += \`
  <div class="panel">
    <div class="panel-hdr">📍 Location</div>
    <div class="panel-body">
      <div class="loc-grid">
        <div class="loc-box"><div class="loc-val">\${mapLabel}</div><div class="loc-lbl">Map</div></div>
        <div class="loc-box" style="grid-column:span 2"><div class="loc-val" style="font-size:12px">\${save.checkpoint}</div><div class="loc-lbl">Checkpoint</div></div>
        <div class="loc-box" style="grid-column:span 2"><div class="loc-val" style="font-size:11px;color:var(--text2)">\${save.spawnPoint}</div><div class="loc-lbl">Spawn Point</div></div>
        <div class="loc-box"><div class="loc-val" style="font-size:11px;color:var(--text2)">\${save.rawTailSize} B</div><div class="loc-lbl">Raw tail (skills/fog)</div></div>
      </div>
    </div>
  </div>\`;

  // ── Weapons ─────────────────────────────────────────────────────────────────
  if (!save.parseError && save.quickSlots?.length > 0) {
    html += \`<div class="panel">
    <div class="panel-hdr">⚔️ Weapons (\${save.quickSlots.length} quick slots + held)</div>
    <div class="panel-body">\`;

    // Headers
    html += \`<div style="display:grid;grid-template-columns:28px 1fr 90px 70px 70px;gap:10px;padding:0 12px 6px;font-size:9px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em;">
      <div>#</div><div>Weapon / Craftplan</div><div style="text-align:center">Durability</div><div style="text-align:center">Qty</div><div style="text-align:center">Level</div>
    </div>\`;

    // Held weapon
    if (save.heldWeapon?.itemId) {
      const w = save.heldWeapon;
      html += \`<div class="weapon-row held">
        <div class="wep-slot" style="color:var(--accent2)">H</div>
        <div class="wep-info">
          <div class="wep-id">\${w.itemId}</div>
          <div class="wep-plan">\${w.craftplanId || '(no craftplan)'}</div>
        </div>
        <div><div class="wep-lbl">Dur</div><input class="wep-input" id="held-dur" type="number" value="\${Math.max(0,w.durability).toFixed(1)}" min="0" max="100" step="0.5"></div>
        <div><div class="wep-lbl">Qty</div><input class="wep-input" id="held-qty" type="number" value="\${w.quantity}" min="0" max="999"></div>
        <div><div class="wep-lbl">Lvl</div><input class="wep-input" id="held-lvl" type="number" value="\${w.itemLevel}" min="0" max="10"></div>
      </div>\`;
    }

    // Quick slots
    save.quickSlots.forEach((w, i) => {
      const isAmmo = w.durability < 0;
      html += \`<div class="weapon-row">
        <div class="wep-slot">\${i}</div>
        <div class="wep-info">
          <div class="wep-id">\${w.itemId || 'Empty'}</div>
          <div class="wep-plan">\${w.craftplanId || ''}</div>
          \${isAmmo ? '<div class="wep-qty">🔫 Firearm / Ammo</div>' : ''}
        </div>
        <div><div class="wep-lbl">Dur</div><input class="wep-input" id="ws-dur-\${i}" type="number" value="\${isAmmo ? -1 : Math.max(0,w.durability).toFixed(1)}" min="-1" max="100" step="0.5"\${isAmmo ? ' disabled style="opacity:0.4"' : ''}></div>
        <div><div class="wep-lbl">Qty</div><input class="wep-input" id="ws-qty-\${i}" type="number" value="\${w.quantity}" min="0" max="9999"></div>
        <div><div class="wep-lbl">Lvl</div><input class="wep-input" id="ws-lvl-\${i}" type="number" value="\${w.itemLevel}" min="0" max="10"></div>
      </div>\`;
    });

    html += \`<div class="btn-row">
        <button class="btn btn-primary" onclick="applyWeaponEdits()">💾 Apply Weapon Edits</button>
        <button class="btn btn-secondary" onclick="maxAllDurability()">🔧 Max All Durability</button>
        <button class="btn btn-secondary" onclick="maxAllAmmo()">🎯 Max All Ammo (999)</button>
      </div>
    </div></div>\`;
  }

  // ── Inventory ────────────────────────────────────────────────────────────────
  if (!save.parseError && save.inventory?.length > 0) {
    html += \`<div class="panel">
    <div class="panel-hdr">🎒 Inventory (\${save.inventory.length} items)</div>
    <div class="panel-body">
      <div class="inv-grid">\`;
    save.inventory.forEach((it, i) => {
      html += \`<div class="inv-item">
        <span class="inv-icon">\${itemIcon(it.itemId)}</span>
        <span class="inv-name" title="\${it.itemId}">\${itemLabel(it.itemId)}</span>
        <input type="number" class="inv-qty" id="inv-qty-\${i}" data-id="\${it.itemId}" value="\${it.quantity}" min="0" max="999">
      </div>\`;
    });
    html += \`</div>
      <div class="btn-row">
        <button class="btn btn-primary"   onclick="applyInventoryEdits()">💾 Apply Inventory</button>
        <button class="btn btn-secondary" onclick="setAllInventory(999)">📦 Max All (999)</button>
        <button class="btn btn-secondary" onclick="setAllInventory(0)">🗑️ Clear All</button>
      </div>
    </div></div>\`;
  }

  // ── Storage / Chest ──────────────────────────────────────────────────────────
  if (!save.parseError && save.storage?.length > 0) {
    html += \`<div class="panel">
    <div class="panel-hdr">🎒 Storage Chest (\${save.storage.length} weapons)</div>
    <div class="panel-body">
      <div style="font-size:11px;color:var(--text2);margin-bottom:12px;">Items in the stash/chest shared between characters.</div>
      \${save.storage.map((it, i) => {
        const isAmmo = it.durability < 0;
        return \`<div class="weapon-row" style="grid-template-columns:28px 1fr 90px 70px 70px;">
          <div class="wep-slot" style="color:#aaa;">\${i}</div>
          <div class="wep-info">
            <div class="wep-id">\${it.itemId}</div>
            <div class="wep-plan">\${it.craftplanId || ''}</div>
          </div>
          <div><div class="wep-lbl">Dur</div><input class="wep-input" id="stor-dur-\${i}" type="number" value="\${isAmmo ? -1 : Math.max(0,it.durability).toFixed(1)}" min="-1" max="100"\${isAmmo?' disabled style="opacity:0.4"':''}></div>
          <div><div class="wep-lbl">Qty</div><input class="wep-input" id="stor-qty-\${i}" type="number" value="\${it.quantity}" min="0" max="9999"></div>
          <div><div class="wep-lbl">Lvl</div><input class="wep-input" id="stor-lvl-\${i}" type="number" value="\${it.itemLevel}" min="0" max="10"></div>
        </div>\`;
      }).join('')}
      <div class="btn-row">
        <button class="btn btn-primary" onclick="applyStorageEdits()">💾 Apply Storage</button>
        <button class="btn btn-secondary" onclick="maxStorageDurability()">🔧 Max All Durability</button>
      </div>
    </div></div>\`;
  }

  // ── Collectibles + Skills + Fog ──────────────────────────────────────────────
  if (!save.parseError) {
    const collUnlocked = (save.collectibles || []).filter((v: boolean) => v).length;
    const collTotal    = (save.collectibles || []).length;
    html += \`<div class="panel">
    <div class="panel-hdr">🏆 Collectibles, Skills &amp; Map</div>
    <div class="panel-body">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:16px;">

        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.08em;">🃏 Collectibles</div>
          <div style="font-size:28px;font-weight:700;color:\${collUnlocked===collTotal?'#4ade80':'#f0a500'};">\${collUnlocked}<span style="font-size:14px;color:var(--text3)"> / \${collTotal}</span></div>
          <div style="font-size:11px;color:var(--text3);margin-bottom:12px;">ID cards · Newspapers · Tapes</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-primary" style="font-size:11px;padding:5px 10px;" onclick="unlockAllCollectibles()">🔓 Unlock All</button>
            <button class="btn btn-secondary" style="font-size:11px;padding:5px 10px;" onclick="lockAllCollectibles()">🔒 Lock All</button>
          </div>
        </div>

        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.08em;">⚡ Skill Trees</div>
          <div style="font-size:13px;color:var(--text);margin-bottom:8px;line-height:1.5;">Heuristic scan of the skills section unlocks all node entries with valid IDs (1–50).</div>
          <div style="font-size:11px;color:var(--text3);margin-bottom:12px;">Fury · Power · Survival trees</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-primary" style="font-size:11px;padding:5px 10px;" onclick="unlockAllSkills()">⚡ Unlock All Skills</button>
            <button class="btn btn-secondary" style="font-size:11px;padding:5px 10px;" onclick="resetAllSkills()">🔄 Reset Skills</button>
          </div>
        </div>

        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
          <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.08em;">🗺️ Map Fog</div>
          <div style="font-size:13px;color:var(--text);margin-bottom:8px;line-height:1.5;">Reveal or hide the map exploration fog of war.</div>
          <div style="font-size:11px;color:var(--text3);margin-bottom:12px;">12 × 12 tile fog grid (240 bytes)</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-primary" style="font-size:11px;padding:5px 10px;" onclick="clearMapFog()">🔭 Reveal Full Map</button>
            <button class="btn btn-secondary" style="font-size:11px;padding:5px 10px;" onclick="fillMapFog()">🌑 Hide Full Map</button>
          </div>
        </div>

      </div>
    </div></div>\`;
  }

  // ── Download & Xbox Push ────────────────────────────────────────────────────
  html += \`<div class="panel">
    <div class="panel-hdr">📥 Download &amp; Push to Xbox</div>
    <div class="panel-body">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px;">
        <button class="btn btn-success" onclick="downloadFile(currentFile)">⬇️ Download .bin</button>
        <span style="font-size:11px;color:var(--text3)">Save the file to transfer manually via USB or Xbox app (PC)</span>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:14px;">
        <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;">📡 Push Directly to Xbox Live</div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:10px;line-height:1.6;">
          Requires <code>--login-legacy</code> to be run first in the terminal.
          Pushes the current file to Xbox Connected Storage so it's available next time you launch the game.
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <select id="manifest-select" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text);font-size:12px;">
            <option value="">Auto-detect manifest</option>
          </select>
          <button class="btn btn-warn" onclick="pushToXbox(true)">🔍 Dry Run</button>
          <button class="btn btn-primary" onclick="pushToXbox(false)" style="background:#8b0000;">📡 Push to Xbox Live</button>
        </div>
        <div id="push-output" style="margin-top:10px;display:none;background:#0a0a0f;border:1px solid var(--border);border-radius:6px;padding:10px;font-size:11px;color:#aaa;font-family:monospace;white-space:pre-wrap;max-height:200px;overflow-y:auto;"></div>
      </div>
    </div>
  </div>\`;

  // Load manifests into the select
  fetch('/api/manifests').then(r=>r.json()).then(mf => {
    const sel = document.getElementById('manifest-select');
    if (!sel) return;
    mf.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = m.name;
      sel.appendChild(opt);
    });
  });

  document.getElementById('main').innerHTML = html;
}

// ─────────────────────────────────────────────────────────────────────────────
async function applyPlayerEdits() {
  await sendEdits({
    level: document.getElementById('ed-level')?.value,
    money: document.getElementById('ed-money')?.value,
    maxHP: document.getElementById('ed-maxhp')?.value,
  });
}

async function applyWeaponEdits() {
  if (!currentSave?.quickSlots) return;
  const weapons = currentSave.quickSlots.map((w, i) => ({
    idx:        i,
    itemId:     w.itemId,
    craftplanId: w.craftplanId,
    durability: document.getElementById('ws-dur-' + i)?.value ?? w.durability,
    level:      document.getElementById('ws-lvl-' + i)?.value ?? w.itemLevel,
    quantity:   document.getElementById('ws-qty-' + i)?.value ?? w.quantity,
  }));
  await sendEdits({ weapons });
}

async function applyInventoryEdits() {
  const inventory = [];
  document.querySelectorAll('.inv-qty').forEach(el => {
    inventory.push({ itemId: el.dataset.id, quantity: el.value });
  });
  await sendEdits({ inventory });
}

async function maxAllDurability()     { await sendEdits({ maxDurability: true }); }
async function maxStorageDurability() { await sendEdits({ maxStorageDurability: true }); }
// Collectibles
async function unlockAllCollectibles() { await sendEdits({ unlockCollectibles: true }); }
async function lockAllCollectibles()   { await sendEdits({ lockCollectibles: true }); }
// Skills
async function unlockAllSkills()  { await sendEdits({ unlockSkills: true }); }
async function resetAllSkills()   { await sendEdits({ resetSkills: true }); }
// Map fog
async function clearMapFog()  { await sendEdits({ clearMapFog: true }); }
async function fillMapFog()   { await sendEdits({ fillMapFog: true }); }
async function applyStorageEdits() {
  if (!currentSave?.storage) return;
  const storage = currentSave.storage.map((it, i) => ({
    itemId: it.itemId,
    quantity: document.getElementById('stor-qty-' + i)?.value ?? it.quantity,
  }));
  await sendEdits({ storage });
}
async function maxAllAmmo() {
  // Set quantity on all firearm slots
  if (!currentSave?.quickSlots) return;
  const weapons = currentSave.quickSlots.map((w, i) => ({
    idx: i, itemId: w.itemId, craftplanId: w.craftplanId,
    durability: w.durability, level: w.itemLevel,
    quantity: w.durability < 0 ? 999 : w.quantity,
  }));
  await sendEdits({ weapons });
}

function setAllInventory(qty) {
  document.querySelectorAll('.inv-qty').forEach(el => el.value = qty);
}

async function applyPreset(preset) {
  const presets = {
    god:      { level: 60, money: 9999999, maxHP: 9999, maxDurability: true },
    maxmoney: { money: 9999999 },
    maxlevel: { level: 60 },
  };
  if (presets[preset]) await sendEdits(presets[preset]);
}

// ─────────────────────────────────────────────────────────────────────────────
async function sendEdits(edits) {
  if (!currentFile) { showToast('No file selected', true); return; }
  showToast('⏳ Applying edits…', false, true);
  try {
    const res    = await fetch('/api/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: currentFile, edits }),
    });
    const result = await res.json();
    if (result.success) {
      showToast('✔ ' + result.message + '\\n→ ' + result.outPath);
      await loadFileList();
      // Auto-load the edited file
      setTimeout(() => {
        const card = document.querySelector('[data-name="' + result.outPath + '"]');
        loadSave(result.outPath, card);
      }, 200);
    } else {
      showToast(result.error ?? 'Unknown error', true);
    }
  } catch (e) { showToast(e.message, true); }
}

// ─────────────────────────────────────────────────────────────────────────────
function downloadFile(fname) {
  if (!fname) return;
  const a = document.createElement('a');
  a.href = '/api/download?file=' + encodeURIComponent(fname);
  a.download = fname;
  a.click();
}

// ─────────────────────────────────────────────────────────────────────────────
async function pushToXbox(dryRun) {
  if (!currentFile) { showToast('No file selected', true); return; }
  const manifestSel = document.getElementById('manifest-select');
  const manifest    = manifestSel?.value || null;
  const outputEl    = document.getElementById('push-output');

  showToast(dryRun ? '🔍 Running dry run…' : '📡 Pushing to Xbox Live…', false, true);
  if (outputEl) { outputEl.style.display = 'block'; outputEl.textContent = '…'; }

  try {
    const res    = await fetch('/api/push-xbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: currentFile, manifest, dryRun }),
    });
    const result = await res.json();
    if (result.success) {
      showToast(dryRun ? '✔ Dry run OK — check output below' : '✔ Pushed to Xbox Live!');
      if (outputEl) outputEl.textContent = result.output;
    } else {
      showToast((result.error ?? 'Push failed').slice(0, 120), true);
      if (outputEl) outputEl.textContent = result.error ?? result.output ?? 'Unknown error';
    }
  } catch (e) {
    showToast(e.message, true);
    if (outputEl) outputEl.textContent = e.message;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function uploadSave(input) {
  const file = input.files[0];
  if (!file) return;
  showToast('⏳ Uploading ' + file.name + '…', false, true);
  const fd = new FormData();
  fd.append('file', file, file.name);
  try {
    const res    = await fetch('/api/upload', { method: 'POST', body: fd });
    const result = await res.json();
    if (result.success) {
      showToast('✔ Uploaded: ' + result.name + ' (' + (result.size/1024).toFixed(1) + ' KB)');
      await loadFileList();
      setTimeout(() => {
        const card = document.querySelector('[data-name="' + result.name + '"]');
        loadSave(result.name, card);
      }, 200);
    } else {
      showToast(result.error, true);
    }
  } catch (e) { showToast(e.message, true); }
  input.value = '';
}

// ─────────────────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, isError = false, persist = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  if (toastTimer) clearTimeout(toastTimer);
  if (!persist) toastTimer = setTimeout(() => el.className = 'toast', 5000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag & drop on sidebar
document.addEventListener('DOMContentLoaded', () => {
  const sidebar = document.querySelector('.sidebar');
  sidebar.addEventListener('dragover', e => { e.preventDefault(); sidebar.classList.add('drag'); });
  sidebar.addEventListener('dragleave', () => sidebar.classList.remove('drag'));
  sidebar.addEventListener('drop', e => {
    e.preventDefault(); sidebar.classList.remove('drag');
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.bin')) {
      const fakeInput = { files: [file] };
      uploadSave(fakeInput);
    }
  });
});

loadFileList();
</script>
</body>
</html>`;
}
