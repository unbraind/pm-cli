import type { PmSettings } from "../../types.js";
import { coercePositiveInteger, toNonEmptyString } from "../shared/primitives.js";
import { tokenizeAlphaNumeric } from "../shared/text-normalization.js";
import { executeEmbeddingRequest, type EmbeddingProviderConfig } from "./providers.js";

export const DEFAULT_QUERY_EXPANSION_MAX_QUERIES = 4;
export const DEFAULT_RERANK_TOP_K = 20;
const MAX_RERANK_TOP_K = 200;

const QUERY_EXPANSION_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

export interface QueryExpansionConfig {
  enabled: boolean;
  provider: string | null;
  max_queries: number;
}

export interface RerankConfig {
  enabled: boolean;
  model: string;
  top_k: number;
}

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankScoredHit {
  id: string;
  score: number;
}

function dedupeQueries(values: string[], limit: number): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const normalized = entry.trim().replaceAll(/\s+/g, " ");
    if (normalized.length === 0) {
      continue;
    }
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    deduped.push(normalized);
    if (deduped.length >= limit) {
      break;
    }
  }
  return deduped;
}

function singularizeSimple(token: string): string {
  const normalizedToken = token.toLowerCase();
  if (normalizedToken.length > 4 && normalizedToken.endsWith("ies")) {
    return `${normalizedToken.slice(0, -3)}y`;
  }
  if (
    normalizedToken.length > 4 &&
    (normalizedToken.endsWith("ches") ||
      normalizedToken.endsWith("shes") ||
      normalizedToken.endsWith("xes") ||
      normalizedToken.endsWith("zes") ||
      normalizedToken.endsWith("sses"))
  ) {
    return normalizedToken.slice(0, -2);
  }
  if (
    normalizedToken.length > 3 &&
    normalizedToken.endsWith("s") &&
    !normalizedToken.endsWith("ss") &&
    !normalizedToken.endsWith("us") &&
    !normalizedToken.endsWith("is") &&
    !normalizedToken.endsWith("as")
  ) {
    return normalizedToken.slice(0, -1);
  }
  return normalizedToken;
}

function pluralizeSimple(token: string): string {
  const normalizedToken = token.toLowerCase();
  if (normalizedToken.length > 2 && (!normalizedToken.endsWith("s") || normalizedToken.endsWith("ss"))) {
    if (normalizedToken.endsWith("y") && !/[aeiou]y$/u.test(normalizedToken)) {
      return `${normalizedToken.slice(0, -1)}ies`;
    }
    if (
      normalizedToken.endsWith("ch") ||
      normalizedToken.endsWith("sh") ||
      normalizedToken.endsWith("x") ||
      normalizedToken.endsWith("z") ||
      normalizedToken.endsWith("ss")
    ) {
      return `${normalizedToken}es`;
    }
    return `${normalizedToken}s`;
  }
  return normalizedToken;
}

export function buildDeterministicQueryExpansions(
  query: string,
  maxQueries = DEFAULT_QUERY_EXPANSION_MAX_QUERIES,
): string[] {
  const normalizedQuery = query.trim().replaceAll(/\s+/g, " ");
  if (normalizedQuery.length === 0) {
    return [];
  }
  const tokens = tokenizeAlphaNumeric(normalizedQuery);
  if (tokens.length === 0) {
    return [normalizedQuery];
  }
  const contentTokens = tokens.filter((token) => !QUERY_EXPANSION_STOP_WORDS.has(token.toLowerCase()));
  const singularized = tokens.map((token) => singularizeSimple(token));
  const pluralized = contentTokens.map((token) => pluralizeSimple(token));
  return dedupeQueries(
    [
      normalizedQuery,
      tokens.join(" "),
      contentTokens.join(" "),
      singularized.join(" "),
      pluralized.join(" "),
    ],
    Math.max(1, maxQueries),
  );
}

export function normalizeQueryExpansionOutput(raw: unknown): string[] {
  const rawQueries = Array.isArray(raw)
    ? raw
    : (raw as { queries?: unknown } | null | undefined)?.queries;
  if (!Array.isArray(rawQueries)) {
    return [];
  }
  return dedupeQueries(
    rawQueries.filter((entry): entry is string => typeof entry === "string"),
    DEFAULT_QUERY_EXPANSION_MAX_QUERIES,
  );
}

export function mergeQueryExpansions(base: string[], extra: string[], maxQueries: number): string[] {
  return dedupeQueries([...base, ...extra], Math.max(1, maxQueries));
}

export function resolveQueryExpansionConfig(
  settings: PmSettings,
  fallbackProviderName: string | null,
): QueryExpansionConfig {
  const search = (settings as { search?: { query_expansion?: { enabled?: unknown; provider?: unknown } } }).search;
  const queryExpansion = search?.query_expansion;
  const configuredProvider = toNonEmptyString(queryExpansion?.provider);
  return {
    enabled: queryExpansion?.enabled === true,
    provider: configuredProvider ?? fallbackProviderName,
    max_queries: DEFAULT_QUERY_EXPANSION_MAX_QUERIES,
  };
}

export function resolveRerankConfig(settings: PmSettings, fallbackModel: string): RerankConfig {
  const search = (settings as { search?: { rerank?: { enabled?: unknown; model?: unknown; top_k?: unknown } } }).search;
  const rerank = search?.rerank;
  const configuredModel = toNonEmptyString(rerank?.model);
  const configuredTopK = coercePositiveInteger(rerank?.top_k);
  const normalizedTopK = configuredTopK ?? DEFAULT_RERANK_TOP_K;
  return {
    enabled: rerank?.enabled === true,
    model: configuredModel ?? fallbackModel,
    top_k: Math.min(MAX_RERANK_TOP_K, normalizedTopK),
  };
}

export function normalizeRerankOutput(raw: unknown): RerankScoredHit[] {
  const rawHits = Array.isArray(raw)
    ? raw
    : (raw as { hits?: unknown } | null | undefined)?.hits;
  if (!Array.isArray(rawHits)) {
    return [];
  }
  const bestById = new Map<string, number>();
  for (const entry of rawHits) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const id = toNonEmptyString((entry as { id?: unknown }).id);
    const score = (entry as { score?: unknown }).score;
    if (!id || typeof score !== "number" || !Number.isFinite(score)) {
      continue;
    }
    const existing = bestById.get(id);
    if (existing === undefined || score > existing) {
      bestById.set(id, score);
    }
  }
  const normalized = [...bestById.entries()].map(([id, score]) => ({ id, score }));
  normalized.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.id.localeCompare(right.id);
  });
  return normalized;
}

function dotProduct(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  let result = 0;
  for (let index = 0; index < size; index += 1) {
    result += left[index] * right[index];
  }
  return result;
}

function l2Norm(vector: number[]): number {
  let sumSquares = 0;
  for (let index = 0; index < vector.length; index += 1) {
    sumSquares += vector[index] * vector[index];
  }
  return Math.sqrt(sumSquares);
}

function cosineSimilarityWithKnownLeftNorm(
  left: number[] | null | undefined,
  right: number[] | null | undefined,
  leftNorm: number,
): number {
  if (!left || !right || left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }
  const numerator = dotProduct(left, right);
  const rightNorm = l2Norm(right);
  const denominator = leftNorm * rightNorm;
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(leftNorm) ||
    !Number.isFinite(rightNorm) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return 0;
  }
  return Math.max(-1, Math.min(1, numerator / denominator));
}

export async function rerankCandidatesWithEmbeddings(
  provider: EmbeddingProviderConfig,
  model: string,
  query: string,
  candidates: RerankCandidate[],
  timeoutMs?: number,
): Promise<Map<string, number>> {
  if (candidates.length === 0) {
    return new Map();
  }
  const effectiveModel = toNonEmptyString(model) ?? provider.model;
  const rerankProvider: EmbeddingProviderConfig =
    effectiveModel === provider.model ? provider : { ...provider, model: effectiveModel };
  const payload = [query.trim(), ...candidates.map((entry) => entry.text)];
  const vectors = await executeEmbeddingRequest(rerankProvider, payload, timeoutMs ? { timeout_ms: timeoutMs } : {});
  const queryVector = vectors[0];
  if (!queryVector) {
    return new Map();
  }
  const queryNorm = l2Norm(queryVector);
  const scoreById = new Map<string, number>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const candidateVector = vectors[index + 1];
    if (!candidateVector) {
      continue;
    }
    const similarity = cosineSimilarityWithKnownLeftNorm(queryVector, candidateVector, queryNorm);
    scoreById.set(candidate.id, Math.max(0, Math.min(1, (similarity + 1) / 2)));
  }
  return scoreById;
}
