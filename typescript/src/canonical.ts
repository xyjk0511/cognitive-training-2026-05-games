export const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
export type JsonValue = null | boolean | string | number | JsonValue[] | { [key: string]: JsonValue };

function assertWellFormedUtf16(value: string, path: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) {
        throw new Error(`${path}[${i}]: unpaired high surrogate is forbidden`);
      }
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${path}[${i}]: unpaired low surrogate is forbidden`);
    }
  }
}

function assertValue(value: JsonValue, path = "$" ): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertWellFormedUtf16(value, path);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${path}: only safe integers are allowed`);
    if (Object.is(value, -0)) throw new Error(`${path}: negative zero is forbidden`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertValue(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    assertWellFormedUtf16(k, `${path}.<key>`);
    assertValue(v, `${path}.${k}`);
  }
}

function utf16Compare(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = a.charCodeAt(i) - b.charCodeAt(i);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

function emit(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(emit).join(",")}]`;
  const keys = Object.keys(value).sort(utf16Compare);
  return `{${keys.map(k => `${JSON.stringify(k)}:${emit(value[k]!)}`).join(",")}}`;
}

export function canonicalUtf8(value: JsonValue): Uint8Array {
  assertValue(value);
  return new TextEncoder().encode(emit(value));
}

export function canonicalString(value: JsonValue): string {
  return new TextDecoder().decode(canonicalUtf8(value));
}

// Pure TypeScript SHA-256. This deliberately avoids node:crypto so the same
// runtime module can execute inside Cocos Creator/JSC/V8 without Node shims.
const SHA256_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);

function rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

export function sha256Hex(input: Uint8Array): string {
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;

  // Uint8Array lengths are far below 2^53 in supported runtimes. Encode the
  // exact bit length as the two 32-bit words required by SHA-256.
  const bitLengthHigh = Math.floor(input.length / 0x20000000);
  const bitLengthLow = (input.length * 8) >>> 0;
  const tail = new DataView(padded.buffer);
  tail.setUint32(paddedLength - 8, bitLengthHigh, false);
  tail.setUint32(paddedLength - 4, bitLengthLow, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  const view = new DataView(padded.buffer);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = words[i - 15]!;
      const w2 = words[i - 2]!;
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) >>> 0;
    }

    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (let i = 0; i < 64; i++) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + s1 + ch + SHA256_K[i]! + words[i]!) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (s0 + maj) >>> 0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
    h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
  }

  return [h0,h1,h2,h3,h4,h5,h6,h7].map(value => value.toString(16).padStart(8, "0")).join("");
}

export function canonicalSha256(value: JsonValue): string {
  return sha256Hex(canonicalUtf8(value));
}
