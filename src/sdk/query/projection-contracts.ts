/**
 * @module sdk/query/projection-contracts
 *
 * Declares dependency-light projection vocabularies for list, get, and search
 * so contract-only SDK imports do not initialize query runtimes or storage.
 */
import { ITEM_METADATA_KEY_ORDER } from "../../core/shared/item-metadata-contract.js";

/** Stable projection names emitted by list envelopes and command contracts. */
export type ListProjectionMode = "full" | "compact" | "brief" | "fields";

/** Stable field order for the compact list projection. */
export const DEFAULT_COMPACT_LIST_FIELDS = [
  "id",
  "title",
  "status",
  "type",
  "priority",
  "parent",
  "updated_at",
] as const;

/** Stable field order for the agent-optimized brief list projection. */
export const BRIEF_LIST_FIELDS = ["id", "status", "type", "title"] as const;

/** Machine-readable default projection contract for every list command. */
export const LIST_COMMAND_DEFAULT_PROJECTIONS = {
  list: "brief",
  "list-all": "full",
  "list-draft": "full",
  "list-open": "brief",
  "list-in-progress": "brief",
  "list-blocked": "brief",
  "list-closed": "full",
  "list-canceled": "full",
} as const satisfies Record<string, Exclude<ListProjectionMode, "fields">>;

/** Command names whose output defaults are described by the list projection contract. */
export type ListCommandName = keyof typeof LIST_COMMAND_DEFAULT_PROJECTIONS;

const TREE_METADATA_FIELDS = [
  "tree_depth",
  "tree_parent",
  "tree_children",
  "tree_title",
] as const;

/** Return every accepted list projection selector for core and runtime metadata. */
export function listListProjectionFields(
  runtimeMetadataKeys: Iterable<string> = [],
): string[] {
  return [
    ...new Set([
      ...ITEM_METADATA_KEY_ORDER,
      "body",
      ...TREE_METADATA_FIELDS,
      ...runtimeMetadataKeys,
    ]),
  ]
    .flatMap((field) => [field, `item.${field}`])
    .sort();
}

/** Canonical get depth values. The CLI also accepts full as an alias for deep. */
export const GET_DEPTH_VALUES = ["brief", "standard", "deep"] as const;

const GET_ROOT_PROJECTION_FIELDS = [
  "body",
  "linked",
  "claim_state",
  "children",
  "schedule",
] as const;
const GET_LINKED_PROJECTION_FIELDS = [
  "linked.files",
  "linked.tests",
  "linked.docs",
] as const;
const GET_CLAIM_STATE_PROJECTION_FIELDS = [
  "claim_state.claimed",
  "claim_state.assignee",
  "claim_state.last_claim",
  "claim_state.last_release",
] as const;
const GET_SCHEDULE_PROJECTION_FIELDS = [
  "schedule.deadline",
  "schedule.start_at",
  "schedule.end_at",
  "schedule.location",
  "schedule.reminders",
  "schedule.events",
] as const;

/** Return every accepted get projection selector for core and runtime metadata. */
export function listGetProjectionFields(
  runtimeMetadataKeys: Iterable<string> = [],
): string[] {
  const itemFields = [
    ...new Set([
      ...ITEM_METADATA_KEY_ORDER,
      ...runtimeMetadataKeys,
      "notes_count",
      "tests_count",
      "collection_counts",
    ]),
  ];
  return [
    ...itemFields.flatMap((field) => [field, `item.${field}`]),
    ...GET_ROOT_PROJECTION_FIELDS,
    ...GET_LINKED_PROJECTION_FIELDS,
    ...GET_CLAIM_STATE_PROJECTION_FIELDS,
    ...GET_SCHEDULE_PROJECTION_FIELDS,
  ].sort();
}

/** Stable field order for compact search results. */
export const DEFAULT_COMPACT_SEARCH_FIELDS = [
  "id",
  "title",
  "status",
  "type",
  "priority",
  "updated_at",
  "score",
  "matched_fields",
] as const;

/** Search-result fields that live beside the nested item projection. */
export const SEARCH_HIT_FIELD_KEYS = [
  "score",
  "matched_fields",
  "highlights",
] as const;

/** Core item fields accepted by explicit search projections. */
export const SEARCH_ITEM_FIELD_KEYS = [
  "id",
  "title",
  "description",
  "type",
  "status",
  "priority",
  "tags",
  "created_at",
  "updated_at",
  "deadline",
  "assignee",
  "author",
  "estimated_minutes",
  "acceptance_criteria",
  "dependencies",
  "comments",
  "notes",
  "learnings",
  "reminders",
  "events",
  "files",
  "tests",
  "docs",
  "close_reason",
  "parent",
  "reviewer",
  "risk",
  "confidence",
  "sprint",
  "release",
  "blocked_by",
  "blocked_reason",
  "reporter",
  "severity",
  "environment",
  "repro_steps",
  "resolution",
  "expected_result",
  "actual_result",
  "affected_version",
  "fixed_version",
  "component",
  "regression",
  "customer_impact",
  "definition_of_ready",
  "order",
  "rank",
  "goal",
  "objective",
  "value",
  "impact",
  "outcome",
  "why_now",
  "plan",
] as const;

/** Return every accepted search projection selector for core and runtime metadata. */
export function listSearchProjectionFields(
  runtimeMetadataKeys: Iterable<string> = [],
): string[] {
  const runtimeKeys = [...new Set(runtimeMetadataKeys)];
  return [
    ...SEARCH_HIT_FIELD_KEYS,
    ...SEARCH_ITEM_FIELD_KEYS,
    ...SEARCH_ITEM_FIELD_KEYS.map((field) => `item.${field}`),
    ...runtimeKeys,
    ...runtimeKeys.map((field) => `item.${field}`),
  ].sort();
}
