// src/parser/skills.ts
// Dead Island DE — Skills block parser

import { Stream } from "./stream";

export interface SkillsData {
  furyTree: number;       // bitmask, 1 bit per skill
  powerTree: number;
  survivalTree: number;
  spentFury: number;
  spentPower: number;
  spentSurvival: number;
}

export function parseSkills(stream: Stream): SkillsData {
  const _blockSize = stream.readUInt32();
  const furyTree = stream.readUInt32();
  const powerTree = stream.readUInt32();
  const survivalTree = stream.readUInt32();
  const spentFury = stream.readUInt32();
  const spentPower = stream.readUInt32();
  const spentSurvival = stream.readUInt32();
  return { furyTree, powerTree, survivalTree, spentFury, spentPower, spentSurvival };
}

export function writeSkills(stream: Stream, data: SkillsData): void {
  const BLOCK_SIZE = 6 * 4; // 6 × uint32
  stream.writeUInt32(BLOCK_SIZE);
  stream.writeUInt32(data.furyTree);
  stream.writeUInt32(data.powerTree);
  stream.writeUInt32(data.survivalTree);
  stream.writeUInt32(data.spentFury);
  stream.writeUInt32(data.spentPower);
  stream.writeUInt32(data.spentSurvival);
}

/** Unlock all skills in every tree */
export function unlockAllSkills(data: SkillsData): SkillsData {
  return {
    ...data,
    furyTree: 0xffffffff,
    powerTree: 0xffffffff,
    survivalTree: 0xffffffff,
  };
}

/** Reset all skill trees — refund all spent points */
export function resetSkills(data: SkillsData, playerSkillPoints: number): { skills: SkillsData; refundedPoints: number } {
  const refunded = data.spentFury + data.spentPower + data.spentSurvival;
  return {
    skills: {
      furyTree: 0,
      powerTree: 0,
      survivalTree: 0,
      spentFury: 0,
      spentPower: 0,
      spentSurvival: 0,
    },
    refundedPoints: playerSkillPoints + refunded,
  };
}
