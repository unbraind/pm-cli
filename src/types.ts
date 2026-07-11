/**
 * @module types
 *
 * Defines the shared project-management data model used by CLI, SDK, MCP, and packages.
 */
/** Supported values accepted by the builtin item type contract. */
export const BUILTIN_ITEM_TYPE_VALUES = [
  "Epic",
  "Feature",
  "Task",
  "Chore",
  "Issue",
  "Decision",
  "Event",
  "Reminder",
  "Milestone",
  "Meeting",
  "Plan",
] as const;
/** Supported values accepted by the item type contract. */
export const ITEM_TYPE_VALUES = BUILTIN_ITEM_TYPE_VALUES;
/** Restricts builtin item type values accepted by command, SDK, and storage contracts. */
export type BuiltinItemType = (typeof BUILTIN_ITEM_TYPE_VALUES)[number];
/** Restricts item type values accepted by command, SDK, and storage contracts. */
export type ItemType = string;

/** Supported values accepted by the status contract. */
export const STATUS_VALUES = [
  "draft",
  "open",
  "in_progress",
  "blocked",
  "closed",
  "canceled",
] as const;
/** Restricts item status values accepted by command, SDK, and storage contracts. */
export type ItemStatus = string;

/** Supported values accepted by the runtime status role contract. */
export const RUNTIME_STATUS_ROLE_VALUES = [
  "draft",
  "active",
  "blocked",
  "terminal",
  "terminal_done",
  "terminal_canceled",
  "default_open",
  "default_close",
  "default_cancel",
] as const;
/** Restricts runtime status role values accepted by command, SDK, and storage contracts. */
export type RuntimeStatusRole = (typeof RUNTIME_STATUS_ROLE_VALUES)[number];

/** Supported values accepted by the runtime field type contract. */
export const RUNTIME_FIELD_TYPE_VALUES = [
  "string",
  "number",
  "boolean",
  "string_array",
] as const;
/** Restricts runtime field type values accepted by command, SDK, and storage contracts. */
export type RuntimeFieldType = (typeof RUNTIME_FIELD_TYPE_VALUES)[number];

/** Supported values accepted by the runtime field command contract. */
export const RUNTIME_FIELD_COMMAND_VALUES = [
  "create",
  "update",
  "update_many",
  "list",
  "search",
  "calendar",
  "context",
] as const;
/** Restricts runtime field command values accepted by command, SDK, and storage contracts. */
export type RuntimeFieldCommand = (typeof RUNTIME_FIELD_COMMAND_VALUES)[number];

/** Supported values accepted by the runtime unknown field policy contract. */
export const RUNTIME_UNKNOWN_FIELD_POLICY_VALUES = [
  "allow",
  "warn",
  "reject",
] as const;
/** Restricts runtime unknown field policy values accepted by command, SDK, and storage contracts. */
export type RuntimeUnknownFieldPolicy =
  (typeof RUNTIME_UNKNOWN_FIELD_POLICY_VALUES)[number];

/** Supported values accepted by the dependency kind contract. */
export const DEPENDENCY_KIND_VALUES = [
  "blocks",
  "parent",
  "child",
  "parent_child",
  "child_of",
  "related",
  "related_to",
  "discovered_from",
  "blocked_by",
  "incident_from",
  "epic",
  "supersedes",
  "task",
] as const;
/** Restricts dependency kind values accepted by command, SDK, and storage contracts. */
export type DependencyKind = (typeof DEPENDENCY_KIND_VALUES)[number];

/** Supported values accepted by the scope contract. */
export const SCOPE_VALUES = ["project", "global"] as const;
/** Restricts link scope values accepted by command, SDK, and storage contracts. */
export type LinkScope = (typeof SCOPE_VALUES)[number];

/** Supported values accepted by the risk contract. */
export const RISK_VALUES = ["low", "medium", "high", "critical"] as const;
/** Restricts risk level values accepted by command, SDK, and storage contracts. */
export type RiskLevel = (typeof RISK_VALUES)[number];

/** Supported values accepted by the issue severity contract. */
export const ISSUE_SEVERITY_VALUES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;
/** Restricts issue severity values accepted by command, SDK, and storage contracts. */
export type IssueSeverity = (typeof ISSUE_SEVERITY_VALUES)[number];

/** Supported values accepted by the confidence text contract. */
export const CONFIDENCE_TEXT_VALUES = ["low", "medium", "high"] as const;
/** Restricts confidence text level values accepted by command, SDK, and storage contracts. */
export type ConfidenceTextLevel = (typeof CONFIDENCE_TEXT_VALUES)[number];
/** Restricts confidence value values accepted by command, SDK, and storage contracts. */
export type ConfidenceValue = number | ConfidenceTextLevel;

/** Supported values accepted by the item format contract. */
export const ITEM_FORMAT_VALUES = ["toon", "json_markdown"] as const;
/** Restricts item format values accepted by command, SDK, and storage contracts. */
export type ItemFormat = (typeof ITEM_FORMAT_VALUES)[number];

/** Supported values accepted by the sprint release format policy contract. */
export const SPRINT_RELEASE_FORMAT_POLICY_VALUES = [
  "warn",
  "strict_error",
] as const;
/** Restricts sprint release format policy values accepted by command, SDK, and storage contracts. */
export type SprintReleaseFormatPolicy =
  (typeof SPRINT_RELEASE_FORMAT_POLICY_VALUES)[number];
/** Supported values accepted by the parent reference policy contract. */
export const PARENT_REFERENCE_POLICY_VALUES = ["warn", "strict_error"] as const;
/** Restricts parent reference policy values accepted by command, SDK, and storage contracts. */
export type ParentReferencePolicy =
  (typeof PARENT_REFERENCE_POLICY_VALUES)[number];
/** Supported values accepted by the validate metadata profile contract. */
export const VALIDATE_METADATA_PROFILE_VALUES = [
  "core",
  "strict",
  "custom",
] as const;
/** Restricts validate metadata profile values accepted by command, SDK, and storage contracts. */
export type ValidateMetadataProfile =
  (typeof VALIDATE_METADATA_PROFILE_VALUES)[number];
/** Supported values accepted by the governance preset contract. */
export const GOVERNANCE_PRESET_VALUES = [
  "minimal",
  "default",
  "strict",
  "custom",
] as const;
/** Restricts governance preset values accepted by command, SDK, and storage contracts. */
export type GovernancePreset = (typeof GOVERNANCE_PRESET_VALUES)[number];
/** Supported values accepted by the governance ownership enforcement contract. */
export const GOVERNANCE_OWNERSHIP_ENFORCEMENT_VALUES = [
  "none",
  "warn",
  "strict",
] as const;
/** Restricts governance ownership enforcement values accepted by command, SDK, and storage contracts. */
export type GovernanceOwnershipEnforcement =
  (typeof GOVERNANCE_OWNERSHIP_ENFORCEMENT_VALUES)[number];
/** Supported values accepted by the governance create mode default contract. */
export const GOVERNANCE_CREATE_MODE_DEFAULT_VALUES = [
  "progressive",
  "strict",
] as const;
/** Restricts governance create mode default values accepted by command, SDK, and storage contracts. */
export type GovernanceCreateModeDefault =
  (typeof GOVERNANCE_CREATE_MODE_DEFAULT_VALUES)[number];
/** Supported values accepted by the governance close validation default contract. */
export const GOVERNANCE_CLOSE_VALIDATION_DEFAULT_VALUES = [
  "off",
  "warn",
  "strict",
] as const;
/** Restricts governance close validation default values accepted by command, SDK, and storage contracts. */
export type GovernanceCloseValidationDefault =
  (typeof GOVERNANCE_CLOSE_VALIDATION_DEFAULT_VALUES)[number];
/** Supported values accepted by the governance workflow enforcement contract. */
export const GOVERNANCE_WORKFLOW_ENFORCEMENT_VALUES = [
  "off",
  "warn",
  "strict",
] as const;
/** Restricts governance workflow enforcement values accepted by command, SDK, and storage contracts. */
export type GovernanceWorkflowEnforcement =
  (typeof GOVERNANCE_WORKFLOW_ENFORCEMENT_VALUES)[number];
/** Supported values accepted by the validate metadata required field contract. */
export const VALIDATE_METADATA_REQUIRED_FIELD_VALUES = [
  "author",
  "acceptance_criteria",
  "estimated_minutes",
  "close_reason",
  "reviewer",
  "risk",
  "confidence",
  "sprint",
  "release",
] as const;
/** Restricts validate metadata required field values accepted by command, SDK, and storage contracts. */
export type ValidateMetadataRequiredField =
  (typeof VALIDATE_METADATA_REQUIRED_FIELD_VALUES)[number];

/** Supported values accepted by the recurrence frequency contract. */
export const RECURRENCE_FREQUENCY_VALUES = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
] as const;
/** Restricts recurrence frequency values accepted by command, SDK, and storage contracts. */
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCY_VALUES)[number];

/** Supported values accepted by the recurrence weekday contract. */
export const RECURRENCE_WEEKDAY_VALUES = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;
/** Restricts recurrence weekday values accepted by command, SDK, and storage contracts. */
export type RecurrenceWeekday = (typeof RECURRENCE_WEEKDAY_VALUES)[number];

/** Canonical week-order index for a recurrence weekday (mon=0 .. sun=6). Shared by item serialization, create/update parsing, and calendar expansion so weekday ordering cannot drift between those modules. */
export function weekdayOrderIndex(value: RecurrenceWeekday): number {
  return RECURRENCE_WEEKDAY_VALUES.indexOf(value);
}

/** Documents the dependency payload exchanged by command, SDK, and package integrations. */
export interface Dependency {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports kind for this contract. */
  kind: DependencyKind;
  /** ISO 8601 timestamp recording when created occurred. */
  created_at: string;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Value that configures or reports source kind for this contract. */
  source_kind?: string;
}

/** Documents the comment payload exchanged by command, SDK, and package integrations. */
export interface Comment {
  /** ISO 8601 timestamp recording when created occurred. */
  created_at: string;
  /** Value that configures or reports author for this contract. */
  author: string;
  /** Value that configures or reports text for this contract. */
  text: string;
}

/** Documents the log note payload exchanged by command, SDK, and package integrations. */
export interface LogNote {
  /** ISO 8601 timestamp recording when created occurred. */
  created_at: string;
  /** Value that configures or reports author for this contract. */
  author: string;
  /** Value that configures or reports text for this contract. */
  text: string;
}

/** Documents the linked file payload exchanged by command, SDK, and package integrations. */
export interface LinkedFile {
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports scope for this contract. */
  scope: LinkScope;
  /** Value that configures or reports note for this contract. */
  note?: string;
}

/** Documents the linked test payload exchanged by command, SDK, and package integrations. */
export interface LinkedTest {
  /** Value that configures or reports command for this contract. */
  command?: string;
  /** Filesystem path used for path resolution. */
  path?: string;
  /** Value that configures or reports scope for this contract. */
  scope: LinkScope;
  /** Value that configures or reports timeout seconds for this contract. */
  timeout_seconds?: number;
  /** Strategy used to control pm context behavior. */
  pm_context_mode?: "schema" | "tracker" | "auto";
  /** Value that configures or reports env set for this contract. */
  env_set?: Record<string, string>;
  /** Value that configures or reports env clear for this contract. */
  env_clear?: string[];
  /** Value that configures or reports shared host safe for this contract. */
  shared_host_safe?: boolean;
  /** Value that configures or reports assert stdout contains for this contract. */
  assert_stdout_contains?: string[];
  /** Value that configures or reports assert stdout regex for this contract. */
  assert_stdout_regex?: string[];
  /** Value that configures or reports assert stderr contains for this contract. */
  assert_stderr_contains?: string[];
  /** Value that configures or reports assert stderr regex for this contract. */
  assert_stderr_regex?: string[];
  /** Value that configures or reports assert stdout min lines for this contract. */
  assert_stdout_min_lines?: number;
  /** Value that configures or reports assert json field equals for this contract. */
  assert_json_field_equals?: Record<string, string>;
  /** Value that configures or reports assert json field gte for this contract. */
  assert_json_field_gte?: Record<string, number>;
  /** Value that configures or reports note for this contract. */
  note?: string;
}

/** Documents the linked doc payload exchanged by command, SDK, and package integrations. */
export interface LinkedDoc {
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports scope for this contract. */
  scope: LinkScope;
  /** Value that configures or reports note for this contract. */
  note?: string;
}

/** Documents the reminder payload exchanged by command, SDK, and package integrations. */
export interface Reminder {
  /** Value that configures or reports at for this contract. */
  at: string;
  /** Value that configures or reports text for this contract. */
  text: string;
}

/** Documents the recurrence rule payload exchanged by command, SDK, and package integrations. */
export interface RecurrenceRule {
  /** Value that configures or reports freq for this contract. */
  freq: RecurrenceFrequency;
  /** Value that configures or reports interval for this contract. */
  interval?: number;
  /** Value that configures or reports count for this contract. */
  count?: number;
  /** Value that configures or reports until for this contract. */
  until?: string;
  /** Value that configures or reports by weekday for this contract. */
  by_weekday?: RecurrenceWeekday[];
  /** Value that configures or reports by month day for this contract. */
  by_month_day?: number[];
  /** Value that configures or reports exdates for this contract. */
  exdates?: string[];
}

/** Documents the calendar event payload exchanged by command, SDK, and package integrations. */
export interface CalendarEvent {
  /** ISO 8601 timestamp recording when start occurred. */
  start_at: string;
  /** ISO 8601 timestamp recording when end occurred. */
  end_at?: string;
  /** Value that configures or reports title for this contract. */
  title?: string;
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Value that configures or reports location for this contract. */
  location?: string;
  /** Value that configures or reports all day for this contract. */
  all_day?: boolean;
  /** Value that configures or reports timezone for this contract. */
  timezone?: string;
  /** Value that configures or reports recurrence for this contract. */
  recurrence?: RecurrenceRule;
}

/** Supported values accepted by the plan mode contract. */
export const PLAN_MODE_VALUES = [
  "draft",
  "research",
  "review",
  "approved",
  "executing",
  "paused",
  "completed",
  "superseded",
] as const;
/** Restricts plan mode values accepted by command, SDK, and storage contracts. */
export type PlanMode = (typeof PLAN_MODE_VALUES)[number];

/** Supported values accepted by the plan step status contract. */
export const PLAN_STEP_STATUS_VALUES = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "skipped",
  "superseded",
] as const;
/** Restricts plan step status values accepted by command, SDK, and storage contracts. */
export type PlanStepStatus = (typeof PLAN_STEP_STATUS_VALUES)[number];

/** Supported values accepted by the plan harness contract. */
export const PLAN_HARNESS_VALUES = [
  "codex",
  "claude-code",
  "cursor",
  "generic",
] as const;
/** Restricts plan harness values accepted by command, SDK, and storage contracts. */
export type PlanHarness = (typeof PLAN_HARNESS_VALUES)[number];

/** Supported values accepted by the plan step link kind contract. */
export const PLAN_STEP_LINK_KIND_VALUES = [
  "related",
  "blocks",
  "blocked_by",
  "depends_on",
  "discovered_from",
  "implements",
  "verifies",
  "supersedes",
] as const;
/** Restricts plan step link kind values accepted by command, SDK, and storage contracts. */
export type PlanStepLinkKind = (typeof PLAN_STEP_LINK_KIND_VALUES)[number];

/** Documents the plan step link payload exchanged by command, SDK, and package integrations. */
export interface PlanStepLink {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports kind for this contract. */
  kind: PlanStepLinkKind;
  /** Value that configures or reports note for this contract. */
  note?: string;
  /** Value that configures or reports required before step for this contract. */
  required_before_step?: boolean;
}

/** Documents the plan step file payload exchanged by command, SDK, and package integrations. */
export interface PlanStepFile {
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports scope for this contract. */
  scope?: LinkScope;
  /** Value that configures or reports note for this contract. */
  note?: string;
}

/** Documents the plan step test payload exchanged by command, SDK, and package integrations. */
export interface PlanStepTest {
  /** Value that configures or reports command for this contract. */
  command?: string;
  /** Filesystem path used for path resolution. */
  path?: string;
  /** Value that configures or reports note for this contract. */
  note?: string;
}

/** Documents the plan step doc payload exchanged by command, SDK, and package integrations. */
export interface PlanStepDoc {
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports scope for this contract. */
  scope?: LinkScope;
  /** Value that configures or reports note for this contract. */
  note?: string;
}

/** Documents the plan step payload exchanged by command, SDK, and package integrations. */
export interface PlanStep {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports order for this contract. */
  order: number;
  /** Value that configures or reports title for this contract. */
  title: string;
  /** Value that configures or reports body for this contract. */
  body?: string;
  /** Lifecycle state reported for status. */
  status: PlanStepStatus;
  /** Value that configures or reports owner for this contract. */
  owner?: string;
  /** Value that configures or reports evidence for this contract. */
  evidence?: string;
  /** Value that configures or reports blocked reason for this contract. */
  blocked_reason?: string;
  /** Value that configures or reports superseded by for this contract. */
  superseded_by?: string;
  /** Value that configures or reports linked items for this contract. */
  linked_items?: PlanStepLink[];
  /** Value that configures or reports files for this contract. */
  files?: PlanStepFile[];
  /** Value that configures or reports tests for this contract. */
  tests?: PlanStepTest[];
  /** Value that configures or reports docs for this contract. */
  docs?: PlanStepDoc[];
  /** ISO 8601 timestamp recording when created occurred. */
  created_at: string;
  /** ISO 8601 timestamp recording when updated occurred. */
  updated_at: string;
  /** ISO 8601 timestamp recording when completed occurred. */
  completed_at?: string;
}

/** Documents the plan decision payload exchanged by command, SDK, and package integrations. */
export interface PlanDecision {
  /** Value that configures or reports ts for this contract. */
  ts: string;
  /** Value that configures or reports author for this contract. */
  author: string;
  /** Value that configures or reports decision for this contract. */
  decision: string;
  /** Value that configures or reports rationale for this contract. */
  rationale?: string;
  /** Value that configures or reports evidence for this contract. */
  evidence?: string;
  /** Value that configures or reports step id for this contract. */
  step_id?: string;
}

/** Documents the plan discovery payload exchanged by command, SDK, and package integrations. */
export interface PlanDiscovery {
  /** Value that configures or reports ts for this contract. */
  ts: string;
  /** Value that configures or reports author for this contract. */
  author: string;
  /** Value that configures or reports text for this contract. */
  text: string;
  /** Value that configures or reports step id for this contract. */
  step_id?: string;
}

/** Documents the plan validation check payload exchanged by command, SDK, and package integrations. */
export interface PlanValidationCheck {
  /** Value that configures or reports text for this contract. */
  text: string;
  /** Value that configures or reports command for this contract. */
  command?: string;
  /** Value that configures or reports expected for this contract. */
  expected?: string;
}

/** Documents the item type option definition payload exchanged by command, SDK, and package integrations. */
export interface ItemTypeOptionDefinition {
  /** Value that configures or reports key for this contract. */
  key: string;
  /** Value that configures or reports values for this contract. */
  values: string[];
  /** Value that configures or reports required for this contract. */
  required?: boolean;
  /** Value that configures or reports aliases for this contract. */
  aliases?: string[];
  /** Value that configures or reports description for this contract. */
  description?: string;
}

/** Documents the item type command option policy payload exchanged by command, SDK, and package integrations. */
export interface ItemTypeCommandOptionPolicy {
  /** Value that configures or reports command for this contract. */
  command: "create" | "update";
  /** Value that configures or reports option for this contract. */
  option: string;
  /** Value that configures or reports required for this contract. */
  required?: boolean;
  /** Value that configures or reports visible for this contract. */
  visible?: boolean;
  /** Whether enabled applies to this operation. */
  enabled?: boolean;
}

/** Documents the item type definition payload exchanged by command, SDK, and package integrations. */
export interface ItemTypeDefinition {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Status assigned to newly created items of this type when `--status` is not provided. Falls back to the workflow's open status when unset or invalid. */
  default_status?: string;
  /** Value that configures or reports folder for this contract. */
  folder?: string;
  /** Value that configures or reports aliases for this contract. */
  aliases?: string[];
  /** Value that configures or reports required create fields for this contract. */
  required_create_fields?: string[];
  /** Value that configures or reports required create repeatables for this contract. */
  required_create_repeatables?: string[];
  /** Value that configures or reports options for this contract. */
  options?: ItemTypeOptionDefinition[];
  /** Value that configures or reports command option policies for this contract. */
  command_option_policies?: ItemTypeCommandOptionPolicy[];
}

/** Documents the runtime status definition payload exchanged by command, SDK, and package integrations. */
export interface RuntimeStatusDefinition {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports aliases for this contract. */
  aliases?: string[];
  /** Value that configures or reports roles for this contract. */
  roles?: RuntimeStatusRole[];
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Value that configures or reports order for this contract. */
  order?: number;
}

/** Documents the runtime field definition payload exchanged by command, SDK, and package integrations. */
export interface RuntimeFieldDefinition {
  /** Value that configures or reports key for this contract. */
  key: string;
  /** Value that configures or reports metadata key for this contract. */
  metadata_key?: string;
  /**
   * @deprecated Use metadata_key.
   */
  front_matter_key?: string;
  /** Value that configures or reports cli flag for this contract. */
  cli_flag?: string;
  /** Value that configures or reports cli aliases for this contract. */
  cli_aliases?: string[];
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type?: RuntimeFieldType;
  /** Value that configures or reports commands for this contract. */
  commands?: RuntimeFieldCommand[];
  /** Value that configures or reports repeatable for this contract. */
  repeatable?: boolean;
  /** Value that configures or reports required for this contract. */
  required?: boolean;
  /** Value that configures or reports required on create for this contract. */
  required_on_create?: boolean;
  /** Value that configures or reports required types for this contract. */
  required_types?: string[];
  /** Value that configures or reports allow unset for this contract. */
  allow_unset?: boolean;
}

/** Documents the runtime workflow definition payload exchanged by command, SDK, and package integrations. */
export interface RuntimeWorkflowDefinition {
  /** Lifecycle state reported for draftthe record. */
  draft_status?: string;
  /** Lifecycle state reported for openthe record. */
  open_status?: string;
  /** Lifecycle state reported for in progressthe record. */
  in_progress_status?: string;
  /** Lifecycle state reported for blockedthe record. */
  blocked_status?: string;
  /** Lifecycle state reported for closethe record. */
  close_status?: string;
  /** Lifecycle state reported for canceledthe record. */
  canceled_status?: string;
}

/** Documents the runtime schema file config payload exchanged by command, SDK, and package integrations. */
export interface RuntimeSchemaFileConfig {
  /** Value that configures or reports types for this contract. */
  types?: string;
  /** Value that configures or reports statuses for this contract. */
  statuses?: string;
  /** Value that configures or reports fields for this contract. */
  fields?: string;
  /** Value that configures or reports workflows for this contract. */
  workflows?: string;
}

/** Per-type allowed-transition rule. A type with no matching entry is unrestricted; a type with an entry allows only the listed [from, to] status pairs (status tokens are resolved case-insensitively through the status registry alias map; a same-status no-op is always allowed). */
export interface TypeWorkflowDefinition {
  /** Schema type that determines the shape and validation rules for this value. */
  type: string;
  /** Value that configures or reports allowed transitions for this contract. */
  allowed_transitions: [string, string][];
}

/** Documents the runtime schema settings payload exchanged by command, SDK, and package integrations. */
export interface RuntimeSchemaSettings {
  /** Value that configures or reports version for this contract. */
  version: number;
  /** Value that configures or reports files for this contract. */
  files: RuntimeSchemaFileConfig;
  /** Value that configures or reports statuses for this contract. */
  statuses: RuntimeStatusDefinition[];
  /** Value that configures or reports fields for this contract. */
  fields: RuntimeFieldDefinition[];
  /** Value that configures or reports workflow for this contract. */
  workflow: RuntimeWorkflowDefinition;
  /** Value that configures or reports type workflows for this contract. */
  type_workflows?: TypeWorkflowDefinition[];
  /** Value that configures or reports unknown field policy for this contract. */
  unknown_field_policy: RuntimeUnknownFieldPolicy;
}

/** Documents the item test run summary payload exchanged by command, SDK, and package integrations. */
export interface ItemTestRunSummary {
  /** Executes the id operation through the package runtime. */
  run_id: string;
  /** Value that configures or reports kind for this contract. */
  kind: "test" | "test-all";
  /** Lifecycle state reported for status. */
  status: "passed" | "failed" | "stopped" | "canceled";
  /** ISO 8601 timestamp recording when started occurred. */
  started_at: string;
  /** ISO 8601 timestamp recording when finished occurred. */
  finished_at: string;
  /** ISO 8601 timestamp recording when recorded occurred. */
  recorded_at: string;
  /** Value that configures or reports attempt for this contract. */
  attempt?: number;
  /** Value that configures or reports resumed from for this contract. */
  resumed_from?: string;
  /** Value that configures or reports passed for this contract. */
  passed: number;
  /** Value that configures or reports failed for this contract. */
  failed: number;
  /** Value that configures or reports skipped for this contract. */
  skipped: number;
  /** Value that configures or reports items for this contract. */
  items?: number;
  /** Value that configures or reports linked tests for this contract. */
  linked_tests?: number;
  /** Value that configures or reports fail on skipped triggered for this contract. */
  fail_on_skipped_triggered?: boolean;
}

/** Documents the item metadata payload exchanged by command, SDK, and package integrations. */
export interface ItemMetadata {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports title for this contract. */
  title: string;
  /** Value that configures or reports description for this contract. */
  description: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type: ItemType;
  /** On-disk front-matter format version. Absent means the implicit baseline (version 1) and is never serialized; populated only once an item advances past the baseline via a future storage migration. See core/item/item-format-version. */
  pm_format_version?: number;
  /** Schema type that determines the shape and validation rules for this value. */
  source_type?: string;
  /** Inputs that customize the type operation. */
  type_options?: Record<string, string>;
  /** Lifecycle state reported for status. */
  status: ItemStatus;
  /** Value that configures or reports priority for this contract. */
  priority: 0 | 1 | 2 | 3 | 4;
  /** Value that configures or reports tags for this contract. */
  tags: string[];
  /** ISO 8601 timestamp recording when created occurred. */
  created_at: string;
  /** ISO 8601 timestamp recording when updated occurred. */
  updated_at: string;
  /** Value that configures or reports deadline for this contract. */
  deadline?: string;
  /** Value that configures or reports reminders for this contract. */
  reminders?: Reminder[];
  /** Value that configures or reports events for this contract. */
  events?: CalendarEvent[];
  /** ISO 8601 timestamp recording when closed occurred. */
  closed_at?: string;
  /** Value that configures or reports assignee for this contract. */
  assignee?: string;
  /** Value that configures or reports source owner for this contract. */
  source_owner?: string;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Value that configures or reports estimated minutes for this contract. */
  estimated_minutes?: number;
  /** Value that configures or reports acceptance criteria for this contract. */
  acceptance_criteria?: string;
  /** Value that configures or reports design for this contract. */
  design?: string;
  /** Value that configures or reports external ref for this contract. */
  external_ref?: string;
  /** Value that configures or reports definition of ready for this contract. */
  definition_of_ready?: string;
  /** Value that configures or reports order for this contract. */
  order?: number;
  /** Value that configures or reports goal for this contract. */
  goal?: string;
  /** Value that configures or reports objective for this contract. */
  objective?: string;
  /** Value that configures or reports value for this contract. */
  value?: string;
  /** Value that configures or reports impact for this contract. */
  impact?: string;
  /** Value that configures or reports outcome for this contract. */
  outcome?: string;
  /** Value that configures or reports why now for this contract. */
  why_now?: string;
  /** Value that configures or reports parent for this contract. */
  parent?: string;
  /** Value that configures or reports reviewer for this contract. */
  reviewer?: string;
  /** Value that configures or reports risk for this contract. */
  risk?: RiskLevel;
  /** Value that configures or reports confidence for this contract. */
  confidence?: ConfidenceValue;
  /** Value that configures or reports sprint for this contract. */
  sprint?: string;
  /** Value that configures or reports release for this contract. */
  release?: string;
  /** Value that configures or reports blocked by for this contract. */
  blocked_by?: string;
  /** Value that configures or reports blocked reason for this contract. */
  blocked_reason?: string;
  /** Value that configures or reports unblock note for this contract. */
  unblock_note?: string;
  /** Value that configures or reports reporter for this contract. */
  reporter?: string;
  /** Value that configures or reports severity for this contract. */
  severity?: IssueSeverity;
  /** Value that configures or reports environment for this contract. */
  environment?: string;
  /** Value that configures or reports repro steps for this contract. */
  repro_steps?: string;
  /** Value that configures or reports resolution for this contract. */
  resolution?: string;
  /** Structured result returned by the expected operation. */
  expected_result?: string;
  /** Structured result returned by the actual operation. */
  actual_result?: string;
  /** Value that configures or reports affected version for this contract. */
  affected_version?: string;
  /** Value that configures or reports fixed version for this contract. */
  fixed_version?: string;
  /** Value that configures or reports component for this contract. */
  component?: string;
  /** Value that configures or reports regression for this contract. */
  regression?: boolean;
  /** Value that configures or reports customer impact for this contract. */
  customer_impact?: string;
  /** Value that configures or reports dependencies for this contract. */
  dependencies?: Dependency[];
  /** Value that configures or reports comments for this contract. */
  comments?: Comment[];
  /** Value that configures or reports notes for this contract. */
  notes?: LogNote[];
  /** Value that configures or reports learnings for this contract. */
  learnings?: LogNote[];
  /** Value that configures or reports files for this contract. */
  files?: LinkedFile[];
  /** Value that configures or reports tests for this contract. */
  tests?: LinkedTest[];
  /** Value that configures or reports test runs for this contract. */
  test_runs?: ItemTestRunSummary[];
  /** Value that configures or reports docs for this contract. */
  docs?: LinkedDoc[];
  /** Value that configures or reports close reason for this contract. */
  close_reason?: string;
  /** Value that configures or reports duplicate of for this contract. */
  duplicate_of?: string;
  /** Strategy used to control plan behavior. */
  plan_mode?: PlanMode;
  /** Value that configures or reports plan scope for this contract. */
  plan_scope?: string;
  /** Value that configures or reports plan harness for this contract. */
  plan_harness?: PlanHarness;
  /** Value that configures or reports plan steps for this contract. */
  plan_steps?: PlanStep[];
  /** Value that configures or reports plan decisions for this contract. */
  plan_decisions?: PlanDecision[];
  /** Value that configures or reports plan discoveries for this contract. */
  plan_discoveries?: PlanDiscovery[];
  /** Value that configures or reports plan validation for this contract. */
  plan_validation?: PlanValidationCheck[];
  /** Value that configures or reports plan resume context for this contract. */
  plan_resume_context?: string;
  [key: string]: unknown;
}

/**
 * @deprecated Use ItemMetadata.
 */
export type ItemFrontMatter = ItemMetadata;

/** Documents the item document payload exchanged by command, SDK, and package integrations. */
export interface ItemDocument {
  /** Value that configures or reports metadata for this contract. */
  metadata: ItemMetadata;
  /** Value that configures or reports body for this contract. */
  body: string;
}

/** Documents the history patch op payload exchanged by command, SDK, and package integrations. */
export interface HistoryPatchOp {
  /** Value that configures or reports op for this contract. */
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports from for this contract. */
  from?: string;
  /** Value that configures or reports value for this contract. */
  value?: unknown;
}

/** Documents the history entry payload exchanged by command, SDK, and package integrations. */
export interface HistoryEntry {
  /** Value that configures or reports ts for this contract. */
  ts: string;
  /** Value that configures or reports author for this contract. */
  author: string;
  /** Value that configures or reports op for this contract. */
  op: string;
  /** Value that configures or reports patch for this contract. */
  patch: HistoryPatchOp[];
  /** Value that configures or reports before hash for this contract. */
  before_hash: string;
  /** Value that configures or reports after hash for this contract. */
  after_hash: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
}

/** Supported values accepted by the context depth contract. */
export const CONTEXT_DEPTH_VALUES = [
  "brief",
  "standard",
  "deep",
  "full",
] as const;
/** Restricts context depth values accepted by command, SDK, and storage contracts. */
export type ContextDepth = (typeof CONTEXT_DEPTH_VALUES)[number];

/** Supported values accepted by the context section contract. */
export const CONTEXT_SECTION_VALUES = [
  "hierarchy",
  "activity",
  "progress",
  "recently_created",
  "unparented",
  "blockers",
  "files",
  "workload",
  "staleness",
  "tests",
] as const;
/** Restricts context section name values accepted by command, SDK, and storage contracts. */
export type ContextSectionName = (typeof CONTEXT_SECTION_VALUES)[number];

/** Documents the context section settings payload exchanged by command, SDK, and package integrations. */
export interface ContextSectionSettings {
  /** Value that configures or reports hierarchy for this contract. */
  hierarchy: boolean;
  /** Value that configures or reports activity for this contract. */
  activity: boolean;
  /** Value that configures or reports progress for this contract. */
  progress: boolean;
  /** Value that configures or reports recently created for this contract. */
  recently_created: boolean;
  /** Value that configures or reports unparented for this contract. */
  unparented: boolean;
  /** Value that configures or reports blockers for this contract. */
  blockers: boolean;
  /** Value that configures or reports files for this contract. */
  files: boolean;
  /** Value that configures or reports workload for this contract. */
  workload: boolean;
  /** Value that configures or reports staleness for this contract. */
  staleness: boolean;
  /** Value that configures or reports tests for this contract. */
  tests: boolean;
}

/** Documents the context settings payload exchanged by command, SDK, and package integrations. */
export interface ContextSettings {
  /** Fallback depth used when callers do not provide an override. */
  default_depth: ContextDepth;
  /** Value that configures or reports activity limit for this contract. */
  activity_limit: number;
  /** Value that configures or reports stale threshold days for this contract. */
  stale_threshold_days: number;
  /** Value that configures or reports sections for this contract. */
  sections: ContextSectionSettings;
}

/** Documents the governance settings payload exchanged by command, SDK, and package integrations. */
export interface GovernanceSettings {
  /** Value that configures or reports preset for this contract. */
  preset: GovernancePreset;
  /** Value that configures or reports ownership enforcement for this contract. */
  ownership_enforcement: GovernanceOwnershipEnforcement;
  /** Creates mode default using the validated operation inputs. */
  create_mode_default: GovernanceCreateModeDefault;
  /** Value that configures or reports close validation default for this contract. */
  close_validation_default: GovernanceCloseValidationDefault;
  /** Value that configures or reports require close reason for this contract. */
  require_close_reason: boolean;
  /** Value that configures or reports parent reference for this contract. */
  parent_reference: ParentReferencePolicy;
  /** Value that configures or reports metadata profile for this contract. */
  metadata_profile: ValidateMetadataProfile;
  /** Value that configures or reports force required for stale lock for this contract. */
  force_required_for_stale_lock: boolean;
  /** Schema type that determines the shape and validation rules for this value. */
  create_default_type?: string;
  /** Per-type allowed-transition enforcement mode for `pm update --status`. Read raw from settings (not preset-derived) so existing projects are unaffected when unset; defaults to "off". */
  workflow_enforcement?: GovernanceWorkflowEnforcement;
}

/** Restricts extension policy mode values accepted by command, SDK, and storage contracts. */
export type ExtensionPolicyMode = "off" | "warn" | "enforce";
/** Restricts extension trust mode values accepted by command, SDK, and storage contracts. */
export type ExtensionTrustMode = "off" | "warn" | "enforce";
/** Restricts extension sandbox profile values accepted by command, SDK, and storage contracts. */
export type ExtensionSandboxProfile = "none" | "restricted" | "strict";

/** Documents the extension policy override settings payload exchanged by command, SDK, and package integrations. */
export interface ExtensionPolicyOverrideSettings {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Whether disabled applies to this operation. */
  disabled?: boolean;
  /** Value that configures or reports require trusted for this contract. */
  require_trusted?: boolean;
  /** Value that configures or reports require provenance for this contract. */
  require_provenance?: boolean;
  /** Value that configures or reports sandbox profile for this contract. */
  sandbox_profile?: ExtensionSandboxProfile;
  /** Value that configures or reports allowed capabilities for this contract. */
  allowed_capabilities?: string[];
  /** Value that configures or reports blocked capabilities for this contract. */
  blocked_capabilities?: string[];
  /** Value that configures or reports allowed surfaces for this contract. */
  allowed_surfaces?: string[];
  /** Value that configures or reports blocked surfaces for this contract. */
  blocked_surfaces?: string[];
  /** Value that configures or reports allowed commands for this contract. */
  allowed_commands?: string[];
  /** Value that configures or reports blocked commands for this contract. */
  blocked_commands?: string[];
  /** Value that configures or reports allowed actions for this contract. */
  allowed_actions?: string[];
  /** Value that configures or reports blocked actions for this contract. */
  blocked_actions?: string[];
  /** Value that configures or reports allowed services for this contract. */
  allowed_services?: string[];
  /** Value that configures or reports blocked services for this contract. */
  blocked_services?: string[];
}

/** Documents the extension policy settings payload exchanged by command, SDK, and package integrations. */
export interface ExtensionPolicySettings {
  /** Value that configures or reports mode for this contract. */
  mode: ExtensionPolicyMode;
  /** Strategy used to control trust behavior. */
  trust_mode: ExtensionTrustMode;
  /** Value that configures or reports require provenance for this contract. */
  require_provenance: boolean;
  /** Value that configures or reports trusted extensions for this contract. */
  trusted_extensions: string[];
  /** Fallback sandbox profile used when callers do not provide an override. */
  default_sandbox_profile: ExtensionSandboxProfile;
  /** Value that configures or reports allowed extensions for this contract. */
  allowed_extensions: string[];
  /** Value that configures or reports blocked extensions for this contract. */
  blocked_extensions: string[];
  /** Value that configures or reports allowed capabilities for this contract. */
  allowed_capabilities: string[];
  /** Value that configures or reports blocked capabilities for this contract. */
  blocked_capabilities: string[];
  /** Value that configures or reports allowed surfaces for this contract. */
  allowed_surfaces: string[];
  /** Value that configures or reports blocked surfaces for this contract. */
  blocked_surfaces: string[];
  /** Value that configures or reports allowed commands for this contract. */
  allowed_commands: string[];
  /** Value that configures or reports blocked commands for this contract. */
  blocked_commands: string[];
  /** Value that configures or reports allowed actions for this contract. */
  allowed_actions: string[];
  /** Value that configures or reports blocked actions for this contract. */
  blocked_actions: string[];
  /** Value that configures or reports allowed services for this contract. */
  allowed_services: string[];
  /** Value that configures or reports blocked services for this contract. */
  blocked_services: string[];
  /** Value that configures or reports extension overrides for this contract. */
  extension_overrides: ExtensionPolicyOverrideSettings[];
}

/** Documents the agent guidance settings payload exchanged by command, SDK, and package integrations. */
export interface AgentGuidanceSettings {
  /** Value that configures or reports prompt completed for this contract. */
  prompt_completed: boolean;
  /** Value that configures or reports declined for this contract. */
  declined: boolean;
  /** ISO 8601 timestamp recording when declined occurred. */
  declined_at: string;
  /** Value that configures or reports template version for this contract. */
  template_version: number;
  /** Value that configures or reports last checked files for this contract. */
  last_checked_files: string[];
}

/** Restricts search mutation refresh policy values accepted by command, SDK, and storage contracts. */
export type SearchMutationRefreshPolicy =
  | "cache_only"
  | "semantic_configured"
  | "semantic_auto";

/** Documents the search query expansion settings payload exchanged by command, SDK, and package integrations. */
export interface SearchQueryExpansionSettings {
  /** Whether enabled applies to this operation. */
  enabled: boolean;
  /** Value that configures or reports provider for this contract. */
  provider: string;
}

/** Documents the search rerank settings payload exchanged by command, SDK, and package integrations. */
export interface SearchRerankSettings {
  /** Whether enabled applies to this operation. */
  enabled: boolean;
  /** Value that configures or reports model for this contract. */
  model: string;
  /** Value that configures or reports top k for this contract. */
  top_k: number;
}

/**
 * Config-driven policy for automatic history-stream compaction triage.
 *
 * When `enabled`, `pm health` surfaces an advisory warning for any history
 * stream whose non-empty entry count exceeds `max_entries`, and `pm
 * history-compact` bulk mode uses `max_entries` as its default `--all-over`
 * threshold so the configured policy drives corpus-wide sweeps. `trigger`
 * records operator intent — both values raise the health advisory; `auto`
 * additionally signals that scheduled/automatic sweeps are expected.
 */
export interface HistoryCompactPolicy {
  /** Whether enabled applies to this operation. */
  enabled: boolean;
  /** Value that configures or reports max entries for this contract. */
  max_entries: number;
  /** Value that configures or reports trigger for this contract. */
  trigger: "health_warn" | "auto";
}

/** Documents the pm settings payload exchanged by command, SDK, and package integrations. */
export interface PmSettings {
  /** Value that configures or reports version for this contract. */
  version: number;
  /** Value that configures or reports id prefix for this contract. */
  id_prefix: string;
  /** Value that configures or reports author default for this contract. */
  author_default: string;
  /** Value that configures or reports item format for this contract. */
  item_format: ItemFormat;
  /** Value that configures or reports locks for this contract. */
  locks: {
    ttl_seconds: number;
    /** Bounded wait budget (milliseconds) for acquiring a contended item lock before surfacing lock_conflict. 0 disables waiting (fail-fast). Overridable per invocation via PM_LOCK_WAIT_MS. */
    wait_ms: number;
  };
  /** Retention policy for bulk-mutation rollback checkpoints written by `update-many`/`close-many`. `pm gc --scope checkpoints` prunes checkpoint files older than `retention_days`; checkpoints with an unparseable `created_at` are retained (safety-first, mirroring the stale-lock sweep). */
  checkpoints: {
    retention_days: number;
  };
  /** Value that configures or reports output for this contract. */
  output: {
    default_format: "toon" | "json";
  };
  /** Value that configures or reports history for this contract. */
  history: {
    missing_stream: "auto_create" | "strict_error";
    compact_policy: HistoryCompactPolicy;
  };
  /** Value that configures or reports validation for this contract. */
  validation: {
    sprint_release_format: SprintReleaseFormatPolicy;
    parent_reference: ParentReferencePolicy;
    metadata_profile: ValidateMetadataProfile;
    metadata_required_fields: ValidateMetadataRequiredField[];
    lifecycle_stale_blocker_reason_patterns: string[];
    lifecycle_closure_like_blocked_reason_patterns: string[];
    lifecycle_closure_like_resolution_patterns: string[];
    lifecycle_closure_like_actual_result_patterns: string[];
    /** Per-type default estimates (minutes) used by `pm validate --auto-fix --fix-scope estimates` to backfill missing `estimated_minutes` (GH-212). Keys are item type names (case-insensitive); values are positive minutes that override the built-in defaults. Empty by default. */
    estimate_defaults_by_type: Record<string, number>;
  };
  /** Value that configures or reports governance for this contract. */
  governance: GovernanceSettings;
  /** Value that configures or reports workflow for this contract. */
  workflow: {
    definition_of_done: string[];
  };
  /** Value that configures or reports testing for this contract. */
  testing: {
    record_results_to_items: boolean;
  };
  /** Value that configures or reports telemetry for this contract. */
  telemetry: {
    enabled: boolean;
    first_run_prompt_completed: boolean;
    capture_level: "minimal" | "redacted" | "max";
    endpoint: string;
    installation_id: string;
    retention_days: number;
  };
  /** Value that configures or reports agent guidance for this contract. */
  agent_guidance: AgentGuidanceSettings;
  /** Value that configures or reports item types for this contract. */
  item_types: {
    definitions: ItemTypeDefinition[];
  };
  /** Value that configures or reports schema for this contract. */
  schema: RuntimeSchemaSettings;
  /** Value that configures or reports extensions for this contract. */
  extensions: {
    enabled: string[];
    disabled: string[];
    policy: ExtensionPolicySettings;
  };
  /** Value that configures or reports search for this contract. */
  search: {
    score_threshold: number;
    hybrid_semantic_weight: number;
    max_results: number;
    embedding_model: string;
    embedding_corpus_max_characters?: number;
    embedding_batch_size: number;
    embedding_timeout_ms: number;
    scanner_max_batch_retries: number;
    provider?: string;
    /** Optional allow-list of corpus field names embedded for semantic search (see DEFAULT_SEARCH_CORPUS_FIELDS in core/search/corpus.ts). When unset or empty, the full default field set is used (backward compatible). When set, only the named fields are embedded — letting teams opt structured signals (priority, assignee, risk, acceptance_criteria, etc.) in/out for token efficiency. Changing this re-flags items stale on the next refresh. */
    corpus_fields?: string[];
    mutation_refresh_policy: SearchMutationRefreshPolicy;
    query_expansion: SearchQueryExpansionSettings;
    rerank: SearchRerankSettings;
    /** Offline BM25 lexical-ranking parameters (pm-75k9), applied when `search.provider` is `bm25` (or auto-selected as the offline fallback) for semantic/hybrid queries. `k1` controls term-frequency saturation, `b` controls document-length normalization. Unset → Lucene defaults (1.2/0.75). */
    bm25?: {
      k1?: number;
      b?: number;
    };
    tuning?: {
      title_exact_bonus?: number;
      title_weight?: number;
      description_weight?: number;
      tags_weight?: number;
      status_weight?: number;
      body_weight?: number;
      comments_weight?: number;
      notes_weight?: number;
      learnings_weight?: number;
      dependencies_weight?: number;
      linked_content_weight?: number;
    };
  };
  /** Value that configures or reports providers for this contract. */
  providers: {
    openai: {
      base_url: string;
      api_key: string;
      model: string;
    };
    ollama: {
      base_url: string;
      model: string;
    };
  };
  /** Value that configures or reports context for this contract. */
  context: ContextSettings;
  /** Value that configures or reports vector store for this contract. */
  vector_store: {
    adapter?: string;
    collection_name: string;
    qdrant: {
      url: string;
      api_key: string;
    };
    lancedb: {
      path: string;
    };
  };
}
