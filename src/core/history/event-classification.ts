/**
 * @module core/history/event-classification
 *
 * Declares the stable semantic boundary between history events that advance
 * project work and maintenance events that only preserve tracker governance.
 */
import type { HistoryEntry, HistoryPatchOp } from "../../types/index.js";

/** Current version of the public history-event classification policy. */
export const HISTORY_EVENT_CLASSIFICATION_VERSION = 1 as const;

/** Semantic effect of an immutable history event on project recency. */
export type HistoryEventClass = "substantive" | "maintenance";

/** Operations whose meaning is always governance or storage maintenance. */
export const MAINTENANCE_HISTORY_OPERATIONS = [
  "docs_add",
  "files_add",
  "history:author-acknowledge",
  "history_author_acknowledge",
  "history_compact",
  "history_compact_baseline",
  "history_redact",
  "history_repair",
  "normalize",
  "release",
  "test_run_track",
  "tests_add",
  "tests_remove",
  "update_audit",
  "update_ownership_bypass",
] as const;

/** Operations whose meaning always advances lifecycle or working context. */
export const SUBSTANTIVE_HISTORY_OPERATIONS = [
  "append",
  "cancel",
  "claim",
  "close",
  "comment_add",
  "create",
  "learning_add",
  "note_add",
  "reopen",
] as const;

const MAINTENANCE_OPERATIONS = new Set<string>(MAINTENANCE_HISTORY_OPERATIONS);
const SUBSTANTIVE_OPERATIONS = new Set<string>(SUBSTANTIVE_HISTORY_OPERATIONS);
const MAINTENANCE_UPDATE_FIELDS = new Set([
  "actual_result",
  "affected_version",
  "assignee",
  "blocked_by",
  "blocked_reason",
  "close_reason",
  "confidence",
  "customer_impact",
  "definition_of_ready",
  "dependencies",
  "docs",
  "environment",
  "expected_result",
  "files",
  "fixed_version",
  "goal",
  "impact",
  "learnings",
  "notes",
  "objective",
  "order",
  "outcome",
  "parent",
  "release",
  "reminders",
  "reporter",
  "repro_steps",
  "resolution",
  "reviewer",
  "severity",
  "sprint",
  "tests",
  "test_runs",
  "unblock_note",
  "updated_at",
  "value",
  "why_now",
]);

function topLevelPatchField(operation: HistoryPatchOp): string | undefined {
  const segments = operation.path.split("/").filter(Boolean);
  if (segments[0] === "metadata" || segments[0] === "front_matter") {
    return segments[1];
  }
  return segments[0] === "body" ? "body" : undefined;
}

/**
 * Classify an immutable event using its declared class when present, then the
 * versioned operation/path contract. Unknown events fail closed as substantive
 * so new work cannot silently disappear from temporal relevance.
 */
export function classifyHistoryEvent(
  entry: Pick<HistoryEntry, "op" | "patch" | "event_class">,
): HistoryEventClass {
  if (
    entry.event_class === "substantive" ||
    entry.event_class === "maintenance"
  ) {
    return entry.event_class;
  }
  if (MAINTENANCE_OPERATIONS.has(entry.op)) return "maintenance";
  if (SUBSTANTIVE_OPERATIONS.has(entry.op)) return "substantive";
  if (entry.op !== "update") return "substantive";
  return Array.isArray(entry.patch) &&
    entry.patch.length > 0 &&
    entry.patch.every((operation) => {
      const field = topLevelPatchField(operation);
      return field !== undefined && MAINTENANCE_UPDATE_FIELDS.has(field);
    })
    ? "maintenance"
    : "substantive";
}
