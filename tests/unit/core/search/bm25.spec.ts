import { describe, expect, it } from "vitest";
import {
  buildBm25Index,
  DEFAULT_BM25_B,
  DEFAULT_BM25_K1,
  flattenSearchCorpusText,
  resolveBm25Params,
  scoreBm25Query,
  tokenizeBm25,
} from "../../../../src/core/search/bm25.js";
import type { PmSettings } from "../../../../src/types.js";

const PARAMS = { k1: DEFAULT_BM25_K1, b: DEFAULT_BM25_B };

describe("bm25 tokenizeBm25", () => {
  it("lowercases and splits on non-alphanumeric runs", () => {
    expect(tokenizeBm25("Database-Connection POOL_42!")).toEqual(["database", "connection", "pool", "42"]);
  });

  it("returns an empty list for whitespace/punctuation-only text", () => {
    expect(tokenizeBm25("  --- ")).toEqual([]);
  });
});

describe("bm25 buildBm25Index", () => {
  it("computes per-document term frequencies, lengths, and corpus statistics", () => {
    const index = buildBm25Index([
      { id: "a", text: "alpha beta beta" },
      { id: "b", text: "beta gamma" },
    ]);
    expect(index.documentCount).toBe(2);
    expect(index.averageDocumentLength).toBe(2.5);
    expect(index.documentFrequency.get("beta")).toBe(2);
    expect(index.documentFrequency.get("alpha")).toBe(1);
    expect(index.documents[0].termFrequencies.get("beta")).toBe(2);
    expect(index.documents[0].length).toBe(3);
  });

  it("retains empty documents with length 0 and yields avgdl 0 for an all-empty corpus", () => {
    const index = buildBm25Index([
      { id: "a", text: "" },
      { id: "b", text: "   " },
    ]);
    expect(index.documentCount).toBe(2);
    expect(index.averageDocumentLength).toBe(0);
    expect(index.documents[0].length).toBe(0);
    expect(index.documentFrequency.size).toBe(0);
  });

  it("returns an empty index for an empty corpus", () => {
    const index = buildBm25Index([]);
    expect(index.documentCount).toBe(0);
    expect(index.averageDocumentLength).toBe(0);
  });
});

describe("bm25 scoreBm25Query", () => {
  it("ranks documents by relevance and omits non-matching documents", () => {
    const index = buildBm25Index([
      { id: "a", text: "database connection pool leak under heavy load" },
      { id: "b", text: "exponential backoff retry http client" },
      { id: "c", text: "database migration plan" },
    ]);
    const scores = scoreBm25Query(index, tokenizeBm25("database connection"), PARAMS);
    expect(scores.has("a")).toBe(true);
    expect(scores.has("c")).toBe(true);
    expect(scores.has("b")).toBe(false);
    // "a" matches both query terms; "c" matches only "database" → "a" ranks higher.
    expect(scores.get("a")!).toBeGreaterThan(scores.get("c")!);
  });

  it("rewards rarer terms via IDF (a corpus-wide term contributes less)", () => {
    const index = buildBm25Index([
      { id: "a", text: "common rare" },
      { id: "b", text: "common common" },
      { id: "c", text: "common" },
    ]);
    const scores = scoreBm25Query(index, tokenizeBm25("rare common"), PARAMS);
    // "a" is the only doc with the rare term, so it outranks the common-only docs.
    expect(scores.get("a")!).toBeGreaterThan(scores.get("b")!);
    expect(scores.get("a")!).toBeGreaterThan(scores.get("c")!);
  });

  it("de-duplicates repeated query terms so they do not double-count", () => {
    const index = buildBm25Index([{ id: "a", text: "alpha beta" }]);
    const once = scoreBm25Query(index, ["alpha"], PARAMS);
    const twice = scoreBm25Query(index, ["alpha", "alpha"], PARAMS);
    expect(twice.get("a")).toBeCloseTo(once.get("a")!, 12);
  });

  it("returns an empty map for an empty index", () => {
    expect(scoreBm25Query(buildBm25Index([]), ["x"], PARAMS).size).toBe(0);
  });

  it("returns an empty map for an all-empty (avgdl 0) corpus", () => {
    const index = buildBm25Index([{ id: "a", text: "" }]);
    expect(scoreBm25Query(index, ["x"], PARAMS).size).toBe(0);
  });

  it("returns an empty map when the query has no usable tokens", () => {
    const index = buildBm25Index([{ id: "a", text: "alpha" }]);
    expect(scoreBm25Query(index, ["", ""], PARAMS).size).toBe(0);
  });

  it("returns an empty map when no query term appears in any document", () => {
    const index = buildBm25Index([{ id: "a", text: "alpha beta" }]);
    expect(scoreBm25Query(index, ["gamma"], PARAMS).size).toBe(0);
  });

  it("applies length normalization so a shorter document outranks a padded one on the same term count", () => {
    const index = buildBm25Index([
      { id: "short", text: "needle" },
      { id: "long", text: "needle padding padding padding padding padding" },
    ]);
    const scores = scoreBm25Query(index, ["needle"], { k1: 1.2, b: 1 });
    expect(scores.get("short")!).toBeGreaterThan(scores.get("long")!);
  });
});

describe("bm25 flattenSearchCorpusText", () => {
  it("collects string, number, array, and nested-object values while excluding keys", () => {
    const text = flattenSearchCorpusText({
      title: "Offline search",
      priority: 2,
      tags: ["area:search", "offline"],
      dependencies: [{ id: "pm-1", kind: "related" }],
      plan: { steps: ["draft the ranker"] },
      ignored: true,
    });
    expect(text).toContain("Offline search");
    expect(text).toContain("2");
    expect(text).toContain("area:search");
    expect(text).toContain("pm-1");
    expect(text).toContain("related");
    expect(text).toContain("draft the ranker");
    // Field names must not leak into the indexed text.
    expect(text).not.toContain("title");
    expect(text).not.toContain("dependencies");
    // Booleans (and other non-string/number scalars) are dropped.
    expect(text).not.toContain("true");
  });

  it("returns an empty string for an empty corpus", () => {
    expect(flattenSearchCorpusText({})).toBe("");
  });
});

describe("bm25 resolveBm25Params", () => {
  function settingsWithBm25(bm25: unknown): Pick<PmSettings, "search"> {
    return { search: { bm25 } } as unknown as Pick<PmSettings, "search">;
  }

  it("defaults to the Lucene k1/b when unset", () => {
    expect(resolveBm25Params(undefined)).toEqual({ k1: DEFAULT_BM25_K1, b: DEFAULT_BM25_B });
    expect(resolveBm25Params({ search: {} } as Pick<PmSettings, "search">)).toEqual({
      k1: DEFAULT_BM25_K1,
      b: DEFAULT_BM25_B,
    });
  });

  it("honors valid in-range overrides", () => {
    expect(resolveBm25Params(settingsWithBm25({ k1: 2, b: 0.4 }))).toEqual({ k1: 2, b: 0.4 });
  });

  it("clamps each invalid/out-of-range knob independently back to its default", () => {
    expect(resolveBm25Params(settingsWithBm25({ k1: -1, b: 2 }))).toEqual({
      k1: DEFAULT_BM25_K1,
      b: DEFAULT_BM25_B,
    });
    expect(resolveBm25Params(settingsWithBm25({ k1: Number.NaN, b: 0.9 }))).toEqual({
      k1: DEFAULT_BM25_K1,
      b: 0.9,
    });
    expect(resolveBm25Params(settingsWithBm25({ k1: "x", b: null }))).toEqual({
      k1: DEFAULT_BM25_K1,
      b: DEFAULT_BM25_B,
    });
    expect(resolveBm25Params(settingsWithBm25({ k1: 1001 }))).toEqual({ k1: DEFAULT_BM25_K1, b: DEFAULT_BM25_B });
  });
});
