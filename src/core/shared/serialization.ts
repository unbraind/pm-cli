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

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

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
