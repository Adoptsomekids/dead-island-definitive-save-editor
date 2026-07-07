// src/editor/save-editor.ts
// Dead Island DE — High-level Save Editor API (v2)
//
// Wraps the low-level parser/serializer with a convenient class-based API.
// All property access is strongly typed against the real SaveFile structure.

import * as fs from "fs";
import {
  SaveFile,
  SaveHeader,
  SaveLocation,
  WeaponItem,
  InventoryItem,
  StorageItem,
  CHARACTER_CLASS,
  parseSaveFile,
  serializeSaveFile,
  maybeDecompress,
  gzipCompress,
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
} from "../parser/save-file";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlayerInfo {
  level: number;
  maxHP: number;
  currHP: number;
  money: number;
  charName: string;
  charClassId: number;
  mapName: string;
  checkpoint: string;
  saveDate: string;
  saveTime: string;
}

export interface EditOptions {
  /** Set wallet amount (0–9,999,999) */
  money?: number;
  /** Set player level (1–60) */
  level?: number;
  /** Set max HP */
  maxHP?: number;
  /** Set current HP (defaults to maxHP if omitted) */
  currHP?: number;
  /** Max out all weapon durability */
  maxAllWeaponDurability?: boolean;
  /** Max out all inventory item quantities */
  maxAllInventory?: boolean;
  /** Max out all storage weapon durability */
  maxStorageDurability?: boolean;
}

// ─── SaveEditor class ─────────────────────────────────────────────────────────

export class SaveEditor {
  private _save: SaveFile | null = null;
  private _wasGzipped = false;

  // ── Load ───────────────────────────────────────────────────────────────────

  /** Load a save file from disk. Auto-detects gzip compression. */
  loadFile(filePath: string): void {
    const raw = fs.readFileSync(filePath);
    this._wasGzipped = raw[0] === 0x1f && raw[1] === 0x8b;
    const dec = maybeDecompress(raw);
    this._save = parseSaveFile(dec);
  }

  /** Load a save from a Buffer. Auto-detects gzip compression. */
  loadBuffer(buffer: Buffer): void {
    this._wasGzipped = buffer[0] === 0x1f && buffer[1] === 0x8b;
    const dec = maybeDecompress(buffer);
    this._save = parseSaveFile(dec);
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  /**
   * Serialize the current state to a Buffer.
   * Re-applies gzip compression if the original was gzipped.
   */
  toBuffer(): Buffer {
    this.assertLoaded();
    const raw = serializeSaveFile(this._save!);
    return this._wasGzipped ? gzipCompress(raw) : raw;
  }

  /** Write the current state to disk. */
  saveFile(filePath: string): void {
    fs.writeFileSync(filePath, this.toBuffer());
  }

  // ── Read-only accessors ────────────────────────────────────────────────────

  get header(): Readonly<SaveHeader> {
    this.assertLoaded();
    return this._save!.header;
  }

  get location(): Readonly<SaveLocation> {
    this.assertLoaded();
    return this._save!.location;
  }

  get heldWeapon(): Readonly<WeaponItem> {
    this.assertLoaded();
    return this._save!.heldWeapon;
  }

  get quickSlots(): ReadonlyArray<WeaponItem> {
    this.assertLoaded();
    return this._save!.quickSlots;
  }

  get inventory(): ReadonlyArray<InventoryItem> {
    this.assertLoaded();
    return this._save!.inventory;
  }

  get storage(): ReadonlyArray<StorageItem> {
    this.assertLoaded();
    return this._save!.storage;
  }

  get rawTail(): Buffer {
    this.assertLoaded();
    return this._save!.rawTail;
  }

  get parseError(): string | undefined {
    this.assertLoaded();
    return this._save!._parseError;
  }

  /** True if the file was gzip-compressed (all Xbox Live atoms are). */
  get wasGzipped(): boolean { return this._wasGzipped; }

  // ── Player convenience ─────────────────────────────────────────────────────

  /** Returns a summary of key player attributes. */
  getPlayerInfo(): PlayerInfo {
    this.assertLoaded();
    const h = this._save!.header;
    const l = this._save!.location;
    return {
      level:       h.level,
      maxHP:       h.maxHP,
      currHP:      h.currHP,
      money:       l.money,
      charName:    CHARACTER_CLASS[l.charClassId] ?? `Unknown(${l.charClassId})`,
      charClassId: l.charClassId,
      mapName:     l.mapName,
      checkpoint:  l.checkpoint,
      saveDate:    `${l.saveYear}-${String(l.saveMonth).padStart(2,"0")}-${String(l.saveDay||1).padStart(2,"0")}`,
      saveTime:    `${String(l.saveHour).padStart(2,"0")}:${String(l.saveMinute).padStart(2,"0")}`,
    };
  }

  // ── Player edits ───────────────────────────────────────────────────────────

  /** Set the player's wallet amount (0–9,999,999). */
  setMoney(amount: number): this {
    this.assertLoaded();
    this._save = setMoney(this._save!, amount);
    return this;
  }

  /** Set the player level (1–60). */
  setLevel(level: number): this {
    this.assertLoaded();
    this._save = setLevel(this._save!, level);
    return this;
  }

  /** Set current and max HP. */
  setHP(maxHP: number, currHP?: number): this {
    this.assertLoaded();
    this._save = setHP(this._save!, maxHP, currHP);
    return this;
  }

  /** Convenience: apply god-mode level HP. */
  setGodMode(): this {
    return this.setHP(99999, 99999);
  }

  /** Convenience: set max money ($9,999,999). */
  setMaxMoney(): this {
    return this.setMoney(9_999_999);
  }

  /** Convenience: set max level (60). */
  setMaxLevel(): this {
    return this.setLevel(60);
  }

  // ── Weapon edits ───────────────────────────────────────────────────────────

  /** Update the held (equipped) weapon's properties. */
  editHeldWeapon(changes: Partial<Pick<WeaponItem, "itemId"|"craftplanId"|"durability"|"quantity"|"itemLevel">>): this {
    this.assertLoaded();
    this._save = setHeldWeapon(this._save!, changes);
    return this;
  }

  /** Replace a quick-slot weapon by index (0-based). */
  replaceQuickSlotWeapon(
    idx: number,
    itemId: string,
    craftplanId = "",
    level = 3,
    durability = 100.0,
    quantity = 1
  ): this {
    this.assertLoaded();
    this._save = replaceQuickSlotWeapon(this._save!, idx, itemId, craftplanId, level, durability, quantity);
    return this;
  }

  /** Max out durability on all equipped and quick-slot weapons. */
  maxAllWeaponDurability(): this {
    this.assertLoaded();
    this._save = maxAllWeaponDurability(this._save!);
    return this;
  }

  // ── Inventory edits ────────────────────────────────────────────────────────

  /** Set the quantity of a specific inventory item by itemId. */
  setInventoryItemQty(itemId: string, quantity: number): this {
    this.assertLoaded();
    this._save = setInventoryItemQty(this._save!, itemId, quantity);
    return this;
  }

  /** Max out all stackable inventory item quantities (999 each). */
  maxAllInventory(maxQty = 999): this {
    this.assertLoaded();
    this._save = maxAllInventory(this._save!, maxQty);
    return this;
  }

  // ── Storage chest edits ────────────────────────────────────────────────────

  /** Set the quantity of a storage chest item by itemId. */
  setStorageItemQty(itemId: string, quantity: number): this {
    this.assertLoaded();
    this._save = setStorageItemQty(this._save!, itemId, quantity);
    return this;
  }

  /** Max out durability on all storage chest weapons. */
  maxStorageDurability(): this {
    this.assertLoaded();
    this._save = maxStorageDurability(this._save!);
    return this;
  }

  /** Add or update a storage chest item. */
  setStorageItem(
    itemId: string,
    craftplanId: string,
    quantity: number,
    durability: number,
    itemLevel: number,
    itemUID = 0
  ): this {
    this.assertLoaded();
    this._save = setStorageItem(this._save!, itemId, craftplanId, quantity, durability, itemLevel, itemUID);
    return this;
  }

  // ── Batch edits ────────────────────────────────────────────────────────────

  /**
   * Apply multiple edits in one call. Returns a summary of applied changes.
   * Example:
   *   editor.applyEdits({ money: 9999999, level: 60, maxAllWeaponDurability: true })
   */
  applyEdits(opts: EditOptions): string[] {
    this.assertLoaded();
    const changes: string[] = [];

    if (opts.money !== undefined) {
      this.setMoney(opts.money);
      changes.push(`money → $${opts.money.toLocaleString()}`);
    }
    if (opts.level !== undefined) {
      this.setLevel(opts.level);
      changes.push(`level → ${opts.level}`);
    }
    if (opts.maxHP !== undefined) {
      this.setHP(opts.maxHP, opts.currHP);
      changes.push(`HP → ${opts.maxHP}/${opts.currHP ?? opts.maxHP}`);
    }
    if (opts.maxAllWeaponDurability) {
      this.maxAllWeaponDurability();
      changes.push("all weapon durability → 100");
    }
    if (opts.maxAllInventory) {
      this.maxAllInventory();
      changes.push("all inventory qty → 999");
    }
    if (opts.maxStorageDurability) {
      this.maxStorageDurability();
      changes.push("all storage durability → 100");
    }

    return changes;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private assertLoaded(): void {
    if (!this._save) {
      throw new Error("No save file loaded. Call loadFile() or loadBuffer() first.");
    }
  }
}
