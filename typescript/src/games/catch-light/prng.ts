const ZERO_STATE_REPLACEMENT = 0x6d2b79f5;

export function fnv1a32Utf8(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function seedMaterial(seedKey: string, sessionSeed: number, batchOrdinal: number, waveOrdinal: number): string {
  if (!Number.isSafeInteger(sessionSeed) || sessionSeed < 0) throw new Error("sessionSeed must be a non-negative safe integer");
  if (!Number.isInteger(batchOrdinal) || batchOrdinal < 1) throw new Error("batchOrdinal must be >= 1");
  if (!Number.isInteger(waveOrdinal) || waveOrdinal < 0) throw new Error("waveOrdinal must be >= 0");
  return `${seedKey}|${sessionSeed}|${batchOrdinal}|${waveOrdinal}`;
}

export class XorShift32 {
  private state: number;

  constructor(seed: number) {
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
    if (!Number.isInteger(exclusiveUpperBound) || exclusiveUpperBound <= 0) {
      throw new Error("exclusiveUpperBound must be a positive integer");
    }
    return this.nextUint32() % exclusiveUpperBound;
  }

  shuffle<T>(values: readonly T[]): T[] {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = this.nextIndex(i + 1);
      const value = result[i]!;
      result[i] = result[j]!;
      result[j] = value;
    }
    return result;
  }
}

export function prngFor(seedKey: string, sessionSeed: number, batchOrdinal: number, waveOrdinal: number): {material: string; seed32: number; prng: XorShift32} {
  const material = seedMaterial(seedKey, sessionSeed, batchOrdinal, waveOrdinal);
  const seed32 = fnv1a32Utf8(material);
  return {material, seed32, prng: new XorShift32(seed32)};
}
