/**
 * LEB128 varint encoding used throughout the WASM binary format
 * (section sizes, indices, i32/i64 const immediates).
 * https://webassembly.github.io/spec/core/binary/values.html#integers
 */

export class ByteWriter {
  private bytes: number[] = [];

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  bytesRaw(data: ArrayLike<number>): this {
    for (let i = 0; i < data.length; i++) this.bytes.push(data[i] & 0xff);
    return this;
  }

  /** Unsigned LEB128. */
  uleb(value: number | bigint): this {
    let v = BigInt(value);
    if (v < 0n) throw new Error(`uleb: negative value ${v}`);
    do {
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v !== 0n) byte |= 0x80;
      this.bytes.push(byte);
    } while (v !== 0n);
    return this;
  }

  /** Signed LEB128. */
  sleb(value: number | bigint): this {
    let v = BigInt(value);
    let more = true;
    while (more) {
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      const signBitSet = (byte & 0x40) !== 0;
      if ((v === 0n && !signBitSet) || (v === -1n && signBitSet)) {
        more = false;
      } else {
        byte |= 0x80;
      }
      this.bytes.push(byte);
    }
    return this;
  }

  /** Raw IEEE-754 single precision, little-endian. */
  f32(value: number): this {
    const buf = new ArrayBuffer(4);
    new Float32Array(buf)[0] = value;
    return this.bytesRaw(new Uint8Array(buf));
  }

  /** Raw IEEE-754 double precision, little-endian. */
  f64(value: number): this {
    const buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = value;
    return this.bytesRaw(new Uint8Array(buf));
  }

  /** UTF-8 name: uleb length prefix + bytes (used for import/export names). */
  name(text: string): this {
    const encoded = new TextEncoder().encode(text);
    this.uleb(encoded.length);
    return this.bytesRaw(encoded);
  }

  /** Append another writer's bytes with a uleb length prefix (used for sized sub-blocks). */
  sized(inner: ByteWriter): this {
    this.uleb(inner.bytes.length);
    return this.bytesRaw(inner.bytes);
  }

  append(inner: ByteWriter): this {
    return this.bytesRaw(inner.bytes);
  }

  get length(): number {
    return this.bytes.length;
  }

  finish(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

export function ulebSize(value: number): number {
  let v = value >>> 0;
  let n = 1;
  while (v > 0x7f) {
    v >>>= 7;
    n++;
  }
  return n;
}
