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

function hasUnmatchedEquivalent<T>(
  leftValue: T,
  rightValues: readonly T[],
  matchedIndexes: Set<number>,
  equals: (leftEntry: T, rightEntry: T) => boolean,
): boolean {
  for (let index = 0; index < rightValues.length; index += 1) {
    if (matchedIndexes.has(index)) {
      continue;
    }
    if (equals(leftValue, rightValues[index] as T)) {
      matchedIndexes.add(index);
      return true;
    }
  }
  return false;
}

function compareRegExpValues(left: unknown, right: unknown): boolean | undefined {
  if (!(left instanceof RegExp || right instanceof RegExp)) {
    return undefined;
  }
  return left instanceof RegExp && right instanceof RegExp && left.toString() === right.toString();
}

function compareDateValues(left: unknown, right: unknown): boolean | undefined {
  if (!(left instanceof Date || right instanceof Date)) {
    return undefined;
  }
  return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
}

function compareSetValues(left: unknown, right: unknown): boolean | undefined {
  if (!(left instanceof Set || right instanceof Set)) {
    return undefined;
  }
  if (!(left instanceof Set && right instanceof Set) || left.size !== right.size) {
    return false;
  }
  const rightValues = [...right];
  const matched = new Set<number>();
  for (const leftValue of left) {
    if (!hasUnmatchedEquivalent(leftValue, rightValues, matched, stableValueEquals)) {
      return false;
    }
  }
  return true;
}

function compareMapValues(left: unknown, right: unknown): boolean | undefined {
  if (!(left instanceof Map || right instanceof Map)) {
    return undefined;
  }
  if (!(left instanceof Map && right instanceof Map) || left.size !== right.size) {
    return false;
  }
  const rightEntries = [...right.entries()];
  const matched = new Set<number>();
  for (const [leftKey, leftValue] of left.entries()) {
    const leftEntry: [unknown, unknown] = [leftKey, leftValue];
    if (
      !hasUnmatchedEquivalent(leftEntry, rightEntries, matched, ([candidateKey, candidateValue], [rightKey, rightValue]) =>
        stableValueEquals(candidateKey, rightKey) && stableValueEquals(candidateValue, rightValue),
      )
    ) {
      return false;
    }
  }
  return true;
}

function compareArrayValues(left: unknown, right: unknown): boolean | undefined {
  if (!(Array.isArray(left) || Array.isArray(right))) {
    return undefined;
  }
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => stableValueEquals(value, right[index]));
}

function comparePlainObjectValues(left: object, right: object): boolean {
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
 * Implements stable value equals for the public runtime surface of this module.
 */
export function stableValueEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const specializedComparisons = [
    compareRegExpValues,
    compareDateValues,
    compareSetValues,
    compareMapValues,
    compareArrayValues,
  ] as const;
  for (const compare of specializedComparisons) {
    const result = compare(left, right);
    if (result !== undefined) {
      return result;
    }
  }
  return comparePlainObjectValues(left, right);
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
