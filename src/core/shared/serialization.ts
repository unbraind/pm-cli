/**
 * @module core/shared/serialization
 *
 * Provides shared primitives and utilities for Serialization.
 */
import crypto from "node:crypto";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function sortObjectKeys(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "function") {
    return `[function:${value.name || "anonymous"}]`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sortObjectKeys(entry));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const maybeJson = value as { toJSON?: () => unknown };
  if (typeof maybeJson.toJSON === "function") {
    const normalized = maybeJson.toJSON();
    if (normalized !== value) {
      return sortObjectKeys(normalized);
    }
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  const result: Record<string, JsonValue> = {};
  for (const key of sortedKeys) {
    const nested = obj[key];
    if (nested === undefined) {
      continue;
    }
    result[key] = sortObjectKeys(nested);
  }
  return result;
}

/**
 * Implements stable stringify for the public runtime surface of this module.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

/**
 * Implements stable value equals for the public runtime surface of this module.
 */
export function stableValueEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (left instanceof RegExp || right instanceof RegExp) {
    return left instanceof RegExp && right instanceof RegExp && left.toString() === right.toString();
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (left instanceof Set || right instanceof Set) {
    if (!(left instanceof Set && right instanceof Set) || left.size !== right.size) {
      return false;
    }
    const rightValues = [...right];
    const matched = new Set<number>();
    for (const leftValue of left) {
      let found = false;
      for (let index = 0; index < rightValues.length; index += 1) {
        if (matched.has(index)) {
          continue;
        }
        if (stableValueEquals(leftValue, rightValues[index])) {
          matched.add(index);
          found = true;
          break;
        }
      }
      if (!found) {
        return false;
      }
    }
    return true;
  }
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map && right instanceof Map) || left.size !== right.size) {
      return false;
    }
    const rightEntries = [...right.entries()];
    const matched = new Set<number>();
    for (const [leftKey, leftValue] of left.entries()) {
      let found = false;
      for (let index = 0; index < rightEntries.length; index += 1) {
        if (matched.has(index)) {
          continue;
        }
        const [rightKey, rightValue] = rightEntries[index]!;
        if (stableValueEquals(leftKey, rightKey) && stableValueEquals(leftValue, rightValue)) {
          matched.add(index);
          found = true;
          break;
        }
      }
      if (!found) {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => stableValueEquals(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort((a, b) => a.localeCompare(b));
  const rightKeys = Object.keys(right).sort((a, b) => a.localeCompare(b));
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (let index = 0; index < leftKeys.length; index += 1) {
    const leftKey = leftKeys[index]!;
    if (leftKey !== rightKeys[index]) {
      return false;
    }
    if (!stableValueEquals((left as Record<string, unknown>)[leftKey], (right as Record<string, unknown>)[leftKey])) {
      return false;
    }
  }
  return true;
}

/**
 * Implements sha256 hex for the public runtime surface of this module.
 */
export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Implements order object for the public runtime surface of this module.
 */
export function orderObject<T extends Record<string, unknown>>(
  value: T,
  keyOrder: ReadonlyArray<string>,
): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};

  for (const key of keyOrder) {
    const entry = value[key];
    if (entry !== undefined) {
      ordered[key] = entry;
    }
  }

  const unknownKeys = Object.keys(value)
    .filter((key) => !keyOrder.includes(key))
    .sort((a, b) => a.localeCompare(b));

  for (const key of unknownKeys) {
    const entry = value[key];
    if (entry !== undefined) {
      ordered[key] = entry;
    }
  }

  return ordered;
}
