export type PmItemStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "closed"
  | "canceled"
  | "draft"
  | string;

export interface PmItem {
  id?: string;
  title: string;
  body?: string;
  status?: PmItemStatus;
  priority?: number;
  type?: string;
  tags?: string[];
  release?: string;
  milestone?: string;
  metadata?: Record<string, unknown>;
  url?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  due_date?: string;
}

export type ChangelogGroupBy = "version" | "release" | "milestone";

export interface GenerateChangelogOptions {
  items: PmItem[];
  title?: string;
  version?: string;
  date?: string;
  since?: string;
  until?: string;
  includeStatuses?: string[];
  groupBy?: ChangelogGroupBy;
  includeEmpty?: boolean;
  includeLinks?: boolean;
}

export interface GeneratedChangelog {
  markdown: string;
  sections: ChangelogSection[];
  itemCount: number;
}

export type ChangelogOutputMode = "replace" | "prepend";

export type ChangelogMergeAction = "created" | "inserted" | "replaced" | "unchanged";

export interface MergeChangelogOptions {
  title?: string;
}

export interface MergeChangelogResult {
  markdown: string;
  action: ChangelogMergeAction;
  changed: boolean;
}

export interface ReadPmItemsOptions {
  pmRoot?: string;
  pmBin?: string;
  pmArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

export interface WriteChangelogOptions extends GenerateChangelogOptions {
  output?: string;
  mode?: ChangelogOutputMode;
  check?: boolean;
}

export interface WriteChangelogResult {
  output: string;
  markdown: string;
  action: ChangelogMergeAction;
  changed: boolean;
  itemCount: number;
  bytes: number;
}

export interface ChangelogSection {
  heading: string;
  items: PmItem[];
}
