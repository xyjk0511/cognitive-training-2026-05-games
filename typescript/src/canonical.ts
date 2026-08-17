import { createHash } from "node:crypto";

export const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
export type JsonValue = null | boolean | string | number | JsonValue[] | { [key: string]: JsonValue };

function assertValue(value: JsonValue, path = "$" ): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${path}: only safe integers are allowed`);
    if (Object.is(value, -0)) throw new Error(`${path}: negative zero is forbidden`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertValue(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value)) assertValue(v, `${path}.${k}`);
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

export function canonicalSha256(value: JsonValue): string {
  return createHash("sha256").update(canonicalUtf8(value)).digest("hex");
}
