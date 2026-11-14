/**
 * How a chunk's vector is stored in `chunks.embedding`. Packed: a four-byte mark, the scale as a
 * float32, then one signed byte a dimension — the int8 quantization the in-memory index searches
 * with anyway (search/vectors.ts), a quarter of the float32 values vectors used to be stored as.
 * Older rows hold the float32 values (four bytes a dimension, no mark); both are read, new vectors
 * are written packed, and `packStoredVectors` converts the old ones in the background.
 *
 * A packed vector is what quantizing its float32 values gives, byte for byte: the index, its
 * snapshot files and the search results are the same whichever form a row is in.
 */
const MARK = [0x4f, 0x56, 0x38, 0x01]; // "OV8", version 1
const HEAD = 8;

export function isPacked(b: Uint8Array) {
  return b.byteLength > HEAD && b[0] === MARK[0] && b[1] === MARK[1] && b[2] === MARK[2] && b[3] === MARK[3];
}

/** Dimensions of a stored vector, either form. */
export const dimsOf = (b: Uint8Array) => (isPacked(b) ? b.byteLength - HEAD : b.byteLength / 4);

/** Stored float32 values as floats; SQLite's buffer is used in place when aligned. */
export function asFloats(b: Uint8Array) {
  if (b.byteOffset % 4 === 0) return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  return new Float32Array(b.slice().buffer);
}

/** Quantize into `codes` at `offset`: each value over the scale, rounded; returns the scale. */
export function quantize(v: Float32Array, codes: Int8Array, offset: number) {
  let max = 0;
  for (let k = 0; k < v.length; k++) max = Math.max(max, Math.abs(v[k]));
  const scale = max / 127 || 1;
  for (let k = 0; k < v.length; k++) codes[offset + k] = Math.round(v[k] / scale);
  return scale;
}

/** A vector as it is stored. */
export function pack(v: Float32Array): Uint8Array {
  const out = new Uint8Array(HEAD + v.length);
  out.set(MARK, 0);
  const scale = quantize(v, new Int8Array(out.buffer, HEAD, v.length), 0);
  new DataView(out.buffer).setFloat32(4, scale, true);
  return out;
}

/** A stored vector (either form) as a row of the index: its codes into `codes` at `offset`; returns the scale. */
export function unpackInto(b: Uint8Array, codes: Int8Array, offset: number) {
  if (!isPacked(b)) return quantize(asFloats(b), codes, offset);
  codes.set(new Int8Array(b.buffer, b.byteOffset + HEAD, b.byteLength - HEAD), offset);
  return new DataView(b.buffer, b.byteOffset, HEAD).getFloat32(4, true);
}

/** A stored vector (either form) as floats: exact for the old form, the quantized values for a packed one. */
export function toFloats(b: Uint8Array): Float32Array {
  if (!isPacked(b)) return new Float32Array(asFloats(b));
  const n = b.byteLength - HEAD;
  const codes = new Int8Array(b.buffer, b.byteOffset + HEAD, n);
  const scale = new DataView(b.buffer, b.byteOffset, HEAD).getFloat32(4, true);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = codes[k] * scale;
  return out;
}
