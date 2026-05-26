/**
 * Shared projection helper for mutation command results.
 *
 * Mutation commands (create/update/close/append/update-many) return a result
 * envelope that carries a `changed_fields` string array. On create this array simply
 * re-lists every field the command just set, which the item echo above it already
 * shows, so for high-volume agent loops it is ~50% redundant payload. This helper
 * lets the CLI (`--no-changed-fields`) and the MCP agent path trim that array down
 * to a deterministic `changed_field_count` without losing mutation evidence.
 *
 * Compaction is deliberately scoped to the mutation envelope only:
 *   - the envelope's own top-level `changed_fields` (create/update/close/append), and
 *   - `rows[*].changed_fields` (update-many reports its delta per row).
 * It does NOT recurse into arbitrary nested objects, so unrelated payloads that
 * legitimately carry `changed_fields` (for example `pm history --diff` entries, or a
 * custom runtime metadata field) are left untouched.
 *
 * The helper is pure and side-effect free, reused by both the output layer and the
 * MCP server, and returns the original reference unchanged when nothing is compacted.
 */

export type ChangedFieldsMode = "full" | "compact";

export interface MutationProjectionOptions {
  /** Defaults to "full" (unchanged output). "compact" drops the array, keeping a count. */
  changedFields?: ChangedFieldsMode;
}

const CHANGED_FIELDS_KEY = "changed_fields";
const CHANGED_FIELD_COUNT_KEY = "changed_field_count";
const ROWS_KEY = "rows";
const UPDATE_MANY_MUTATION_MODES = new Set(["apply", "rollback"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/** Replace a single envelope's own top-level `changed_fields` array with a count. */
function compactOwnChangedFields(envelope: Record<string, unknown>): Record<string, unknown> | null {
  const changedFields = envelope[CHANGED_FIELDS_KEY];
  if (!Array.isArray(changedFields)) {
    return null;
  }
  const projected: Record<string, unknown> =
    Object.getPrototypeOf(envelope) === null ? Object.create(null) : {};
  for (const [key, value] of Object.entries(envelope)) {
    if (key !== CHANGED_FIELDS_KEY) {
      projected[key] = value;
    }
  }
  projected[CHANGED_FIELD_COUNT_KEY] = changedFields.length;
  return projected;
}

function isMutationEnvelope(value: Record<string, unknown>): boolean {
  return "item" in value && Array.isArray(value[CHANGED_FIELDS_KEY]);
}

function isUpdateManyMutationEnvelope(value: Record<string, unknown>): boolean {
  return (
    typeof value.mode === "string" &&
    UPDATE_MANY_MUTATION_MODES.has(value.mode) &&
    Array.isArray(value[ROWS_KEY])
  );
}

function replaceRows(envelope: Record<string, unknown>, rows: unknown[]): Record<string, unknown> {
  const projected: Record<string, unknown> =
    Object.getPrototypeOf(envelope) === null ? Object.create(null) : {};
  Object.assign(projected, envelope);
  projected[ROWS_KEY] = rows;
  return projected;
}

/**
 * Returns a copy of a mutation result with the envelope `changed_fields` arrays
 * replaced by `changed_field_count` when compact mode is requested. Inputs that are
 * not a mutation envelope (or full mode) are returned unchanged (same reference).
 */
export function projectMutationResult(result: unknown, options: MutationProjectionOptions = {}): unknown {
  const mode = options.changedFields ?? "full";
  if (mode === "full" || !isPlainObject(result)) {
    return result;
  }

  let changed = false;
  let projected: Record<string, unknown> = result;

  const compactedTop = isMutationEnvelope(result) ? compactOwnChangedFields(result) : null;
  if (compactedTop !== null) {
    projected = compactedTop;
    changed = true;
  }

  // update-many reports its per-item delta under rows[*].changed_fields.
  const rows = isUpdateManyMutationEnvelope(projected) ? projected[ROWS_KEY] : undefined;
  if (Array.isArray(rows)) {
    let rowsChanged = false;
    const nextRows = rows.map((row) => {
      if (!isPlainObject(row)) {
        return row;
      }
      const compactedRow = compactOwnChangedFields(row);
      if (compactedRow) {
        rowsChanged = true;
        return compactedRow;
      }
      return row;
    });
    if (rowsChanged) {
      projected = replaceRows(projected, nextRows);
      changed = true;
    }
  }

  return changed ? projected : result;
}
