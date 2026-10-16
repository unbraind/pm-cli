/** @module sdk/lifecycle/core-item-fields Shared core metadata vocabulary for document validation and upsert identity. */
import { ITEM_PROJECT_CONTEXT_KEYS } from "../../core/shared/constants.js";

/** Core item document fields; extension metadata retains its independently declared spelling. */
export const CORE_ITEM_FIELD_KEYS: ReadonlySet<string> = new Set([
  "id",
  "title",
  "description",
  "type",
  "status",
  "priority",
  "tags",
  "body",
  "deadline",
  "estimated_minutes",
  "acceptance_criteria",
  "definition_of_ready",
  "order",
  "rank",
  "assignee",
  ...ITEM_PROJECT_CONTEXT_KEYS,
  "affected_version",
  "fixed_version",
  "component",
  "regression",
  "customer_impact",
  "close_reason",
  "completed_at",
  "dependencies",
  "comments",
  "notes",
  "learnings",
  "files",
  "tests",
  "docs",
  "reminders",
  "events",
  "type_options",
]);

/** Normalize only known core option targets; preserve unrelated extension metadata keys verbatim. */
export function resolveCoreUpsertMetadataKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const stored = key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
  return CORE_ITEM_FIELD_KEYS.has(stored) ? stored : key;
}
