/**
 * @module sdk/similarity
 *
 * Provides one bounded, reusable similarity contract for create-time
 * governance and package-owned duplicate analysis.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import { normalizeStatusInput } from "../core/item/status.js";
import { resolveRuntimeStatusRegistry } from "../core/schema/runtime-schema.js";
import { listAllItemMetadataLight } from "../core/store/item-store.js";
import { resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import { readItemMetadataDerivedIndexState } from "../core/store/item-metadata-cache.js";
import { querySimilarItemMetadataIndex } from "../core/store/item-metadata-query-index.js";
import type { ItemMetadata } from "../types/index.js";
import {
  prepareSimilarityText,
  scoreItemSimilarity,
  scorePreparedItemSimilarity,
  tokenizeSimilarityText,
  type PreparedSimilarityText,
} from "./similarity-scoring.js";
export {
  jaccardSimilarity,
  normalizeSimilarityText,
  prepareSimilarityText,
  scoreItemSimilarity,
  scorePreparedItemSimilarity,
  tokenizeSimilarityText,
  type ItemSimilarityScore,
  type PreparedSimilarityText,
} from "./similarity-scoring.js";

const DEFAULT_SIMILARITY_LIMIT = 3;
const MAX_SIMILARITY_LIMIT = 20;
const DEFAULT_SIMILARITY_THRESHOLD = 0.8;
const DEFAULT_DUPLICATE_CLUSTER_LIMIT = 100;
const MAX_DUPLICATE_CLUSTER_LIMIT = 1_000;
const MAX_BATCH_PAIR_EVALUATIONS = 1_000_000;

/** Candidate content accepted by the similarity primitive. */
export interface SimilarItemCandidate {
  /** Proposed title. */
  title: string;
  /** Optional description used by future semantic providers. */
  description?: string;
  /** Optional body used by future semantic providers. */
  body?: string;
  /** Existing ids to omit, such as a copy source or current item. */
  excludeIds?: readonly string[];
}

/** Query controls for {@link findSimilarItems}. */
export interface FindSimilarItemsOptions {
  /** Explicit tracker root. */
  pmRoot?: string;
  /** Workspace used for nearest-tracker discovery. */
  cwd?: string;
  /** Maximum returned matches, from zero through twenty. */
  limit?: number;
  /** Inclusive score threshold on the zero-to-one scale. */
  threshold?: number;
}

/** One likely existing duplicate. */
export interface SimilarItemMatch {
  /** Existing item id. */
  id: string;
  /** Existing item title. */
  title: string;
  /** Existing lifecycle status. */
  status: string;
  /** Existing item type. */
  type: string;
  /** Stable similarity score on the zero-to-one scale. */
  score: number;
  /** Strongest deterministic match signal. */
  reason: "exact_title" | "issue_code" | "title_token_jaccard";
}

/** Bounded similarity query result. */
export interface SimilarItemsResult {
  /** Ranked likely duplicates. */
  items: SimilarItemMatch[];
  /** Number of returned matches. */
  count: number;
  /** Effective threshold. */
  threshold: number;
  /** Retrieval path used before shared scoring. */
  source: "persistent_index" | "metadata_fallback";
}

/** Query controls for one all-status duplicate-cluster sweep. */
export interface FindDuplicateClustersOptions extends FindSimilarItemsOptions {
  /** Lifecycle statuses to include; omit to inspect every status. */
  statuses?: readonly string[];
  /** Inclusive ISO timestamp lower bound on item creation. */
  since?: string;
}

/** One deterministic pair that caused items to join a duplicate cluster. */
export interface DuplicateClusterMatch {
  /** First item id in lexical order. */
  left_id: string;
  /** Second item id in lexical order. */
  right_id: string;
  /** Canonical deterministic score. */
  score: number;
  /** Strongest deterministic signal. */
  reason: SimilarItemMatch["reason"];
}

/** One connected component of likely duplicate items. */
export interface DuplicateCluster {
  /** Stable cluster key derived from the lexically first item id. */
  id: string;
  /** Item summaries ordered by id. */
  items: Omit<SimilarItemMatch, "score" | "reason">[];
  /** Qualifying pair evidence ordered by score then ids. */
  matches: DuplicateClusterMatch[];
  /** Strongest pair score in this component. */
  max_score: number;
}

/** Bounded batch duplicate analysis result with explicit cost disclosure. */
export interface DuplicateClustersResult {
  /** Connected duplicate components. */
  clusters: DuplicateCluster[];
  /** Number of returned components. */
  count: number;
  /** Effective threshold. */
  threshold: number;
  /** Retrieval path used for this whole-workspace sweep. */
  source: "metadata_scan";
  /** Effective lifecycle filter; null means the complete all-status corpus. */
  filters: {
    statuses: string[] | null;
    since: string | null;
  };
  /** Work performed after the single metadata read. */
  cost: {
    /** Items retained after filters. */
    item_count: number;
    /** Candidate pairs sharing at least one deterministic signal. */
    candidate_pairs: number;
    /** Candidate pairs scored. */
    scored_pairs: number;
  };
}

interface PreparedDuplicateItem {
  item: ItemMetadata;
  prepared: PreparedSimilarityText;
}

/** Create/copy governance envelope attached when likely duplicates exist. */
export interface SimilarityAdvisory {
  /** Effective governance mode. */
  mode: "advisory" | "strict";
  /** Whether strict enforcement was explicitly bypassed. */
  bypassed: boolean;
  /** Shared similarity query result. */
  result: SimilarItemsResult;
}

/** Render compact warning tokens shared by create and copy results. */
export function similarityAdvisoryWarnings(
  advisory: SimilarityAdvisory | undefined,
): string[] {
  return advisory === undefined
    ? []
    : [
        `likely_duplicates:${advisory.result.items
          .map((item) => item.id)
          .join(",")}`,
      ];
}

function validateSimilarityOptions(options: FindSimilarItemsOptions): {
  limit: number;
  threshold: number;
} {
  const limit = options.limit ?? DEFAULT_SIMILARITY_LIMIT;
  const threshold = options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > MAX_SIMILARITY_LIMIT
  ) {
    throw new PmCliError(
      `Similarity limit must be an integer from 0 to ${MAX_SIMILARITY_LIMIT}.`,
      EXIT_CODE.USAGE,
    );
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new PmCliError(
      "Similarity threshold must be a number from 0 to 1.",
      EXIT_CODE.USAGE,
    );
  }
  return { limit, threshold };
}

function validateDuplicateClusterOptions(
  options: FindDuplicateClustersOptions,
): { limit: number; since: Date | undefined } {
  const limit = options.limit ?? DEFAULT_DUPLICATE_CLUSTER_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > MAX_DUPLICATE_CLUSTER_LIMIT
  ) {
    throw new PmCliError(
      `Duplicate cluster limit must be an integer from 0 to ${MAX_DUPLICATE_CLUSTER_LIMIT}.`,
      EXIT_CODE.USAGE,
    );
  }
  const since =
    options.since === undefined ? undefined : new Date(options.since);
  if (since && Number.isNaN(since.getTime())) {
    throw new PmCliError(
      "Duplicate cluster --since must be a valid ISO timestamp.",
      EXIT_CODE.USAGE,
    );
  }
  return { limit, since };
}

async function loadPreparedDuplicateItems(
  options: FindDuplicateClustersOptions,
  since: Date | undefined,
): Promise<{
  items: PreparedDuplicateItem[];
  statuses: string[] | undefined;
}> {
  const pmRoot = resolvePmRoot(options.cwd ?? process.cwd(), options.pmRoot);
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings);
  const requestedStatuses = options.statuses
    ?.map((status) => status.trim().toLowerCase())
    .filter(Boolean);
  if (options.statuses !== undefined && requestedStatuses?.length === 0) {
    throw new PmCliError(
      "Duplicate cluster statuses must include at least one lifecycle status or all.",
      EXIT_CODE.USAGE,
    );
  }
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const normalizedStatuses = requestedStatuses?.map((status) => {
    if (status === "all") return status;
    const normalized = normalizeStatusInput(status, statusRegistry);
    if (!normalized) {
      throw new PmCliError(
        `Unknown duplicate-cluster status "${status}". Allowed: all, ${statusRegistry.definitions.map((entry) => entry.id).join(", ")}.`,
        EXIT_CODE.USAGE,
      );
    }
    return normalized;
  });
  const hasAll = normalizedStatuses?.includes("all") === true;
  if (hasAll && normalizedStatuses?.some((status) => status !== "all")) {
    throw new PmCliError(
      'The "all" status cannot be combined with other statuses.',
      EXIT_CODE.USAGE,
    );
  }
  const effectiveStatuses = hasAll ? undefined : normalizedStatuses;
  const allowedStatuses = effectiveStatuses
    ? new Set(effectiveStatuses)
    : undefined;
  return {
    items: (
      await listAllItemMetadataLight(
        pmRoot,
        settings.item_format,
        typeRegistry.type_to_folder,
        undefined,
        settings.schema,
      )
    )
      .filter(
        (item) =>
          (!allowedStatuses || allowedStatuses.has(item.status)) &&
          (!since || new Date(item.created_at).getTime() >= since.getTime()),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({ item, prepared: prepareSimilarityText(item.title) })),
    statuses: effectiveStatuses,
  };
}

function collectDuplicateCandidatePairs(
  items: PreparedDuplicateItem[],
  maxPairEvaluations = MAX_BATCH_PAIR_EVALUATIONS,
): Set<string> {
  const candidates = new Set<string>();
  const indexes = [
    new Map<string, number[]>(),
    new Map<string, number[]>(),
    new Map<string, number[]>(),
  ];
  for (const [index, entry] of items.entries()) {
    const signals = [
      [entry.prepared.normalized],
      entry.prepared.issueCodes,
      entry.prepared.tokens,
    ];
    for (const [signalKind, values] of signals.entries()) {
      for (const value of values) {
        const matches = indexes[signalKind].get(value) ?? [];
        for (const other of matches) candidates.add(`${other}:${index}`);
        if (candidates.size > maxPairEvaluations) {
          throw new PmCliError(
            `Duplicate sweep exceeded ${MAX_BATCH_PAIR_EVALUATIONS} candidate pairs; narrow it with statuses or since.`,
            EXIT_CODE.CONFLICT,
            {
              code: "duplicate_sweep_cost_limit",
              required:
                "Narrow the batch duplicate query until its deterministic candidate set fits the disclosed safety bound.",
            },
          );
        }
        matches.push(index);
        indexes[signalKind].set(value, matches);
      }
    }
  }
  return candidates;
}

/** Internal deterministic seams used to prove bounded batch behavior without building a million-pair fixture. */
export const _testOnlySimilarity = {
  buildDuplicateClusters,
  collectDuplicateCandidatePairs,
  createDuplicateUnionFind,
};

function createDuplicateUnionFind(size: number): {
  parent: number[];
  findRoot: (index: number) => number;
} {
  const parent = Array.from({ length: size }, (_entry, index) => index);
  const findRoot = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  return { parent, findRoot };
}

function scoreDuplicateCandidates(
  items: PreparedDuplicateItem[],
  candidates: Set<string>,
  threshold: number,
  union: ReturnType<typeof createDuplicateUnionFind>,
): DuplicateClusterMatch[] {
  const matches: DuplicateClusterMatch[] = [];
  for (const candidate of candidates) {
    const [leftIndex, rightIndex] = candidate
      .split(":")
      .map((value) => Number.parseInt(value, 10));
    const scored = scorePreparedItemSimilarity(
      items[leftIndex].prepared,
      items[rightIndex].prepared,
    );
    if (scored.score < threshold) continue;
    const leftRoot = union.findRoot(leftIndex);
    const rightRoot = union.findRoot(rightIndex);
    if (leftRoot !== rightRoot) union.parent[rightRoot] = leftRoot;
    matches.push({
      left_id: items[leftIndex].item.id,
      right_id: items[rightIndex].item.id,
      ...scored,
    });
  }
  return matches;
}

function buildDuplicateClusters(
  items: PreparedDuplicateItem[],
  matches: DuplicateClusterMatch[],
  union: ReturnType<typeof createDuplicateUnionFind>,
  limit: number,
): DuplicateCluster[] {
  const components = new Map<number, number[]>();
  for (const index of items.keys()) {
    const root = union.findRoot(index);
    const component = components.get(root) ?? [];
    component.push(index);
    components.set(root, component);
  }
  return [...components.values()]
    .filter((component) => component.length > 1)
    .map((component): DuplicateCluster => {
      const ids = new Set(component.map((index) => items[index].item.id));
      const clusterMatches = matches
        .filter((match) => ids.has(match.left_id) && ids.has(match.right_id))
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.left_id.localeCompare(right.left_id) ||
            left.right_id.localeCompare(right.right_id),
        );
      return {
        id: items[component[0]].item.id,
        items: component.map((itemIndex) => {
          const item = items[itemIndex].item;
          return {
            id: item.id,
            title: item.title,
            status: item.status,
            type: item.type,
          };
        }),
        matches: clusterMatches,
        max_score: clusterMatches[0]?.score ?? 0,
      };
    })
    .sort(
      (left, right) =>
        right.max_score - left.max_score || left.id.localeCompare(right.id),
    )
    .slice(0, limit);
}

function rankSimilarItems(
  title: string,
  candidates: readonly ItemMetadata[],
  excludedIds: ReadonlySet<string>,
  threshold: number,
  limit: number,
): SimilarItemMatch[] {
  return candidates
    .filter((item) => !excludedIds.has(item.id))
    .map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      type: item.type,
      ...scoreItemSimilarity(title, item.title),
    }))
    .filter((item) => item.score >= threshold)
    .sort(
      (left, right) =>
        right.score - left.score || left.id.localeCompare(right.id),
    )
    .slice(0, limit);
}

/** Find likely existing duplicates through an index-first bounded read. */
export async function findSimilarItems(
  candidate: SimilarItemCandidate,
  options: FindSimilarItemsOptions = {},
): Promise<SimilarItemsResult> {
  const title = candidate.title.trim();
  if (title.length === 0) {
    throw new PmCliError(
      "Similarity candidate title must not be empty.",
      EXIT_CODE.USAGE,
    );
  }
  const { limit, threshold } = validateSimilarityOptions(options);
  const pmRoot = resolvePmRoot(options.cwd ?? process.cwd(), options.pmRoot);
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings);
  const indexState = await readItemMetadataDerivedIndexState(
    pmRoot,
    Object.values(typeRegistry.type_to_folder),
  );
  const tokens = tokenizeSimilarityText(title);
  const indexed =
    indexState && tokens.length > 0
      ? await querySimilarItemMetadataIndex({
          pmRoot,
          expectedSourceCursor: indexState.source_cursor,
          query: tokens
            .map((token) => `"${token.replaceAll('"', '""')}"`)
            .join(" OR "),
          limit: Math.max(limit * 10, 50),
        })
      : null;
  const candidates =
    indexed === null
      ? await listAllItemMetadataLight(
          pmRoot,
          settings.item_format,
          typeRegistry.type_to_folder,
          undefined,
          settings.schema,
        )
      : indexed.items;
  const items = rankSimilarItems(
    title,
    candidates,
    new Set(candidate.excludeIds ?? []),
    threshold,
    limit,
  );
  return {
    items,
    count: items.length,
    threshold,
    source: indexed ? "persistent_index" : "metadata_fallback",
  };
}

/** Find connected duplicate clusters with one metadata read and one prepared representation per item. */
export async function findDuplicateClusters(
  options: FindDuplicateClustersOptions = {},
): Promise<DuplicateClustersResult> {
  const { threshold } = validateSimilarityOptions({
    ...options,
    limit: undefined,
  });
  const { limit, since } = validateDuplicateClusterOptions(options);
  const { items, statuses } = await loadPreparedDuplicateItems(options, since);
  const candidates = collectDuplicateCandidatePairs(items);
  const union = createDuplicateUnionFind(items.length);
  const matches = scoreDuplicateCandidates(items, candidates, threshold, union);
  const clusters = buildDuplicateClusters(items, matches, union, limit);
  return {
    clusters,
    count: clusters.length,
    threshold,
    source: "metadata_scan",
    filters: {
      statuses: statuses ?? null,
      since: options.since ?? null,
    },
    cost: {
      item_count: items.length,
      candidate_pairs: candidates.size,
      scored_pairs: candidates.size,
    },
  };
}

/** Apply off/advisory/strict mutation governance through the shared query. */
export async function evaluateSimilarityGovernance(
  candidate: SimilarItemCandidate,
  options: FindSimilarItemsOptions & {
    mode: "off" | "advisory" | "strict";
    allowDuplicate?: boolean;
  },
): Promise<SimilarityAdvisory | undefined> {
  if (options.mode === "off") return undefined;
  const result = await findSimilarItems(candidate, options);
  if (result.count === 0) return undefined;
  const bypassed = options.mode === "strict" && options.allowDuplicate === true;
  if (options.mode === "strict" && !bypassed) {
    const candidates = result.items
      .map((item) => `${item.id} (${item.status}): ${item.title}`)
      .join("; ");
    throw new PmCliError(
      `Likely duplicate item(s) found: ${candidates}. Reuse the canonical item or pass --allow-duplicate with explicit intent.`,
      EXIT_CODE.CONFLICT,
      {
        code: "likely_duplicate",
        required:
          "Reuse an existing item, or explicitly acknowledge the duplicate with --allow-duplicate.",
        recovery: {
          suggested_flags: ["--allow-duplicate"],
        },
      },
    );
  }
  return { mode: options.mode, bypassed, result };
}
