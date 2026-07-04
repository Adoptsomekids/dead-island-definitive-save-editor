// src/xbox/container.ts
// Xbox save container — high-level wrapper over STFS parser.
// Identifies the Dead Island save blob within a profile container.

import * as fs from "fs";
import { parseStfsHeader, extractFileByName, StfsHeader } from "./stfs";

// Known Dead Island DE title IDs
export const DEAD_ISLAND_DE_TITLE_ID = 0x534307D4;    // Xbox 360 / One / Series X
export const DEAD_ISLAND_RIPTIDE_TITLE_ID = 0x534307D5;

// Known save file names (heuristic search terms)
const SAVE_FILE_NAMES = ["deadisland", "savegame", "profile", "player"];

export interface XboxSaveContainer {
  header: StfsHeader;
  saveBuffer: Buffer;
}

/**
 * Load a Dead Island DE save from an Xbox STFS container file.
 * Parses the package header, validates the title ID, and extracts the save blob.
 */
export function loadFromContainer(containerPath: string): XboxSaveContainer {
  if (!fs.existsSync(containerPath)) {
    throw new Error(`Container file not found: ${containerPath}`);
  }

  const buffer = fs.readFileSync(containerPath);
  const header = parseStfsHeader(buffer);

  if (
    header.titleId !== DEAD_ISLAND_DE_TITLE_ID &&
    header.titleId !== DEAD_ISLAND_RIPTIDE_TITLE_ID
  ) {
    console.warn(
      `Warning: Title ID 0x${header.titleId.toString(16).toUpperCase()} ` +
      `does not match known Dead Island DE IDs. Proceeding anyway.`
    );
  }

  // Try to find the save blob
  let saveBuffer: Buffer | null = null;
  for (const name of SAVE_FILE_NAMES) {
    saveBuffer = extractFileByName(buffer, name);
    if (saveBuffer) break;
  }

  // Fallback: if STFS parsing is incomplete, return the entire payload section
  if (!saveBuffer) {
    console.warn(
      "Could not locate named save entry in STFS table. " +
      "Returning raw container buffer for manual inspection."
    );
    saveBuffer = buffer;
  }

  return { header, saveBuffer };
}

/**
 * Write a modified save blob back into an STFS container.
 * NOTE: Re-signing the STFS header requires the console's private key (CON)
 * or Xbox Live signing (LIVE/PIRS). For offline/modded use, resign with
 * a tool like Horizon or Velocity after calling this function.
 */
export function patchContainer(
  originalContainerPath: string,
  newSaveBuffer: Buffer,
  outputPath: string
): void {
  const original = fs.readFileSync(originalContainerPath);

  // Re-inject save buffer into the data area at the same offset (heuristic)
  // A proper implementation requires STFS block chain rewriting.
  const patched = Buffer.from(original);
  const DATA_AREA_OFFSET = 0xC000;
  newSaveBuffer.copy(patched, DATA_AREA_OFFSET);

  fs.writeFileSync(outputPath, patched);
  console.log(`Patched container written to: ${outputPath}`);
  console.log("IMPORTANT: Re-sign the container with Horizon/Velocity before copying to Xbox.");
}
