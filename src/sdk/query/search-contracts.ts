/**
 * @module sdk/query/search-contracts
 *
 * Owns search input parsing, output projection contracts, and tuning defaults.
 */
import { coerceNumberInRange } from "../../core/shared/primitives.js";
import type { RuntimeFieldRegistry } from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { resolveIsoOrRelative } from "../../core/shared/time.js";
import type { SharedItemFilterOptions } from "./item-filter-options.js";
import type { SearchMode } from "./search-rendering.js";

/** Documents the search options payload exchanged by command, SDK, and package integrations. */
export interface SearchOptions extends SharedItemFilterOptions {
  /** Value that configures or reports mode for this contract. */
  mode?: string;
  /** Strategy used to control match behavior. */
  matchMode?: string;
  /** Value that configures or reports min score for this contract. */
  minScore?: string | number;
  /** Value that configures or reports count for this contract. */
  count?: boolean;
  /** Value that configures or reports semantic weight for this contract. */
  semanticWeight?: string | number;
  /** Value that configures or reports include linked for this contract. */
  includeLinked?: boolean;
  /** Value that configures or reports title exact for this contract. */
  titleExact?: boolean;
  /** Value that configures or reports phrase exact for this contract. */
  phraseExact?: boolean;
  /** Value that configures or reports limit for this contract. */
  limit?: string;
  /** Opaque cursor returned by a previous search page. */
  after?: string;
  /** Value that configures or reports compact for this contract. */
  compact?: boolean;
  /** Value that configures or reports full for this contract. */
  full?: boolean;
  /** Value that configures or reports fields for this contract. */
  fields?: string;
  /** Whether matched-text snippets are included on each hit. */
  highlight?: boolean;
}

/** Restricts search match mode values accepted by command, SDK, and storage contracts. */
export type SearchMatchMode = "and" | "or" | "exact";

/** Search result projection modes. */
export type SearchProjectionMode = "compact" | "full" | "fields";

/** Validated search result projection. */
export interface SearchProjectionConfig {
  /** Selected projection mode. */
  mode: SearchProjectionMode;
  /** Explicit fields for compact or fields mode. */
  fields: string[];
}

const DEFAULT_COMPACT_SEARCH_FIELDS = [
  "id",
  "title",
  "status",
  "type",
  "priority",
  "updated_at",
  "score",
  "matched_fields",
] as const;

const SEARCH_HIT_FIELD_KEYS = new Set([
  "score",
  "matched_fields",
  "highlights",
]);
const SEARCH_ITEM_FIELD_KEYS = new Set([
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
]);

/** Parse the configured search execution mode. */
export function parseSearchMode(raw: string | undefined): SearchMode {
  if (raw === undefined) return "keyword";
  const normalized = raw.trim().toLowerCase();
  if (
    normalized !== "keyword" &&
    normalized !== "semantic" &&
    normalized !== "hybrid"
  ) {
    throw new PmCliError(
      "Search mode must be one of keyword|semantic|hybrid",
      EXIT_CODE.USAGE,
    );
  }
  return normalized;
}

/** Normalize an opt-in boolean search flag. */
export function parseSearchBoolean(raw: boolean | undefined): boolean {
  return raw === true;
}

/** Parse a per-query semantic weight override. */
export function parseSemanticWeightOverride(raw: unknown): number | undefined {
  return coerceNumberInRange(raw, 0, 1) ?? undefined;
}

/** Parse the lexical match strategy. */
export function parseSearchMatchMode(raw: string | undefined): SearchMatchMode {
  if (raw === undefined) return "or";
  const normalized = raw.trim().toLowerCase();
  if (normalized !== "and" && normalized !== "or" && normalized !== "exact") {
    throw new PmCliError(
      "Search --match-mode must be one of and|or|exact",
      EXIT_CODE.USAGE,
    );
  }
  return normalized;
}

/** Parse a non-negative per-query score threshold. */
export function parseMinScoreOverride(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  /* c8 ignore start -- numeric-vs-string coercion is exercised through CLI parsing */
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  /* c8 ignore stop */
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PmCliError(
      "Search --min-score must be a finite number >= 0",
      EXIT_CODE.USAGE,
    );
  }
  return parsed;
}

/** Parse an ISO or signed-relative timestamp window. */
export function parseTimestampWindow(
  raw: unknown,
  fieldLabel: string,
): string | undefined {
  if (raw == null) return undefined;
  const value = String(raw).trim();
  if (value.length === 0) return undefined;
  return resolveIsoOrRelative(value, new Date(), fieldLabel);
}

/** Normalize a phrase for case-insensitive matching. */
export function normalizeSearchPhrase(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Parse an optional deadline filter. */
export function parseSearchDeadline(
  raw: string | undefined,
  fieldLabel: string,
): string | undefined {
  if (raw === undefined) return undefined;
  return resolveIsoOrRelative(raw, new Date(), fieldLabel);
}

function parseFieldSelectors(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const selectors = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (selectors.length === 0) {
    throw new PmCliError(
      "Search --fields requires a comma-separated list of field names",
      EXIT_CODE.USAGE,
    );
  }
  return [...new Set(selectors)];
}

/** Resolve mutually exclusive compact, full, or explicit-field projection. */
export function parseSearchProjection(
  options: SearchOptions,
): SearchProjectionConfig {
  const compactRequested = options.compact === true;
  const fullRequested = options.full === true;
  const fieldSelectors = parseFieldSelectors(options.fields);
  const enabledModes =
    Number(compactRequested) +
    Number(fullRequested) +
    Number(fieldSelectors !== undefined);
  if (enabledModes > 1) {
    throw new PmCliError(
      "Search projection options are mutually exclusive. Use one of --compact, --full, or --fields.",
      EXIT_CODE.USAGE,
    );
  }
  if (compactRequested) {
    return { mode: "compact", fields: [...DEFAULT_COMPACT_SEARCH_FIELDS] };
  }
  if (fullRequested) return { mode: "full", fields: [] };
  if (fieldSelectors) return { mode: "fields", fields: fieldSelectors };
  return { mode: "full", fields: [] };
}

/** Validate explicit projection fields against core and runtime metadata. */
export function validateSearchProjectionFields(
  projection: SearchProjectionConfig,
  runtimeFieldRegistry: RuntimeFieldRegistry,
): void {
  if (projection.mode !== "fields") return;
  const runtimeKeys = new Set(
    runtimeFieldRegistry.definitions.flatMap((field) => [
      field.key,
      field.metadata_key,
    ]),
  );
  const unknown = projection.fields.filter((field) => {
    const normalized = field.trim();
    const itemKey = normalized.startsWith("item.")
      ? normalized.slice("item.".length)
      : normalized;
    return (
      !SEARCH_HIT_FIELD_KEYS.has(normalized) &&
      !SEARCH_ITEM_FIELD_KEYS.has(itemKey) &&
      !runtimeKeys.has(itemKey)
    );
  });
  if (unknown.length > 0) {
    throw new PmCliError(
      `Unknown search --fields value(s): ${unknown.join(", ")}`,
      EXIT_CODE.USAGE,
      {
        examples: [
          "pm search <query> --fields id,title,status,score",
          "pm search <query> --fields id,title,item.description,matched_fields",
        ],
        nextSteps: [
          "Use item.<field> for explicit item metadata fields, or run pm search --help for projection examples.",
        ],
      },
    );
  }
}

/** Parse a non-empty normalized query into lexical tokens. */
export function parseSearchTokens(query: string): string[] {
  const normalized = normalizeSearchPhrase(query);
  if (!normalized) {
    throw new PmCliError("Search query must not be empty", EXIT_CODE.USAGE);
  }
  return normalized.split(/\s+/u).filter(Boolean);
}

/** Documents the search tuning payload exchanged by command, SDK, and package integrations. */
export interface SearchTuning {
  /** Exact-title ranking bonus. */
  title_exact_bonus: number;
  /** Title field weight. */
  title_weight: number;
  /** Description field weight. */
  description_weight: number;
  /** Tag field weight. */
  tags_weight: number;
  /** Status field weight. */
  status_weight: number;
  /** Body field weight. */
  body_weight: number;
  /** Comment field weight. */
  comments_weight: number;
  /** Note field weight. */
  notes_weight: number;
  /** Learning field weight. */
  learnings_weight: number;
  /** Reminder field weight. */
  reminders_weight: number;
  /** Event field weight. */
  events_weight: number;
  /** Dependency field weight. */
  dependencies_weight: number;
  /** Linked-content field weight. */
  linked_content_weight: number;
}

/** Resolve the bounded default maximum result count. */
export function resolveSearchMaxResults(settings: unknown): number {
  const candidate = (settings as { search?: { max_results?: unknown } }).search
    ?.max_results;
  if (
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate > 0
  ) {
    return Math.floor(candidate);
  }
  return 50;
}

/** Resolve the configured minimum result score. */
export function resolveSearchScoreThreshold(settings: unknown): number {
  const candidate = (settings as { search?: { score_threshold?: unknown } })
    .search?.score_threshold;
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : 0;
}

/** Resolve the configured hybrid semantic weighting. */
export function resolveHybridSemanticWeight(settings: unknown): number {
  const candidate = (
    settings as { search?: { hybrid_semantic_weight?: unknown } }
  ).search?.hybrid_semantic_weight;
  if (
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate >= 0 &&
    candidate <= 1
  ) {
    return candidate;
  }
  return 0.7;
}

/** Resolve non-negative field weights over stable defaults. */
export function resolveSearchTuning(settings: unknown): SearchTuning {
  const defaults: SearchTuning = {
    title_exact_bonus: 10,
    title_weight: 8,
    description_weight: 5,
    tags_weight: 6,
    status_weight: 2,
    body_weight: 1,
    comments_weight: 1,
    notes_weight: 1,
    learnings_weight: 1,
    reminders_weight: 2,
    events_weight: 2,
    dependencies_weight: 3,
    linked_content_weight: 1,
  };
  const tuning = (settings as { search?: { tuning?: Partial<SearchTuning> } })
    .search?.tuning;
  if (!tuning) return defaults;
  const resolveWeight = (candidate: unknown, fallback: number): number =>
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate >= 0
      ? candidate
      : fallback;
  return {
    title_exact_bonus: resolveWeight(
      tuning.title_exact_bonus,
      defaults.title_exact_bonus,
    ),
    title_weight: resolveWeight(tuning.title_weight, defaults.title_weight),
    description_weight: resolveWeight(
      tuning.description_weight,
      defaults.description_weight,
    ),
    tags_weight: resolveWeight(tuning.tags_weight, defaults.tags_weight),
    status_weight: resolveWeight(tuning.status_weight, defaults.status_weight),
    body_weight: resolveWeight(tuning.body_weight, defaults.body_weight),
    comments_weight: resolveWeight(
      tuning.comments_weight,
      defaults.comments_weight,
    ),
    notes_weight: resolveWeight(tuning.notes_weight, defaults.notes_weight),
    learnings_weight: resolveWeight(
      tuning.learnings_weight,
      defaults.learnings_weight,
    ),
    reminders_weight: resolveWeight(
      tuning.reminders_weight,
      defaults.reminders_weight,
    ),
    events_weight: resolveWeight(tuning.events_weight, defaults.events_weight),
    dependencies_weight: resolveWeight(
      tuning.dependencies_weight,
      defaults.dependencies_weight,
    ),
    linked_content_weight: resolveWeight(
      tuning.linked_content_weight,
      defaults.linked_content_weight,
    ),
  };
}
