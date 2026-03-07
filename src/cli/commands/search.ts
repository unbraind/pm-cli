import fs from "node:fs/promises";
import path from "node:path";
import { runActiveOnReadHooks } from "../../core/extensions/index.js";
import { executeEmbeddingRequest, resolveEmbeddingProviders } from "../../core/search/providers.js";
import { executeVectorQuery, resolveVectorStores } from "../../core/search/vector-stores.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { parseItemDocument } from "../../core/item/item-format.js";
import { EXIT_CODE, TYPE_TO_FOLDER } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso, resolveIsoOrRelative } from "../../core/shared/time.js";
import { listAllFrontMatter } from "../../core/store/item-store.js";
import { getSettingsPath, resolveGlobalPmRoot, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemDocument, ItemFrontMatter, ItemStatus, ItemType } from "../../types/index.js";

export interface SearchOptions {
  mode?: string;
  includeLinked?: boolean;
  type?: string;
  tag?: string;
  priority?: string;
  deadlineBefore?: string;
  deadlineAfter?: string;
  limit?: string;
}

export interface SearchHit {
  item: ItemFrontMatter;
  score: number;
  matched_fields: string[];
}

export interface SearchResult {
  query: string;
  mode: "keyword" | "semantic" | "hybrid";
  items: SearchHit[];
  count: number;
  filters: Record<string, unknown>;
  now: string;
}



const ITEM_TYPES_BY_LOWER = new Map<string, ItemType>([
  ["epic", "Epic"],
  ["feature", "Feature"],
  ["task", "Task"],
  ["chore", "Chore"],
  ["issue", "Issue"],
]);

function isTerminal(status: ItemStatus): boolean {
  return status === "closed" || status === "canceled";
}

interface SearchModeContext {
  hasProvider: boolean;
  hasVectorStore: boolean;
}

function parseMode(raw: string | undefined, context: SearchModeContext): "keyword" | "semantic" | "hybrid" {
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

function parsePriority(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4) {
    throw new PmCliError("Priority filter must be 0..4", EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseType(raw: string | undefined): ItemType | undefined {
  if (raw === undefined) return undefined;
  const parsed = ITEM_TYPES_BY_LOWER.get(raw.trim().toLowerCase());
  if (!parsed) {
    throw new PmCliError("Type filter must be one of Epic|Feature|Task|Chore|Issue", EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseDeadline(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return resolveIsoOrRelative(raw);
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PmCliError("Limit filter must be a non-negative number", EXIT_CODE.USAGE);
  }
  return Math.floor(parsed);
}

function parseTokens(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    throw new PmCliError("Search query must not be empty", EXIT_CODE.USAGE);
  }
  return normalized.split(/\s+/).filter(Boolean);
}

function applyFilters(items: ItemDocument[], options: SearchOptions): ItemDocument[] {
  const typeFilter = parseType(options.type);
  const tagFilter = options.tag?.trim().toLowerCase();
  const priorityFilter = parsePriority(options.priority);
  const deadlineBefore = parseDeadline(options.deadlineBefore);
  const deadlineAfter = parseDeadline(options.deadlineAfter);

  return items.filter((document) => {
    const item = document.front_matter;
    if (typeFilter && item.type !== typeFilter) return false;
    if (tagFilter && !item.tags.includes(tagFilter)) return false;
    if (priorityFilter !== undefined && item.priority !== priorityFilter) return false;
    if (deadlineBefore && (!item.deadline || item.deadline > deadlineBefore)) return false;
    if (deadlineAfter && (!item.deadline || item.deadline < deadlineAfter)) return false;
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
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
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

function scoreDocument(document: ItemDocument, tokens: string[], linkedCorpus: string, tuning: SearchTuning): SearchHit | null {
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

  if (score <= 0) {
    return null;
  }

  return {
    item,
    score,
    matched_fields: [...matched].sort((a, b) => a.localeCompare(b)),
  };
}

function sortHits(items: SearchHit[]): SearchHit[] {
  return [...items].sort((a, b) => {
    const byScore = b.score - a.score;
    if (byScore !== 0) return byScore;
    const aTerminal = isTerminal(a.item.status);
    const bTerminal = isTerminal(b.item.status);
    if (aTerminal !== bTerminal) {
      return aTerminal ? 1 : -1;
    }
    const byPriority = a.item.priority - b.item.priority;
    if (byPriority !== 0) return byPriority;
    const byUpdated = b.item.updated_at.localeCompare(a.item.updated_at);
    if (byUpdated !== 0) return byUpdated;
    return a.item.id.localeCompare(b.item.id);
  });
}

function buildHybridLexicalScore(
  document: ItemDocument,
  tokens: string[],
  includeLinked: boolean,
  linkedCorpusById: Map<string, string>,
  tuning: SearchTuning,
): SearchHit | null {
  return scoreDocument(
    document,
    tokens,
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
  mode: "keyword" | "semantic" | "hybrid",
  options: SearchOptions,
  includeLinked: boolean,
  scoreThreshold: number,
  hybridSemanticWeight: number,
): SearchResult {
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
      score_threshold: scoreThreshold,
      hybrid_semantic_weight: mode === "hybrid" ? hybridSemanticWeight : null,
      limit: options.limit ?? null,
    },
    now: nowIso(),
  };
}

async function loadDocuments(pmRoot: string): Promise<ItemDocument[]> {
  const items = await listAllFrontMatter(pmRoot);
  const documents: ItemDocument[] = [];
  for (const item of items) {
    const itemPath = path.join(pmRoot, TYPE_TO_FOLDER[item.type], `${item.id}.md`);
    const raw = await fs.readFile(itemPath, "utf8");
    await runActiveOnReadHooks({
      path: itemPath,
      scope: "project",
    });
    const parsed = parseItemDocument(raw);
    documents.push(parsed);
  }
  return documents;
}

export async function runSearch(query: string, options: SearchOptions, global: GlobalOptions): Promise<SearchResult> {
  const includeLinked = parseIncludeLinked(options.includeLinked);
  const tokens = parseTokens(query);
  const limit = parseLimit(options.limit);
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const scoreThreshold = resolveSearchScoreThreshold(settings);
  const hybridSemanticWeight = resolveHybridSemanticWeight(settings);
  const tuning = resolveSearchTuning(settings);
  const providerResolution = resolveEmbeddingProviders(settings);
  const vectorResolution = resolveVectorStores(settings);
  const requestedMode = parseMode(options.mode, {
    hasProvider: providerResolution.active !== null,
    hasVectorStore: vectorResolution.active !== null,
  });
  const allDocuments = await loadDocuments(pmRoot);
  const filteredDocuments = applyFilters(allDocuments, options);
  if (requestedMode === "keyword" && filteredDocuments.length === 0) {
    return emptySearchResult(query, requestedMode, options, includeLinked, scoreThreshold, hybridSemanticWeight);
  }

  const projectRoot = process.cwd();
  const globalRoot = resolveGlobalPmRoot(projectRoot);
  const linkedCorpusById = new Map<string, string>();
  if (includeLinked && (requestedMode === "keyword" || requestedMode === "hybrid")) {
    for (const document of filteredDocuments) {
      linkedCorpusById.set(document.front_matter.id, await loadLinkedCorpus(document, projectRoot, globalRoot));
    }
  }

  const keywordHits = filteredDocuments
    .map((document) => buildHybridLexicalScore(document, tokens, requestedMode !== "semantic", linkedCorpusById, tuning))
    .filter((entry): entry is SearchHit => entry !== null);

  let hits = keywordHits;
  if (requestedMode !== "keyword") {
    if (!providerResolution.active) {
      throw new PmCliError(
        `Search mode '${requestedMode}' requires a configured embedding provider in settings.providers.openai or settings.providers.ollama`,
        EXIT_CODE.USAGE,
      );
    }
    if (!vectorResolution.active) {
      throw new PmCliError(
        `Search mode '${requestedMode}' requires a configured vector store in settings.vector_store.qdrant or settings.vector_store.lancedb`,
        EXIT_CODE.USAGE,
      );
    }
    if (filteredDocuments.length === 0) {
      return emptySearchResult(query, requestedMode, options, includeLinked, scoreThreshold, hybridSemanticWeight);
    }

    const maxResults = resolveSearchMaxResults(settings);
    const semanticLimit = limit ?? maxResults;
    const queryVectors = await executeEmbeddingRequest(providerResolution.active, query.trim());
    const semanticVector = queryVectors[0];
    const vectorHits = await executeVectorQuery(vectorResolution.active, semanticVector, semanticLimit);

    const filteredById = new Map(filteredDocuments.map((document) => [document.front_matter.id, document]));
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

    if (requestedMode === "semantic") {
      hits = semanticHits;
    } else {
      const keywordScores = new Map(keywordHits.map((entry) => [entry.item.id, entry.score]));
      const keywordMatches = new Map(keywordHits.map((entry) => [entry.item.id, entry.matched_fields]));
      const normalizedSemantic = normalizeScoreMap(semanticScores);
      const normalizedKeyword = normalizeScoreMap(keywordScores);
      const candidateIds = new Set<string>([...semanticScores.keys(), ...keywordScores.keys()]);
      const keywordWeight = 1 - hybridSemanticWeight;

      hits = [...candidateIds]
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
  }

  const thresholded = hits.filter((entry) => entry.score >= scoreThreshold);
  const sorted = sortHits(thresholded);
  const effectiveLimit = requestedMode === "keyword" ? limit : (limit ?? resolveSearchMaxResults(settings));
  const limited = effectiveLimit === undefined ? sorted : sorted.slice(0, effectiveLimit);

  return {
    query: query.trim(),
    mode: requestedMode,
    items: limited,
    count: limited.length,
    filters: {
      mode: requestedMode,
      type: options.type ?? null,
      tag: options.tag ?? null,
      priority: options.priority ?? null,
      deadline_before: options.deadlineBefore ?? null,
      deadline_after: options.deadlineAfter ?? null,
      include_linked: includeLinked,
      score_threshold: scoreThreshold,
      hybrid_semantic_weight: requestedMode === "hybrid" ? hybridSemanticWeight : null,
      limit: options.limit ?? null,
    },
    now: nowIso(),
  };
}
