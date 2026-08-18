import { WAVE_COUNT } from "./types.js";

const ZERO_STATE_REPLACEMENT = 0x6d2b79f5;
const UINT32_MAX = 0xffff_ffff;
const UINT32_RANGE = 0x1_0000_0000;

function assertWellFormedUtf16(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) throw new Error(`${label} contains an unpaired high surrogate`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} contains an unpaired low surrogate`);
    }
  }
}

export function fnv1a32Utf8(value: string): number {
  assertWellFormedUtf16(value, "FNV input");
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function seedMaterial(seedKey: string, sessionSeed: number, batchOrdinal: number, waveOrdinal: number): string {
  if (seedKey.length === 0 || seedKey.includes("|") || /[\u0000-\u001f\u007f]/.test(seedKey)) {
    throw new Error("seedKey must be non-empty and must not contain separators or control characters");
  }
  assertWellFormedUtf16(seedKey, "seedKey");
  if (!Number.isSafeInteger(sessionSeed) || sessionSeed < 0) throw new Error("sessionSeed must be a non-negative safe integer");
  if (!Number.isSafeInteger(batchOrdinal) || batchOrdinal < 1) throw new Error("batchOrdinal must be a positive safe integer");
  if (!Number.isSafeInteger(waveOrdinal) || waveOrdinal < 0 || waveOrdinal > WAVE_COUNT) {
    throw new Error(`waveOrdinal must be in 0..${WAVE_COUNT}`);
  }
  return `${seedKey}|${sessionSeed}|${batchOrdinal}|${waveOrdinal}`;
}

export class XorShift32 {
  private state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > UINT32_MAX) throw new Error("xorshift32 seed must be an unsigned 32-bit integer");
    const normalized = seed >>> 0;
    this.state = normalized === 0 ? ZERO_STATE_REPLACEMENT : normalized;
  }

  nextUint32(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }

  nextIndex(exclusiveUpperBound: number): number {
    if (!Number.isSafeInteger(exclusiveUpperBound) || exclusiveUpperBound <= 0 || exclusiveUpperBound > UINT32_RANGE) {
      throw new Error("exclusiveUpperBound must be a positive safe integer no greater than 2^32");
    }
    // Rejection sampling avoids modulo bias while preserving a deterministic,
    // implementation-independent uint32 consumption rule.
    const acceptanceLimit = Math.floor(UINT32_RANGE / exclusiveUpperBound) * exclusiveUpperBound;
    let value: number;
    do value = this.nextUint32(); while (value >= acceptanceLimit);
    return value % exclusiveUpperBound;
  }

  shuffle<T>(values: readonly T[]): T[] {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = this.nextIndex(index + 1);
      const value = result[index]!;
      result[index] = result[swapIndex]!;
      result[swapIndex] = value;
    }
    return result;
  }
}

export function prngFor(
  seedKey: string,
  sessionSeed: number,
  batchOrdinal: number,
  waveOrdinal: number,
): {material: string; seed32: number; prng: XorShift32} {
  const material = seedMaterial(seedKey, sessionSeed, batchOrdinal, waveOrdinal);
  const seed32 = fnv1a32Utf8(material);
  return {material, seed32, prng: new XorShift32(seed32)};
}
