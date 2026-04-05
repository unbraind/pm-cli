export const BUILTIN_ITEM_TYPE_VALUES = [
  "Epic",
  "Feature",
  "Task",
  "Chore",
  "Issue",
  "Event",
  "Reminder",
  "Milestone",
  "Meeting",
] as const;
export const ITEM_TYPE_VALUES = BUILTIN_ITEM_TYPE_VALUES;
export type BuiltinItemType = (typeof BUILTIN_ITEM_TYPE_VALUES)[number];
export type ItemType = string;

export const STATUS_VALUES = [
  "draft",
  "open",
  "in_progress",
  "blocked",
  "closed",
  "canceled",
] as const;
export type ItemStatus = (typeof STATUS_VALUES)[number];

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
export type DependencyKind = (typeof DEPENDENCY_KIND_VALUES)[number];

export const SCOPE_VALUES = ["project", "global"] as const;
export type LinkScope = (typeof SCOPE_VALUES)[number];

export const RISK_VALUES = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_VALUES)[number];

export const ISSUE_SEVERITY_VALUES = ["low", "medium", "high", "critical"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITY_VALUES)[number];

export const CONFIDENCE_TEXT_VALUES = ["low", "medium", "high"] as const;
export type ConfidenceTextLevel = (typeof CONFIDENCE_TEXT_VALUES)[number];
export type ConfidenceValue = number | ConfidenceTextLevel;

export const ITEM_FORMAT_VALUES = ["toon", "json_markdown"] as const;
export type ItemFormat = (typeof ITEM_FORMAT_VALUES)[number];

export const SPRINT_RELEASE_FORMAT_POLICY_VALUES = ["warn", "strict_error"] as const;
export type SprintReleaseFormatPolicy = (typeof SPRINT_RELEASE_FORMAT_POLICY_VALUES)[number];
export const PARENT_REFERENCE_POLICY_VALUES = ["warn", "strict_error"] as const;
export type ParentReferencePolicy = (typeof PARENT_REFERENCE_POLICY_VALUES)[number];
export const VALIDATE_METADATA_PROFILE_VALUES = ["core", "strict", "custom"] as const;
export type ValidateMetadataProfile = (typeof VALIDATE_METADATA_PROFILE_VALUES)[number];
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
export type ValidateMetadataRequiredField = (typeof VALIDATE_METADATA_REQUIRED_FIELD_VALUES)[number];

export const RECURRENCE_FREQUENCY_VALUES = ["daily", "weekly", "monthly", "yearly"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCY_VALUES)[number];

export const RECURRENCE_WEEKDAY_VALUES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type RecurrenceWeekday = (typeof RECURRENCE_WEEKDAY_VALUES)[number];

export interface Dependency {
  id: string;
  kind: DependencyKind;
  created_at: string;
  author?: string;
  source_kind?: string;
}

export interface Comment {
  created_at: string;
  author: string;
  text: string;
}

export interface LogNote {
  created_at: string;
  author: string;
  text: string;
}

export interface LinkedFile {
  path: string;
  scope: LinkScope;
  note?: string;
}

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

export interface LinkedDoc {
  path: string;
  scope: LinkScope;
  note?: string;
}

export interface Reminder {
  at: string;
  text: string;
}

export interface RecurrenceRule {
  freq: RecurrenceFrequency;
  interval?: number;
  count?: number;
  until?: string;
  by_weekday?: RecurrenceWeekday[];
  by_month_day?: number[];
  exdates?: string[];
}

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

export interface ItemTypeOptionDefinition {
  key: string;
  values: string[];
  required?: boolean;
  aliases?: string[];
  description?: string;
}

export interface ItemTypeCommandOptionPolicy {
  command: "create" | "update";
  option: string;
  required?: boolean;
  visible?: boolean;
  enabled?: boolean;
}

export interface ItemTypeDefinition {
  name: string;
  folder?: string;
  aliases?: string[];
  required_create_fields?: string[];
  required_create_repeatables?: string[];
  options?: ItemTypeOptionDefinition[];
  command_option_policies?: ItemTypeCommandOptionPolicy[];
}

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

export interface ItemFrontMatter {
  id: string;
  title: string;
  description: string;
  type: ItemType;
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
  risk?: "low" | "medium" | "high" | "critical";
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
}

export interface ItemDocument {
  front_matter: ItemFrontMatter;
  body: string;
}

export interface HistoryPatchOp {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  from?: string;
  value?: unknown;
}

export interface HistoryEntry {
  ts: string;
  author: string;
  op: string;
  patch: HistoryPatchOp[];
  before_hash: string;
  after_hash: string;
  message?: string;
}

export interface PmSettings {
  version: number;
  id_prefix: string;
  author_default: string;
  item_format: ItemFormat;
  locks: {
    ttl_seconds: number;
  };
  output: {
    default_format: "toon" | "json";
  };
  history: {
    missing_stream: "auto_create" | "strict_error";
  };
  validation: {
    sprint_release_format: SprintReleaseFormatPolicy;
    parent_reference: ParentReferencePolicy;
    metadata_profile: ValidateMetadataProfile;
    metadata_required_fields: ValidateMetadataRequiredField[];
  };
  workflow: {
    definition_of_done: string[];
  };
  testing: {
    record_results_to_items: boolean;
  };
  item_types: {
    definitions: ItemTypeDefinition[];
  };
  extensions: {
    enabled: string[];
    disabled: string[];
  };
  search: {
    score_threshold: number;
    hybrid_semantic_weight: number;
    max_results: number;
    embedding_model: string;
    embedding_batch_size: number;
    scanner_max_batch_retries: number;
    provider?: string;
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
  vector_store: {
    adapter?: string;
    qdrant: {
      url: string;
      api_key: string;
    };
    lancedb: {
      path: string;
    };
  };
}
