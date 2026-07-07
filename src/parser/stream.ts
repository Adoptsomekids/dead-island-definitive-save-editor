// src/parser/stream.ts
// Binary stream reader/writer — position-aware, little-endian by default.
// Inspired by the libvantage Stream class.

export enum SeekOrigin {
  Begin = 0,
  Current = 1,
  End = 2,
}

export class Stream {
  private _buffer: Buffer;
  private _position: number = 0;

  constructor(buffer: Buffer) {
    this._buffer = buffer;
  }

  // ── Factory ──────────────────────────────────────────────────────────────

  static alloc(size: number): Stream {
    return new Stream(Buffer.alloc(size));
  }

  static reserve(initialSize: number = 256): Stream {
    const s = new Stream(Buffer.alloc(initialSize));
    (s as any)._position = 0;
    return s;
  }

  static from(buf: Buffer): Stream {
    return new Stream(buf);
  }

  // ── Properties ───────────────────────────────────────────────────────────

  get position(): number {
    return this._position;
  }

  set position(v: number) {
    this._position = v;
  }

  get length(): number {
    return this._buffer.length;
  }

  get remaining(): number {
    return this._buffer.length - this._position;
  }

  getBuffer(): Buffer {
    return this._buffer;
  }

  // ── Seek ─────────────────────────────────────────────────────────────────

  seek(offset: number, origin: SeekOrigin = SeekOrigin.Begin): this {
    switch (origin) {
      case SeekOrigin.Begin:
        this._position = offset;
        break;
      case SeekOrigin.Current:
        this._position += offset;
        break;
      case SeekOrigin.End:
        this._position = this._buffer.length + offset;
        break;
    }
    return this;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  readByte(): number {
    const v = this._buffer.readUInt8(this._position);
    this._position += 1;
    return v;
  }

  readBoolean(): boolean {
    return this.readByte() !== 0;
  }

  readBytes(length: number): Buffer {
    const slice = this._buffer.slice(this._position, this._position + length);
    this._position += length;
    return slice;
  }

  readToEnd(): Buffer {
    return this.readBytes(this.remaining);
  }

  readUInt16(littleEndian: boolean = true): number {
    const v = littleEndian
      ? this._buffer.readUInt16LE(this._position)
      : this._buffer.readUInt16BE(this._position);
    this._position += 2;
    return v;
  }

  readInt16(littleEndian: boolean = true): number {
    const v = littleEndian
      ? this._buffer.readInt16LE(this._position)
      : this._buffer.readInt16BE(this._position);
    this._position += 2;
    return v;
  }

  readUInt32(littleEndian: boolean = true): number {
    const v = littleEndian
      ? this._buffer.readUInt32LE(this._position)
      : this._buffer.readUInt32BE(this._position);
    this._position += 4;
    return v;
  }

  readInt32(littleEndian: boolean = true): number {
    const v = littleEndian
      ? this._buffer.readInt32LE(this._position)
      : this._buffer.readInt32BE(this._position);
    this._position += 4;
    return v;
  }

  readFloat(littleEndian: boolean = true): number {
    const v = littleEndian
      ? this._buffer.readFloatLE(this._position)
      : this._buffer.readFloatBE(this._position);
    this._position += 4;
    return v;
  }

  readDouble(littleEndian: boolean = true): number {
    const v = littleEndian
      ? this._buffer.readDoubleLE(this._position)
      : this._buffer.readDoubleBE(this._position);
    this._position += 8;
    return v;
  }

  /** Read a null-terminated or fixed-length string */
  readString(maxBytes: number, encoding: BufferEncoding = "utf8"): string {
    const bytes = this.readBytes(maxBytes);
    const nullIdx = bytes.indexOf(0);
    return bytes.slice(0, nullIdx >= 0 ? nullIdx : maxBytes).toString(encoding);
  }

  /**
   * Read a DI-style length-prefixed string:
   *   [uint16 LE length][UTF-8 bytes × length]
   */
  readWStr(): string {
    const len = this.readUInt16();
    if (len === 0) return "";
    return this.readBytes(len).toString("utf8");
  }

  /** Read a length-prefixed string (uint32 length + data) */
  readLPString(encoding: BufferEncoding = "utf8"): string {
    const len = this.readUInt32();
    return this.readBytes(len).toString(encoding);
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  private ensureCapacity(needed: number): void {
    const available = this._buffer.length - this._position;
    if (available < needed) {
      const newSize = Math.max(
        this._buffer.length * 2,
        this._buffer.length + needed
      );
      const newBuf = Buffer.alloc(newSize);
      this._buffer.copy(newBuf);
      this._buffer = newBuf;
    }
  }

  writeByte(value: number): this {
    this.ensureCapacity(1);
    this._buffer.writeUInt8(value & 0xff, this._position);
    this._position += 1;
    return this;
  }

  writeBoolean(value: boolean): this {
    return this.writeByte(value ? 1 : 0);
  }

  writeBytes(data: Buffer): this {
    this.ensureCapacity(data.length);
    data.copy(this._buffer, this._position);
    this._position += data.length;
    return this;
  }

  writeUInt16(value: number, littleEndian: boolean = true): this {
    this.ensureCapacity(2);
    if (littleEndian) this._buffer.writeUInt16LE(value, this._position);
    else this._buffer.writeUInt16BE(value, this._position);
    this._position += 2;
    return this;
  }

  writeInt16(value: number, littleEndian: boolean = true): this {
    this.ensureCapacity(2);
    if (littleEndian) this._buffer.writeInt16LE(value, this._position);
    else this._buffer.writeInt16BE(value, this._position);
    this._position += 2;
    return this;
  }

  writeUInt32(value: number, littleEndian: boolean = true): this {
    this.ensureCapacity(4);
    if (littleEndian) this._buffer.writeUInt32LE(value >>> 0, this._position);
    else this._buffer.writeUInt32BE(value >>> 0, this._position);
    this._position += 4;
    return this;
  }

  writeInt32(value: number, littleEndian: boolean = true): this {
    this.ensureCapacity(4);
    if (littleEndian) this._buffer.writeInt32LE(value, this._position);
    else this._buffer.writeInt32BE(value, this._position);
    this._position += 4;
    return this;
  }

  writeFloat(value: number, littleEndian: boolean = true): this {
    this.ensureCapacity(4);
    if (littleEndian) this._buffer.writeFloatLE(value, this._position);
    else this._buffer.writeFloatBE(value, this._position);
    this._position += 4;
    return this;
  }

  writeDouble(value: number, littleEndian: boolean = true): this {
    this.ensureCapacity(8);
    if (littleEndian) this._buffer.writeDoubleLE(value, this._position);
    else this._buffer.writeDoubleBE(value, this._position);
    this._position += 8;
    return this;
  }

  writeString(
    value: string,
    maxBytes: number,
    encoding: BufferEncoding = "utf8",
    nullTerminate: boolean = true
  ): this {
    const encoded = Buffer.from(value, encoding);
    const toCopy = Math.min(encoded.length, nullTerminate ? maxBytes - 1 : maxBytes);
    this.ensureCapacity(maxBytes);
    encoded.copy(this._buffer, this._position, 0, toCopy);
    if (nullTerminate) {
      this._buffer.writeUInt8(0, this._position + toCopy);
    }
    this._position += maxBytes;
    return this;
  }

  /**
   * Write a DI-style length-prefixed string:
   *   [uint16 LE length][UTF-8 bytes × length]
   */
  writeWStr(value: string): this {
    const encoded = Buffer.from(value, "utf8");
    this.writeUInt16(encoded.length);
    this.writeBytes(encoded);
    return this;
  }

  /** Write a length-prefixed string (uint32 length + data, no null terminator) */
  writeLPString(value: string, encoding: BufferEncoding = "utf8"): this {
    const encoded = Buffer.from(value, encoding);
    this.writeUInt32(encoded.length);
    this.writeBytes(encoded);
    return this;
  }
}
