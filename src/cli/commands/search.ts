import fs from "node:fs/promises";
import path from "node:path";
import { getActiveExtensionRegistrations, runActiveOnReadHooks } from "../../core/extensions/index.js";
import {
  resolveRegisteredSearchProvider,
  resolveRegisteredVectorStoreAdapter,
} from "../../core/extensions/runtime-registrations.js";
import { resolveItemTypeRegistry, resolveTypeName, type ItemTypeRegistry } from "../../core/item/type-registry.js";
import {
  executeEmbeddingRequest,
  resolveEmbeddingProviders,
  type EmbeddingProviderConfig,
  type EmbeddingProviderResolution,
} from "../../core/search/providers.js";
import { resolveSettingsWithSemanticRuntimeDefaults } from "../../core/search/semantic-defaults.js";
import {
  executeVectorQuery,
  resolveVectorStores,
  type VectorQueryHit,
  type VectorStoreConfig,
  type VectorStoreResolution,
} from "../../core/search/vector-stores.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { parseItemDocument } from "../../core/item/item-format.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import { collectRuntimeFilterValues, matchesRuntimeFilters } from "../../core/schema/runtime-field-filters.js";
import {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { tokenizeAlphaNumeric } from "../../core/shared/text-normalization.js";
import { compareTimestampStrings, nowIso, resolveIsoOrRelative } from "../../core/shared/time.js";
import { listAllFrontMatter } from "../../core/store/item-store.js";
import { getSettingsPath, resolveGlobalPmRoot, resolvePmRoot, getItemPath } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemDocument, ItemFormat, ItemFrontMatter, ItemStatus, ItemType, PmSettings } from "../../types/index.js";

export interface SearchOptions {
  mode?: string;
  includeLinked?: boolean;
  titleExact?: boolean;
  phraseExact?: boolean;
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

const LONG_QUERY_TOKEN_THRESHOLD = 4;
const LONG_QUERY_TITLE_EXACT_BONUS = 120;
const LONG_QUERY_PHRASE_MULTIPLIER = 6;

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



function isTerminal(status: ItemStatus, statusRegistry: RuntimeStatusRegistry): boolean {
  const normalized = normalizeStatusInput(status, statusRegistry) ?? status;
  return statusRegistry.terminal_statuses.has(normalized);
}

interface SearchModeContext {
  hasProvider: boolean;
  hasVectorStore: boolean;
}

function parseMode(raw: string | undefined, context: SearchModeContext): SearchMode {
  if (raw === undefined) {
    return context.hasProvider && context.hasVectorStore ? "hybrid" : "keyword";
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

function normalizeSearchPhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parsePriority(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4) {
    throw new PmCliError("Priority filter must be 0..4", EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseType(raw: string | undefined, typeRegistry: ItemTypeRegistry): ItemType | undefined {
  if (raw === undefined) return undefined;
  const parsed = resolveTypeName(raw, typeRegistry);
  if (!parsed) {
    throw new PmCliError(`Type filter must be one of ${typeRegistry.types.join("|")}`, EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseDeadline(raw: string | undefined, fieldLabel: string): string | undefined {
  if (raw === undefined) return undefined;
  return resolveIsoOrRelative(raw, new Date(), fieldLabel);
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PmCliError("Limit filter must be a non-negative number", EXIT_CODE.USAGE);
  }
  return Math.floor(parsed);
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

function parseTokens(query: string): string[] {
  const normalized = normalizeSearchPhrase(query);
  if (!normalized) {
    throw new PmCliError("Search query must not be empty", EXIT_CODE.USAGE);
  }
  return normalized.split(/\s+/).filter(Boolean);
}

function collectExactPhraseFields(document: ItemDocument): string[] {
  const item = document.front_matter;
  return [
    item.title,
    item.description,
    item.status,
    item.tags.join(" "),
    document.body,
    (item.comments ?? []).map((entry) => entry.text).join(" "),
    (item.notes ?? []).map((entry) => entry.text).join(" "),
    (item.learnings ?? []).map((entry) => entry.text).join(" "),
    (item.dependencies ?? []).map((entry) => `${entry.id} ${entry.kind}`).join(" "),
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
    if (options.titleExact && normalizeSearchPhrase(document.front_matter.title) !== normalizedQuery) {
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
): ItemDocument[] {
  const typeFilter = parseType(options.type, typeRegistry);
  const tagFilter = options.tag?.trim().toLowerCase();
  const priorityFilter = parsePriority(options.priority);
  const deadlineBefore = parseDeadline(options.deadlineBefore, "deadline-before");
  const deadlineAfter = parseDeadline(options.deadlineAfter, "deadline-after");

  return items.filter((document) => {
    const item = document.front_matter;
    if (typeFilter && item.type !== typeFilter) return false;
    if (tagFilter && !item.tags.includes(tagFilter)) return false;
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

function isPathWithinRoot(root: string, resolvedPath: string): boolean {
  const relative = path.relative(root, resolvedPath);
  if (relative.length === 0) {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

interface ContainmentRoot {
  resolved: string;
  realpath: string;
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

async function loadLinkedCorpus(
  document: ItemDocument,
  projectRoot: string,
  globalRoot: string,
): Promise<string> {
  const linkedPaths = collectLinkedPaths(document.front_matter);
  const chunks: string[] = [];
  const projectContainmentRoot = await resolveContainmentRoot(projectRoot);
  const globalContainmentRoot = await resolveContainmentRoot(globalRoot);
  for (const linkedPath of linkedPaths) {
    const containmentRoot = linkedPath.scope === "global" ? globalContainmentRoot : projectContainmentRoot;
    if (!containmentRoot) {
      continue;
    }
    const resolved = path.resolve(containmentRoot.resolved, linkedPath.path);
    if (!isPathWithinRoot(containmentRoot.resolved, resolved)) {
      continue;
    }
    let linkedRealpath: string;
    try {
      linkedRealpath = await fs.realpath(resolved);
    } catch {
      continue;
    }
    if (!isPathWithinRoot(containmentRoot.realpath, linkedRealpath)) {
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
  const item = document.front_matter;
  const titleTokenCounts = new Map<string, number>();
  for (const token of tokenizeForExactTokenMatch(item.title)) {
    titleTokenCounts.set(token, (titleTokenCounts.get(token) ?? 0) + 1);
  }
  const searchableFields: Array<{ name: string; value: string; weight: number }> = [
    { name: "title", value: item.title, weight: tuning.title_weight },
    { name: "description", value: item.description, weight: tuning.description_weight },
    { name: "tags", value: item.tags.join(" "), weight: tuning.tags_weight },
    { name: "status", value: item.status, weight: tuning.status_weight },
    { name: "body", value: document.body, weight: tuning.body_weight },
    { name: "comments", value: (item.comments ?? []).map((entry) => entry.text).join(" "), weight: tuning.comments_weight },
    { name: "notes", value: (item.notes ?? []).map((entry) => entry.text).join(" "), weight: tuning.notes_weight },
    { name: "learnings", value: (item.learnings ?? []).map((entry) => entry.text).join(" "), weight: tuning.learnings_weight },
    {
      name: "dependencies",
      value: (item.dependencies ?? []).map((entry) => `${entry.id} ${entry.kind}`).join(" "),
      weight: tuning.dependencies_weight,
    },
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
    const aTerminal = isTerminal(a.item.status, statusRegistry);
    const bTerminal = isTerminal(b.item.status, statusRegistry);
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
    includeLinked ? linkedCorpusById.get(document.front_matter.id) ?? "" : "",
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
      limit: options.limit ?? null,
      projection: projection.mode,
      fields: projectionFields,
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

function toOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveExtensionSearchProvider(settings: PmSettings): { providerName: string; query: ExtensionSearchProviderQuery } | null {
  const registrations = getActiveExtensionRegistrations();
  const providerName = toOptionalNonEmptyString((settings.search as { provider?: unknown } | undefined)?.provider);
  const resolved = resolveRegisteredSearchProvider(registrations, providerName);
  if (!resolved) {
    return null;
  }
  const runtimeDefinition = resolved.runtime_definition ?? resolved.definition;
  const query = (runtimeDefinition as { query?: unknown }).query;
  if (typeof query !== "function") {
    return null;
  }
  const registeredName =
    toOptionalNonEmptyString((runtimeDefinition as { name?: unknown }).name) ??
    toOptionalNonEmptyString((resolved.definition as { name?: unknown }).name) ??
    providerName;
  if (!registeredName) {
    return null;
  }
  return {
    providerName: registeredName,
    query: query as ExtensionSearchProviderQuery,
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
      item: document.front_matter,
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
      item: document.front_matter,
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
        item: document.front_matter,
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
  settings: PmSettings;
}

async function computeSemanticOrHybridHits(context: SemanticQueryContext): Promise<SearchHit[]> {
  const semanticLimit = context.limit ?? context.maxResults;
  const queryVectors = await executeEmbeddingRequest(context.provider, context.query.trim());
  const semanticVector = queryVectors[0];
  let vectorHits: VectorQueryHit[];
  if (context.extensionVectorAdapter?.query) {
    try {
      vectorHits = await Promise.resolve(
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
      vectorHits = await executeVectorQuery(context.vectorStore, semanticVector, semanticLimit);
    }
  } else if (context.vectorStore) {
    vectorHits = await executeVectorQuery(context.vectorStore, semanticVector, semanticLimit);
  } else {
    throw new PmCliError(
      "Semantic search requires either a configured vector store or an extension vector adapter query handler",
      EXIT_CODE.USAGE,
    );
  }
  const filteredById = new Map(context.filteredDocuments.map((document) => [document.front_matter.id, document]));
  const { semanticHits, semanticScores } = buildSemanticHits(vectorHits, filteredById);
  if (context.requestedMode === "semantic") {
    return semanticHits;
  }
  return combineHybridHits(filteredById, semanticScores, context.keywordHits, context.hybridSemanticWeight);
}

function alternateFormat(itemFormat: ItemFormat): ItemFormat {
  return itemFormat === "toon" ? "json_markdown" : "toon";
}

async function loadDocuments(
  pmRoot: string,
  itemFormat: ItemFormat,
  typeToFolder: Record<string, string>,
  schema: PmSettings["schema"],
): Promise<{ documents: ItemDocument[]; warnings: string[] }> {
  const listWarnings: string[] = [];
  const items = await listAllFrontMatter(pmRoot, itemFormat, typeToFolder, listWarnings, schema);
  const warnings = [...new Set(listWarnings)].sort((left, right) => left.localeCompare(right));
  const documents: ItemDocument[] = [];
  for (const item of items) {
    const preferredPath = getItemPath(pmRoot, item.type, item.id, itemFormat, typeToFolder);
    try {
      const raw = await fs.readFile(preferredPath, "utf8");
      await runActiveOnReadHooks({
        path: preferredPath,
        scope: "project",
      });
      documents.push(parseItemDocument(raw, { format: itemFormat, schema, onWarning: (warning) => listWarnings.push(warning) }));
      continue;
    } catch {
      // Fallback to the alternate format when preferred format path is absent.
    }
    const fallbackFormat = alternateFormat(itemFormat);
    const fallbackPath = getItemPath(pmRoot, item.type, item.id, fallbackFormat, typeToFolder);
    const raw = await fs.readFile(fallbackPath, "utf8");
    await runActiveOnReadHooks({
      path: fallbackPath,
      scope: "project",
    });
    documents.push(parseItemDocument(raw, { format: fallbackFormat, schema, onWarning: (warning) => listWarnings.push(warning) }));
  }
  return {
    documents,
    warnings,
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
    const itemRecord = hit.item as unknown as Record<string, unknown>;
    return itemRecord[itemKey] ?? null;
  }
  const hitRecord = hit as unknown as Record<string, unknown>;
  const itemRecord = hit.item as unknown as Record<string, unknown>;
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
  const runtimeFieldFilters = collectRuntimeFilterValues(options as Record<string, unknown>, runtimeFieldRegistry, "search");
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const maxResults = resolveSearchMaxResults(settings);
  const scoreThreshold = resolveSearchScoreThreshold(settings);
  const hybridSemanticWeight = resolveHybridSemanticWeight(settings);
  const tuning = resolveSearchTuning(settings);
  const providerResolution = resolveEmbeddingProviders(settings);
  const vectorResolution = resolveVectorStores(settings);
  const extensionSearchProvider = resolveExtensionSearchProvider(settings);
  const extensionVectorAdapter = resolveExtensionVectorAdapter(settings);
  let effectiveMode = parseMode(options.mode, {
    hasProvider: providerResolution.active !== null || extensionSearchProvider !== null,
    hasVectorStore: vectorResolution.active !== null || extensionVectorAdapter !== null,
  });
  const loadedDocuments = await loadDocuments(
    pmRoot,
    settings.item_format ?? "json_markdown",
    typeRegistry.type_to_folder,
    settings.schema,
  );
  const warnings = loadedDocuments.warnings;
  const allDocuments = loadedDocuments.documents;
  const metadataFilteredDocuments = applyFilters(allDocuments, options, typeRegistry, runtimeFieldFilters);
  const filteredDocuments = applyExactQueryFilters(metadataFilteredDocuments, normalizedQuery, {
    titleExact,
    phraseExact,
  });
  if (effectiveMode === "keyword" && (filteredDocuments.length === 0 || limit === 0)) {
    return emptySearchResult(query, effectiveMode, options, includeLinked, scoreThreshold, hybridSemanticWeight, projection, warnings);
  }

  const projectRoot = process.cwd();
  const globalRoot = resolveGlobalPmRoot(projectRoot);
  const linkedCorpusById = new Map<string, string>();
  if (includeLinked && (effectiveMode === "keyword" || effectiveMode === "hybrid")) {
    for (const document of filteredDocuments) {
      linkedCorpusById.set(document.front_matter.id, await loadLinkedCorpus(document, projectRoot, globalRoot));
    }
  }

  const keywordHits = filteredDocuments
    .map((document) => buildHybridLexicalScore(document, tokens, normalizedQuery, effectiveMode !== "semantic", linkedCorpusById, tuning))
    .filter((entry): entry is SearchHit => entry !== null);

  let hits = keywordHits;
  if (effectiveMode !== "keyword") {
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
          projection,
          warnings,
        );
      }
      const filteredById = new Map(filteredDocuments.map((document) => [document.front_matter.id, document]));
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
        const { provider, vectorStore } = requireSemanticDependencies(
          effectiveMode,
          providerResolution,
          vectorResolution,
          extensionVectorAdapter !== null,
        );
        hits = await computeSemanticOrHybridHits({
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
          settings,
        });
      }
    } catch (error: unknown) {
      const canFallbackToKeyword =
        runtimeDefaultsResolution.auto_ollama_defaults_applied && !modeWasExplicit && effectiveMode === "hybrid";
      if (!canFallbackToKeyword) {
        throw error;
      }
      effectiveMode = "keyword";
      hits = keywordHits;
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
      limit: options.limit ?? null,
      runtime_filters: runtimeFieldFilters,
      projection: projection.mode,
      fields: projectionFields,
    },
    projection: {
      mode: projection.mode,
      fields: projectionFields,
    },
    now: nowIso(),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
