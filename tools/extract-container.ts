#!/usr/bin/env ts-node
// tools/extract-container.ts
// CLI tool: extract the raw save blob from an Xbox STFS container

import * as fs from "fs";
import * as path from "path";
import { loadFromContainer } from "../src/xbox/container";

const [, , inputArg, outputArg] = process.argv;

if (!inputArg) {
  console.error("Usage: npx ts-node tools/extract-container.ts <container-file> [output.sav]");
  process.exit(1);
}

const outputPath = outputArg ?? path.basename(inputArg) + ".extracted.sav";

try {
  console.log(`Opening STFS container: ${inputArg}`);
  const { header, saveBuffer } = loadFromContainer(inputArg);

  console.log(`  Display name : ${header.displayName}`);
  console.log(`  Title ID     : 0x${header.titleId.toString(16).toUpperCase()}`);
  console.log(`  Content type : 0x${header.contentType.toString(16).toUpperCase()}`);
  console.log(`  Save size    : ${saveBuffer.length} bytes`);

  fs.writeFileSync(outputPath, saveBuffer);
  console.log(`\n✔ Save blob extracted to: ${path.resolve(outputPath)}`);
} catch (err: any) {
  console.error("Error:", err.message);
  process.exit(1);
}
