/**
 * Shared projection helper for mutation command results.
 *
 * Mutation commands (create/update/close/append/...) return a result object that
 * always carries a `changed_fields` string array. On create this array simply
 * re-lists every field the command just set, which the item echo above it already
 * shows, so for high-volume agent loops it is ~50% redundant payload. This helper
 * lets the CLI (`--no-changed-fields`) and the MCP agent path trim that array down
 * to a deterministic `changed_field_count` without losing mutation evidence.
 *
 * The helper is intentionally pure and side-effect free so it can be reused from
 * both the output layer and the MCP server, and fully unit covered.
 */

export type ChangedFieldsMode = "full" | "compact";

export interface MutationProjectionOptions {
  /** Defaults to "full" (unchanged output). "compact" drops the array, keeping a count. */
  changedFields?: ChangedFieldsMode;
}

const CHANGED_FIELDS_KEY = "changed_fields";
const CHANGED_FIELD_COUNT_KEY = "changed_field_count";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a copy of a mutation result with `changed_fields` replaced by
 * `changed_field_count` when compact mode is requested. Inputs without a
 * `changed_fields` array (or non-object inputs, or full mode) are returned
 * unchanged so callers can apply this unconditionally.
 */
export function projectMutationResult(result: unknown, options: MutationProjectionOptions = {}): unknown {
  const mode = options.changedFields ?? "full";
  if (mode === "full") {
    return result;
  }
  if (!isPlainObject(result) || !Array.isArray(result[CHANGED_FIELDS_KEY])) {
    return result;
  }
  const { [CHANGED_FIELDS_KEY]: changedFields, ...rest } = result;
  return {
    ...rest,
    [CHANGED_FIELD_COUNT_KEY]: (changedFields as unknown[]).length,
  };
}
