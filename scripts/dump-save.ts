#!/usr/bin/env ts-node
// scripts/dump-save.ts
// Hex dump + structured analysis helper for Dead Island DE save files

import * as fs from "fs";
import { Stream } from "../src/parser/stream";

const [, , inputPath, limitArg] = process.argv;

if (!inputPath) {
  console.error("Usage: npx ts-node scripts/dump-save.ts <save.sav> [limit-bytes]");
  process.exit(1);
}

const buffer = fs.readFileSync(inputPath);
const limit = limitArg ? parseInt(limitArg, 10) : 256;

console.log(`File: ${inputPath}  (${buffer.length} bytes total)`);
console.log(`Hex dump of first ${Math.min(limit, buffer.length)} bytes:\n`);

// Hex dump
const COLS = 16;
for (let i = 0; i < Math.min(limit, buffer.length); i += COLS) {
  const row = buffer.slice(i, i + COLS);
  const hex = Array.from(row)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ")
    .padEnd(COLS * 3 - 1, " ");
  const ascii = Array.from(row)
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
    .join("");
  console.log(`${i.toString(16).padStart(8, "0").toUpperCase()}  ${hex}  |${ascii}|`);
}

// Try to read header fields
console.log("\n=== Interpreted Header (little-endian) ===");
const s = new Stream(buffer);
try {
  console.log(`Magic      : 0x${s.readUInt32().toString(16).toUpperCase().padStart(8, "0")} (should be 0x45534944 = "DISE")`);
  console.log(`Version    : ${s.readUInt32()}`);
  console.log(`Platform   : ${s.readUInt32()} (0=PC 1=Xbox 2=PS)`);
  console.log(`Checksum   : 0x${s.readUInt32().toString(16).toUpperCase().padStart(8, "0")}`);
  console.log(`Data size  : ${s.readUInt32()} bytes`);
  console.log(`Flags      : 0x${s.readUInt32().toString(16).padStart(8, "0")} (bit0=zstd)`);
} catch {
  console.log("(Could not fully parse header — file may use a different format)");
}
