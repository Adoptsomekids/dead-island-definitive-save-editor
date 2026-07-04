// src/editor/save-editor.ts
// High-level Save Editor API — load, mutate, save

import * as fs from "fs";
import { SaveFile, parseSaveFile, serializeSaveFile } from "../parser/save-file";
import { PlayerData } from "../parser/player";
import { SkillsData, unlockAllSkills, resetSkills } from "../parser/skills";
import { InventoryData, InventoryItem } from "../parser/inventory";
import {
  CollectiblesData,
  unlockAllCollectibles,
} from "../parser/collectibles";

export class SaveEditor {
  private _save: SaveFile | null = null;

  // ── Load / Save ───────────────────────────────────────────────────────────

  async loadFile(filePath: string): Promise<void> {
    const buffer = fs.readFileSync(filePath);
    this._save = await parseSaveFile(buffer);
  }

  async loadBuffer(buffer: Buffer): Promise<void> {
    this._save = await parseSaveFile(buffer);
  }

  async saveFile(filePath: string): Promise<void> {
    const buffer = await this.saveBuffer();
    fs.writeFileSync(filePath, buffer);
  }

  async saveBuffer(): Promise<Buffer> {
    this.assertLoaded();
    return serializeSaveFile(this._save!);
  }

  // ── Player ────────────────────────────────────────────────────────────────

  getPlayer(): PlayerData {
    this.assertLoaded();
    return { ...this._save!.player };
  }

  setPlayer(data: Partial<PlayerData>): void {
    this.assertLoaded();
    this._save!.player = { ...this._save!.player, ...data };
  }

  setGodMode(enabled: boolean): void {
    this.assertLoaded();
    if (enabled) {
      this._save!.player.health = 99999;
      this._save!.player.maxHealth = 99999;
    }
  }

  setMaxLevel(): void {
    this.assertLoaded();
    this._save!.player.level = 60;
    this._save!.player.experience = 9999999;
    this._save!.player.skillPoints = 49; // max allocatable
  }

  setMaxCash(): void {
    this.assertLoaded();
    this._save!.player.cash = 9999999;
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  getSkills(): SkillsData {
    this.assertLoaded();
    return { ...this._save!.skills };
  }

  setSkills(data: Partial<SkillsData>): void {
    this.assertLoaded();
    this._save!.skills = { ...this._save!.skills, ...data };
  }

  unlockAllSkills(): void {
    this.assertLoaded();
    this._save!.skills = unlockAllSkills(this._save!.skills);
  }

  resetSkills(): void {
    this.assertLoaded();
    const { skills, refundedPoints } = resetSkills(
      this._save!.skills,
      this._save!.player.skillPoints
    );
    this._save!.skills = skills;
    this._save!.player.skillPoints = refundedPoints;
  }

  // ── Inventory ─────────────────────────────────────────────────────────────

  getInventory(): InventoryData {
    this.assertLoaded();
    return this._save!.inventory;
  }

  addItem(item: InventoryItem, toStorage: boolean = false): void {
    this.assertLoaded();
    if (toStorage) {
      this._save!.inventory.storageItems.push(item);
    } else {
      this._save!.inventory.items.push(item);
    }
  }

  removeItem(index: number, fromStorage: boolean = false): void {
    this.assertLoaded();
    const list = fromStorage
      ? this._save!.inventory.storageItems
      : this._save!.inventory.items;
    list.splice(index, 1);
  }

  setItemDurability(index: number, durability: number, inStorage: boolean = false): void {
    this.assertLoaded();
    const list = inStorage
      ? this._save!.inventory.storageItems
      : this._save!.inventory.items;
    if (index < 0 || index >= list.length) throw new RangeError(`Item index ${index} out of range`);
    list[index].durability = Math.min(1.0, Math.max(0.0, durability));
  }

  maxAllDurability(): void {
    this.assertLoaded();
    const maxDur = (item: InventoryItem) => { item.durability = 1.0; };
    this._save!.inventory.items.forEach(maxDur);
    this._save!.inventory.storageItems.forEach(maxDur);
  }

  setAmmo(index: number, quantity: number, inStorage: boolean = false): void {
    this.assertLoaded();
    const list = inStorage
      ? this._save!.inventory.storageItems
      : this._save!.inventory.items;
    if (index < 0 || index >= list.length) throw new RangeError(`Item index ${index} out of range`);
    list[index].quantity = Math.min(65535, Math.max(0, quantity));
  }

  // ── Collectibles ──────────────────────────────────────────────────────────

  getCollectibles(): CollectiblesData {
    this.assertLoaded();
    return { ...this._save!.collectibles };
  }

  unlockAllCollectibles(): void {
    this.assertLoaded();
    this._save!.collectibles = unlockAllCollectibles(this._save!.collectibles);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private assertLoaded(): void {
    if (!this._save) throw new Error("No save file loaded. Call loadFile() or loadBuffer() first.");
  }
}
