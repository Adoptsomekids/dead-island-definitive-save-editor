// src/parser/collectibles.ts
// Dead Island DE — Collectibles block parser (ID cards, news, tapes, blueprints)

import { Stream } from "./stream";

export interface CollectiblesData {
  idCards: bigint;       // 64-bit bitmask (64 ID cards)
  news: number;          // 32-bit bitmask (32 news items)
  tapes: number;         // 32-bit bitmask (32 tapes)
  blueprints: bigint[];  // 128-bit bitmask split into 4 × uint32
}

export function parseCollectibles(stream: Stream): CollectiblesData {
  const _blockSize = stream.readUInt32();

  const idCardsLo = stream.readUInt32();
  const idCardsHi = stream.readUInt32();
  const idCards = BigInt(idCardsHi) << 32n | BigInt(idCardsLo);

  const news = stream.readUInt32();
  const tapes = stream.readUInt32();

  const blueprints: bigint[] = [
    BigInt(stream.readUInt32()),
    BigInt(stream.readUInt32()),
    BigInt(stream.readUInt32()),
    BigInt(stream.readUInt32()),
  ];

  return { idCards, news, tapes, blueprints };
}

export function writeCollectibles(stream: Stream, data: CollectiblesData): void {
  const BLOCK_SIZE = 4 + 4 + 4 + 4 + 4 * 4; // id(8) + news(4) + tapes(4) + blueprints(16)
  stream.writeUInt32(BLOCK_SIZE);
  stream.writeUInt32(Number(data.idCards & 0xffffffffn));
  stream.writeUInt32(Number((data.idCards >> 32n) & 0xffffffffn));
  stream.writeUInt32(data.news);
  stream.writeUInt32(data.tapes);
  for (const bp of data.blueprints) stream.writeUInt32(Number(bp & 0xffffffffn));
}

/** Unlock every collectible */
export function unlockAllCollectibles(data: CollectiblesData): CollectiblesData {
  return {
    idCards: 0xffffffffffffffffn,
    news: 0xffffffff,
    tapes: 0xffffffff,
    blueprints: [0xffffffffn, 0xffffffffn, 0xffffffffn, 0xffffffffn],
  };
}
