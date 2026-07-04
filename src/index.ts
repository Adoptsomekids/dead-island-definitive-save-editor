#!/usr/bin/env ts-node
// src/index.ts — CLI entry point for Dead Island DE Save Editor

import * as fs from "fs";
import * as path from "path";
import { SaveEditor } from "./editor/save-editor";
import { loadFromContainer } from "./xbox/container";

const USAGE = `
Dead Island Definitive Edition Save Editor v0.1.0
Usage: npx ts-node src/index.ts [options]

Options:
  --input  <file>          Path to .sav file or Xbox STFS container
  --output <file>          Path to write the modified save (default: <input>.edited)
  --from-container         Treat --input as an Xbox STFS container and extract save
  --god-mode               Set health to max (99999)
  --max-level              Set player level to 60 with max XP and skill points
  --max-cash               Set cash to 9,999,999
  --unlock-skills          Unlock all skills in every tree
  --reset-skills           Reset all skill trees and refund points
  --max-durability         Set all weapons/items to full durability
  --unlock-collectibles    Unlock all ID cards, news, tapes, and blueprints
  --dump                   Print save file contents to stdout (no modification)
  --help                   Show this message
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    console.log(USAGE);
    process.exit(0);
  }

  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const hasFlag = (flag: string) => args.includes(flag);

  const inputPath = getArg("--input");
  if (!inputPath) {
    console.error("Error: --input is required.");
    process.exit(1);
  }

  const outputPath = getArg("--output") ?? inputPath + ".edited";
  const editor = new SaveEditor();

  // Load save
  if (hasFlag("--from-container")) {
    console.log(`Extracting save from Xbox container: ${inputPath}`);
    const { saveBuffer } = loadFromContainer(inputPath);
    await editor.loadBuffer(saveBuffer);
  } else {
    console.log(`Loading save file: ${inputPath}`);
    await editor.loadFile(inputPath);
  }

  // Apply modifications
  if (hasFlag("--god-mode")) {
    editor.setGodMode(true);
    console.log("✔ God mode enabled");
  }
  if (hasFlag("--max-level")) {
    editor.setMaxLevel();
    console.log("✔ Max level applied (60)");
  }
  if (hasFlag("--max-cash")) {
    editor.setMaxCash();
    console.log("✔ Cash set to 9,999,999");
  }
  if (hasFlag("--unlock-skills")) {
    editor.unlockAllSkills();
    console.log("✔ All skills unlocked");
  }
  if (hasFlag("--reset-skills")) {
    editor.resetSkills();
    console.log("✔ Skill trees reset — points refunded");
  }
  if (hasFlag("--max-durability")) {
    editor.maxAllDurability();
    console.log("✔ All item durability maxed");
  }
  if (hasFlag("--unlock-collectibles")) {
    editor.unlockAllCollectibles();
    console.log("✔ All collectibles unlocked");
  }

  if (hasFlag("--dump")) {
    const player = editor.getPlayer();
    const skills = editor.getSkills();
    const inventory = editor.getInventory();
    const collectibles = editor.getCollectibles();
    console.log("\n=== Player ===");
    console.log(JSON.stringify(player, null, 2));
    console.log("\n=== Skills ===");
    console.log(JSON.stringify(skills, null, 2));
    console.log("\n=== Inventory ===");
    console.log(`Items: ${inventory.items.length}, Storage: ${inventory.storageItems.length}`);
    console.log("\n=== Collectibles ===");
    console.log(JSON.stringify(
      { ...collectibles, idCards: collectibles.idCards.toString(16), blueprints: collectibles.blueprints.map(b => b.toString(16)) },
      null,
      2
    ));
    return;
  }

  // Save output
  await editor.saveFile(outputPath);
  console.log(`\n✔ Saved to: ${path.resolve(outputPath)}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
