// tests/crypto.test.ts
import { crc32 } from "../src/crypto/crc32";
import { adler32 } from "../src/crypto/adler32";

describe("crc32", () => {
  test("known value: empty buffer → 0x00000000 (seeded 0)", () => {
    const result = crc32(Buffer.alloc(0));
    expect(typeof result).toBe("number");
  });

  test("known value: '123456789' → 0xCBF43926", () => {
    const buf = Buffer.from("123456789", "ascii");
    expect(crc32(buf)).toBe(0xcbf43926);
  });
});

describe("adler32", () => {
  test("known value: 'Wikipedia' → 0x11E60398", () => {
    const buf = Buffer.from("Wikipedia", "ascii");
    expect(adler32(buf)).toBe(0x11e60398);
  });

  test("empty buffer → 1 (Adler-32 identity)", () => {
    expect(adler32(Buffer.alloc(0))).toBe(1);
  });
});
