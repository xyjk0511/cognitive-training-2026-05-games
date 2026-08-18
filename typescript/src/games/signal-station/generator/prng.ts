import { SIGNAL_STATION_GENERATOR_VERSION } from "../constants.js";

export interface GeneratorKey {
  readonly sessionSeed: number;
  readonly level: number;
  readonly batchOrdinal: number;
  readonly waveOrdinal: number;
  readonly scope: string;
  readonly generatorVersion?: string;
}

function fnv1a32(value: string): number {
  const bytes = new TextEncoder().encode(value);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash === 0 ? 0x6d2b79f5 : hash;
}

function assertKeyInteger(value: number, name: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a safe integer >= ${min}`);
}

export class DeterministicRng {
  private state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("PRNG seed must be uint32");
    this.state = seed === 0 ? 0x6d2b79f5 : seed >>> 0;
  }

  nextUint32(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x100000000) {
      throw new Error("maxExclusive must be a positive integer <= 2^32");
    }
    const range = 0x100000000;
    const limit = range - (range % maxExclusive);
    let value = this.nextUint32();
    while (value >= limit) value = this.nextUint32();
    return value % maxExclusive;
  }

  choose<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error("cannot choose from an empty collection");
    return values[this.nextInt(values.length)]!;
  }

  shuffled<T>(values: readonly T[]): T[] {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = this.nextInt(index + 1);
      const hold = result[index]!;
      result[index] = result[swapIndex]!;
      result[swapIndex] = hold;
    }
    return result;
  }
}

export function createGeneratorRng(key: GeneratorKey): DeterministicRng {
  assertKeyInteger(key.sessionSeed, "sessionSeed", 0);
  assertKeyInteger(key.level, "level", 1);
  assertKeyInteger(key.batchOrdinal, "batchOrdinal", 1);
  assertKeyInteger(key.waveOrdinal, "waveOrdinal", 0);
  const version = key.generatorVersion ?? SIGNAL_STATION_GENERATOR_VERSION;
  const material = `${version}|${key.sessionSeed}|${key.level}|${key.batchOrdinal}|${key.waveOrdinal}|${key.scope}`;
  return new DeterministicRng(fnv1a32(material));
}
