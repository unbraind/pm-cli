/**
 * @module types
 *
 * Defines the shared project-management data model used by CLI, SDK, MCP, and packages.
 */
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
export const ITEM_TYPE_VALUES = BUILTIN_ITEM_TYPE_VALUES;
/**
 * Restricts builtin item type values accepted by command, SDK, and storage contracts.
 */
export type BuiltinItemType = (typeof BUILTIN_ITEM_TYPE_VALUES)[number];
/**
 * Restricts item type values accepted by command, SDK, and storage contracts.
 */
export type ItemType = string;

export const STATUS_VALUES = [
  "draft",
  "open",
  "in_progress",
  "blocked",
  "closed",
  "canceled",
] as const;
/**
 * Restricts item status values accepted by command, SDK, and storage contracts.
 */
export type ItemStatus = string;

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
/**
 * Restricts runtime status role values accepted by command, SDK, and storage contracts.
 */
export type RuntimeStatusRole = (typeof RUNTIME_STATUS_ROLE_VALUES)[number];

export const RUNTIME_FIELD_TYPE_VALUES = ["string", "number", "boolean", "string_array"] as const;
/**
 * Restricts runtime field type values accepted by command, SDK, and storage contracts.
 */
export type RuntimeFieldType = (typeof RUNTIME_FIELD_TYPE_VALUES)[number];

export const RUNTIME_FIELD_COMMAND_VALUES = ["create", "update", "update_many", "list", "search", "calendar", "context"] as const;
/**
 * Restricts runtime field command values accepted by command, SDK, and storage contracts.
 */
export type RuntimeFieldCommand = (typeof RUNTIME_FIELD_COMMAND_VALUES)[number];

export const RUNTIME_UNKNOWN_FIELD_POLICY_VALUES = ["allow", "warn", "reject"] as const;
/**
 * Restricts runtime unknown field policy values accepted by command, SDK, and storage contracts.
 */
export type RuntimeUnknownFieldPolicy = (typeof RUNTIME_UNKNOWN_FIELD_POLICY_VALUES)[number];

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
/**
 * Restricts dependency kind values accepted by command, SDK, and storage contracts.
 */
export type DependencyKind = (typeof DEPENDENCY_KIND_VALUES)[number];

export const SCOPE_VALUES = ["project", "global"] as const;
/**
 * Restricts link scope values accepted by command, SDK, and storage contracts.
 */
export type LinkScope = (typeof SCOPE_VALUES)[number];

export const RISK_VALUES = ["low", "medium", "high", "critical"] as const;
/**
 * Restricts risk level values accepted by command, SDK, and storage contracts.
 */
export type RiskLevel = (typeof RISK_VALUES)[number];

export const ISSUE_SEVERITY_VALUES = ["low", "medium", "high", "critical"] as const;
/**
 * Restricts issue severity values accepted by command, SDK, and storage contracts.
 */
export type IssueSeverity = (typeof ISSUE_SEVERITY_VALUES)[number];

export const CONFIDENCE_TEXT_VALUES = ["low", "medium", "high"] as const;
/**
 * Restricts confidence text level values accepted by command, SDK, and storage contracts.
 */
export type ConfidenceTextLevel = (typeof CONFIDENCE_TEXT_VALUES)[number];
/**
 * Restricts confidence value values accepted by command, SDK, and storage contracts.
 */
export type ConfidenceValue = number | ConfidenceTextLevel;

export const ITEM_FORMAT_VALUES = ["toon", "json_markdown"] as const;
/**
 * Restricts item format values accepted by command, SDK, and storage contracts.
 */
export type ItemFormat = (typeof ITEM_FORMAT_VALUES)[number];

export const SPRINT_RELEASE_FORMAT_POLICY_VALUES = ["warn", "strict_error"] as const;
/**
 * Restricts sprint release format policy values accepted by command, SDK, and storage contracts.
 */
export type SprintReleaseFormatPolicy = (typeof SPRINT_RELEASE_FORMAT_POLICY_VALUES)[number];
export const PARENT_REFERENCE_POLICY_VALUES = ["warn", "strict_error"] as const;
/**
 * Restricts parent reference policy values accepted by command, SDK, and storage contracts.
 */
export type ParentReferencePolicy = (typeof PARENT_REFERENCE_POLICY_VALUES)[number];
export const VALIDATE_METADATA_PROFILE_VALUES = ["core", "strict", "custom"] as const;
/**
 * Restricts validate metadata profile values accepted by command, SDK, and storage contracts.
 */
export type ValidateMetadataProfile = (typeof VALIDATE_METADATA_PROFILE_VALUES)[number];
export const GOVERNANCE_PRESET_VALUES = ["minimal", "default", "strict", "custom"] as const;
/**
 * Restricts governance preset values accepted by command, SDK, and storage contracts.
 */
export type GovernancePreset = (typeof GOVERNANCE_PRESET_VALUES)[number];
export const GOVERNANCE_OWNERSHIP_ENFORCEMENT_VALUES = ["none", "warn", "strict"] as const;
/**
 * Restricts governance ownership enforcement values accepted by command, SDK, and storage contracts.
 */
export type GovernanceOwnershipEnforcement = (typeof GOVERNANCE_OWNERSHIP_ENFORCEMENT_VALUES)[number];
export const GOVERNANCE_CREATE_MODE_DEFAULT_VALUES = ["progressive", "strict"] as const;
/**
 * Restricts governance create mode default values accepted by command, SDK, and storage contracts.
 */
export type GovernanceCreateModeDefault = (typeof GOVERNANCE_CREATE_MODE_DEFAULT_VALUES)[number];
export const GOVERNANCE_CLOSE_VALIDATION_DEFAULT_VALUES = ["off", "warn", "strict"] as const;
/**
 * Restricts governance close validation default values accepted by command, SDK, and storage contracts.
 */
export type GovernanceCloseValidationDefault = (typeof GOVERNANCE_CLOSE_VALIDATION_DEFAULT_VALUES)[number];
export const GOVERNANCE_WORKFLOW_ENFORCEMENT_VALUES = ["off", "warn", "strict"] as const;
/**
 * Restricts governance workflow enforcement values accepted by command, SDK, and storage contracts.
 */
export type GovernanceWorkflowEnforcement = (typeof GOVERNANCE_WORKFLOW_ENFORCEMENT_VALUES)[number];
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
/**
 * Restricts validate metadata required field values accepted by command, SDK, and storage contracts.
 */
export type ValidateMetadataRequiredField = (typeof VALIDATE_METADATA_REQUIRED_FIELD_VALUES)[number];

export const RECURRENCE_FREQUENCY_VALUES = ["daily", "weekly", "monthly", "yearly"] as const;
/**
 * Restricts recurrence frequency values accepted by command, SDK, and storage contracts.
 */
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCY_VALUES)[number];

export const RECURRENCE_WEEKDAY_VALUES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
/**
 * Restricts recurrence weekday values accepted by command, SDK, and storage contracts.
 */
export type RecurrenceWeekday = (typeof RECURRENCE_WEEKDAY_VALUES)[number];

/**
 * Canonical week-order index for a recurrence weekday (mon=0 .. sun=6).
 * Shared by item serialization, create/update parsing, and calendar expansion
 * so weekday ordering cannot drift between those modules.
 */
export function weekdayOrderIndex(value: RecurrenceWeekday): number {
  return RECURRENCE_WEEKDAY_VALUES.indexOf(value);
}

/**
 * Documents the dependency payload exchanged by command, SDK, and package integrations.
 */
export interface Dependency {
  id: string;
  kind: DependencyKind;
  created_at: string;
  author?: string;
  source_kind?: string;
}

/**
 * Documents the comment payload exchanged by command, SDK, and package integrations.
 */
export interface Comment {
  created_at: string;
  author: string;
  text: string;
}

/**
 * Documents the log note payload exchanged by command, SDK, and package integrations.
 */
export interface LogNote {
  created_at: string;
  author: string;
  text: string;
}

/**
 * Documents the linked file payload exchanged by command, SDK, and package integrations.
 */
export interface LinkedFile {
  path: string;
  scope: LinkScope;
  note?: string;
}

/**
 * Documents the linked test payload exchanged by command, SDK, and package integrations.
 */
export interface LinkedTest {
  command?: string;
  path?: string;
  scope: LinkScope;
  timeout_seconds?: number;
  pm_context_mode?: "schema" | "tracker" | "auto";
  env_set?: Record<string, string>;
  env_clear?: string[];
  shared_host_safe?: boolean;
  assert_stdout_contains?: string[];
  assert_stdout_regex?: string[];
  assert_stderr_contains?: string[];
  assert_stderr_regex?: string[];
  assert_stdout_min_lines?: number;
  assert_json_field_equals?: Record<string, string>;
  assert_json_field_gte?: Record<string, number>;
  note?: string;
}

/**
 * Documents the linked doc payload exchanged by command, SDK, and package integrations.
 */
export interface LinkedDoc {
  path: string;
  scope: LinkScope;
  note?: string;
}

/**
 * Documents the reminder payload exchanged by command, SDK, and package integrations.
 */
export interface Reminder {
  at: string;
  text: string;
}

/**
 * Documents the recurrence rule payload exchanged by command, SDK, and package integrations.
 */
export interface RecurrenceRule {
  freq: RecurrenceFrequency;
  interval?: number;
  count?: number;
  until?: string;
  by_weekday?: RecurrenceWeekday[];
  by_month_day?: number[];
  exdates?: string[];
}

/**
 * Documents the calendar event payload exchanged by command, SDK, and package integrations.
 */
export interface CalendarEvent {
  start_at: string;
  end_at?: string;
  title?: string;
  description?: string;
  location?: string;
  all_day?: boolean;
  timezone?: string;
  recurrence?: RecurrenceRule;
}

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
/**
 * Restricts plan mode values accepted by command, SDK, and storage contracts.
 */
export type PlanMode = (typeof PLAN_MODE_VALUES)[number];

export const PLAN_STEP_STATUS_VALUES = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "skipped",
  "superseded",
] as const;
/**
 * Restricts plan step status values accepted by command, SDK, and storage contracts.
 */
export type PlanStepStatus = (typeof PLAN_STEP_STATUS_VALUES)[number];

export const PLAN_HARNESS_VALUES = ["codex", "claude-code", "cursor", "generic"] as const;
/**
 * Restricts plan harness values accepted by command, SDK, and storage contracts.
 */
export type PlanHarness = (typeof PLAN_HARNESS_VALUES)[number];

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
/**
 * Restricts plan step link kind values accepted by command, SDK, and storage contracts.
 */
export type PlanStepLinkKind = (typeof PLAN_STEP_LINK_KIND_VALUES)[number];

/**
 * Documents the plan step link payload exchanged by command, SDK, and package integrations.
 */
export interface PlanStepLink {
  id: string;
  kind: PlanStepLinkKind;
  note?: string;
  required_before_step?: boolean;
}

/**
 * Documents the plan step file payload exchanged by command, SDK, and package integrations.
 */
export interface PlanStepFile {
  path: string;
  scope?: LinkScope;
  note?: string;
}

/**
 * Documents the plan step test payload exchanged by command, SDK, and package integrations.
 */
export interface PlanStepTest {
  command?: string;
  path?: string;
  note?: string;
}

/**
 * Documents the plan step doc payload exchanged by command, SDK, and package integrations.
 */
export interface PlanStepDoc {
  path: string;
  scope?: LinkScope;
  note?: string;
}

/**
 * Documents the plan step payload exchanged by command, SDK, and package integrations.
 */
export interface PlanStep {
  id: string;
  order: number;
  title: string;
  body?: string;
  status: PlanStepStatus;
  owner?: string;
  evidence?: string;
  blocked_reason?: string;
  superseded_by?: string;
  linked_items?: PlanStepLink[];
  files?: PlanStepFile[];
  tests?: PlanStepTest[];
  docs?: PlanStepDoc[];
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

/**
 * Documents the plan decision payload exchanged by command, SDK, and package integrations.
 */
export interface PlanDecision {
  ts: string;
  author: string;
  decision: string;
  rationale?: string;
  evidence?: string;
  step_id?: string;
}

/**
 * Documents the plan discovery payload exchanged by command, SDK, and package integrations.
 */
export interface PlanDiscovery {
  ts: string;
  author: string;
  text: string;
  step_id?: string;
}

/**
 * Documents the plan validation check payload exchanged by command, SDK, and package integrations.
 */
export interface PlanValidationCheck {
  text: string;
  command?: string;
  expected?: string;
}

/**
 * Documents the item type option definition payload exchanged by command, SDK, and package integrations.
 */
export interface ItemTypeOptionDefinition {
  key: string;
  values: string[];
  required?: boolean;
  aliases?: string[];
  description?: string;
}

/**
 * Documents the item type command option policy payload exchanged by command, SDK, and package integrations.
 */
export interface ItemTypeCommandOptionPolicy {
  command: "create" | "update";
  option: string;
  required?: boolean;
  visible?: boolean;
  enabled?: boolean;
}

/**
 * Documents the item type definition payload exchanged by command, SDK, and package integrations.
 */
export interface ItemTypeDefinition {
  name: string;
  description?: string;
  /**
   * Status assigned to newly created items of this type when `--status` is not
   * provided. Falls back to the workflow's open status when unset or invalid.
   */
  default_status?: string;
  folder?: string;
  aliases?: string[];
  required_create_fields?: string[];
  required_create_repeatables?: string[];
  options?: ItemTypeOptionDefinition[];
  command_option_policies?: ItemTypeCommandOptionPolicy[];
}

/**
 * Documents the runtime status definition payload exchanged by command, SDK, and package integrations.
 */
export interface RuntimeStatusDefinition {
  id: string;
  aliases?: string[];
  roles?: RuntimeStatusRole[];
  description?: string;
  order?: number;
}

/**
 * Documents the runtime field definition payload exchanged by command, SDK, and package integrations.
 */
export interface RuntimeFieldDefinition {
  key: string;
  metadata_key?: string;
  /**
   * @deprecated Use metadata_key.
   */
  front_matter_key?: string;
  cli_flag?: string;
  cli_aliases?: string[];
  description?: string;
  type?: RuntimeFieldType;
  commands?: RuntimeFieldCommand[];
  repeatable?: boolean;
  required?: boolean;
  required_on_create?: boolean;
  required_types?: string[];
  allow_unset?: boolean;
}

/**
 * Documents the runtime workflow definition payload exchanged by command, SDK, and package integrations.
 */
export interface RuntimeWorkflowDefinition {
  draft_status?: string;
  open_status?: string;
  in_progress_status?: string;
  blocked_status?: string;
  close_status?: string;
  canceled_status?: string;
}

/**
 * Documents the runtime schema file config payload exchanged by command, SDK, and package integrations.
 */
export interface RuntimeSchemaFileConfig {
  types?: string;
  statuses?: string;
  fields?: string;
  workflows?: string;
}

/**
 * Per-type allowed-transition rule. A type with no matching entry is
 * unrestricted; a type with an entry allows only the listed [from, to]
 * status pairs (status tokens are resolved case-insensitively through the
 * status registry alias map; a same-status no-op is always allowed).
 */
export interface TypeWorkflowDefinition {
  type: string;
  allowed_transitions: [string, string][];
}

/**
 * Documents the runtime schema settings payload exchanged by command, SDK, and package integrations.
 */
export interface RuntimeSchemaSettings {
  version: number;
  files: RuntimeSchemaFileConfig;
  statuses: RuntimeStatusDefinition[];
  fields: RuntimeFieldDefinition[];
  workflow: RuntimeWorkflowDefinition;
  type_workflows?: TypeWorkflowDefinition[];
  unknown_field_policy: RuntimeUnknownFieldPolicy;
}

/**
 * Documents the item test run summary payload exchanged by command, SDK, and package integrations.
 */
export interface ItemTestRunSummary {
  run_id: string;
  kind: "test" | "test-all";
  status: "passed" | "failed" | "stopped" | "canceled";
  started_at: string;
  finished_at: string;
  recorded_at: string;
  attempt?: number;
  resumed_from?: string;
  passed: number;
  failed: number;
  skipped: number;
  items?: number;
  linked_tests?: number;
  fail_on_skipped_triggered?: boolean;
}

/**
 * Documents the item metadata payload exchanged by command, SDK, and package integrations.
 */
export interface ItemMetadata {
  id: string;
  title: string;
  description: string;
  type: ItemType;
  /**
   * On-disk front-matter format version. Absent means the implicit baseline
   * (version 1) and is never serialized; populated only once an item advances
   * past the baseline via a future storage migration. See
   * core/item/item-format-version.
   */
  pm_format_version?: number;
  source_type?: string;
  type_options?: Record<string, string>;
  status: ItemStatus;
  priority: 0 | 1 | 2 | 3 | 4;
  tags: string[];
  created_at: string;
  updated_at: string;
  deadline?: string;
  reminders?: Reminder[];
  events?: CalendarEvent[];
  closed_at?: string;
  assignee?: string;
  source_owner?: string;
  author?: string;
  estimated_minutes?: number;
  acceptance_criteria?: string;
  design?: string;
  external_ref?: string;
  definition_of_ready?: string;
  order?: number;
  goal?: string;
  objective?: string;
  value?: string;
  impact?: string;
  outcome?: string;
  why_now?: string;
  parent?: string;
  reviewer?: string;
  risk?: RiskLevel;
  confidence?: ConfidenceValue;
  sprint?: string;
  release?: string;
  blocked_by?: string;
  blocked_reason?: string;
  unblock_note?: string;
  reporter?: string;
  severity?: IssueSeverity;
  environment?: string;
  repro_steps?: string;
  resolution?: string;
  expected_result?: string;
  actual_result?: string;
  affected_version?: string;
  fixed_version?: string;
  component?: string;
  regression?: boolean;
  customer_impact?: string;
  dependencies?: Dependency[];
  comments?: Comment[];
  notes?: LogNote[];
  learnings?: LogNote[];
  files?: LinkedFile[];
  tests?: LinkedTest[];
  test_runs?: ItemTestRunSummary[];
  docs?: LinkedDoc[];
  close_reason?: string;
  duplicate_of?: string;
  plan_mode?: PlanMode;
  plan_scope?: string;
  plan_harness?: PlanHarness;
  plan_steps?: PlanStep[];
  plan_decisions?: PlanDecision[];
  plan_discoveries?: PlanDiscovery[];
  plan_validation?: PlanValidationCheck[];
  plan_resume_context?: string;
  [key: string]: unknown;
}

/**
 * @deprecated Use ItemMetadata.
 */
export type ItemFrontMatter = ItemMetadata;

/**
 * Documents the item document payload exchanged by command, SDK, and package integrations.
 */
export interface ItemDocument {
  metadata: ItemMetadata;
  body: string;
}

/**
 * Documents the history patch op payload exchanged by command, SDK, and package integrations.
 */
export interface HistoryPatchOp {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  from?: string;
  value?: unknown;
}

/**
 * Documents the history entry payload exchanged by command, SDK, and package integrations.
 */
export interface HistoryEntry {
  ts: string;
  author: string;
  op: string;
  patch: HistoryPatchOp[];
  before_hash: string;
  after_hash: string;
  message?: string;
}

export const CONTEXT_DEPTH_VALUES = ["brief", "standard", "deep", "full"] as const;
/**
 * Restricts context depth values accepted by command, SDK, and storage contracts.
 */
export type ContextDepth = (typeof CONTEXT_DEPTH_VALUES)[number];

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
/**
 * Restricts context section name values accepted by command, SDK, and storage contracts.
 */
export type ContextSectionName = (typeof CONTEXT_SECTION_VALUES)[number];

/**
 * Documents the context section settings payload exchanged by command, SDK, and package integrations.
 */
export interface ContextSectionSettings {
  hierarchy: boolean;
  activity: boolean;
  progress: boolean;
  recently_created: boolean;
  unparented: boolean;
  blockers: boolean;
  files: boolean;
  workload: boolean;
  staleness: boolean;
  tests: boolean;
}

/**
 * Documents the context settings payload exchanged by command, SDK, and package integrations.
 */
export interface ContextSettings {
  default_depth: ContextDepth;
  activity_limit: number;
  stale_threshold_days: number;
  sections: ContextSectionSettings;
}

/**
 * Documents the governance settings payload exchanged by command, SDK, and package integrations.
 */
export interface GovernanceSettings {
  preset: GovernancePreset;
  ownership_enforcement: GovernanceOwnershipEnforcement;
  create_mode_default: GovernanceCreateModeDefault;
  close_validation_default: GovernanceCloseValidationDefault;
  require_close_reason: boolean;
  parent_reference: ParentReferencePolicy;
  metadata_profile: ValidateMetadataProfile;
  force_required_for_stale_lock: boolean;
  create_default_type?: string;
  /**
   * Per-type allowed-transition enforcement mode for `pm update --status`.
   * Read raw from settings (not preset-derived) so existing projects are
   * unaffected when unset; defaults to "off".
   */
  workflow_enforcement?: GovernanceWorkflowEnforcement;
}

/**
 * Restricts extension policy mode values accepted by command, SDK, and storage contracts.
 */
export type ExtensionPolicyMode = "off" | "warn" | "enforce";
/**
 * Restricts extension trust mode values accepted by command, SDK, and storage contracts.
 */
export type ExtensionTrustMode = "off" | "warn" | "enforce";
/**
 * Restricts extension sandbox profile values accepted by command, SDK, and storage contracts.
 */
export type ExtensionSandboxProfile = "none" | "restricted" | "strict";

/**
 * Documents the extension policy override settings payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionPolicyOverrideSettings {
  name: string;
  disabled?: boolean;
  require_trusted?: boolean;
  require_provenance?: boolean;
  sandbox_profile?: ExtensionSandboxProfile;
  allowed_capabilities?: string[];
  blocked_capabilities?: string[];
  allowed_surfaces?: string[];
  blocked_surfaces?: string[];
  allowed_commands?: string[];
  blocked_commands?: string[];
  allowed_actions?: string[];
  blocked_actions?: string[];
  allowed_services?: string[];
  blocked_services?: string[];
}

/**
 * Documents the extension policy settings payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionPolicySettings {
  mode: ExtensionPolicyMode;
  trust_mode: ExtensionTrustMode;
  require_provenance: boolean;
  trusted_extensions: string[];
  default_sandbox_profile: ExtensionSandboxProfile;
  allowed_extensions: string[];
  blocked_extensions: string[];
  allowed_capabilities: string[];
  blocked_capabilities: string[];
  allowed_surfaces: string[];
  blocked_surfaces: string[];
  allowed_commands: string[];
  blocked_commands: string[];
  allowed_actions: string[];
  blocked_actions: string[];
  allowed_services: string[];
  blocked_services: string[];
  extension_overrides: ExtensionPolicyOverrideSettings[];
}

/**
 * Documents the agent guidance settings payload exchanged by command, SDK, and package integrations.
 */
export interface AgentGuidanceSettings {
  prompt_completed: boolean;
  declined: boolean;
  declined_at: string;
  template_version: number;
  last_checked_files: string[];
}

/**
 * Restricts search mutation refresh policy values accepted by command, SDK, and storage contracts.
 */
export type SearchMutationRefreshPolicy = "cache_only" | "semantic_configured" | "semantic_auto";

/**
 * Documents the search query expansion settings payload exchanged by command, SDK, and package integrations.
 */
export interface SearchQueryExpansionSettings {
  enabled: boolean;
  provider: string;
}

/**
 * Documents the search rerank settings payload exchanged by command, SDK, and package integrations.
 */
export interface SearchRerankSettings {
  enabled: boolean;
  model: string;
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
  enabled: boolean;
  max_entries: number;
  trigger: "health_warn" | "auto";
}

/**
 * Documents the pm settings payload exchanged by command, SDK, and package integrations.
 */
export interface PmSettings {
  version: number;
  id_prefix: string;
  author_default: string;
  item_format: ItemFormat;
  locks: {
    ttl_seconds: number;
  };
  /**
   * Retention policy for bulk-mutation rollback checkpoints written by
   * `update-many`/`close-many`. `pm gc --scope checkpoints` prunes checkpoint
   * files older than `retention_days`; checkpoints with an unparseable
   * `created_at` are retained (safety-first, mirroring the stale-lock sweep).
   */
  checkpoints: {
    retention_days: number;
  };
  output: {
    default_format: "toon" | "json";
  };
  history: {
    missing_stream: "auto_create" | "strict_error";
    compact_policy: HistoryCompactPolicy;
  };
  validation: {
    sprint_release_format: SprintReleaseFormatPolicy;
    parent_reference: ParentReferencePolicy;
    metadata_profile: ValidateMetadataProfile;
    metadata_required_fields: ValidateMetadataRequiredField[];
    lifecycle_stale_blocker_reason_patterns: string[];
    lifecycle_closure_like_blocked_reason_patterns: string[];
    lifecycle_closure_like_resolution_patterns: string[];
    lifecycle_closure_like_actual_result_patterns: string[];
    /**
     * Per-type default estimates (minutes) used by `pm validate --auto-fix
     * --fix-scope estimates` to backfill missing `estimated_minutes` (GH-212).
     * Keys are item type names (case-insensitive); values are positive minutes
     * that override the built-in defaults. Empty by default.
     */
    estimate_defaults_by_type: Record<string, number>;
  };
  governance: GovernanceSettings;
  workflow: {
    definition_of_done: string[];
  };
  testing: {
    record_results_to_items: boolean;
  };
  telemetry: {
    enabled: boolean;
    first_run_prompt_completed: boolean;
    capture_level: "minimal" | "redacted" | "max";
    endpoint: string;
    installation_id: string;
    retention_days: number;
  };
  agent_guidance: AgentGuidanceSettings;
  item_types: {
    definitions: ItemTypeDefinition[];
  };
  schema: RuntimeSchemaSettings;
  extensions: {
    enabled: string[];
    disabled: string[];
    policy: ExtensionPolicySettings;
  };
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
    /**
     * Optional allow-list of corpus field names embedded for semantic search
     * (see DEFAULT_SEARCH_CORPUS_FIELDS in core/search/corpus.ts). When unset or
     * empty, the full default field set is used (backward compatible). When set,
     * only the named fields are embedded — letting teams opt structured signals
     * (priority, assignee, risk, acceptance_criteria, etc.) in/out for token
     * efficiency. Changing this re-flags items stale on the next refresh.
     */
    corpus_fields?: string[];
    mutation_refresh_policy: SearchMutationRefreshPolicy;
    query_expansion: SearchQueryExpansionSettings;
    rerank: SearchRerankSettings;
    /**
     * Offline BM25 lexical-ranking parameters (pm-75k9), applied when
     * `search.provider` is `bm25` (or auto-selected as the offline fallback) for
     * semantic/hybrid queries. `k1` controls term-frequency saturation, `b`
     * controls document-length normalization. Unset → Lucene defaults (1.2/0.75).
     */
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
  context: ContextSettings;
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
