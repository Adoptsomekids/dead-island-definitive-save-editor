// tests/editor.test.ts
import { SaveEditor } from "../src/editor/save-editor";
import { Stream } from "../src/parser/stream";
import { SAVE_MAGIC, SAVE_VERSION } from "../src/parser/save-file";
import { crc32 } from "../src/crypto/crc32";

function buildMinimalSave(): Buffer {
  // Build a minimal but valid save buffer
  const data = Stream.reserve(512);

  // Player block (112 + 4 for block size)
  data.writeUInt32(112); // block size
  data.writeUInt32(0);   // characterClass = Xian
  data.writeFloat(100);  // health
  data.writeFloat(100);  // maxHealth
  data.writeUInt32(0);   // xp
  data.writeUInt32(1);   // level
  data.writeUInt32(5);   // skillPoints
  data.writeFloat(1000); // cash
  data.writeBytes(Buffer.alloc(16)); // guid
  data.writeString("TestChar", 64);  // name

  // Skills block
  data.writeUInt32(24); // 6 × uint32
  data.writeUInt32(0);  // fury
  data.writeUInt32(0);  // power
  data.writeUInt32(0);  // survival
  data.writeUInt32(0);  data.writeUInt32(0);  data.writeUInt32(0);

  // Inventory block (empty)
  data.writeUInt32(8); // block size: itemCount + storageCount
  data.writeUInt32(0); // itemCount
  data.writeUInt32(0); // storageCount

  // Collectibles block
  data.writeUInt32(28); // 4+4+4+4*4
  data.writeUInt32(0);  data.writeUInt32(0); // idCards
  data.writeUInt32(0);  // news
  data.writeUInt32(0);  // tapes
  data.writeUInt32(0);  data.writeUInt32(0); data.writeUInt32(0); data.writeUInt32(0); // blueprints

  const dataBuffer = data.getBuffer().slice(0, data.position);
  const checksum = crc32(dataBuffer);

  const header = Stream.reserve(24 + dataBuffer.length);
  header.writeUInt32(SAVE_MAGIC);
  header.writeUInt32(SAVE_VERSION);
  header.writeUInt32(1);           // platformFlags = Xbox
  header.writeUInt32(checksum);
  header.writeUInt32(dataBuffer.length);
  header.writeUInt32(0);           // flags = no compression
  header.writeBytes(dataBuffer);

  return header.getBuffer().slice(0, header.position);
}

describe("SaveEditor", () => {
  test("loads a minimal save buffer without errors", async () => {
    const editor = new SaveEditor();
    await expect(editor.loadBuffer(buildMinimalSave())).resolves.not.toThrow();
  });

  test("getPlayer returns correct initial values", async () => {
    const editor = new SaveEditor();
    await editor.loadBuffer(buildMinimalSave());
    const player = editor.getPlayer();
    expect(player.level).toBe(1);
    expect(player.characterClass).toBe(0);
    expect(player.playerName).toBe("TestChar");
  });

  test("setGodMode sets health to 99999", async () => {
    const editor = new SaveEditor();
    await editor.loadBuffer(buildMinimalSave());
    editor.setGodMode(true);
    expect(editor.getPlayer().health).toBe(99999);
  });

  test("setMaxLevel sets level to 60", async () => {
    const editor = new SaveEditor();
    await editor.loadBuffer(buildMinimalSave());
    editor.setMaxLevel();
    expect(editor.getPlayer().level).toBe(60);
  });

  test("unlockAllSkills sets all tree bitmasks to 0xFFFFFFFF", async () => {
    const editor = new SaveEditor();
    await editor.loadBuffer(buildMinimalSave());
    editor.unlockAllSkills();
    const skills = editor.getSkills();
    expect(skills.furyTree).toBe(0xffffffff);
    expect(skills.powerTree).toBe(0xffffffff);
    expect(skills.survivalTree).toBe(0xffffffff);
  });

  test("unlockAllCollectibles sets all bitmasks to max", async () => {
    const editor = new SaveEditor();
    await editor.loadBuffer(buildMinimalSave());
    editor.unlockAllCollectibles();
    const c = editor.getCollectibles();
    expect(c.news).toBe(0xffffffff);
    expect(c.tapes).toBe(0xffffffff);
  });

  test("saveBuffer produces a re-loadable save", async () => {
    const editor = new SaveEditor();
    await editor.loadBuffer(buildMinimalSave());
    editor.setGodMode(true);
    const buf = await editor.saveBuffer();
    const editor2 = new SaveEditor();
    await expect(editor2.loadBuffer(buf)).resolves.not.toThrow();
    expect(editor2.getPlayer().health).toBe(99999);
  });

  test("throws if loadBuffer not called before getPlayer", () => {
    const editor = new SaveEditor();
    expect(() => editor.getPlayer()).toThrow("No save file loaded");
  });
});
