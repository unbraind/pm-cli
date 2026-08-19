/**
 * @module core/shared/item-metadata-contract
 *
 * Declares the dependency-free canonical item metadata vocabulary shared by
 * storage, query projections, generated contracts, and package consumers.
 */

/** Portable project-context fields shared by storage order and structured mutation IO. */
export const ITEM_PROJECT_CONTEXT_KEYS = [
  "goal",
  "objective",
  "value",
  "impact",
  "outcome",
  "why_now",
  "parent",
  "reviewer",
  "risk",
  "confidence",
  "sprint",
  "release",
  "blocked_by",
  "blocked_reason",
  "unblock_note",
  "reporter",
  "severity",
  "environment",
  "repro_steps",
  "resolution",
  "expected_result",
  "actual_result",
] as const;

const ITEM_METADATA_KEY_ORDER_VALUES = [
  "id",
  "title",
  "description",
  "type",
  "pm_format_version",
  "source_type",
  "type_options",
  "status",
  "priority",
  "tags",
  "created_at",
  "updated_at",
  "deadline",
  "reminders",
  "events",
  "closed_at",
  "completed_at",
  "assignee",
  "claim_principal",
  "source_owner",
  "author",
  "estimated_minutes",
  "acceptance_criteria",
  "design",
  "external_ref",
  "definition_of_ready",
  "order",
  ...ITEM_PROJECT_CONTEXT_KEYS,
  "affected_version",
  "fixed_version",
  "component",
  "regression",
  "customer_impact",
  "dependencies",
  "comments",
  "notes",
  "learnings",
  "files",
  "tests",
  "test_runs",
  "docs",
  "close_reason",
  "duplicate_of",
  "plan_mode",
  "plan_scope",
  "plan_harness",
  "plan_resume_context",
  "plan_validation",
  "plan_decisions",
  "plan_discoveries",
  "plan_steps",
] as const satisfies readonly string[];

/** Literal union of every canonical built-in item metadata key. */
export type ItemMetadataKey = (typeof ITEM_METADATA_KEY_ORDER_VALUES)[number];

/** Public contract for item metadata key order, shared by SDK and presentation-layer consumers. */
export const ITEM_METADATA_KEY_ORDER: ReadonlyArray<string> =
  ITEM_METADATA_KEY_ORDER_VALUES;
