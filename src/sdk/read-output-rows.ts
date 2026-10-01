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

const BUDGET_METADATA_ROOT_KEYS = new Set([
  "applied_bound",
  "completeness",
  "budget_retention_policy",
  "continuation_contract",
  "continuation_kind",
  "continuation_path",
  "filters",
  "omission_receipt",
  "output_budget_truncation",
  "projection",
  "read_output",
  "read_session",
  "row_contract",
  "sorting",
]);

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
    if (Array.isArray(value)) {
      if (!/^\d+$/u.test(segment)) return undefined;
      value = value[Number(segment)];
    } else {
      if (!isRecord(value)) return undefined;
      value = value[segment];
    }
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
  const replace = (value: unknown, offset: number): unknown => {
    if (offset === segments.length) return replacement;
    const segment = segments[offset]!;
    if (Array.isArray(value)) {
      const index = Number(segment);
      const cloned = [...value];
      cloned[index] = replace(value[index], offset + 1);
      return cloned;
    }
    const record = value as Record<string, unknown>;
    return {
      ...record,
      [segment]: replace(record[segment], offset + 1),
    };
  };
  return replace(result, 0) as Record<string, unknown>;
}

/** Replace one declared row collection with a suffix beginning at an offset. */
export function sliceReadOutputRowCollection(
  result: Record<string, unknown>,
  rowPath: string,
  offset: number,
): Record<string, unknown> {
  const collection = readOutputContinuationRowCollections(result).find(
    (entry) => entry.path === rowPath,
  );
  if (!collection) return result;
  const replacement = Array.isArray(collection.value)
    ? collection.value.slice(offset)
    : Object.fromEntries(Object.entries(collection.value).slice(offset));
  const sliced = replaceValueAtPath(result, rowPath, replacement);
  if (isRecord(sliced.summary) && isRecord(sliced.summary.focus_row_states) && typeof sliced.summary.focus_row_states[rowPath] === "string") {
    sliced.summary = { ...sliced.summary, focus_row_states: { ...sliced.summary.focus_row_states, [rowPath]: sliced.summary.focus_row_states[rowPath].slice(offset) } };
  }
  refreshReadOutputDeliveredCounts(sliced);
  return sliced;
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

/** Resolve collections that may be resumed independently from primary result rows. */
export function readOutputContinuationRowPaths(
  result: Record<string, unknown>,
): string[] {
  const contract = result.row_contract;
  if (isRecord(contract) && Array.isArray(contract.continuation_row_keys)) {
    return contract.continuation_row_keys.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
  }
  return readOutputRowPaths(result);
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

/** Resolve every declared continuation path that currently contains iterable rows. */
export function readOutputContinuationRowCollections(
  result: Record<string, unknown>,
): PmReadOutputRowCollection[] {
  return readOutputContinuationRowPaths(result).flatMap((rowPath) => {
    const value = valueAtPath(result, rowPath);
    return Array.isArray(value) || isRecord(value)
      ? [{ path: rowPath, value }]
      : [];
  });
}

/**
 * Discover every collection the token-budget degradation ladder may reduce.
 *
 * Ordinary field and amount projections stay bound to declared row paths (or
 * top-level array fallbacks), because a nested tag list is not an independent
 * result row. Budget degradation has a different obligation: it must exhaust
 * nested content collections before omitting the whole useful result. This
 * census therefore adds nested arrays while excluding receipt/envelope metadata
 * whose mutation would make the disclosure itself incomplete.
 */
export function readOutputBudgetCollections(
  result: Record<string, unknown>,
): PmReadOutputRowCollection[] {
  const collections = readOutputRowCollections(result);
  const declaredPaths = new Set(
    collections.map((collection) => collection.path),
  );
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      if (!declaredPaths.has(path)) {
        collections.push({ path, value });
      }
      value.forEach((entry, index) => visit(entry, `${path}.${index}`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (path.length === 0 && BUDGET_METADATA_ROOT_KEYS.has(key)) continue;
      visit(entry, path.length === 0 ? key : `${path}.${key}`);
    }
  };
  visit(result, "");
  return collections;
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

const FOCUS_KEYS = ["high_level", "low_level", "blocked_fallback"];

/** Encode producer role and blocker state without expanding projected item rows. */
function focusRowState(row: Record<string, unknown>): string {
  const state = row.status === "in_progress" ? "i" : "o";
  return row.blocked === true ? state.toUpperCase() : state;
}

/** Retain compact producer classifications across serialized projection boundaries. */
export function rememberReadOutputFocusRows(result: Record<string, unknown>, rows: readonly Record<string, unknown>[]): void {
  if (!isRecord(result.summary) || !isRecord(result.summary.returned_focus)) return;
  const byId = new Map(rows.map((row) => [row.id, row]));
  result.summary = { ...result.summary, focus_row_states: Object.fromEntries(FOCUS_KEYS.map((key) => [key,
    Array.isArray(result[key]) ? result[key].filter(isRecord).map((row) => focusRowState(byId.get(row.id) ?? row)).join("") : "",
  ])) };
}

/** Reject corrupt semantic receipts rather than inferring lost classifications. */
function validatedFocusStates(value: unknown, rows: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length !== rows || !/^[iIoO]*$/u.test(value)) {
    throw new TypeError("Context focus classification receipt must contain one i/I/o/O code per delivered record");
  }
  return value;
}

/** Resolve a delivered focus section from its authoritative pre-shaping rows. */
function deliveredFocusSectionStates(
  result: Record<string, unknown>, source: Record<string, unknown>, key: string,
  sourceStates: Record<string, unknown>,
): { states: string; needsStates: boolean } {
  const original = Array.isArray(source[key]) ? source[key].filter(isRecord) : [];
  const originalStates = validatedFocusStates(sourceStates[key], original.length) ?? original.map(focusRowState).join("");
  const byId = new Map<unknown, string | undefined>(original.flatMap((row, index) => row.id === undefined ? [] : [[row.id, originalStates[index]] as const]));
  const delivered = Array.isArray(result[key]) ? result[key].filter(isRecord) : [];
  let needsStates = false;
  const states = delivered.map((row, index) => {
    const state = byId.get(row.id) ?? (row.id === undefined ? originalStates[index] : undefined) ?? focusRowState(row);
    if (state !== focusRowState(row)) needsStates = true;
    return state;
  }).join("");
  return { states, needsStates };
}

/** Restore producer aggregates or count delivered items independently of auxiliary rows. */
function refreshItemCount(result: Record<string, unknown>, source: Record<string, unknown>): void {
  if (Array.isArray(result.items) && typeof result.count === "number") {
    result.count = result.count_only === true
      ? (typeof source.count === "number" ? source.count : result.count)
      : result.items.length;
  }
}

/** Refresh delivered counters, preserving full-match totals and hidden classifications. */
export function refreshReadOutputDeliveredCounts(
  result: Record<string, unknown>,
  source: Record<string, unknown> = result,
): void {
  refreshItemCount(result, source);
  if (!isRecord(result.summary) || !isRecord(result.summary.returned_focus)) return;
  const summary = { ...result.summary };
  const sourceStates = isRecord(source.summary) && isRecord(source.summary.focus_row_states) ? source.summary.focus_row_states : {};
  const sections = FOCUS_KEYS.map((key) => ({ key, ...deliveredFocusSectionStates(result, source, key, sourceStates) }));
  const states = Object.fromEntries(sections.map(({ key, states }) => [key, states]));
  const needsStates = sections.some((section) => section.needsStates);
  const deliveredStates = Object.values(states).join("");
  if (typeof summary.high_level === "number") summary.high_level = Array.isArray(result.high_level) ? result.high_level.length : 0;
  if (typeof summary.low_level === "number") summary.low_level = Array.isArray(result.low_level) ? result.low_level.length : 0;
  summary.returned_focus = {
    active_items: deliveredStates.length,
    in_progress: [...deliveredStates].filter((state) => state.toLowerCase() === "i").length,
    open: [...deliveredStates].filter((state) => state.toLowerCase() === "o").length,
    blocked: [...deliveredStates].filter((state) => state === state.toUpperCase()).length,
  };
  if (needsStates) summary.focus_row_states = states;
  else delete summary.focus_row_states;
  result.summary = summary;
}
