export const ITEM_TYPE_VALUES = ["Epic", "Feature", "Task", "Chore", "Issue"] as const;
export type ItemType = (typeof ITEM_TYPE_VALUES)[number];

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
  "related",
  "discovered_from",
] as const;
export type DependencyKind = (typeof DEPENDENCY_KIND_VALUES)[number];

export const SCOPE_VALUES = ["project", "global"] as const;
export type LinkScope = (typeof SCOPE_VALUES)[number];

export const RISK_VALUES = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_VALUES)[number];

export interface Dependency {
  id: string;
  kind: DependencyKind;
  created_at: string;
  author?: string;
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
  note?: string;
}

export interface LinkedDoc {
  path: string;
  scope: LinkScope;
  note?: string;
}

export interface ItemFrontMatter {
  id: string;
  title: string;
  description: string;
  type: ItemType;
  status: ItemStatus;
  priority: 0 | 1 | 2 | 3 | 4;
  tags: string[];
  created_at: string;
  updated_at: string;
  deadline?: string;
  assignee?: string;
  author?: string;
  estimated_minutes?: number;
  acceptance_criteria?: string;
  parent?: string;
  reviewer?: string;
  risk?: "low" | "medium" | "high" | "critical";
  sprint?: string;
  release?: string;
  blocked_by?: string;
  blocked_reason?: string;
  dependencies?: Dependency[];
  comments?: Comment[];
  notes?: LogNote[];
  learnings?: LogNote[];
  files?: LinkedFile[];
  tests?: LinkedTest[];
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
  locks: {
    ttl_seconds: number;
  };
  output: {
    default_format: "toon" | "json";
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
    qdrant: {
      url: string;
      api_key: string;
    };
    lancedb: {
      path: string;
    };
  };
}
