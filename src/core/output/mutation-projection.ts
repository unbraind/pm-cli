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

/** Controls whether mutation output keeps full changed fields or compact counts. */
export type ChangedFieldsMode = "full" | "compact";

/** Documents the mutation projection options payload exchanged by command, SDK, and package integrations. */
export interface MutationProjectionOptions {
  /** Defaults to "full" (unchanged output). "compact" drops the array, keeping a count. */
  changedFields?: ChangedFieldsMode;
  /** Return the default agent envelope: id, status, changed-field count, and close reason. */
  compactEnvelope?: boolean;
  /** Return only id/status for single-item mutation envelopes. */
  idOnly?: boolean;
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
function compactOwnChangedFields(
  envelope: Record<string, unknown>,
): Record<string, unknown> | null {
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

function replaceRows(
  envelope: Record<string, unknown>,
  rows: unknown[],
): Record<string, unknown> {
  const projected: Record<string, unknown> =
    Object.getPrototypeOf(envelope) === null ? Object.create(null) : {};
  Object.assign(projected, envelope);
  projected[ROWS_KEY] = rows;
  return projected;
}

function projectIdOnlyResult(result: unknown): unknown | null {
  if (!isPlainObject(result)) {
    return null;
  }
  // Plan mutations wrap the mutated subject under "plan" instead of "item";
  // both shapes honor the root --id-only contract (id + status).
  const subject = isPlainObject(result.item)
    ? result.item
    : isPlainObject(result.plan)
      ? result.plan
      : null;
  if (subject === null) {
    return null;
  }
  const id = typeof subject.id === "string" ? subject.id : undefined;
  const status =
    typeof result.outcome === "string"
      ? result.outcome
      : typeof subject.status === "string"
        ? subject.status
        : undefined;
  if (!id) {
    return null;
  }
  return status
    ? {
        id,
        status,
        ...(typeof result.deleted === "boolean"
          ? { deleted: result.deleted }
          : {}),
      }
    : { id };
}

function projectCompactMutationEnvelope(result: unknown): unknown | null {
  if (!isPlainObject(result) || !isPlainObject(result.item)) return null;
  if (typeof result.item.id !== "string") return null;
  const changedFields = result[CHANGED_FIELDS_KEY];
  if (!Array.isArray(changedFields)) return null;
  const compact: Record<string, unknown> = {
    id: result.item.id,
    ...(typeof result.outcome === "string"
      ? { status: result.outcome }
      : typeof result.item.status === "string"
        ? { status: result.item.status }
        : {}),
    ...(typeof result.deleted === "boolean" ? { deleted: result.deleted } : {}),
    ...(typeof result.previous_status === "string"
      ? { previous_status: result.previous_status }
      : {}),
    changed_field_count: changedFields.length,
  };
  const closeReason =
    typeof result.close_reason === "string"
      ? result.close_reason
      : typeof result.item.close_reason === "string"
        ? result.item.close_reason
        : undefined;
  if (closeReason !== undefined) compact.close_reason = closeReason;
  if (Array.isArray(result.warnings) && result.warnings.length > 0)
    compact.warnings = result.warnings;
  return compact;
}

function compactUpdateManyRows(envelope: Record<string, unknown>): {
  projected: Record<string, unknown>;
  changed: boolean;
} {
  const rows = isUpdateManyMutationEnvelope(envelope)
    ? envelope[ROWS_KEY]
    : undefined;
  if (!Array.isArray(rows)) {
    return { projected: envelope, changed: false };
  }
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
  return rowsChanged
    ? { projected: replaceRows(envelope, nextRows), changed: true }
    : { projected: envelope, changed: false };
}

/** Returns a copy of a mutation result with the envelope `changed_fields` arrays replaced by `changed_field_count` when compact mode is requested. Inputs that are not a mutation envelope (or full mode) are returned unchanged (same reference). */
export function projectMutationResult(
  result: unknown,
  options: MutationProjectionOptions = {},
): unknown {
  if (options.idOnly === true) {
    const idOnly = projectIdOnlyResult(result);
    if (idOnly !== null) {
      return idOnly;
    }
  }

  if (options.compactEnvelope === true) {
    const compact = projectCompactMutationEnvelope(result);
    if (compact !== null) return compact;
  }

  const mode = options.changedFields ?? "full";
  if (mode === "full" || !isPlainObject(result)) {
    return result;
  }

  let changed = false;
  let projected: Record<string, unknown> = result;

  const compactedTop = isMutationEnvelope(result)
    ? compactOwnChangedFields(result)
    : null;
  if (compactedTop !== null) {
    projected = compactedTop;
    changed = true;
  }

  const rowProjection = compactUpdateManyRows(projected);
  if (rowProjection.changed) {
    projected = rowProjection.projected;
    changed = true;
  }

  return changed ? projected : result;
}
