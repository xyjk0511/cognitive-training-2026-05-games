import { validateJsonResources, type JsonValue } from "../../canonical.js";

function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  const copy: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) copy[key] = cloneJsonValue(child);
  return copy;
}

function freezeJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const child of value) freezeJsonValue(child);
  } else {
    for (const child of Object.values(value)) freezeJsonValue(child);
  }
  return Object.freeze(value) as JsonValue;
}

/**
 * Recursively freezes an already-owned canonical-JSON object graph.
 * Use only for module-local literals that cannot be aliased by a caller.
 */
export function deepFreezeInPlace<T>(value: T): T {
  validateJsonResources(value);
  return freezeJsonValue(value as unknown as JsonValue) as T;
}

/**
 * Validates, detaches and recursively freezes canonical-JSON evidence before it
 * crosses a runtime boundary or is retained after hashing.
 */
export function immutableSnapshot<T>(value: T): T {
  validateJsonResources(value);
  return freezeJsonValue(cloneJsonValue(value as unknown as JsonValue)) as T;
}

export function isDeepFrozenJson(value: unknown): boolean {
  validateJsonResources(value);
  const visit = (node: JsonValue): boolean => {
    if (node === null || typeof node !== "object") return true;
    if (!Object.isFrozen(node)) return false;
    return Array.isArray(node) ? node.every(visit) : Object.values(node).every(visit);
  };
  return visit(value as JsonValue);
}
