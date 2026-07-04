// src/parser/player.ts
// Dead Island DE — Player data block parser

import { Stream } from "./stream";

export interface PlayerData {
  characterClass: number;   // 0=Xian, 1=Sam, 2=Purna, 3=Logan
  health: number;           // current HP
  maxHealth: number;
  experience: number;
  level: number;            // 1–60
  skillPoints: number;
  cash: number;
  playerGuid: Buffer;       // 16 bytes
  playerName: string;
}

export const CHARACTER_CLASS: Record<number, string> = {
  0: "Xian Mei",
  1: "Sam B",
  2: "Purna",
  3: "Logan Carter",
};

export function parsePlayerData(stream: Stream): PlayerData {
  const _blockSize = stream.readUInt32();  // consume block size
  const characterClass = stream.readUInt32();
  const health = stream.readFloat();
  const maxHealth = stream.readFloat();
  const experience = stream.readUInt32();
  const level = stream.readUInt32();
  const skillPoints = stream.readUInt32();
  const cash = stream.readFloat();
  const playerGuid = stream.readBytes(16);
  const playerName = stream.readString(64);

  return {
    characterClass,
    health,
    maxHealth,
    experience,
    level,
    skillPoints,
    cash,
    playerGuid,
    playerName,
  };
}

export function writePlayerData(stream: Stream, data: PlayerData): void {
  // Block size = 4+4+4+4+4+4+4+16+64 = 112 bytes of payload
  const BLOCK_SIZE = 112;
  stream.writeUInt32(BLOCK_SIZE);
  stream.writeUInt32(data.characterClass);
  stream.writeFloat(data.health);
  stream.writeFloat(data.maxHealth);
  stream.writeUInt32(data.experience);
  stream.writeUInt32(data.level);
  stream.writeUInt32(data.skillPoints);
  stream.writeFloat(data.cash);
  stream.writeBytes(data.playerGuid);
  stream.writeString(data.playerName, 64);
}
