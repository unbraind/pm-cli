import fs from "node:fs/promises";
import path from "node:path";
import { coerceNumberInRange, toNonEmptyStringOrUndefined } from "../../core/shared/primitives.js";
import { isPathWithinDirectory } from "../../core/fs/path-utils.js";
import { getActiveExtensionRegistrations, runActiveOnReadHooks } from "../../core/extensions/index.js";
import { collectRegisteredItemFieldNames } from "../../core/extensions/item-fields.js";
import {
  resolveRegisteredSearchProvider,
  resolveRegisteredVectorStoreAdapter,
} from "../../core/extensions/runtime-registrations.js";
import { resolveItemTypeRegistry, type ItemTypeRegistry } from "../../core/item/type-registry.js";
import { parseLimit, parsePriority, parseType } from "../shared-parsers.js";
import {
  executeEmbeddingRequest,
  resolveEmbeddingProviders,
  type EmbeddingProviderConfig,
  type EmbeddingProviderResolution,
} from "../../core/search/providers.js";
import {
  buildDeterministicQueryExpansions,
  mergeQueryExpansions,
  normalizeQueryExpansionOutput,
  normalizeRerankOutput,
  rerankCandidatesWithEmbeddings,
  resolveQueryExpansionConfig,
  resolveRerankConfig,
  type QueryExpansionConfig,
  type RerankCandidate,
  type RerankConfig,
} from "../../core/search/relevance.js";
import { resolveSettingsWithSemanticRuntimeDefaults } from "../../core/search/semantic-defaults.js";
import {
  executeVectorQuery,
  resolveVectorStores,
  type VectorQueryHit,
  type VectorStoreConfig,
  type VectorStoreResolution,
} from "../../core/search/vector-stores.js";
import { readVectorizationStatusLedger } from "../../core/search/cache.js";
import { buildEventCorpus, buildPlanFlatCorpus, buildReminderCorpus } from "../../core/search/corpus.js";
import { collectStaleVectorizationIds } from "../../core/search/staleness.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { parseItemDocument } from "../../core/item/item-format.js";
import { toItemRecord } from "../../core/item/item-record.js";
import { isTerminalStatus } from "../../core/item/status.js";
import { parseStatusFilterCsv } from "../../core/item/status-filter.js";
import { collectRuntimeFilterValues, matchesRuntimeFilters } from "../../core/schema/runtime-field-filters.js";
import {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeFieldRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { tokenizeAlphaNumeric } from "../../core/shared/text-normalization.js";
import { compareTimestampStrings, nowIso, resolveIsoOrRelative } from "../../core/shared/time.js";
import { listAllDocumentCandidatesCached } from "../../core/store/front-matter-cache.js";
import { listAllFrontMatter } from "../../core/store/item-store.js";
import { getItemPath, getSettingsPath, resolveGlobalPmRoot, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemDocument, ItemFormat, ItemFrontMatter, ItemStatus, ItemType, PmSettings } from "../../types/index.js";

export interface SearchOptions {
  mode?: string;
  semanticWeight?: string | number;
  includeLinked?: boolean;
  titleExact?: boolean;
  phraseExact?: boolean;
  status?: string;
  type?: string;
  tag?: string;
  priority?: string;
  deadlineBefore?: string;
  deadlineAfter?: string;
  limit?: string;
  compact?: boolean;
  full?: boolean;
  fields?: string;
  [key: string]: unknown;
}

type SearchMode = "keyword" | "semantic" | "hybrid";
type SearchProjectionMode = "compact" | "full" | "fields";

interface SearchProjectionConfig {
  mode: SearchProjectionMode;
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

const SEARCH_HIT_FIELD_KEYS = new Set(["score", "matched_fields"]);
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

const LONG_QUERY_TOKEN_THRESHOLD = 2;
const LONG_QUERY_TITLE_EXACT_BONUS = 120;
const LONG_QUERY_PHRASE_MULTIPLIER = 6;
const IMPLICIT_HYBRID_EMBEDDING_TIMEOUT_MS = 8_000;
const IMPLICIT_HYBRID_VECTOR_TIMEOUT_MS = 8_000;

export interface SearchHit {
  item: ItemFrontMatter;
  score: number;
  matched_fields: string[];
}

export type SearchResultItem = SearchHit | Record<string, unknown>;

export interface SearchResult {
  query: string;
  mode: SearchMode;
  items: SearchResultItem[];
  count: number;
  filters: Record<string, unknown>;
  projection: {
    mode: SearchProjectionMode;
    fields: string[] | null;
  };
  now: string;
  warnings?: string[];
}

interface ExtensionSearchProviderContext {
  query: string;
  mode: SearchMode;
  tokens: string[];
  options: SearchOptions;
  settings: PmSettings;
  documents: ItemDocument[];
}

interface ExtensionSearchProviderHit {
  id: string;
  score: number;
  matched_fields?: string[];
}

type ExtensionSearchProviderQuery = (
  context: ExtensionSearchProviderContext,
) => Promise<ExtensionSearchProviderHit[] | { hits?: ExtensionSearchProviderHit[] }> | ExtensionSearchProviderHit[] | { hits?: ExtensionSearchProviderHit[] };

interface ExtensionSearchProviderQueryExpansionContext {
  query: string;
  mode: Exclude<SearchMode, "keyword">;
  settings: PmSettings;
}

type ExtensionSearchProviderQueryExpansion = (
  context: ExtensionSearchProviderQueryExpansionContext,
) => Promise<string[] | { queries?: string[] }> | string[] | { queries?: string[] };

interface ExtensionSearchProviderRerankCandidate {
  id: string;
  text: string;
  score: number;
}

interface ExtensionSearchProviderRerankContext {
  query: string;
  mode: "hybrid";
  model: string;
  top_k: number;
  settings: PmSettings;
  candidates: ExtensionSearchProviderRerankCandidate[];
}

type ExtensionSearchProviderRerank = (
  context: ExtensionSearchProviderRerankContext,
) => Promise<Array<{ id?: unknown; score?: unknown }> | { hits?: Array<{ id?: unknown; score?: unknown }> }>
  | Array<{ id?: unknown; score?: unknown }>
  | { hits?: Array<{ id?: unknown; score?: unknown }> };

type ExtensionVectorQuery = (
  context: {
    vector: number[];
    limit: number;
    settings: PmSettings;
  },
) => Promise<VectorQueryHit[]> | VectorQueryHit[];

type ExtensionVectorAdapter = {
  query?: ExtensionVectorQuery;
};



interface SearchModeContext {
  hasProvider: boolean;
  hasVectorStore: boolean;
}

type ImplicitSemanticFallbackReason = "timeout" | "connection" | "error";

/**
 * Aggregate the `code` strings found along an error's `cause` chain.
 *
 * undici (Node's fetch) collapses connection errors to the generic message
 * "fetch failed" and stashes the real syscall code (e.g. `ECONNREFUSED`) on
 * `error.cause.code`. Walking the chain (bounded depth) lets the fallback
 * classifier label a downed/unreachable Ollama backend as "connection" rather
 * than the catch-all "error".
 */
export function collectErrorCauseCodes(error: unknown): string {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      codes.push(code.toLowerCase());
    }
    current = (current as { cause?: unknown }).cause;
  }
  return codes.join(" ");
}

/**
 * Classify why an implicit/explicit semantic search degraded to keyword mode,
 * inspecting both the error message and the {@link collectErrorCauseCodes} chain
 * so undici's generic "fetch failed" is recognised as a connection failure.
 */
export function classifyImplicitSemanticFallbackReason(error: unknown): ImplicitSemanticFallbackReason {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const causeCodes = collectErrorCauseCodes(error);
  const haystack = `${message} ${causeCodes}`;
  if (haystack.includes("timed out") || haystack.includes("timeout") || haystack.includes("etimedout")) {
    return "timeout";
  }
  if (
    haystack.includes("econnrefused") ||
    haystack.includes("connection refused") ||
    haystack.includes("connect ") ||
    haystack.includes("enotfound") ||
    haystack.includes("eai_again") ||
    haystack.includes("econnreset") ||
    haystack.includes("fetch failed")
  ) {
    return "connection";
  }
  return "error";
}

function buildImplicitSemanticFallbackWarning(error: unknown): string {
  const reason = classifyImplicitSemanticFallbackReason(error);
  if (reason === "timeout") {
    return "search_implicit_semantic_fallback:timeout:using_keyword_mode";
  }
  if (reason === "connection") {
    return "search_implicit_semantic_fallback:connection:using_keyword_mode";
  }
  return "search_implicit_semantic_fallback:error:using_keyword_mode";
}

// Explicit --semantic/--hybrid searches must never hard-fail an agent when the
// embedding/vector backend is unreachable or unconfigured: degrade to keyword
// search and surface a machine-readable warning instead of an unknown_error.
function buildExplicitSemanticFallbackWarning(requestedMode: SearchMode, error: unknown): string {
  const reason = classifyImplicitSemanticFallbackReason(error);
  return `search_${requestedMode}_fallback:${reason}:using_keyword_mode`;
}

/**
 * Compare the vectorization-status ledger against the filtered corpus and, when
 * the vector index is behind, emit a one-line stderr warning plus a structured
 * `vector_index_stale:N` entry in the JSON warnings array. Best-effort: ledger
 * read failures fall through silently — the existing semantic/hybrid fallback
 * paths cover backend errors.
 */
async function maybeEmitVectorIndexStaleWarning(
  pmRoot: string,
  filteredDocuments: ItemDocument[],
  warnings: string[],
): Promise<void> {
  try {
    const ledger = await readVectorizationStatusLedger(pmRoot);
    if (ledger.warnings.length > 0) {
      warnings.push(...ledger.warnings);
    }
    const staleIds = collectStaleVectorizationIds(
      filteredDocuments.map((document) => ({
        id: document.metadata.id,
        updated_at: document.metadata.updated_at,
      })),
      ledger.entries,
    );
    if (staleIds.length === 0) {
      return;
    }
    warnings.push(`vector_index_stale:${staleIds.length}`);
    process.stderr.write(
      `[pm] warning: ${staleIds.length} item${staleIds.length === 1 ? " is" : "s are"} new or modified since the last reindex and ${staleIds.length === 1 ? "is" : "are"} NOT in the semantic index yet — they will be missing from semantic/hybrid results until you run 'pm reindex --mode hybrid'. (Write-time embedding is governed by search.mutation_refresh_policy; staleness means the embed was skipped, failed, or the backend was unreachable.)\n`,
    );
  } catch {
    // Best-effort: missing/unreadable ledger is not a query-blocking concern.
  }
}

function parseMode(raw: string | undefined, _context: SearchModeContext): SearchMode {
  if (raw === undefined) {
    return "keyword";
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized !== "keyword" && normalized !== "semantic" && normalized !== "hybrid") {
    throw new PmCliError("Search mode must be one of keyword|semantic|hybrid", EXIT_CODE.USAGE);
  }
  return normalized;
}

function parseIncludeLinked(raw: boolean | undefined): boolean {
  return raw === true;
}

function parseTitleExact(raw: boolean | undefined): boolean {
  return raw === true;
}

function parsePhraseExact(raw: boolean | undefined): boolean {
  return raw === true;
}

function parseSemanticWeightOverride(raw: unknown): number | undefined {
  return coerceNumberInRange(raw, 0, 1) ?? undefined;
}

function normalizeSearchPhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseDeadline(raw: string | undefined, fieldLabel: string): string | undefined {
  if (raw === undefined) return undefined;
  return resolveIsoOrRelative(raw, new Date(), fieldLabel);
}

function parseFieldSelectors(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const selectors = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (selectors.length === 0) {
    throw new PmCliError("Search --fields requires a comma-separated list of field names", EXIT_CODE.USAGE);
  }
  return [...new Set(selectors)];
}

function parseProjectionConfig(options: SearchOptions): SearchProjectionConfig {
  const compactRequested = options.compact === true;
  const fullRequested = options.full === true;
  const fieldSelectors = parseFieldSelectors(options.fields);
  const enabledModes = Number(compactRequested) + Number(fullRequested) + Number(fieldSelectors !== undefined);
  if (enabledModes > 1) {
    throw new PmCliError(
      "Search projection options are mutually exclusive. Use one of --compact, --full, or --fields.",
      EXIT_CODE.USAGE,
    );
  }
  if (compactRequested) {
    return {
      mode: "compact",
      fields: [...DEFAULT_COMPACT_SEARCH_FIELDS],
    };
  }
  if (fullRequested) {
    return {
      mode: "full",
      fields: [],
    };
  }
  if (fieldSelectors) {
    return {
      mode: "fields",
      fields: fieldSelectors,
    };
  }
  return {
    mode: "full",
    fields: [],
  };
}

function validateSearchProjectionFields(projection: SearchProjectionConfig, runtimeFieldRegistry: RuntimeFieldRegistry): void {
  if (projection.mode !== "fields") {
    return;
  }
  const runtimeKeys = new Set(runtimeFieldRegistry.definitions.flatMap((field) => [field.key, field.metadata_key]));
  const unknown = projection.fields.filter((field) => {
    const normalized = field.trim();
    const itemKey = normalized.startsWith("item.") ? normalized.slice("item.".length) : normalized;
    return !SEARCH_HIT_FIELD_KEYS.has(normalized) && !SEARCH_ITEM_FIELD_KEYS.has(itemKey) && !runtimeKeys.has(itemKey);
  });
  if (unknown.length > 0) {
    throw new PmCliError(`Unknown search --fields value(s): ${unknown.join(", ")}`, EXIT_CODE.USAGE, {
      examples: [
        "pm search <query> --fields id,title,status,score",
        "pm search <query> --fields id,title,item.description,matched_fields",
      ],
      nextSteps: ["Use item.<field> for explicit item metadata fields, or run pm search --help for projection examples."],
    });
  }
}

function parseTokens(query: string): string[] {
  const normalized = normalizeSearchPhrase(query);
  if (!normalized) {
    throw new PmCliError("Search query must not be empty", EXIT_CODE.USAGE);
  }
  return normalized.split(/\s+/).filter(Boolean);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function textEntries(value: unknown): Array<{ text: string }> {
  return Array.isArray(value)
    ? value.filter((entry): entry is { text: string } =>
        typeof entry === "object" && entry !== null && typeof (entry as { text?: unknown }).text === "string",
      )
    : [];
}

function dependencyEntries(value: unknown): Array<{ id: string; kind: string }> {
  return Array.isArray(value)
    ? value.filter((entry): entry is { id: string; kind: string } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "string" &&
        typeof (entry as { kind?: unknown }).kind === "string",
      )
    : [];
}

function collectExactPhraseFields(document: ItemDocument): string[] {
  const item = document.metadata;
  return [
    item.title,
    item.description,
    item.status,
    stringArray(item.tags).join(" "),
    document.body,
    textEntries(item.comments).map((entry) => entry.text).join(" "),
    textEntries(item.notes).map((entry) => entry.text).join(" "),
    textEntries(item.learnings).map((entry) => entry.text).join(" "),
    buildReminderCorpus(item).join(" "),
    buildEventCorpus(item).join(" "),
    dependencyEntries(item.dependencies).map((entry) => `${entry.id} ${entry.kind}`).join(" "),
    buildPlanFlatCorpus(item),
  ];
}

function documentContainsExactPhrase(document: ItemDocument, normalizedQuery: string): boolean {
  return collectExactPhraseFields(document).some((fieldValue) =>
    normalizeSearchPhrase(fieldValue).includes(normalizedQuery),
  );
}

function applyExactQueryFilters(
  items: ItemDocument[],
  normalizedQuery: string,
  options: { titleExact: boolean; phraseExact: boolean },
): ItemDocument[] {
  if (!options.titleExact && !options.phraseExact) {
    return items;
  }
  return items.filter((document) => {
    if (options.titleExact && normalizeSearchPhrase(document.metadata.title) !== normalizedQuery) {
      return false;
    }
    if (options.phraseExact && !documentContainsExactPhrase(document, normalizedQuery)) {
      return false;
    }
    return true;
  });
}

function applyFilters(
  items: ItemDocument[],
  options: SearchOptions,
  typeRegistry: ItemTypeRegistry,
  runtimeFieldFilters: Record<string, unknown>,
  statusFilter: ItemStatus[] | undefined,
): ItemDocument[] {
  const typeFilter = parseType(options.type, typeRegistry);
  const tagFilter = options.tag?.trim().toLowerCase();
  const priorityFilter = parsePriority(options.priority);
  const deadlineBefore = parseDeadline(options.deadlineBefore, "deadline-before");
  const deadlineAfter = parseDeadline(options.deadlineAfter, "deadline-after");
  const statusSet = statusFilter && statusFilter.length > 0 ? new Set<ItemStatus>(statusFilter) : undefined;

  return items.filter((document) => {
    const item = document.metadata;
    if (statusSet && !statusSet.has(item.status)) return false;
    if (typeFilter && item.type !== typeFilter) return false;
    if (tagFilter && !stringArray(item.tags).includes(tagFilter)) return false;
    if (priorityFilter !== undefined && item.priority !== priorityFilter) return false;
    if (deadlineBefore && (!item.deadline || compareTimestampStrings(item.deadline, deadlineBefore) > 0)) return false;
    if (deadlineAfter && (!item.deadline || compareTimestampStrings(item.deadline, deadlineAfter) < 0)) return false;
    if (!matchesRuntimeFilters(item as Record<string, unknown>, runtimeFieldFilters)) return false;
    return true;
  });
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const foundAt = haystack.indexOf(needle, index);
    if (foundAt < 0) {
      return count;
    }
    count += 1;
    index = foundAt + needle.length;
  }
}

function tokenizeForExactTokenMatch(value: string): string[] {
  return tokenizeAlphaNumeric(value);
}

function collectLinkedPaths(item: ItemFrontMatter): Array<{ scope: "project" | "global"; path: string }> {
  const fromFiles = (item.files ?? []).map((entry) => ({
    scope: entry.scope,
    path: entry.path.trim(),
  }));
  const fromDocs = (item.docs ?? []).map((entry) => ({
    scope: entry.scope,
    path: entry.path.trim(),
  }));
  const fromTests = (item.tests ?? [])
    .filter((entry): entry is typeof entry & { path: string } => typeof entry.path === "string" && entry.path.trim().length > 0)
    .map((entry) => ({
      scope: entry.scope,
      path: entry.path.trim(),
    }));
  const sorted = [...fromFiles, ...fromDocs, ...fromTests]
    .filter((entry) => entry.path.length > 0)
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.path.localeCompare(b.path));
  const deduped = new Map<string, { scope: "project" | "global"; path: string }>();
  for (const entry of sorted) {
    deduped.set(`${entry.scope}:${entry.path}`, entry);
  }
  return [...deduped.values()];
}

interface ContainmentRoot {
  resolved: string;
  realpath: string;
}

interface LinkedCorpusRoots {
  projectContainmentRoot: ContainmentRoot | null;
  globalContainmentRoot: ContainmentRoot | null;
}

async function resolveContainmentRoot(root: string): Promise<ContainmentRoot | null> {
  const resolved = path.resolve(root);
  try {
    const realpathRoot = await fs.realpath(resolved);
    return {
      resolved,
      realpath: realpathRoot,
    };
  } catch {
    return null;
  }
}

async function resolveLinkedCorpusRoots(projectRoot: string, globalRoot: string): Promise<LinkedCorpusRoots> {
  const [projectContainmentRoot, globalContainmentRoot] = await Promise.all([
    resolveContainmentRoot(projectRoot),
    resolveContainmentRoot(globalRoot),
  ]);
  return {
    projectContainmentRoot,
    globalContainmentRoot,
  };
}

async function loadLinkedCorpus(
  document: ItemDocument,
  roots: LinkedCorpusRoots,
): Promise<string> {
  const linkedPaths = collectLinkedPaths(document.metadata);
  const chunks: string[] = [];
  for (const linkedPath of linkedPaths) {
    const containmentRoot = linkedPath.scope === "global" ? roots.globalContainmentRoot : roots.projectContainmentRoot;
    if (!containmentRoot) {
      continue;
    }
    const resolved = path.resolve(containmentRoot.resolved, linkedPath.path);
    if (!isPathWithinDirectory(containmentRoot.resolved, resolved)) {
      continue;
    }
    let linkedRealpath: string;
    try {
      linkedRealpath = await fs.realpath(resolved);
    } catch {
      continue;
    }
    if (!isPathWithinDirectory(containmentRoot.realpath, linkedRealpath)) {
      continue;
    }
    try {
      await runActiveOnReadHooks({
        path: resolved,
        scope: linkedPath.scope,
      });
      chunks.push(await fs.readFile(resolved, "utf8"));
    } catch {
      // Best-effort linked-content indexing: unreadable paths are ignored.
    }
  }
  return chunks.join("\n");
}

export interface SearchTuning {
  title_exact_bonus: number;
  title_weight: number;
  description_weight: number;
  tags_weight: number;
  status_weight: number;
  body_weight: number;
  comments_weight: number;
  notes_weight: number;
  learnings_weight: number;
  reminders_weight: number;
  events_weight: number;
  dependencies_weight: number;
  linked_content_weight: number;
}

function scoreDocument(
  document: ItemDocument,
  tokens: string[],
  normalizedQuery: string,
  linkedCorpus: string,
  tuning: SearchTuning,
): SearchHit | null {
  const item = document.metadata;
  const titleTokenCounts = new Map<string, number>();
  for (const token of tokenizeForExactTokenMatch(item.title)) {
    titleTokenCounts.set(token, (titleTokenCounts.get(token) ?? 0) + 1);
  }
  const searchableFields: Array<{ name: string; value: string; weight: number }> = [
    { name: "title", value: item.title, weight: tuning.title_weight },
    { name: "description", value: item.description, weight: tuning.description_weight },
    { name: "tags", value: stringArray(item.tags).join(" "), weight: tuning.tags_weight },
    { name: "status", value: typeof item.status === "string" ? item.status : "", weight: tuning.status_weight },
    { name: "body", value: document.body, weight: tuning.body_weight },
    { name: "comments", value: textEntries(item.comments).map((entry) => entry.text).join(" "), weight: tuning.comments_weight },
    { name: "notes", value: textEntries(item.notes).map((entry) => entry.text).join(" "), weight: tuning.notes_weight },
    { name: "learnings", value: textEntries(item.learnings).map((entry) => entry.text).join(" "), weight: tuning.learnings_weight },
    { name: "reminders", value: buildReminderCorpus(item).join(" "), weight: tuning.reminders_weight },
    { name: "events", value: buildEventCorpus(item).join(" "), weight: tuning.events_weight },
    {
      name: "dependencies",
      value: dependencyEntries(item.dependencies).map((entry) => `${entry.id} ${entry.kind}`).join(" "),
      weight: tuning.dependencies_weight,
    },
    { name: "plan", value: buildPlanFlatCorpus(item), weight: tuning.body_weight },
    { name: "linked_content", value: linkedCorpus, weight: tuning.linked_content_weight },
  ];

  let score = 0;
  const matched = new Set<string>();
  for (const token of tokens) {
    const exactTitleMatches = titleTokenCounts.get(token) ?? 0;
    if (exactTitleMatches > 0) {
      score += exactTitleMatches * tuning.title_exact_bonus;
      matched.add("title");
    }
    for (const field of searchableFields) {
      const fieldValue = field.value.toLowerCase();
      const occurrences = countOccurrences(fieldValue, token);
      if (occurrences > 0) {
        score += occurrences * field.weight;
        matched.add(field.name);
      }
    }
  }

  const isLongPhraseQuery = tokens.length >= LONG_QUERY_TOKEN_THRESHOLD && normalizedQuery.includes(" ");
  if (isLongPhraseQuery) {
    const normalizedTitle = normalizeSearchPhrase(item.title);
    if (normalizedTitle === normalizedQuery) {
      score += LONG_QUERY_TITLE_EXACT_BONUS;
      matched.add("title");
    }
    for (const field of searchableFields) {
      const normalizedField = normalizeSearchPhrase(field.value);
      const phraseOccurrences = countOccurrences(normalizedField, normalizedQuery);
      if (phraseOccurrences > 0) {
        score += phraseOccurrences * field.weight * LONG_QUERY_PHRASE_MULTIPLIER;
        matched.add(field.name);
      }
    }
  }

  if (score <= 0) {
    return null;
  }

  return {
    item,
    score,
    matched_fields: [...matched].sort((a, b) => a.localeCompare(b)),
  };
}

function sortHits(items: SearchHit[], statusRegistry: RuntimeStatusRegistry): SearchHit[] {
  return [...items].sort((a, b) => {
    const byScore = b.score - a.score;
    if (byScore !== 0) return byScore;
    const aTerminal = isTerminalStatus(a.item.status, statusRegistry);
    const bTerminal = isTerminalStatus(b.item.status, statusRegistry);
    if (aTerminal !== bTerminal) {
      return aTerminal ? 1 : -1;
    }
    const byPriority = a.item.priority - b.item.priority;
    if (byPriority !== 0) return byPriority;
    const byUpdated = compareTimestampStrings(b.item.updated_at, a.item.updated_at);
    if (byUpdated !== 0) return byUpdated;
    return a.item.id.localeCompare(b.item.id);
  });
}

function buildHybridLexicalScore(
  document: ItemDocument,
  tokens: string[],
  normalizedQuery: string,
  includeLinked: boolean,
  linkedCorpusById: Map<string, string>,
  tuning: SearchTuning,
): SearchHit | null {
  return scoreDocument(
    document,
    tokens,
    normalizedQuery,
    includeLinked ? linkedCorpusById.get(document.metadata.id) ?? "" : "",
    tuning,
  );
}

function normalizeScoreMap(scoreById: Map<string, number>): Map<string, number> {
  if (scoreById.size === 0) {
    return new Map();
  }
  const values = [...scoreById.values()];
  const minScore = Math.min(...values);
  const maxScore = Math.max(...values);
  if (maxScore === minScore) {
    return new Map([...scoreById.keys()].map((id) => [id, 1]));
  }
  const normalized = new Map<string, number>();
  for (const [id, score] of scoreById) {
    normalized.set(id, (score - minScore) / (maxScore - minScore));
  }
  return normalized;
}

export function resolveSearchMaxResults(settings: unknown): number {
  const candidate = (settings as { search?: { max_results?: unknown } }).search?.max_results;
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
    return Math.floor(candidate);
  }
  return 50;
}

export function resolveSearchScoreThreshold(settings: unknown): number {
  const candidate = (settings as { search?: { score_threshold?: unknown } }).search?.score_threshold;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return candidate;
  }
  return 0;
}

export function resolveHybridSemanticWeight(settings: unknown): number {
  const candidate = (settings as { search?: { hybrid_semantic_weight?: unknown } }).search?.hybrid_semantic_weight;
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 && candidate <= 1) {
    return candidate;
  }
  return 0.7;
}

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
  const tuning = (settings as { search?: { tuning?: Partial<SearchTuning> } }).search?.tuning;
  if (!tuning) return defaults;

  const resolveWeight = (candidate: unknown, fallback: number) => {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
    return fallback;
  };

  return {
    title_exact_bonus: resolveWeight(tuning.title_exact_bonus, defaults.title_exact_bonus),
    title_weight: resolveWeight(tuning.title_weight, defaults.title_weight),
    description_weight: resolveWeight(tuning.description_weight, defaults.description_weight),
    tags_weight: resolveWeight(tuning.tags_weight, defaults.tags_weight),
    status_weight: resolveWeight(tuning.status_weight, defaults.status_weight),
    body_weight: resolveWeight(tuning.body_weight, defaults.body_weight),
    comments_weight: resolveWeight(tuning.comments_weight, defaults.comments_weight),
    notes_weight: resolveWeight(tuning.notes_weight, defaults.notes_weight),
    learnings_weight: resolveWeight(tuning.learnings_weight, defaults.learnings_weight),
    reminders_weight: resolveWeight(tuning.reminders_weight, defaults.reminders_weight),
    events_weight: resolveWeight(tuning.events_weight, defaults.events_weight),
    dependencies_weight: resolveWeight(tuning.dependencies_weight, defaults.dependencies_weight),
    linked_content_weight: resolveWeight(tuning.linked_content_weight, defaults.linked_content_weight),
  };
}

function emptySearchResult(
  query: string,
  mode: SearchMode,
  options: SearchOptions,
  includeLinked: boolean,
  scoreThreshold: number,
  hybridSemanticWeight: number,
  queryExpansion: QueryExpansionConfig,
  rerank: RerankConfig,
  projection: SearchProjectionConfig,
  warnings: string[],
): SearchResult {
  const projectionFields = projection.mode === "full" ? null : [...projection.fields];
  return {
    query: query.trim(),
    mode,
    items: [],
    count: 0,
    filters: {
      mode,
      status: options.status ?? null,
      type: options.type ?? null,
      tag: options.tag ?? null,
      priority: options.priority ?? null,
      deadline_before: options.deadlineBefore ?? null,
      deadline_after: options.deadlineAfter ?? null,
      include_linked: includeLinked,
      title_exact: options.titleExact === true,
      phrase_exact: options.phraseExact === true,
      score_threshold: scoreThreshold,
      hybrid_semantic_weight: mode === "hybrid" ? hybridSemanticWeight : null,
      query_expansion_enabled: queryExpansion.enabled,
      query_expansion_provider: queryExpansion.provider,
      rerank_enabled: rerank.enabled,
      rerank_model: rerank.model,
      rerank_top_k: rerank.top_k,
      limit: options.limit ?? null,
    },
    projection: {
      mode: projection.mode,
      fields: projectionFields,
    },
    now: nowIso(),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function requireSemanticDependencies(
  requestedMode: Exclude<SearchMode, "keyword">,
  providerResolution: EmbeddingProviderResolution,
  vectorResolution: VectorStoreResolution,
  hasExtensionVectorQuery: boolean,
): { provider: EmbeddingProviderConfig; vectorStore: VectorStoreConfig | null } {
  if (!providerResolution.active) {
    throw new PmCliError(
      `Search mode '${requestedMode}' requires a configured embedding provider in settings.providers.openai or settings.providers.ollama`,
      EXIT_CODE.USAGE,
    );
  }
  if (!vectorResolution.active && !hasExtensionVectorQuery) {
    throw new PmCliError(
      `Search mode '${requestedMode}' requires a configured vector store in settings.vector_store.qdrant/settings.vector_store.lancedb or an extension adapter selected by settings.vector_store.adapter`,
      EXIT_CODE.USAGE,
    );
  }
  return {
    provider: providerResolution.active,
    vectorStore: vectorResolution.active ?? null,
  };
}

const toOptionalNonEmptyString = toNonEmptyStringOrUndefined;

interface ExtensionSearchProviderHooks {
  providerName: string;
  query?: ExtensionSearchProviderQuery;
  queryExpansion?: ExtensionSearchProviderQueryExpansion;
  rerank?: ExtensionSearchProviderRerank;
}

function resolveExtensionSearchProviderByName(providerName: string | undefined): ExtensionSearchProviderHooks | null {
  const registrations = getActiveExtensionRegistrations();
  const resolved = resolveRegisteredSearchProvider(registrations, providerName);
  if (!resolved) {
    return null;
  }
  const runtimeDefinition = resolved.runtime_definition ?? resolved.definition;
  const query = (runtimeDefinition as { query?: unknown }).query;
  const queryExpansion =
    (runtimeDefinition as { queryExpansion?: unknown; query_expansion?: unknown }).queryExpansion ??
    (runtimeDefinition as { queryExpansion?: unknown; query_expansion?: unknown }).query_expansion;
  const rerank = (runtimeDefinition as { rerank?: unknown }).rerank;
  const registeredName =
    toOptionalNonEmptyString((runtimeDefinition as { name?: unknown }).name) ??
    toOptionalNonEmptyString((resolved.definition as { name?: unknown }).name) ??
    providerName;
  if (!registeredName) {
    return null;
  }
  const hooks: ExtensionSearchProviderHooks = {
    providerName: registeredName,
    ...(typeof query === "function" ? { query: query as ExtensionSearchProviderQuery } : {}),
    ...(typeof queryExpansion === "function"
      ? { queryExpansion: queryExpansion as ExtensionSearchProviderQueryExpansion }
      : {}),
    ...(typeof rerank === "function" ? { rerank: rerank as ExtensionSearchProviderRerank } : {}),
  };
  if (!hooks.query && !hooks.queryExpansion && !hooks.rerank) {
    return null;
  }
  return hooks;
}

function resolveExtensionSearchProvider(settings: PmSettings): { providerName: string; query: ExtensionSearchProviderQuery } | null {
  const providerName = toOptionalNonEmptyString((settings.search as { provider?: unknown } | undefined)?.provider);
  const resolved = resolveExtensionSearchProviderByName(providerName);
  if (!resolved?.query) {
    return null;
  }
  return {
    providerName: resolved.providerName,
    query: resolved.query,
  };
}

function resolveExtensionVectorAdapter(settings: PmSettings): ExtensionVectorAdapter | null {
  const registrations = getActiveExtensionRegistrations();
  const adapterName = toOptionalNonEmptyString((settings.vector_store as { adapter?: unknown } | undefined)?.adapter);
  const resolved = resolveRegisteredVectorStoreAdapter(registrations, adapterName);
  if (!resolved) {
    return null;
  }
  const runtimeDefinition = resolved.runtime_definition ?? resolved.definition;
  const query = (runtimeDefinition as { query?: unknown }).query;
  if (typeof query !== "function") {
    return null;
  }
  return {
    query: query as ExtensionVectorQuery,
  };
}

function normalizeExtensionProviderHits(
  providerName: string,
  raw: unknown,
  filteredById: Map<string, ItemDocument>,
): SearchHit[] {
  const rawHits = Array.isArray(raw)
    ? raw
    : (raw as { hits?: unknown } | null | undefined)?.hits;
  if (!Array.isArray(rawHits)) {
    throw new PmCliError(
      `Extension search provider "${providerName}" must return an array of hits or { hits: [...] }`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const rawHit of rawHits) {
    if (typeof rawHit !== "object" || rawHit === null) {
      continue;
    }
    const id = toOptionalNonEmptyString((rawHit as { id?: unknown }).id);
    const score = (rawHit as { score?: unknown }).score;
    if (!id || typeof score !== "number" || !Number.isFinite(score) || seen.has(id)) {
      continue;
    }
    const document = filteredById.get(id);
    if (!document) {
      continue;
    }
    const matchedFieldsRaw = (rawHit as { matched_fields?: unknown }).matched_fields;
    const matchedFields =
      Array.isArray(matchedFieldsRaw) && matchedFieldsRaw.every((entry) => typeof entry === "string")
        ? [...new Set((matchedFieldsRaw as string[]).map((entry) => entry.trim()).filter((entry) => entry.length > 0))].sort((a, b) =>
            a.localeCompare(b),
          )
        : [`provider:${providerName}`];
    seen.add(id);
    hits.push({
      item: document.metadata,
      score,
      matched_fields: matchedFields,
    });
  }
  return hits;
}

function buildSemanticHits(
  vectorHits: VectorQueryHit[],
  filteredById: Map<string, ItemDocument>,
): { semanticHits: SearchHit[]; semanticScores: Map<string, number> } {
  const semanticHits: SearchHit[] = [];
  const semanticScores = new Map<string, number>();
  for (const vectorHit of vectorHits) {
    if (semanticScores.has(vectorHit.id)) {
      continue;
    }
    const document = filteredById.get(vectorHit.id);
    if (!document) {
      continue;
    }
    semanticScores.set(vectorHit.id, vectorHit.score);
    semanticHits.push({
      item: document.metadata,
      score: vectorHit.score,
      matched_fields: ["semantic"],
    });
  }
  return {
    semanticHits,
    semanticScores,
  };
}

function combineHybridHits(
  filteredById: Map<string, ItemDocument>,
  semanticScores: Map<string, number>,
  keywordHits: SearchHit[],
  hybridSemanticWeight: number,
): SearchHit[] {
  const keywordScores = new Map(keywordHits.map((entry) => [entry.item.id, entry.score]));
  const keywordMatches = new Map(keywordHits.map((entry) => [entry.item.id, entry.matched_fields]));
  const normalizedSemantic = normalizeScoreMap(semanticScores);
  const normalizedKeyword = normalizeScoreMap(keywordScores);
  const candidateIds = new Set<string>([...semanticScores.keys(), ...keywordScores.keys()]);
  const keywordWeight = 1 - hybridSemanticWeight;
  return [...candidateIds]
    .map((id) => {
      const document = filteredById.get(id)!;
      const semanticScore = normalizedSemantic.get(id) ?? 0;
      const keywordScore = normalizedKeyword.get(id) ?? 0;
      const combinedScore = (semanticScore * hybridSemanticWeight) + (keywordScore * keywordWeight);
      if (combinedScore <= 0) {
        return null;
      }
      const matchedFields = new Set<string>();
      if (semanticScores.has(id)) {
        matchedFields.add("semantic");
      }
      for (const field of keywordMatches.get(id) ?? []) {
        matchedFields.add(field);
      }
      return {
        item: document.metadata,
        score: combinedScore,
        matched_fields: [...matchedFields].sort((a, b) => a.localeCompare(b)),
      };
    })
    .filter((entry): entry is SearchHit => entry !== null);
}

interface SemanticQueryContext {
  requestedMode: Exclude<SearchMode, "keyword">;
  query: string;
  filteredDocuments: ItemDocument[];
  keywordHits: SearchHit[];
  hybridSemanticWeight: number;
  limit: number | undefined;
  maxResults: number;
  provider: EmbeddingProviderConfig;
  vectorStore: VectorStoreConfig | null;
  extensionVectorAdapter: ExtensionVectorAdapter | null;
  queryExpansion: QueryExpansionConfig;
  queryExpansionExtension: { providerName: string; expand: ExtensionSearchProviderQueryExpansion } | null;
  rerank: RerankConfig;
  rerankExtension: { providerName: string; rerank: ExtensionSearchProviderRerank } | null;
  warnings: string[];
  settings: PmSettings;
  embeddingTimeoutMs?: number;
  vectorQueryTimeoutMs?: number;
}

interface SemanticQueryResult {
  hits: SearchHit[];
  // Number of documents returned by the vector stage for this query after the
  // current metadata filters. When this is 0 the semantic/hybrid query ran
  // successfully, but vector ranking contributed nothing to the returned hits.
  vectorMatchCount: number;
}

function mergeVectorHitsById(vectorHitGroups: VectorQueryHit[][]): VectorQueryHit[] {
  const bestById = new Map<string, VectorQueryHit>();
  for (const group of vectorHitGroups) {
    for (const hit of group) {
      const existing = bestById.get(hit.id);
      if (!existing || hit.score > existing.score) {
        bestById.set(hit.id, hit);
      }
    }
  }
  const merged = [...bestById.values()];
  merged.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.id.localeCompare(right.id);
  });
  return merged;
}

function buildRerankCorpus(document: ItemDocument): string {
  const metadata = document.metadata;
  const tags = Array.isArray(metadata.tags) ? metadata.tags.join(" ") : "";
  return [
    metadata.title,
    metadata.description,
    metadata.type,
    metadata.status,
    tags,
    document.body,
  ]
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0)
    .join("\n");
}

async function computeSemanticOrHybridHits(context: SemanticQueryContext): Promise<SemanticQueryResult> {
  const semanticLimit = context.limit ?? context.maxResults;
  const embeddingOptions = context.embeddingTimeoutMs !== undefined ? { timeout_ms: context.embeddingTimeoutMs } : {};
  const vectorQueryOptions = context.vectorQueryTimeoutMs !== undefined ? { timeout_ms: context.vectorQueryTimeoutMs } : {};
  const queryTrimmed = context.query.trim();
  const baseExpandedQueries = context.queryExpansion.enabled
    ? buildDeterministicQueryExpansions(queryTrimmed, context.queryExpansion.max_queries)
    : [queryTrimmed];
  let expandedQueries = baseExpandedQueries.length > 0 ? baseExpandedQueries : [queryTrimmed];
  if (context.queryExpansion.enabled) {
    if (context.queryExpansionExtension?.expand) {
      try {
        const rawExpansion = await Promise.resolve(
          context.queryExpansionExtension.expand({
            query: queryTrimmed,
            mode: context.requestedMode,
            settings: context.settings,
          }),
        );
        const extensionExpansion = normalizeQueryExpansionOutput(rawExpansion);
        expandedQueries = mergeQueryExpansions(expandedQueries, extensionExpansion, context.queryExpansion.max_queries);
      } catch {
        context.warnings.push(
          `search_query_expansion_provider_failed:${context.queryExpansionExtension.providerName}:using_builtin`,
        );
      }
    } else if (
      context.queryExpansion.provider &&
      context.queryExpansion.provider !== "openai" &&
      context.queryExpansion.provider !== "ollama"
    ) {
      context.warnings.push(
        `search_query_expansion_provider_unavailable:${context.queryExpansion.provider}:using_builtin`,
      );
    }
  }

  const queryVectors = await executeEmbeddingRequest(context.provider, expandedQueries, embeddingOptions);
  const queryVectorGroups: VectorQueryHit[][] = [];

  const executeVectorQueryWithFallback = async (semanticVector: number[]): Promise<VectorQueryHit[]> => {
    if (context.extensionVectorAdapter?.query) {
      try {
        return await Promise.resolve(
          context.extensionVectorAdapter.query({
            vector: semanticVector,
            limit: semanticLimit,
            settings: context.settings,
          }),
        );
      } catch (error: unknown) {
        if (!context.vectorStore) {
          throw new PmCliError(
            `Extension vector adapter query failed and no built-in fallback store is configured (${error instanceof Error ? error.message : String(error)})`,
            EXIT_CODE.GENERIC_FAILURE,
          );
        }
        return await executeVectorQuery(context.vectorStore, semanticVector, semanticLimit, vectorQueryOptions);
      }
    }
    if (context.vectorStore) {
      return await executeVectorQuery(context.vectorStore, semanticVector, semanticLimit, vectorQueryOptions);
    }
    throw new PmCliError(
      "Semantic search requires either a configured vector store or an extension vector adapter query handler",
      EXIT_CODE.USAGE,
    );
  };

  for (const semanticVector of queryVectors) {
    queryVectorGroups.push(await executeVectorQueryWithFallback(semanticVector));
  }
  const vectorHits = mergeVectorHitsById(queryVectorGroups);
  const filteredById = new Map(context.filteredDocuments.map((document) => [document.metadata.id, document]));
  const { semanticHits, semanticScores } = buildSemanticHits(vectorHits, filteredById);
  const vectorMatchCount = semanticScores.size;
  if (context.requestedMode === "semantic") {
    return { hits: semanticHits, vectorMatchCount };
  }
  let hybridHits = combineHybridHits(filteredById, semanticScores, context.keywordHits, context.hybridSemanticWeight);
  if (context.rerank.enabled && hybridHits.length > 1) {
    const sortedForCandidates = [...hybridHits].sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.item.id.localeCompare(right.item.id);
    });
    const candidateHits = sortedForCandidates.slice(0, context.rerank.top_k);
    const candidateContexts = candidateHits
      .map((hit) => {
        const document = filteredById.get(hit.item.id);
        if (!document) {
          return null;
        }
        return { hit, text: buildRerankCorpus(document) };
      })
      .filter((entry): entry is { hit: SearchHit; text: string } => entry !== null);
    const rerankCandidates: RerankCandidate[] = candidateContexts.map((entry) => ({
      id: entry.hit.item.id,
      text: entry.text,
    }));
    let rerankScores: Map<string, number> | null = null;
    if (context.rerankExtension?.rerank) {
      try {
        const rawRerank = await Promise.resolve(
          context.rerankExtension.rerank({
            query: queryTrimmed,
            mode: "hybrid",
            model: context.rerank.model,
            top_k: context.rerank.top_k,
            settings: context.settings,
            candidates: candidateContexts.map((entry) => ({
              id: entry.hit.item.id,
              text: entry.text,
              score: entry.hit.score,
            })),
          }),
        );
        const normalizedRerank = normalizeRerankOutput(rawRerank);
        if (normalizedRerank.length > 0) {
          rerankScores = new Map(normalizedRerank.map((entry) => [entry.id, entry.score]));
        } else {
          context.warnings.push(
            `search_rerank_provider_invalid_response:${context.rerankExtension.providerName}:using_builtin`,
          );
        }
      } catch {
        context.warnings.push(`search_rerank_provider_failed:${context.rerankExtension.providerName}:using_builtin`);
      }
    }
    if (!rerankScores) {
      try {
        rerankScores = await rerankCandidatesWithEmbeddings(
          context.provider,
          context.rerank.model,
          queryTrimmed,
          rerankCandidates,
          context.embeddingTimeoutMs,
        );
      } catch {
        context.warnings.push("search_rerank_failed:using_hybrid_scores");
      }
    }
    if (rerankScores && rerankScores.size > 0) {
      hybridHits = hybridHits.map((hit) => {
        const rerankScore = rerankScores.get(hit.item.id);
        if (rerankScore === undefined) {
          return hit;
        }
        const matchedFields = new Set(hit.matched_fields);
        matchedFields.add("rerank");
        return {
          ...hit,
          score: rerankScore,
          matched_fields: [...matchedFields].sort((left, right) => left.localeCompare(right)),
        };
      });
      hybridHits.sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        return left.item.id.localeCompare(right.item.id);
      });
    }
  }
  return {
    hits: hybridHits,
    vectorMatchCount,
  };
}

async function loadDocuments(
  pmRoot: string,
  itemFormat: ItemFormat,
  typeToFolder: Record<string, string>,
  schema: PmSettings["schema"],
): Promise<{ documents: ItemDocument[]; warnings: string[] }> {
  const extensionFieldNames = collectRegisteredItemFieldNames(getActiveExtensionRegistrations());
  const readDocumentBody = async (
    metadata: ItemFrontMatter,
    preferredPath: string,
    preferredFormat: ItemFormat,
  ): Promise<string> => {
    const tryRead = async (targetPath: string, format: ItemFormat): Promise<string> => {
      await runActiveOnReadHooks({ path: targetPath, scope: "project" });
      const raw = await fs.readFile(targetPath, "utf8");
      const parsed = parseItemDocument(raw, {
        format,
        schema,
        extensionFieldNames,
        onWarning: (warning) => listWarnings.push(warning),
      });
      return parsed.body;
    };

    try {
      return await tryRead(preferredPath, preferredFormat);
    } catch {
      const alternateFormat: ItemFormat = preferredFormat === "toon" ? "json_markdown" : "toon";
      const alternatePath = getItemPath(pmRoot, metadata.type as ItemType, metadata.id, alternateFormat, typeToFolder);
      try {
        return await tryRead(alternatePath, alternateFormat);
      } catch {
        listWarnings.push(`item_list_item_read_failed:${path.relative(pmRoot, alternatePath)}`);
        return "";
      }
    }
  };

  const listWarnings: string[] = [];
  const cachedDocuments = await listAllDocumentCandidatesCached(pmRoot, itemFormat, typeToFolder, listWarnings, schema);
  const documents: ItemDocument[] = [];
  if (cachedDocuments.length === 0) {
    const frontMatterDocuments = await listAllFrontMatter(pmRoot, itemFormat, typeToFolder, listWarnings, schema);
    for (const metadata of frontMatterDocuments) {
      const preferredPath = getItemPath(pmRoot, metadata.type as ItemType, metadata.id, itemFormat, typeToFolder);
      const body = await readDocumentBody(metadata, preferredPath, itemFormat);
      documents.push({ metadata, body });
    }
    return {
      documents,
      warnings: [...new Set(listWarnings)].sort((left, right) => left.localeCompare(right)),
    };
  }

  for (const cachedDocument of cachedDocuments) {
    if (typeof cachedDocument.body === "string") {
      documents.push({
        metadata: cachedDocument.metadata,
        body: cachedDocument.body,
      });
      continue;
    }
    const body = await readDocumentBody(cachedDocument.metadata, cachedDocument.item_path, cachedDocument.item_format);
    documents.push({
      metadata: cachedDocument.metadata,
      body,
    });
  }
  return {
    documents,
    warnings: [...new Set(listWarnings)].sort((left, right) => left.localeCompare(right)),
  };
}

function readSearchFieldValue(hit: SearchHit, field: string): unknown {
  const normalized = field.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized === "score") {
    return hit.score;
  }
  if (normalized === "matched_fields") {
    return hit.matched_fields;
  }
  if (normalized.startsWith("item.")) {
    const itemKey = normalized.slice("item.".length);
    if (itemKey.length === 0) {
      return null;
    }
    const itemRecord = toItemRecord(hit.item);
    return itemRecord[itemKey] ?? null;
  }
  const hitRecord = hit as unknown as Record<string, unknown>;
  const itemRecord = toItemRecord(hit.item);
  if (Object.prototype.hasOwnProperty.call(itemRecord, normalized)) {
    return itemRecord[normalized] ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(hitRecord, normalized)) {
    return hitRecord[normalized] ?? null;
  }
  return null;
}

function projectSearchHits(hits: SearchHit[], projection: SearchProjectionConfig): SearchResultItem[] {
  if (projection.mode === "full") {
    return hits;
  }
  return hits.map((hit) => {
    const projected: Record<string, unknown> = {};
    for (const field of projection.fields) {
      projected[field] = readSearchFieldValue(hit, field);
    }
    return projected;
  });
}

export async function runSearch(query: string, options: SearchOptions, global: GlobalOptions): Promise<SearchResult> {
  const includeLinked = parseIncludeLinked(options.includeLinked);
  const titleExact = parseTitleExact(options.titleExact);
  const phraseExact = parsePhraseExact(options.phraseExact);
  const tokens = parseTokens(query);
  const normalizedQuery = normalizeSearchPhrase(query);
  const limit = parseLimit(options.limit);
  const projection = parseProjectionConfig(options);
  const modeWasExplicit = typeof options.mode === "string" && options.mode.trim().length > 0;
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const storedSettings = await readSettings(pmRoot);
  const runtimeDefaultsResolution = resolveSettingsWithSemanticRuntimeDefaults(storedSettings);
  const settings = runtimeDefaultsResolution.settings;
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  validateSearchProjectionFields(projection, runtimeFieldRegistry);
  const runtimeFieldFilters = collectRuntimeFilterValues(options as Record<string, unknown>, runtimeFieldRegistry, "search");
  // `pm search --status` resolves strictly (a typo'd status surfaces a
  // did-you-mean hint) so agents can scope retrieval to open work and drop
  // closed-history noise without re-listing. Resolved before the corpus scan so
  // an invalid value fails fast.
  const statusFilter = parseStatusFilterCsv(
    typeof options.status === "string" ? options.status : undefined,
    statusRegistry,
    { strict: true },
  );
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const maxResults = resolveSearchMaxResults(settings);
  const scoreThreshold = resolveSearchScoreThreshold(settings);
  const semanticWeightProvided = options.semanticWeight !== undefined;
  const semanticWeightOverride = parseSemanticWeightOverride(options.semanticWeight);
  const hybridSemanticWeight = semanticWeightOverride ?? resolveHybridSemanticWeight(settings);
  const tuning = resolveSearchTuning(settings);
  const providerResolution = resolveEmbeddingProviders(settings);
  const vectorResolution = resolveVectorStores(settings);
  const extensionSearchProvider = resolveExtensionSearchProvider(settings);
  const extensionVectorAdapter = resolveExtensionVectorAdapter(settings);
  const queryExpansion = resolveQueryExpansionConfig(settings, providerResolution.active?.name ?? null);
  const rerank = resolveRerankConfig(
    settings,
    providerResolution.active?.model ?? toOptionalNonEmptyString(settings.search?.embedding_model) ?? "text-embedding-3-small",
  );
  const queryExpansionProvider = resolveExtensionSearchProviderByName(queryExpansion.provider ?? undefined);
  const queryExpansionExtension = queryExpansionProvider?.queryExpansion
    ? { providerName: queryExpansionProvider.providerName, expand: queryExpansionProvider.queryExpansion }
    : null;
  const rerankProvider = resolveExtensionSearchProviderByName(toOptionalNonEmptyString(settings.search?.provider));
  const rerankExtension = rerankProvider?.rerank
    ? { providerName: rerankProvider.providerName, rerank: rerankProvider.rerank }
    : null;
  let effectiveMode = parseMode(options.mode, {
    hasProvider: providerResolution.active !== null || extensionSearchProvider !== null,
    hasVectorStore: vectorResolution.active !== null || extensionVectorAdapter !== null,
  });
  const loadedDocuments = await loadDocuments(
    pmRoot,
    settings.item_format ?? "toon",
    typeRegistry.type_to_folder,
    settings.schema,
  );
  const warnings = loadedDocuments.warnings;
  if (effectiveMode === "hybrid" && semanticWeightProvided && semanticWeightOverride === undefined) {
    warnings.push("search_hybrid_semantic_weight_override_invalid:using_settings_default");
  }
  const allDocuments = loadedDocuments.documents;
  const metadataFilteredDocuments = applyFilters(allDocuments, options, typeRegistry, runtimeFieldFilters, statusFilter);
  const filteredDocuments = applyExactQueryFilters(metadataFilteredDocuments, normalizedQuery, {
    titleExact,
    phraseExact,
  });
  if (effectiveMode === "keyword" && (filteredDocuments.length === 0 || limit === 0)) {
    return emptySearchResult(
      query,
      effectiveMode,
      options,
      includeLinked,
      scoreThreshold,
      hybridSemanticWeight,
      queryExpansion,
      rerank,
      projection,
      warnings,
    );
  }

  const projectRoot = process.cwd();
  const globalRoot = resolveGlobalPmRoot(projectRoot);
  const linkedCorpusById = new Map<string, string>();
  if (includeLinked && (effectiveMode === "keyword" || effectiveMode === "hybrid")) {
    const linkedCorpusRoots = await resolveLinkedCorpusRoots(projectRoot, globalRoot);
    const linkedCorpusEntries = await Promise.all(
      filteredDocuments.map(async (document) => [document.metadata.id, await loadLinkedCorpus(document, linkedCorpusRoots)] as const),
    );
    for (const [id, corpus] of linkedCorpusEntries) {
      linkedCorpusById.set(id, corpus);
    }
  }

  const keywordHits = filteredDocuments
    .map((document) => buildHybridLexicalScore(document, tokens, normalizedQuery, effectiveMode !== "semantic", linkedCorpusById, tuning))
    .filter((entry): entry is SearchHit => entry !== null);

  let hits = keywordHits;
  if (effectiveMode !== "keyword") {
    // Surface vector-index staleness once per query so agents notice when a
    // refresh is overdue. Only emitted when:
    //   (1) the user explicitly asked for semantic/hybrid mode (implicit
    //       upgrades fall back silently to keyword on any failure path below
    //       and shouldn't carry noise), AND
    //   (2) the BUILT-IN semantic path is what will run — an extension search
    //       provider has its own indexing lifecycle and the local ledger we
    //       read is irrelevant to it.
    const builtInSemanticWillRun =
      !extensionSearchProvider &&
      providerResolution.active !== null &&
      (vectorResolution.active !== null || extensionVectorAdapter !== null);
    if (modeWasExplicit && builtInSemanticWillRun) {
      await maybeEmitVectorIndexStaleWarning(pmRoot, filteredDocuments, warnings);
    }
    try {
      if (!extensionSearchProvider) {
        requireSemanticDependencies(effectiveMode, providerResolution, vectorResolution, extensionVectorAdapter !== null);
      }
      if (filteredDocuments.length === 0 || limit === 0) {
        return emptySearchResult(
          query,
          effectiveMode,
          options,
          includeLinked,
          scoreThreshold,
          hybridSemanticWeight,
          queryExpansion,
          rerank,
          projection,
          warnings,
        );
      }
      const filteredById = new Map(filteredDocuments.map((document) => [document.metadata.id, document]));
      const canUseBuiltInSemantic =
        providerResolution.active !== null && (vectorResolution.active !== null || extensionVectorAdapter !== null);
      if (extensionSearchProvider) {
        try {
          const providerResponse = await Promise.resolve(
            extensionSearchProvider.query({
              query,
              mode: effectiveMode,
              tokens,
              options,
              settings,
              documents: filteredDocuments,
            }),
          );
          hits = normalizeExtensionProviderHits(extensionSearchProvider.providerName, providerResponse, filteredById);
        } catch (error: unknown) {
          if (!canUseBuiltInSemantic) {
            throw new PmCliError(
              `Extension search provider "${extensionSearchProvider.providerName}" failed: ${error instanceof Error ? error.message : String(error)}`,
              EXIT_CODE.GENERIC_FAILURE,
            );
          }
        }
      }
      if (hits === keywordHits) {
        const implicitHybridMode = !modeWasExplicit && effectiveMode === "hybrid";
        const { provider, vectorStore } = requireSemanticDependencies(
          effectiveMode,
          providerResolution,
          vectorResolution,
          extensionVectorAdapter !== null,
        );
        const semanticResult = await computeSemanticOrHybridHits({
          requestedMode: effectiveMode,
          query,
          filteredDocuments,
          keywordHits,
          hybridSemanticWeight,
          limit,
          maxResults,
          provider,
          vectorStore,
          extensionVectorAdapter,
          queryExpansion,
          queryExpansionExtension,
          rerank,
          rerankExtension,
          warnings,
          settings,
          ...(implicitHybridMode
            ? {
                embeddingTimeoutMs: IMPLICIT_HYBRID_EMBEDDING_TIMEOUT_MS,
                vectorQueryTimeoutMs: IMPLICIT_HYBRID_VECTOR_TIMEOUT_MS,
              }
            : {}),
        });
        hits = semanticResult.hits;
        // The semantic/hybrid query ran without error, but vector ranking
        // contributed no hits for this query/filter set. Pure semantic mode would
        // otherwise return an empty set, so degrade to the locally computed
        // keyword hits (hybrid already blends them in) and warn so agents do not
        // mistake them for true vector ranking. The reported mode is left
        // unchanged; the warning is the signal.
        if (semanticResult.vectorMatchCount === 0) {
          if (effectiveMode === "semantic") {
            hits = keywordHits;
          }
          warnings.push(`search_${effectiveMode}_degraded:no_vector_matches:results_are_lexical`);
        }
      }
    } catch (error: unknown) {
      // Any semantic/hybrid attempt that fails (backend down, timeout, or the
      // project is not configured for semantic search) degrades to keyword mode
      // so agents are never blocked. Keyword hits are always computed locally
      // before this point, so the fallback is guaranteed to succeed.
      const fallbackWarning = modeWasExplicit
        ? buildExplicitSemanticFallbackWarning(effectiveMode, error)
        : buildImplicitSemanticFallbackWarning(error);
      effectiveMode = "keyword";
      hits = keywordHits;
      warnings.push(fallbackWarning);
    }
  }

  const thresholded = hits.filter((entry) => entry.score >= scoreThreshold);
  const sorted = sortHits(thresholded, statusRegistry);
  const resolvedLimit = effectiveMode === "keyword" ? limit : (limit ?? maxResults);
  const limited = resolvedLimit === undefined ? sorted : sorted.slice(0, resolvedLimit);
  const projectedItems = projectSearchHits(limited, projection);
  const projectionFields = projection.mode === "full" ? null : [...projection.fields];

  return {
    query: query.trim(),
    mode: effectiveMode,
    items: projectedItems,
    count: projectedItems.length,
    filters: {
      mode: effectiveMode,
      status: options.status ?? null,
      type: options.type ?? null,
      tag: options.tag ?? null,
      priority: options.priority ?? null,
      deadline_before: options.deadlineBefore ?? null,
      deadline_after: options.deadlineAfter ?? null,
      include_linked: includeLinked,
      title_exact: titleExact,
      phrase_exact: phraseExact,
      score_threshold: scoreThreshold,
      hybrid_semantic_weight: effectiveMode === "hybrid" ? hybridSemanticWeight : null,
      query_expansion_enabled: queryExpansion.enabled,
      query_expansion_provider: queryExpansion.provider,
      rerank_enabled: rerank.enabled,
      rerank_model: rerank.model,
      rerank_top_k: rerank.top_k,
      limit: options.limit ?? null,
      runtime_filters: runtimeFieldFilters,
    },
    projection: {
      mode: projection.mode,
      fields: projectionFields,
    },
    now: nowIso(),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
