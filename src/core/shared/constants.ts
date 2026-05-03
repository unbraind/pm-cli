import type { BuiltinItemType, GovernancePreset, GovernanceSettings, ItemFrontMatter, PmSettings } from "../../types/index.js";

export const PM_DIRNAME = ".agents/pm";
export const SETTINGS_FILENAME = "settings.json";

export const PM_CORE_REQUIRED_SUBDIRS = [
  "",
  "epics",
  "features",
  "tasks",
  "chores",
  "issues",
  "schema",
  "history",
  "index",
  "search",
  "extensions",
  "locks",
] as const;

export const PM_OPTIONAL_TYPE_SUBDIRS = [
  "decisions",
  "events",
  "reminders",
  "milestones",
  "meetings",
] as const;

export const PM_REQUIRED_SUBDIRS = [...PM_CORE_REQUIRED_SUBDIRS, ...PM_OPTIONAL_TYPE_SUBDIRS] as const;

export const TYPE_TO_FOLDER: Record<BuiltinItemType, string> = {
  Epic: "epics",
  Feature: "features",
  Task: "tasks",
  Chore: "chores",
  Issue: "issues",
  Decision: "decisions",
  Event: "events",
  Reminder: "reminders",
  Milestone: "milestones",
  Meeting: "meetings",
};

export const FRONT_MATTER_KEY_ORDER: ReadonlyArray<string> = [
  "id",
  "title",
  "description",
  "type",
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
  "assignee",
  "source_owner",
  "author",
  "estimated_minutes",
  "acceptance_criteria",
  "design",
  "external_ref",
  "definition_of_ready",
  "order",
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
];

type BuiltinGovernancePreset = Exclude<GovernancePreset, "custom">;

export const GOVERNANCE_PRESET_DEFAULTS: Record<BuiltinGovernancePreset, Omit<GovernanceSettings, "preset">> = {
  minimal: {
    ownership_enforcement: "none",
    create_mode_default: "progressive",
    close_validation_default: "off",
    parent_reference: "warn",
    metadata_profile: "core",
    force_required_for_stale_lock: false,
  },
  default: {
    ownership_enforcement: "warn",
    create_mode_default: "progressive",
    close_validation_default: "warn",
    parent_reference: "warn",
    metadata_profile: "core",
    force_required_for_stale_lock: true,
  },
  strict: {
    ownership_enforcement: "strict",
    create_mode_default: "strict",
    close_validation_default: "strict",
    parent_reference: "strict_error",
    metadata_profile: "strict",
    force_required_for_stale_lock: true,
  },
};

export const DEFAULT_VALIDATE_STALE_BLOCKER_REASON_PATTERNS = [
  "no active blocker",
  "ready for planned execution sequencing",
  "work completed",
  "work is closed",
] as const;

export const DEFAULT_VALIDATE_CLOSURE_LIKE_METADATA_FIELD_PATTERNS = {
  blocked_reason: ["no active blocker because work is closed", "work is closed"],
  resolution: ["closed with implementation evidence", "closed with verification evidence", "work completed and recorded", "work is closed"],
  actual_result: ["closed and recorded", "work completed", "work completed and recorded"],
} as const;

export const SETTINGS_DEFAULTS: PmSettings = {
  version: 1,
  id_prefix: "pm-",
  author_default: "",
  item_format: "toon",
  locks: {
    ttl_seconds: 1800,
  },
  output: {
    default_format: "toon",
  },
  history: {
    missing_stream: "auto_create",
  },
  validation: {
    sprint_release_format: "warn",
    parent_reference: "warn",
    metadata_profile: "core",
    metadata_required_fields: [],
    lifecycle_stale_blocker_reason_patterns: [...DEFAULT_VALIDATE_STALE_BLOCKER_REASON_PATTERNS],
    lifecycle_closure_like_blocked_reason_patterns: [
      ...DEFAULT_VALIDATE_CLOSURE_LIKE_METADATA_FIELD_PATTERNS.blocked_reason,
    ],
    lifecycle_closure_like_resolution_patterns: [...DEFAULT_VALIDATE_CLOSURE_LIKE_METADATA_FIELD_PATTERNS.resolution],
    lifecycle_closure_like_actual_result_patterns: [
      ...DEFAULT_VALIDATE_CLOSURE_LIKE_METADATA_FIELD_PATTERNS.actual_result,
    ],
  },
  governance: {
    preset: "minimal",
    ...GOVERNANCE_PRESET_DEFAULTS.minimal,
  },
  workflow: {
    definition_of_done: [],
  },
  testing: {
    record_results_to_items: false,
  },
  telemetry: {
    enabled: true,
    first_run_prompt_completed: false,
    capture_level: "redacted",
    endpoint: "https://pm-cli.unbrained.dev/v1/events",
    installation_id: "",
    retention_days: 365,
  },
  item_types: {
    definitions: [],
  },
  schema: {
    version: 1,
    files: {
      types: "schema/types.json",
      statuses: "schema/statuses.json",
      fields: "schema/fields.json",
      workflows: "schema/workflows.json",
    },
    statuses: [
      {
        id: "draft",
        roles: ["draft"],
      },
      {
        id: "open",
        roles: ["active", "default_open"],
      },
      {
        id: "in_progress",
        aliases: ["in-progress"],
        roles: ["active"],
      },
      {
        id: "blocked",
        roles: ["blocked"],
      },
      {
        id: "closed",
        roles: ["terminal", "terminal_done", "default_close"],
      },
      {
        id: "canceled",
        aliases: ["cancelled"],
        roles: ["terminal", "terminal_canceled", "default_cancel"],
      },
    ],
    fields: [],
    workflow: {
      draft_status: "draft",
      open_status: "open",
      in_progress_status: "in_progress",
      blocked_status: "blocked",
      close_status: "closed",
      canceled_status: "canceled",
    },
    unknown_field_policy: "allow",
  },
  extensions: {
    enabled: [],
    disabled: [],
  },
  search: {
    score_threshold: 0,
    hybrid_semantic_weight: 0.7,
    max_results: 50,
    embedding_model: "",
    embedding_batch_size: 32,
    scanner_max_batch_retries: 3,
    provider: "",
  },
  providers: {
    openai: {
      base_url: "",
      api_key: "",
      model: "",
    },
    ollama: {
      base_url: "",
      model: "",
    },
  },
  context: {
    default_depth: "brief",
    activity_limit: 10,
    stale_threshold_days: 7,
    sections: {
      hierarchy: true,
      activity: true,
      progress: true,
      blockers: true,
      files: true,
      workload: true,
      staleness: true,
      tests: true,
    },
  },
  vector_store: {
    adapter: "",
    qdrant: {
      url: "",
      api_key: "",
    },
    lancedb: {
      path: "",
    },
  },
};

export const EMPTY_CANONICAL_DOCUMENT = {
  front_matter: {},
  body: "",
};

export const EXIT_CODE = {
  SUCCESS: 0,
  GENERIC_FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  CONFLICT: 4,
  DEPENDENCY_FAILED: 5,
} as const;

export type TelemetryErrorCategory = "usage" | "validation" | "conflict" | "runtime" | "unknown";

export const TELEMETRY_ERROR_CATEGORY_BY_CODE: Readonly<Record<string, TelemetryErrorCategory>> = Object.freeze({
  unknown_command: "usage",
  unknown_option: "usage",
  missing_required_option: "usage",
  missing_required_argument: "usage",
  invalid_command_usage: "usage",
  invalid_argument_value: "validation",
  no_update_fields: "validation",
  unsupported_update_option: "validation",
  tracker_not_initialized: "validation",
  item_not_found: "validation",
  ownership_conflict: "conflict",
  lock_conflict: "conflict",
  command_failed: "runtime",
  unknown_error: "runtime",
});

export function resolveTelemetryErrorCategory(errorCode: string | undefined): TelemetryErrorCategory {
  const normalized = (errorCode ?? "").trim().toLowerCase();
  if (normalized.length === 0) {
    return "unknown";
  }
  const explicit = TELEMETRY_ERROR_CATEGORY_BY_CODE[normalized];
  if (typeof explicit === "string") {
    return explicit;
  }
  if (normalized.includes("conflict") || normalized.includes("locked")) {
    return "conflict";
  }
  if (normalized.startsWith("unknown_") || normalized.startsWith("missing_required_")) {
    return "usage";
  }
  if (normalized.startsWith("invalid_") || normalized.endsWith("_not_found") || normalized.includes("validation")) {
    return "validation";
  }
  if (normalized.endsWith("_error") || normalized.endsWith("_failed")) {
    return "runtime";
  }
  return "unknown";
}
