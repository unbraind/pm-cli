import { afterEach, describe, expect, it } from "vitest";
import {
  buildDeterministicQueryExpansions,
  mergeQueryExpansions,
  normalizeQueryExpansionOutput,
  normalizeRerankOutput,
  rerankCandidatesWithEmbeddings,
  resolveQueryExpansionConfig,
  resolveRerankConfig,
} from "../../src/core/search/relevance.js";
import { SETTINGS_DEFAULTS } from "../../src/core/shared/constants.js";

function makeSettings() {
  return structuredClone(SETTINGS_DEFAULTS);
}

describe("search relevance helpers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds deterministic query expansion variants and caps the count", () => {
    const expanded = buildDeterministicQueryExpansions("  the projects status updates  ", 3);
    expect(expanded[0]).toBe("the projects status updates");
    expect(expanded.length).toBe(3);
    expect(new Set(expanded.map((entry) => entry.toLowerCase())).size).toBe(expanded.length);
    expect(mergeQueryExpansions(["one", "two"], ["three", "four"], 2)).toEqual(["one", "two"]);
    expect(buildDeterministicQueryExpansions("   ")).toEqual([]);
    expect(buildDeterministicQueryExpansions("!!!")).toEqual(["!!!"]);
  });

  it("normalizes and merges expansion output safely", () => {
    expect(normalizeQueryExpansionOutput([" status update ", 7, "status update"])).toEqual(["status update"]);
    expect(normalizeQueryExpansionOutput(["   ", "release status"])).toEqual(["release status"]);
    expect(normalizeQueryExpansionOutput({ queries: ["Release Docs", "release docs", "weekly status"] })).toEqual([
      "Release Docs",
      "weekly status",
    ]);
    expect(normalizeQueryExpansionOutput({ queries: "nope" })).toEqual([]);
    expect(mergeQueryExpansions(["alpha", "beta"], ["beta", "gamma"], 2)).toEqual(["alpha", "beta"]);
  });

  it("resolves query-expansion and rerank settings with deterministic fallbacks", () => {
    const settings = makeSettings();
    settings.search.query_expansion.enabled = true;
    settings.search.query_expansion.provider = "ollama";
    settings.search.rerank.enabled = true;
    settings.search.rerank.model = "custom-rerank-model";
    settings.search.rerank.top_k = 13;

    expect(resolveQueryExpansionConfig(settings, "openai")).toEqual({
      enabled: true,
      provider: "ollama",
      max_queries: 4,
    });
    expect(resolveRerankConfig(settings, "fallback-model")).toEqual({
      enabled: true,
      model: "custom-rerank-model",
      top_k: 13,
    });

    settings.search.query_expansion.provider = "   ";
    settings.search.rerank.model = "  ";
    settings.search.rerank.top_k = 0;
    expect(resolveQueryExpansionConfig(settings, "openai").provider).toBe("openai");
    expect(resolveRerankConfig(settings, "fallback-model")).toEqual({
      enabled: true,
      model: "fallback-model",
      top_k: 20,
    });
  });

  it("normalizes rerank provider output into deterministic score hits", () => {
    expect(
      normalizeRerankOutput({
        hits: [
          null,
          "invalid",
          { id: "pm-b", score: 0.2 },
          { id: "pm-b", score: 0.6 },
          { id: "pm-a", score: 0.8 },
          { id: "pm-a", score: 0.1 },
          { id: "", score: 1 },
          { id: "pm-c", score: "x" },
        ],
      }),
    ).toEqual([
      { id: "pm-a", score: 0.8 },
      { id: "pm-b", score: 0.6 },
    ]);
    expect(normalizeRerankOutput([{ id: "pm-b", score: 0.5 }, { id: "pm-a", score: 0.5 }])).toEqual([
      { id: "pm-a", score: 0.5 },
      { id: "pm-b", score: 0.5 },
    ]);
    expect(normalizeRerankOutput("bad-shape")).toEqual([]);
  });

  it("reranks candidates with embedding scores and honors model override", async () => {
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      fetchCalls.push({ url: String(url), body: parsed });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: [
            { index: 0, embedding: [0, 0] },
            { index: 1, embedding: [1, 0] },
            { index: 2, embedding: [0, 1] },
          ],
        }),
        text: async () => "",
      } as unknown as Response;
    }) as typeof globalThis.fetch;

    const scores = await rerankCandidatesWithEmbeddings(
      {
        name: "openai",
        base_url: "https://api.example.test/v1",
        model: "text-embedding-3-small",
        api_key: "",
      },
      "custom-rerank-model",
      "release notes",
      [
        { id: "pm-a", text: "release docs checklist" },
        { id: "pm-b", text: "weekly status update" },
      ],
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://api.example.test/v1/embeddings");
    expect(fetchCalls[0]?.body.model).toBe("custom-rerank-model");
    expect(scores.get("pm-a")).toBe(0.5);
    expect(scores.get("pm-b")).toBe(0.5);
  });

  it("falls back to provider model and supports timeout options", async () => {
    const fetchCalls: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      fetchCalls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: [
            { index: 0, embedding: [1, 0] },
            { index: 1, embedding: [1, 0] },
          ],
        }),
        text: async () => "",
      } as unknown as Response;
    }) as typeof globalThis.fetch;

    const scores = await rerankCandidatesWithEmbeddings(
      {
        name: "openai",
        base_url: "https://api.example.test/v1",
        model: "provider-default-model",
        api_key: "",
      },
      "   ",
      "release notes",
      [{ id: "pm-timeout", text: "release docs checklist" }],
      25,
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.model).toBe("provider-default-model");
    expect(scores.get("pm-timeout")).toBe(1);
  });

  it("returns empty rerank scores without calling fetch when no candidates", async () => {
    globalThis.fetch = (async () => {
      throw new Error("fetch should not run");
    }) as typeof globalThis.fetch;

    const scores = await rerankCandidatesWithEmbeddings(
      {
        name: "openai",
        base_url: "https://api.example.test/v1",
        model: "text-embedding-3-small",
        api_key: "",
      },
      "text-embedding-3-small",
      "release notes",
      [],
    );

    expect(scores.size).toBe(0);
  });

  it("handles empty vectors by returning neutral normalized rerank scores", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: [
            { index: 0, embedding: [] },
            { index: 1, embedding: [1, 0] },
          ],
        }),
        text: async () => "",
      }) as unknown as Response) as typeof globalThis.fetch;

    const scores = await rerankCandidatesWithEmbeddings(
      {
        name: "openai",
        base_url: "https://api.example.test/v1",
        model: "text-embedding-3-small",
        api_key: "",
      },
      "text-embedding-3-small",
      "release notes",
      [{ id: "pm-a", text: "release docs checklist" }],
    );

    expect(scores.get("pm-a")).toBe(0.5);
  });

  it("handles dimension-mismatched vectors by returning neutral normalized rerank scores", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: [
            { index: 0, embedding: [1, 0] },
            { index: 1, embedding: [1, 0, 0] },
          ],
        }),
        text: async () => "",
      }) as unknown as Response) as typeof globalThis.fetch;

    const scores = await rerankCandidatesWithEmbeddings(
      {
        name: "openai",
        base_url: "https://api.example.test/v1",
        model: "text-embedding-3-small",
        api_key: "",
      },
      "text-embedding-3-small",
      "release notes",
      [{ id: "pm-dim", text: "release docs checklist" }],
    );

    expect(scores.get("pm-dim")).toBe(0.5);
  });

  it("handles non-finite cosine intermediates by returning neutral normalized rerank scores", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: [
            { index: 0, embedding: [1e308, 1e308] },
            { index: 1, embedding: [1e308, 1e308] },
          ],
        }),
        text: async () => "",
      }) as unknown as Response) as typeof globalThis.fetch;

    const scores = await rerankCandidatesWithEmbeddings(
      {
        name: "openai",
        base_url: "https://api.example.test/v1",
        model: "text-embedding-3-small",
        api_key: "",
      },
      "text-embedding-3-small",
      "release notes",
      [{ id: "pm-overflow", text: "release docs checklist" }],
    );

    expect(scores.get("pm-overflow")).toBe(0.5);
  });

  it("throws when embedding cardinality does not match rerank payload", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: [
            { index: 0, embedding: [0.1, 0.2] },
            { index: 1, embedding: [0.3, 0.4] },
          ],
        }),
        text: async () => "",
      }) as unknown as Response) as typeof globalThis.fetch;

    await expect(
      rerankCandidatesWithEmbeddings(
        {
          name: "openai",
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          api_key: "",
        },
        "text-embedding-3-small",
        "release notes",
        [
          { id: "pm-a", text: "release docs checklist" },
          { id: "pm-b", text: "weekly status update" },
        ],
      ),
    ).rejects.toThrow("cardinality mismatch");
  });
});
