import { describe, expect, it } from "vitest";
import { _testOnlySearchCommand } from "../../../src/cli/commands/search.js";
import { DEFAULT_BM25_B, DEFAULT_BM25_K1 } from "../../../src/core/search/bm25.js";
import type { ItemDocument, ItemMetadata } from "../../../src/types.js";

const { resolveBuiltInBm25Mode, computeBuiltInBm25Hits } = _testOnlySearchCommand;
const BM25_PARAMS = { k1: DEFAULT_BM25_K1, b: DEFAULT_BM25_B };

function makeMetadata(overrides: Partial<ItemMetadata>): ItemMetadata {
  return {
    id: "pm-x",
    title: "title",
    description: "",
    type: "Task",
    status: "open",
    priority: 3,
    tags: [],
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-20T00:00:00.000Z",
    ...overrides,
  } as ItemMetadata;
}

function makeDocument(id: string, text: string): ItemDocument {
  return { metadata: makeMetadata({ id, title: text }), body: text };
}

describe("resolveBuiltInBm25Mode", () => {
  it("returns 'explicit' for provider bm25 even when an embedding provider exists", () => {
    expect(
      resolveBuiltInBm25Mode({ configuredProvider: "bm25", hasEmbeddingProvider: true, hasExtensionSearchProvider: false }),
    ).toBe("explicit");
    expect(
      resolveBuiltInBm25Mode({ configuredProvider: "BM25", hasEmbeddingProvider: false, hasExtensionSearchProvider: false }),
    ).toBe("explicit");
  });

  it("returns 'auto-fallback' for provider auto only when no embedding/extension provider is available", () => {
    expect(
      resolveBuiltInBm25Mode({ configuredProvider: "auto", hasEmbeddingProvider: false, hasExtensionSearchProvider: false }),
    ).toBe("auto-fallback");
    expect(
      resolveBuiltInBm25Mode({ configuredProvider: "auto", hasEmbeddingProvider: true, hasExtensionSearchProvider: false }),
    ).toBeNull();
    expect(
      resolveBuiltInBm25Mode({ configuredProvider: "auto", hasEmbeddingProvider: false, hasExtensionSearchProvider: true }),
    ).toBeNull();
  });

  it("returns null for any other provider value or unset", () => {
    expect(
      resolveBuiltInBm25Mode({ configuredProvider: "ollama", hasEmbeddingProvider: true, hasExtensionSearchProvider: false }),
    ).toBeNull();
    expect(
      resolveBuiltInBm25Mode({ configuredProvider: undefined, hasEmbeddingProvider: false, hasExtensionSearchProvider: false }),
    ).toBeNull();
  });
});

describe("computeBuiltInBm25Hits", () => {
  const documents = [
    makeDocument("pm-a", "database connection pool leak under load"),
    makeDocument("pm-b", "exponential backoff retry http client"),
    makeDocument("pm-c", "database migration plan"),
  ];

  it("ranks semantic-mode hits with the bm25 matched-field marker", () => {
    const hits = computeBuiltInBm25Hits({
      requestedMode: "semantic",
      query: "database connection",
      filteredDocuments: documents,
      keywordHits: [],
      corpusFields: ["title", "body"],
      bm25Params: BM25_PARAMS,
      hybridSemanticWeight: 0.7,
    });
    const ids = hits.map((hit) => hit.item.id);
    expect(ids).toContain("pm-a");
    expect(ids).toContain("pm-c");
    expect(ids).not.toContain("pm-b");
    expect(hits.every((hit) => hit.matched_fields.includes("bm25"))).toBe(true);
  });

  it("blends bm25 and keyword scores in hybrid mode, tagging the dense component 'bm25'", () => {
    const keywordHits = [
      { item: documents[0].metadata, score: 8, matched_fields: ["title"], matched_all_terms: true },
    ];
    const hits = computeBuiltInBm25Hits({
      requestedMode: "hybrid",
      query: "database connection",
      filteredDocuments: documents,
      keywordHits,
      corpusFields: ["title", "body"],
      bm25Params: BM25_PARAMS,
      hybridSemanticWeight: 0.7,
    });
    const top = hits.find((hit) => hit.item.id === "pm-a");
    expect(top).toBeDefined();
    expect(top!.matched_fields).toContain("bm25");
    expect(top!.matched_fields).toContain("title");
  });

  it("forces an exact-ID keyword match to the top in semantic mode even with no bm25 match", () => {
    const exactHit = {
      item: documents[1].metadata,
      score: 1000,
      matched_fields: ["id"],
      matched_all_terms: true,
      exact_id_match: true,
    };
    const hits = computeBuiltInBm25Hits({
      requestedMode: "semantic",
      query: "database connection",
      filteredDocuments: documents,
      keywordHits: [exactHit],
      corpusFields: ["title", "body"],
      bm25Params: BM25_PARAMS,
      hybridSemanticWeight: 0.7,
    });
    expect(hits[0].item.id).toBe("pm-b");
    expect(hits[0].matched_fields).toEqual(["id"]);
  });
});
