import { bench, describe } from "vitest";

import {
  jaccardSimilarity,
  normalizeLowercaseWhitespace,
  tokenizeAlphaNumeric,
} from "../src/core/shared/text-normalization.js";

/**
 * Text normalization primitives are shared by search tokenization, dedupe
 * detection, and content matching. They run once per document field and once
 * per query term, so they sit on the hot path of indexing and search. These
 * benchmarks feed them a representative multi-paragraph item body.
 */

const SAMPLE_TEXT = `
  Implement the BM25 lexical retrieval fallback for the offline search path.
  When the embedding service is unavailable (CI, air-gapped, zero-setup) the
  ranker must degrade to a dense-quality lexical scorer rather than the naive
  field-weighted keyword scorer. Cover index construction, query scoring,
  length normalization, and inverse document frequency. Add regression tests
  for empty corpora, empty queries, and parameter clamping.
`.repeat(8);

const leftTokens = tokenizeAlphaNumeric(SAMPLE_TEXT);
const rightTokens = tokenizeAlphaNumeric(
  SAMPLE_TEXT.replace(/retrieval/g, "search").replace(/scorer/g, "ranker"),
);

describe("text normalization", () => {
  bench("normalizeLowercaseWhitespace", () => {
    normalizeLowercaseWhitespace(SAMPLE_TEXT);
  });

  bench("tokenizeAlphaNumeric", () => {
    tokenizeAlphaNumeric(SAMPLE_TEXT);
  });

  bench("jaccardSimilarity", () => {
    jaccardSimilarity(leftTokens, rightTokens);
  });
});
