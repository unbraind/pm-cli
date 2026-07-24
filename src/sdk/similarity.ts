/**
 * @module sdk/similarity
 *
 * Provides one bounded, reusable similarity contract for create-time
 * governance and package-owned duplicate analysis.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import { listAllItemMetadataLight } from "../core/store/item-store.js";
import { resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import {
  readItemMetadataDerivedIndexState,
} from "../core/store/item-metadata-cache.js";
import { querySimilarItemMetadataIndex } from "../core/store/item-metadata-query-index.js";
import type { ItemMetadata } from "../types/index.js";
import {
  scoreItemSimilarity,
  tokenizeSimilarityText,
} from "./similarity-scoring.js";
export {
  jaccardSimilarity,
  normalizeSimilarityText,
  scoreItemSimilarity,
  tokenizeSimilarityText,
  type ItemSimilarityScore,
} from "./similarity-scoring.js";

const DEFAULT_SIMILARITY_LIMIT = 3;
const MAX_SIMILARITY_LIMIT = 20;
const DEFAULT_SIMILARITY_THRESHOLD = 0.8;

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
  if (
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    throw new PmCliError(
      "Similarity threshold must be a number from 0 to 1.",
      EXIT_CODE.USAGE,
    );
  }
  return { limit, threshold };
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
          query: tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR "),
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
  const bypassed =
    options.mode === "strict" && options.allowDuplicate === true;
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
