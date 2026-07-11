/**
 * @module core/search/bm25
 *
 * Offline BM25 lexical retrieval (pm-75k9). Provides an Okapi BM25 ranker that
 * scores the in-memory item corpus with no embedding service, vector store, or
 * network dependency, so semantic/hybrid search degrades to a dense-quality
 * lexical ranker — rather than the naive field-weighted scorer — in air-gapped,
 * CI, and zero-setup environments.
 *
 * BM25 improves on raw term-frequency counting in three ways the legacy keyword
 * scorer cannot: inverse document frequency down-weights terms common across the
 * whole corpus, term-frequency saturation (`k1`) caps the contribution of a term
 * repeated many times in one document, and length normalization (`b`) prevents
 * long documents from dominating purely by size.
 */
import type { PmSettings } from "../../types/index.js";
import { tokenizeAlphaNumeric } from "../shared/text-normalization.js";

/** Default Okapi BM25 term-frequency saturation parameter. `1.2` is the widely used Lucene/Elasticsearch default: higher values reduce the diminishing returns of repeated terms more slowly (terms keep accruing weight), lower values saturate sooner. */
export const DEFAULT_BM25_K1 = 1.2;

/** Default Okapi BM25 length-normalization parameter. `0.75` is the Lucene default: `0` disables length normalization entirely, `1` fully normalizes a document's score by its length relative to the corpus average. */
export const DEFAULT_BM25_B = 0.75;

/**
 * Resolved BM25 tuning parameters. Both are clamped to sane ranges by
 * {@link resolveBm25Params} before scoring.
 */
export interface Bm25Params {
  /** Term-frequency saturation (`k1`); finite and `>= 0`. */
  k1: number;
  /** Length normalization (`b`); finite and within `[0, 1]`. */
  b: number;
}

/**
 * One corpus document supplied to {@link buildBm25Index}: a stable id and the
 * already-concatenated searchable text. Callers build the text from whichever
 * fields they want indexed (typically the resolved `search.corpus_fields`).
 */
export interface Bm25Document {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports text for this contract. */
  text: string;
}

/**
 * Per-document statistics retained in a {@link Bm25Index}: the term-frequency
 * map and the document length (total token count) used for length
 * normalization.
 */
interface Bm25DocumentStats {
  id: string;
  termFrequencies: Map<string, number>;
  length: number;
}

/**
 * An immutable BM25 index built from a document set. Carries the per-document
 * term frequencies, per-term document frequencies, corpus size, and average
 * document length needed to score any query. Build once per query batch with
 * {@link buildBm25Index}, then score with {@link scoreBm25Query}.
 */
export interface Bm25Index {
  /** Value that configures or reports documents for this contract. */
  documents: Bm25DocumentStats[];
  /** Value that configures or reports document frequency for this contract. */
  documentFrequency: Map<string, number>;
  /** Number of document entries represented by this result. */
  documentCount: number;
  /** Value that configures or reports average document length for this contract. */
  averageDocumentLength: number;
}

/**
 * Tokenize a document/query string into BM25 terms. Shares
 * {@link tokenizeAlphaNumeric} with the lexical scorer so the BM25 vocabulary is
 * identical to the rest of search: lowercase, alphanumeric runs, no stop-word
 * removal or stemming (kept deliberately simple and language-agnostic).
 */
export function tokenizeBm25(text: string): string[] {
  return tokenizeAlphaNumeric(text);
}

/** Count occurrences of each token in a token list. */
function buildTermFrequencies(tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}

/**
 * Build a BM25 index from a corpus. Computes each document's term frequencies
 * and length, the per-term document frequency, the corpus size, and the average
 * document length. Empty documents (no tokens) are retained with length `0` so
 * they can still be scored (they simply never match a query term). An empty
 * corpus yields an index with `averageDocumentLength` `0`, which
 * {@link scoreBm25Query} handles without dividing by zero.
 */
export function buildBm25Index(documents: Bm25Document[]): Bm25Index {
  const stats: Bm25DocumentStats[] = [];
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const document of documents) {
    const tokens = tokenizeBm25(document.text);
    const termFrequencies = buildTermFrequencies(tokens);
    totalLength += tokens.length;
    for (const term of termFrequencies.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
    stats.push({ id: document.id, termFrequencies, length: tokens.length });
  }
  const documentCount = stats.length;
  return {
    documents: stats,
    documentFrequency,
    documentCount,
    averageDocumentLength: documentCount > 0 ? totalLength / documentCount : 0,
  };
}

/** Inverse document frequency for one term using the BM25 "plus-one" variant (`ln(1 + (N - n + 0.5) / (n + 0.5))`) used by Lucene. The `1 +` inside the logarithm keeps the IDF strictly non-negative even for a term that appears in every document, so a common term can never subtract from a document's score. */
function inverseDocumentFrequency(
  documentCount: number,
  termDocumentFrequency: number,
): number {
  return Math.log(
    1 +
      (documentCount - termDocumentFrequency + 0.5) /
        (termDocumentFrequency + 0.5),
  );
}

/** Score every document in the index against a query and return an id → score map containing only documents with a strictly positive score (a document that matches no query term is omitted, mirroring the lexical scorer's "no match → no hit" contract). Query tokens are de-duplicated so a token repeated in the query does not multiply its own contribution. Returns an empty map for an empty index, an empty query, or a query whose terms appear in no document. */
export function scoreBm25Query(
  index: Bm25Index,
  queryTokens: string[],
  params: Bm25Params,
): Map<string, number> {
  const scores = new Map<string, number>();
  // Empty corpus, or a corpus where every document is empty (avgdl 0): no term
  // can match, so return early. Guarding here also guarantees a non-zero
  // average document length below, keeping the length-normalization division
  // safe without an unreachable fallback branch.
  if (index.documentCount === 0 || index.averageDocumentLength === 0) {
    return scores;
  }
  const distinctQueryTerms = [
    ...new Set(queryTokens.filter((token) => token.length > 0)),
  ];
  if (distinctQueryTerms.length === 0) {
    return scores;
  }
  // Precompute the IDF for each query term once rather than per document.
  const idfByTerm = new Map<string, number>();
  for (const term of distinctQueryTerms) {
    const termDocumentFrequency = index.documentFrequency.get(term);
    if (termDocumentFrequency === undefined) {
      continue;
    }
    idfByTerm.set(
      term,
      inverseDocumentFrequency(index.documentCount, termDocumentFrequency),
    );
  }
  if (idfByTerm.size === 0) {
    return scores;
  }
  for (const document of index.documents) {
    let score = 0;
    for (const [term, idf] of idfByTerm) {
      const termFrequency = document.termFrequencies.get(term);
      if (termFrequency === undefined) {
        continue;
      }
      const lengthNormalization =
        1 -
        params.b +
        (params.b * document.length) / index.averageDocumentLength;
      const denominator = termFrequency + params.k1 * lengthNormalization;
      score += idf * ((termFrequency * (params.k1 + 1)) / denominator);
    }
    if (score > 0) {
      scores.set(document.id, score);
    }
  }
  return scores;
}

/** Coerce one persisted BM25 parameter to a finite number within `[min, max]`. A finite number is clamped to the range (preserving user intent — e.g. `k1=5000` becomes `1000` rather than being silently ignored); any non-number or non-finite value (string, `NaN`, `Infinity`, missing) falls back to `fallback` so a malformed `settings.json` can never crash or skew scoring. */
function resolveClampedParam(
  candidate: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, candidate));
}

/** Flatten a structured search-corpus record (the shape produced by `buildSearchCorpus`) into a single whitespace-joined string of its *values* only — field names/object keys are deliberately excluded so corpus-wide keys (`title`, `description`, …) never enter the BM25 vocabulary and skew IDF. Strings and numbers contribute their text; arrays and nested objects (tags, dependencies, the plan corpus) are walked recursively; everything else is dropped. */
export function flattenSearchCorpusText(
  corpus: Record<string, unknown>,
): string {
  const collectValueText = (value: unknown): string[] => {
    if (typeof value === "string") {
      return [value];
    }
    if (typeof value === "number") {
      return [String(value)];
    }
    if (Array.isArray(value)) {
      return value.flatMap(collectValueText);
    }
    if (typeof value === "object" && value !== null) {
      return Object.values(value).flatMap(collectValueText);
    }
    return [];
  };
  return collectValueText(Object.values(corpus)).join(" ");
}

/**
 * Resolve the effective BM25 parameters from `settings.search.bm25`, applying
 * {@link DEFAULT_BM25_K1}/{@link DEFAULT_BM25_B} when unset and clamping `k1` to
 * `[0, 1000]` and `b` to `[0, 1]`. Tolerant of partial/invalid config: each
 * knob is resolved independently so one bad value does not discard the other.
 */
export function resolveBm25Params(
  settings: Pick<PmSettings, "search"> | undefined,
): Bm25Params {
  const bm25 = (
    settings?.search as { bm25?: { k1?: unknown; b?: unknown } } | undefined
  )?.bm25;
  return {
    k1: resolveClampedParam(bm25?.k1, DEFAULT_BM25_K1, 0, 1_000),
    b: resolveClampedParam(bm25?.b, DEFAULT_BM25_B, 0, 1),
  };
}
