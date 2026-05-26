/**
 * Shared projection helper for mutation command results.
 *
 * Mutation commands (create/update/close/append/update-many/...) return result
 * objects that carry a `changed_fields` string array. On create this array simply
 * re-lists every field the command just set, which the item echo above it already
 * shows, so for high-volume agent loops it is ~50% redundant payload. This helper
 * lets the CLI (`--no-changed-fields`) and the MCP agent path trim that array down
 * to a deterministic `changed_field_count` without losing mutation evidence.
 *
 * Compaction is applied recursively so nested occurrences are covered too — e.g.
 * `update-many` reports `changed_fields` per `rows[*]` rather than at the top level.
 *
 * The helper is intentionally pure and side-effect free so it can be reused from
 * both the output layer and the MCP server, and fully unit covered. When nothing
 * is compacted it returns the original reference unchanged.
 */

export type ChangedFieldsMode = "full" | "compact";

export interface MutationProjectionOptions {
  /** Defaults to "full" (unchanged output). "compact" drops the array, keeping a count. */
  changedFields?: ChangedFieldsMode;
}

const CHANGED_FIELDS_KEY = "changed_fields";
const CHANGED_FIELD_COUNT_KEY = "changed_field_count";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // Only traverse genuine plain objects so the recursion never rewrites the
  // prototype of built-ins (Date/RegExp/Map/Set) or class instances into {}.
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function compactChangedFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const projected = value.map((entry) => {
      const next = compactChangedFields(entry);
      if (next !== entry) {
        changed = true;
      }
      return next;
    });
    return changed ? projected : value;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  let changed = false;
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === CHANGED_FIELDS_KEY && Array.isArray(entry)) {
      projected[CHANGED_FIELD_COUNT_KEY] = entry.length;
      changed = true;
      continue;
    }
    const next = compactChangedFields(entry);
    if (next !== entry) {
      changed = true;
    }
    projected[key] = next;
  }
  return changed ? projected : value;
}

/**
 * Returns a copy of a mutation result with every `changed_fields` array replaced
 * by `changed_field_count` when compact mode is requested. Inputs without any
 * `changed_fields` array (or in full mode) are returned unchanged (same reference)
 * so callers can apply this unconditionally.
 */
export function projectMutationResult(result: unknown, options: MutationProjectionOptions = {}): unknown {
  const mode = options.changedFields ?? "full";
  if (mode === "full") {
    return result;
  }
  return compactChangedFields(result);
}
