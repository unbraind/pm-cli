import { cloneEmptyReplayDocument, tryApplyReplayPatch, type ReplayDocument } from "./replay.js";
import type { HistoryEntry } from "../../types/index.js";

export interface HistoryFieldChange {
  field: string;
  // before and after are the raw field values captured by replaying the history chain.
  // `undefined` is intentional: it signals that the field was absent in the document at
  // that point (e.g. after a JSON-Patch `remove` op). JSON serialization will omit
  // undefined values, which correctly communicates "field did not exist".
  before: unknown;
  after: unknown;
}

export interface HistoryDiffValueEntry {
  /** 1-based position in the FULL stream (fullEntries index + 1). */
  index: number;
  ts: string;
  op: string;
  author: string;
  /** Number of JSON-patch operations in this entry (entry.patch.length). */
  patch_ops: number;
  /** Unique field names touched by this entry, sorted by localeCompare. */
  changed_fields: string[];
  /** Per-field before/after values, sorted by field name (localeCompare). */
  changes: HistoryFieldChange[];
}

// ---------------------------------------------------------------------------
// JSON-Pointer helpers (ported from src/cli/commands/history.ts so the
// orchestrator can replace the private copy there with an import from here).
// ---------------------------------------------------------------------------

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * Map a JSON-Patch path string to a human-readable changed-field name.
 *
 * Rules (in priority order):
 *  - "/body" or "/body/…"                      → "body"
 *  - "/metadata/…" or "/front_matter/…"
 *      with a first segment                     → that decoded segment (e.g. "status")
 *      without a first segment (bare prefix)    → "metadata"
 *  - "/" (root pointer, empty segment after strip) → "root"
 *  - anything else                               → decoded first path segment
 */
export function patchPathToChangedField(path: string): string {
  if (path === "/body" || path.startsWith("/body/")) return "body";
  if (
    path === "/metadata" ||
    path.startsWith("/metadata/") ||
    path === "/front_matter" ||
    path.startsWith("/front_matter/")
  ) {
    const segment = path.replace(/^\/(?:metadata|front_matter)\/?/, "").split("/")[0];
    if (!segment) return "metadata";
    return decodeJsonPointerSegment(segment);
  }
  const segment = path.replace(/^\//, "").split("/")[0];
  return segment ? decodeJsonPointerSegment(segment) : "root";
}

// ---------------------------------------------------------------------------
// Field-value reader
// ---------------------------------------------------------------------------

/**
 * Extract the before/after value for a logical field from a replay document.
 *
 * - "body"     → doc.body
 * - "metadata" → doc.metadata (the whole object, for a bare /metadata replace)
 * - "root"     → the whole document (for a bare "/" patch op)
 * - other      → doc.metadata[field] (may be undefined when the field was absent)
 */
function readFieldValue(doc: ReplayDocument, field: string): unknown {
  if (field === "body") return doc.body;
  if (field === "metadata") return doc.metadata;
  if (field === "root") return doc;
  return doc.metadata[field];
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Replay a full history entry stream and produce enriched diff entries with
 * per-field before/after values.
 *
 * @param fullEntries   The complete ordered history chain to replay.
 * @param options.windowStartIndex  0-based index into fullEntries at which the
 *   DISPLAYED window begins. Entries before this index are still replayed (so
 *   state is accurate) but are not emitted. Defaults to 0.
 * @param options.field  When supplied, only entries that changed this field are
 *   emitted, and each emitted entry's `changes` and `changed_fields` are
 *   restricted to that single field.
 */
export function computeHistoryDiff(
  fullEntries: HistoryEntry[],
  options?: { windowStartIndex?: number; field?: string },
): HistoryDiffValueEntry[] {
  const windowStartIndex = options?.windowStartIndex ?? 0;
  const fieldFilter = options?.field;

  if (fullEntries.length === 0 || windowStartIndex >= fullEntries.length) {
    return [];
  }

  let current = cloneEmptyReplayDocument();
  const result: HistoryDiffValueEntry[] = [];

  for (let p = 0; p < fullEntries.length; p += 1) {
    const entry = fullEntries[p];

    // Capture before state.
    const beforeDoc = current;

    // Attempt to apply patch.
    const applied = tryApplyReplayPatch(current, entry.patch);
    let afterDoc: ReplayDocument;
    if (applied.ok) {
      afterDoc = applied.document;
      current = afterDoc;
    } else {
      // Patch failed — use before state as after (cannot trust partial result).
      // Do NOT advance current; keep prior replay state.
      afterDoc = beforeDoc;
    }

    // Collect changed field names from patch paths (and from: paths for move/copy).
    const changedFieldSet = new Set<string>();
    for (const patchOp of entry.patch) {
      changedFieldSet.add(patchPathToChangedField(patchOp.path));
      if (patchOp.from !== undefined) {
        changedFieldSet.add(patchPathToChangedField(patchOp.from));
      }
    }
    const sortedFields = [...changedFieldSet].sort((a, b) => a.localeCompare(b));

    // Only emit entries in the display window.
    if (p >= windowStartIndex) {
      // Apply field filter: skip this entry entirely if it doesn't touch the
      // requested field; otherwise narrow down to only that field.
      if (fieldFilter !== undefined) {
        if (!changedFieldSet.has(fieldFilter)) {
          // This entry does not touch the requested field — skip it.
          continue;
        }
        // Emit only the filtered field.
        const change: HistoryFieldChange = {
          field: fieldFilter,
          before: readFieldValue(beforeDoc, fieldFilter),
          after: readFieldValue(afterDoc, fieldFilter),
        };
        result.push({
          index: p + 1,
          ts: entry.ts,
          op: entry.op,
          author: entry.author,
          patch_ops: entry.patch.length,
          changed_fields: [fieldFilter],
          changes: [change],
        });
      } else {
        // Emit all changed fields.
        const changes: HistoryFieldChange[] = sortedFields.map((field) => ({
          field,
          before: readFieldValue(beforeDoc, field),
          after: readFieldValue(afterDoc, field),
        }));
        result.push({
          index: p + 1,
          ts: entry.ts,
          op: entry.op,
          author: entry.author,
          patch_ops: entry.patch.length,
          changed_fields: sortedFields,
          changes,
        });
      }
    }
  }

  return result;
}
