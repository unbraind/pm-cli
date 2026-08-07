/**
 * @module sdk/read-output-rows
 *
 * Resolves and transforms the row collections declared by universal read
 * envelopes, including dot-delimited nested paths used by graph projections.
 */

/** One declared array or object-map row collection in a read envelope. */
export interface PmReadOutputRowCollection {
  /** Dot-delimited path published by the envelope row contract. */
  path: string;
  /** Array rows or a keyed row map stored at {@link path}. */
  value: unknown[] | Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read one dot-delimited path without treating missing segments as rows. */
function valueAtPath(
  result: Record<string, unknown>,
  rowPath: string,
): unknown {
  let value: unknown = result;
  for (const segment of rowPath.split(".")) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

/** Clone the owners along one row path and replace only its terminal value. */
function replaceValueAtPath(
  result: Record<string, unknown>,
  rowPath: string,
  replacement: unknown,
): Record<string, unknown> {
  const segments = rowPath.split(".");
  const root = { ...result };
  let source: Record<string, unknown> = result;
  let target: Record<string, unknown> = root;
  for (const segment of segments.slice(0, -1)) {
    const sourceChild = source[segment] as Record<string, unknown>;
    const targetChild = { ...sourceChild };
    target[segment] = targetChild;
    source = sourceChild;
    target = targetChild;
  }
  target[segments.at(-1)!] = replacement;
  return root;
}

/** Resolve declared row paths, falling back to top-level array properties. */
export function readOutputRowPaths(result: Record<string, unknown>): string[] {
  const contract = result.row_contract;
  if (isRecord(contract) && Array.isArray(contract.row_keys)) {
    return contract.row_keys.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
  }
  return Object.entries(result)
    .filter(([, value]) => Array.isArray(value))
    .map(([key]) => key);
}

/** Resolve every declared row path that currently contains iterable rows. */
export function readOutputRowCollections(
  result: Record<string, unknown>,
): PmReadOutputRowCollection[] {
  return readOutputRowPaths(result).flatMap((rowPath) => {
    const value = valueAtPath(result, rowPath);
    return Array.isArray(value) || isRecord(value)
      ? [{ path: rowPath, value }]
      : [];
  });
}

/** Count array entries and object-map values across declared row collections. */
export function countReadOutputRows(result: Record<string, unknown>): number {
  return readOutputRowCollections(result).reduce(
    (total, collection) =>
      total +
      (Array.isArray(collection.value)
        ? collection.value.length
        : Object.keys(collection.value).length),
    0,
  );
}

/**
 * Transform every declared row while preserving collection keys and cloning
 * only the owner objects along paths that changed.
 */
export function mapReadOutputRows(
  result: Record<string, unknown>,
  transform: (row: unknown, path: string, index: number) => unknown,
): Record<string, unknown> {
  let projected = result;
  for (const collection of readOutputRowCollections(projected)) {
    const replacement = Array.isArray(collection.value)
      ? collection.value.map((row, index) =>
          transform(row, collection.path, index),
        )
      : Object.fromEntries(
          Object.entries(collection.value).map(([key, row], index) => [
            key,
            transform(row, collection.path, index),
          ]),
        );
    projected = replaceValueAtPath(projected, collection.path, replacement);
  }
  return projected;
}

/** Bound every declared row collection independently and report truncation. */
export function boundReadOutputRows(
  result: Record<string, unknown>,
  amount: number,
): { result: Record<string, unknown>; truncated: boolean } {
  let projected = result;
  let truncated = false;
  for (const collection of readOutputRowCollections(projected)) {
    const entries = Array.isArray(collection.value)
      ? collection.value
      : Object.entries(collection.value);
    if (entries.length <= amount) continue;
    truncated = true;
    const replacement = Array.isArray(collection.value)
      ? entries.slice(0, amount)
      : Object.fromEntries(entries.slice(0, amount) as [string, unknown][]);
    projected = replaceValueAtPath(projected, collection.path, replacement);
  }
  return { result: projected, truncated };
}
