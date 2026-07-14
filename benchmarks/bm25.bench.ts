import { bench, describe } from "vitest";

import {
  DEFAULT_BM25_B,
  DEFAULT_BM25_K1,
  buildBm25Index,
  scoreBm25Query,
  tokenizeBm25,
  type Bm25Document,
} from "../src/core/search/bm25.js";

/**
 * BM25 lexical retrieval is the offline search ranker used whenever the
 * embedding/vector path is unavailable (CI, air-gapped, zero-setup). Both
 * index construction and query scoring run over the whole in-memory corpus, so
 * they are on the hot path of every `pm search` invocation that falls back to
 * lexical mode. These benchmarks exercise a realistically sized synthetic
 * corpus so regressions in tokenization, indexing, or scoring are caught.
 */

const BM25_PARAMS = { k1: DEFAULT_BM25_K1, b: DEFAULT_BM25_B };

const VOCABULARY = [
  "release",
  "sprint",
  "backlog",
  "kanban",
  "roadmap",
  "milestone",
  "dependency",
  "regression",
  "benchmark",
  "throughput",
  "latency",
  "governance",
  "audit",
  "template",
  "workspace",
  "cursor",
  "retrieval",
  "semantic",
  "embedding",
  "lexical",
];

/** Build a deterministic pseudo-random document corpus of a given size. */
function buildCorpus(documentCount: number, wordsPerDocument: number): Bm25Document[] {
  const documents: Bm25Document[] = [];
  let seed = 1;
  const next = (): number => {
    // Simple xorshift so the corpus is deterministic across runs.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return Math.abs(seed);
  };
  for (let doc = 0; doc < documentCount; doc += 1) {
    const words: string[] = [];
    for (let word = 0; word < wordsPerDocument; word += 1) {
      words.push(VOCABULARY[next() % VOCABULARY.length] as string);
    }
    documents.push({ id: `pm-${doc.toString(36)}`, text: words.join(" ") });
  }
  return documents;
}

const smallCorpus = buildCorpus(200, 40);
const largeCorpus = buildCorpus(2000, 80);
const largeIndex = buildBm25Index(largeCorpus);
const queryTokens = tokenizeBm25("release sprint dependency regression benchmark latency");

describe("BM25 index construction", () => {
  bench("build index (200 docs x 40 words)", () => {
    buildBm25Index(smallCorpus);
  });

  bench("build index (2000 docs x 80 words)", () => {
    buildBm25Index(largeCorpus);
  });
});

describe("BM25 query scoring", () => {
  bench("score query over 2000 docs", () => {
    scoreBm25Query(largeIndex, queryTokens, BM25_PARAMS);
  });

  bench("tokenize + score query over 2000 docs", () => {
    const tokens = tokenizeBm25(
      "release sprint dependency regression benchmark latency governance audit",
    );
    scoreBm25Query(largeIndex, tokens, BM25_PARAMS);
  });
});
