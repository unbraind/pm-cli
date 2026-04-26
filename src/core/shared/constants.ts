import type { BuiltinItemType, ItemFrontMatter, PmSettings } from "../../types/index.js";

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
    capture_level: "max",
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
