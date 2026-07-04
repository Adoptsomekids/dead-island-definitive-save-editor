// src/parser/inventory.ts
// Dead Island DE — Inventory block parser

import { Stream } from "./stream";

export interface InventoryItem {
  itemId: number;
  durability: number;     // 0.0 – 1.0
  quantity: number;       // ammo count or stack size
  quickSlot: number;      // 0-3 or 0xFF = not assigned
  flags: number;
  modSlots: [number, number, number, number]; // item IDs of mods, 0 = empty
  upgradeTier: number;
}

export interface InventoryData {
  items: InventoryItem[];
  storageItems: InventoryItem[];
}

function readItem(stream: Stream): InventoryItem {
  const itemId = stream.readUInt32();
  const durability = stream.readFloat();
  const quantity = stream.readUInt16();
  const quickSlot = stream.readByte();
  const flags = stream.readByte();
  const modSlots: [number, number, number, number] = [
    stream.readUInt32(),
    stream.readUInt32(),
    stream.readUInt32(),
    stream.readUInt32(),
  ];
  const upgradeTier = stream.readFloat();
  return { itemId, durability, quantity, quickSlot, flags, modSlots, upgradeTier };
}

function writeItem(stream: Stream, item: InventoryItem): void {
  stream.writeUInt32(item.itemId);
  stream.writeFloat(item.durability);
  stream.writeUInt16(item.quantity);
  stream.writeByte(item.quickSlot);
  stream.writeByte(item.flags);
  stream.writeUInt32(item.modSlots[0]);
  stream.writeUInt32(item.modSlots[1]);
  stream.writeUInt32(item.modSlots[2]);
  stream.writeUInt32(item.modSlots[3]);
  stream.writeFloat(item.upgradeTier);
}

export function parseInventory(stream: Stream): InventoryData {
  const _blockSize = stream.readUInt32();
  const itemCount = stream.readUInt32();
  const storageCount = stream.readUInt32();

  const items: InventoryItem[] = [];
  for (let i = 0; i < itemCount; i++) {
    items.push(readItem(stream));
  }

  const storageItems: InventoryItem[] = [];
  for (let i = 0; i < storageCount; i++) {
    storageItems.push(readItem(stream));
  }

  return { items, storageItems };
}

export function writeInventory(stream: Stream, data: InventoryData): void {
  // Each item = 4+4+2+1+1+16+4 = 32 bytes
  const ITEM_SIZE = 32;
  const blockSize =
    4 + // itemCount
    4 + // storageCount
    data.items.length * ITEM_SIZE +
    data.storageItems.length * ITEM_SIZE;

  stream.writeUInt32(blockSize);
  stream.writeUInt32(data.items.length);
  stream.writeUInt32(data.storageItems.length);
  for (const item of data.items) writeItem(stream, item);
  for (const item of data.storageItems) writeItem(stream, item);
}
