// tests/stream.test.ts
import { Stream, SeekOrigin } from "../src/parser/stream";

describe("Stream", () => {
  test("readUInt32 / writeUInt32 round-trip (LE)", () => {
    const s = Stream.reserve(4);
    s.writeUInt32(0xDEADBEEF);
    s.seek(0);
    expect(s.readUInt32()).toBe(0xDEADBEEF);
  });

  test("readFloat / writeFloat round-trip", () => {
    const s = Stream.reserve(4);
    s.writeFloat(1.5);
    s.seek(0);
    expect(s.readFloat()).toBeCloseTo(1.5, 5);
  });

  test("readString / writeString round-trip (null-terminated)", () => {
    const s = Stream.reserve(64);
    s.writeString("TestPlayer", 64);
    s.seek(0);
    expect(s.readString(64)).toBe("TestPlayer");
  });

  test("readBytes / writeBytes round-trip", () => {
    const data = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const s = Stream.reserve(4);
    s.writeBytes(data);
    s.seek(0);
    const read = s.readBytes(4);
    expect(read).toEqual(data);
  });

  test("seek from Begin / Current / End", () => {
    const s = Stream.alloc(16);
    s.seek(4);
    expect(s.position).toBe(4);
    s.seek(2, SeekOrigin.Current);
    expect(s.position).toBe(6);
    s.seek(-4, SeekOrigin.End);
    expect(s.position).toBe(12);
  });

  test("auto-expansion on overflow write", () => {
    const s = Stream.alloc(2);
    s.writeUInt32(0xCAFEBABE); // 4 bytes into a 2-byte buffer
    s.seek(0);
    expect(s.readUInt32()).toBe(0xCAFEBABE);
  });
});
