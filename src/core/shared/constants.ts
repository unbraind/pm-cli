import type { ItemFrontMatter, ItemType, PmSettings } from "../../types/index.js";

export const PM_DIRNAME = ".agents/pm";
export const SETTINGS_FILENAME = "settings.json";

export const PM_REQUIRED_SUBDIRS = [
  "",
  "epics",
  "features",
  "tasks",
  "chores",
  "issues",
  "history",
  "index",
  "search",
  "extensions",
  "locks",
] as const;

export const TYPE_TO_FOLDER: Record<ItemType, string> = {
  Epic: "epics",
  Feature: "features",
  Task: "tasks",
  Chore: "chores",
  Issue: "issues",
};

export const FRONT_MATTER_KEY_ORDER: ReadonlyArray<keyof ItemFrontMatter> = [
  "id",
  "title",
  "description",
  "type",
  "source_type",
  "status",
  "priority",
  "tags",
  "created_at",
  "updated_at",
  "deadline",
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
  "docs",
  "close_reason",
];

export const SETTINGS_DEFAULTS: PmSettings = {
  version: 1,
  id_prefix: "pm-",
  author_default: "",
  locks: {
    ttl_seconds: 1800,
  },
  output: {
    default_format: "toon",
  },
  workflow: {
    definition_of_done: [],
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
