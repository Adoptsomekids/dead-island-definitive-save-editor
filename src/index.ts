#!/usr/bin/env ts-node
// src/index.ts
// Dead Island DE Save Editor — Programmatic API entry point
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │  NOTE: The main CLI is tools/save-sync.ts (download/edit/upload saves)  │
// │  The web editor is tools/web-editor-server.ts (browser UI on port 3000) │
// └─────────────────────────────────────────────────────────────────────────┘
//
// This file re-exports the public API for programmatic use:
//
//   import { SaveEditor } from "dead-island-definitive-save-editor";
//
//   const editor = new SaveEditor();
//   editor.loadFile("./saves/save_1.sav_dec.bin");
//   editor.setGodMode().setMaxMoney().setLevel(60).maxAllWeaponDurability();
//   editor.saveFile("./saves/save_1_modded.bin");

// ── Public API ────────────────────────────────────────────────────────────────

// Core editor class
export { SaveEditor, PlayerInfo, EditOptions } from "./editor/save-editor";

// Low-level parser + interfaces
export {
  parseSaveFile,
  serializeSaveFile,
  maybeDecompress,
  gzipCompress,
  detectPreambleSize,
  setMoney,
  setLevel,
  setHP,
  maxAllWeaponDurability,
  maxAllInventory,
  maxStorageDurability,
  setInventoryItemQty,
  setStorageItemQty,
  setStorageItem,
  replaceQuickSlotWeapon,
  setHeldWeapon,
  // Collectibles + fog + skills
  parseCollectibles,
  unlockAllCollectibles,
  lockAllCollectibles,
  getMapFogData,
  clearMapFog,
  fillMapFog,
  unlockAllSkills,
  resetAllSkills,
  RAW_TAIL_OFFSETS,
  CHARACTER_CLASS,
  CHARACTER_CLASS_BY_KEY,
  WEAPON_PREAMBLE_SIZE,
  KNOWN_PREAMBLE_SIZES,
} from "./parser/save-file";

// Types
export type {
  SaveFile,
  SaveHeader,
  SaveLocation,
  WeaponItem,
  InventoryItem,
  StorageItem,
  SkillEntry,
} from "./parser/save-file";

// Xbox container (STFS — for Xbox 360 / Legacy saves)
export { loadFromContainer, patchContainer } from "./xbox/container";
