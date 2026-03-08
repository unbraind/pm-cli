import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { ItemFrontMatter } from "../../src/types.js";
import { EXIT_CODE } from "../../src/constants.js";
import { readJsonFixture } from "../helpers/fixtures.js";

const pathExistsMock = vi.fn<() => Promise<boolean>>();
const readSettingsMock = vi.fn<() => Promise<{ id_prefix: string }>>();
const listAllFrontMatterMock = vi.fn<() => Promise<ItemFrontMatter[]>>();
const readFileMock = vi.fn<(targetPath: string, encoding: string) => Promise<string>>();
const realpathMock = vi.fn<(targetPath: string) => Promise<string>>();
const runActiveOnReadHooksMock = vi.fn<() => Promise<string[]>>();

vi.mock("../../src/core/fs/fs-utils.js", () => ({
  pathExists: pathExistsMock,
}));

vi.mock("../../src/core/store/settings.js", () => ({
  readSettings: readSettingsMock,
}));

vi.mock("../../src/core/store/item-store.js", () => ({
  listAllFrontMatter: listAllFrontMatterMock,
}));

vi.mock("../../src/core/extensions/index.js", () => ({
  runActiveOnReadHooks: runActiveOnReadHooksMock,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: readFileMock,
    realpath: realpathMock,
  },
}));

interface KeywordCorpusFixture {
  match_scenario: {
    query: string;
    matching_overrides: Partial<ItemFrontMatter> & Pick<ItemFrontMatter, "id">;
    non_matching_overrides: Partial<ItemFrontMatter> & Pick<ItemFrontMatter, "id">;
  };
}

const keywordCorpusFixture = readJsonFixture<KeywordCorpusFixture>("search", "keyword-corpus.json");

function makeFrontMatter(overrides: Partial<ItemFrontMatter> & Pick<ItemFrontMatter, "id">): ItemFrontMatter {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? "",
    type: overrides.type ?? "Task",
    status: overrides.status ?? "open",
    priority: overrides.priority ?? 1,
    tags: overrides.tags ?? [],
    created_at: overrides.created_at ?? "2026-02-18T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-02-18T00:00:00.000Z",
    deadline: overrides.deadline,
    assignee: overrides.assignee,
    author: overrides.author,
    estimated_minutes: overrides.estimated_minutes,
    acceptance_criteria: overrides.acceptance_criteria,
    dependencies: overrides.dependencies,
    comments: overrides.comments,
    notes: overrides.notes,
    learnings: overrides.learnings,
    files: overrides.files,
    tests: overrides.tests,
    docs: overrides.docs,
    close_reason: overrides.close_reason,
  };
}

function serializeDocument(frontMatter: ItemFrontMatter, body: string): string {
  return `${JSON.stringify(frontMatter, null, 2)}\n\n${body}`;
}

function resolveFetchTarget(url: unknown): string {
  if (typeof url === "string") {
    return url;
  }
  if (url instanceof URL) {
    return url.toString();
  }
  if (typeof url === "object" && url !== null && "url" in url) {
    const maybeUrl = (url as { url?: unknown }).url;
    if (typeof maybeUrl === "string") {
      return maybeUrl;
    }
  }
  throw new TypeError(`Unexpected fetch target type: ${typeof url}`);
}

function parseJsonBody<T>(body: unknown): T {
  if (typeof body !== "string") {
    throw new TypeError(`Expected string request body but received ${typeof body}`);
  }
  return JSON.parse(body) as T;
}

describe("runSearch", () => {
  beforeEach(() => {
    pathExistsMock.mockReset();
    readSettingsMock.mockReset();
    listAllFrontMatterMock.mockReset();
    readFileMock.mockReset();
    realpathMock.mockReset();
    runActiveOnReadHooksMock.mockReset();

    pathExistsMock.mockResolvedValue(true);
    readSettingsMock.mockResolvedValue({ id_prefix: "pm-" });
    listAllFrontMatterMock.mockResolvedValue([]);
    realpathMock.mockImplementation(async (targetPath) => targetPath);
    runActiveOnReadHooksMock.mockResolvedValue([]);
  });

  it("fails when tracker is not initialized", async () => {
    pathExistsMock.mockResolvedValueOnce(false);
    const { runSearch } = await import("../../src/cli/commands/search.js");
    await expect(runSearch("token", {}, { path: "/tmp/not-init" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.NOT_FOUND,
    });
  });

  it("resolves search max-results and score-threshold fallbacks deterministically", async () => {
    const { resolveSearchMaxResults, resolveSearchScoreThreshold, resolveHybridSemanticWeight } = await import(
      "../../src/cli/commands/search.js"
    );
    expect(resolveSearchMaxResults({ search: { max_results: 7.9 } })).toBe(7);
    expect(resolveSearchMaxResults({ search: { max_results: 0 } })).toBe(50);
    expect(resolveSearchMaxResults({ search: { max_results: "bad" } })).toBe(50);
    expect(resolveSearchScoreThreshold({ search: { score_threshold: 0.42 } })).toBe(0.42);
    expect(resolveSearchScoreThreshold({ search: { score_threshold: Number.NaN } })).toBe(0);
    expect(resolveSearchScoreThreshold({ search: { score_threshold: "bad" } })).toBe(0);
    expect(resolveHybridSemanticWeight({ search: { hybrid_semantic_weight: 0.2 } })).toBe(0.2);
    expect(resolveHybridSemanticWeight({ search: { hybrid_semantic_weight: -0.1 } })).toBe(0.7);
    expect(resolveHybridSemanticWeight({ search: { hybrid_semantic_weight: 1.1 } })).toBe(0.7);
    expect(resolveHybridSemanticWeight({ search: { hybrid_semantic_weight: "bad" } })).toBe(0.7);
  });

  it("validates query, mode, and filter inputs", async () => {
    const { runSearch } = await import("../../src/cli/commands/search.js");

    await expect(runSearch("   ", {}, { path: "/tmp/pm-search" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    const keywordDefaultNoSemantic = await runSearch("token", {}, { path: "/tmp/pm-search" });
    expect(keywordDefaultNoSemantic.mode).toBe("keyword");
    expect(keywordDefaultNoSemantic.count).toBe(0);
    await expect(runSearch("token", { mode: "semantic" }, { path: "/tmp/pm-search" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
      message: expect.stringContaining("requires a configured embedding provider"),
    });
    await expect(runSearch("token", { mode: "hybrid" }, { path: "/tmp/pm-search" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
      message: expect.stringContaining("requires a configured embedding provider"),
    });
    readSettingsMock.mockResolvedValueOnce({
      providers: {
        openai: {
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          api_key: "",
        },
      },
    } as unknown as { id_prefix: string });
    await expect(runSearch("token", { mode: "semantic" }, { path: "/tmp/pm-search" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
      message: expect.stringContaining("requires a configured vector store"),
    });
    const openAiSemanticSettings = {
      providers: {
        openai: {
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          api_key: "",
        },
      },
      vector_store: {
        qdrant: {
          url: "https://qdrant.example.test:6333",
          api_key: "",
        },
      },
    } as unknown as { id_prefix: string };
    readSettingsMock.mockResolvedValueOnce(openAiSemanticSettings);
    const defaultHybridNoItems = await runSearch("token", {}, { path: "/tmp/pm-search" });
    expect(defaultHybridNoItems.mode).toBe("hybrid");
    expect(defaultHybridNoItems.count).toBe(0);
    readSettingsMock.mockResolvedValueOnce(openAiSemanticSettings);
    const semanticNoItems = await runSearch("token", { mode: "semantic" }, { path: "/tmp/pm-search" });
    expect(semanticNoItems.mode).toBe("semantic");
    expect(semanticNoItems.count).toBe(0);
    readSettingsMock.mockResolvedValueOnce(openAiSemanticSettings);
    const explicitKeywordNoItems = await runSearch("token", { mode: "keyword" }, { path: "/tmp/pm-search" });
    expect(explicitKeywordNoItems.mode).toBe("keyword");
    expect(explicitKeywordNoItems.count).toBe(0);
    readSettingsMock.mockResolvedValueOnce({
      providers: {
        ollama: {
          base_url: "http://localhost:11434",
          model: "nomic-embed-text",
        },
      },
      vector_store: {
        lancedb: {
          path: "/tmp/lance db",
        },
      },
    } as unknown as { id_prefix: string });
    const hybridNoItems = await runSearch("token", { mode: "hybrid" }, { path: "/tmp/pm-search" });
    expect(hybridNoItems.mode).toBe("hybrid");
    expect(hybridNoItems.count).toBe(0);
    await expect(runSearch("token", { mode: "bad-mode" }, { path: "/tmp/pm-search" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runSearch("token", { type: "NotAType" }, { path: "/tmp/pm-search" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runSearch("token", { priority: "8" }, { path: "/tmp/pm-search" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runSearch("token", { priority: "1.5" }, { path: "/tmp/pm-search" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(
      runSearch("token", { deadlineBefore: "not-a-deadline" }, { path: "/tmp/pm-search" }),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runSearch("token", { limit: "-1" }, { path: "/tmp/pm-search" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
  });

  it("returns deterministic empty semantic and hybrid results for limit=0 without embedding/vector requests", async () => {
    const semanticSettings = {
      providers: {
        openai: {
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          api_key: "",
        },
      },
      vector_store: {
        qdrant: {
          url: "https://qdrant.example.test:6333",
          api_key: "",
        },
      },
    } as unknown as { id_prefix: string };
    const indexedItem = makeFrontMatter({
      id: "pm-limit-zero",
      title: "token title",
      description: "token description",
      tags: ["token"],
    });

    readSettingsMock.mockResolvedValue(semanticSettings);
    listAllFrontMatterMock.mockResolvedValue([indexedItem]);
    readFileMock.mockImplementation(async (targetPath) => {
      if (targetPath.endsWith("pm-limit-zero.md")) {
        return serializeDocument(indexedItem, "token body");
      }
      throw new Error(`Unexpected path: ${targetPath}`);
    });

    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should not be called for limit=0 semantic/hybrid search");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../src/cli/commands/search.js");
      const semanticResult = await runSearch("token", { mode: "semantic", limit: "0" }, { path: "/tmp/pm-search" });
      expect(semanticResult.mode).toBe("semantic");
      expect(semanticResult.count).toBe(0);
      expect(semanticResult.items).toEqual([]);
      expect(semanticResult.filters).toMatchObject({ limit: "0" });

      const hybridResult = await runSearch("token", { mode: "hybrid", limit: "0" }, { path: "/tmp/pm-search" });
      expect(hybridResult.mode).toBe("hybrid");
      expect(hybridResult.count).toBe(0);
      expect(hybridResult.items).toEqual([]);
      expect(hybridResult.filters).toMatchObject({ limit: "0" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("matches every keyword corpus field and applies metadata filters", async () => {
    const matching = makeFrontMatter(keywordCorpusFixture.match_scenario.matching_overrides);
    const nonMatch = makeFrontMatter(keywordCorpusFixture.match_scenario.non_matching_overrides);
    const query = keywordCorpusFixture.match_scenario.query;

    listAllFrontMatterMock.mockResolvedValueOnce([nonMatch, matching]);
    readFileMock.mockImplementation(async (targetPath) => {
      if (targetPath.endsWith("pm-match.md")) {
        return serializeDocument(matching, "bodytoken");
      }
      if (targetPath.endsWith("pm-non-match.md")) {
        return serializeDocument(nonMatch, "different");
      }
      throw new Error(`Unexpected path: ${targetPath}`);
    });

    const { runSearch } = await import("../../src/cli/commands/search.js");
    const result = await runSearch(
      query,
      {
        mode: "keyword",
        type: "Task",
        tag: "tagtoken",
        priority: "2",
        deadlineBefore: "2026-02-21T00:00:00.000Z",
        deadlineAfter: "2026-02-19T00:00:00.000Z",
        limit: "1.9",
      },
      { path: "/tmp/pm-search" },
    );

    expect(result.mode).toBe("keyword");
    expect(result.query).toBe(query);
    expect(result.count).toBe(1);
    expect(result.items[0].item.id).toBe("pm-match");
    expect(result.items[0].matched_fields).toEqual([
      "body",
      "comments",
      "dependencies",
      "description",
      "learnings",
      "notes",
      "status",
      "tags",
      "title",
    ]);
    expect(result.filters).toMatchObject({
      mode: "keyword",
      type: "Task",
      tag: "tagtoken",
      priority: "2",
      deadline_before: "2026-02-21T00:00:00.000Z",
      deadline_after: "2026-02-19T00:00:00.000Z",
      limit: "1.9",
    });

    listAllFrontMatterMock.mockResolvedValue([matching]);
    readFileMock.mockResolvedValue(serializeDocument(matching, "bodytoken"));

    const wrongType = await runSearch("titletoken", { type: "Issue" }, { path: "/tmp/pm-search" });
    expect(wrongType.count).toBe(0);
    expect(wrongType.items).toEqual([]);

    const normalizedType = await runSearch("titletoken", { type: "task" }, { path: "/tmp/pm-search" });
    expect(normalizedType.count).toBe(1);
    expect(normalizedType.items[0].item.id).toBe("pm-match");

    const wrongPriority = await runSearch("titletoken", { priority: "0" }, { path: "/tmp/pm-search" });
    expect(wrongPriority.count).toBe(0);

    const deadlineBeforeMiss = await runSearch(
      "titletoken",
      { deadlineBefore: "2026-02-19T00:00:00.000Z" },
      { path: "/tmp/pm-search" },
    );
    expect(deadlineBeforeMiss.count).toBe(0);

    const deadlineAfterMiss = await runSearch(
      "titletoken",
      { deadlineAfter: "2026-02-21T00:00:00.000Z" },
      { path: "/tmp/pm-search" },
    );
    expect(deadlineAfterMiss.count).toBe(0);
  });

  it("executes semantic and hybrid search modes with deterministic ranking", async () => {
    const semanticTop = makeFrontMatter({
      id: "pm-sem-top",
      title: "tok alpha",
      updated_at: "2026-02-18T00:02:00.000Z",
      priority: 1,
    });
    const semanticAndLexical = makeFrontMatter({
      id: "pm-sem-lex",
      title: "tok tok beta",
      updated_at: "2026-02-18T00:01:00.000Z",
      priority: 1,
    });
    const lexicalOnly = makeFrontMatter({
      id: "pm-lex-only",
      title: "tok tok tok gamma",
      updated_at: "2026-02-18T00:03:00.000Z",
      priority: 0,
    });
    const semanticDropped = makeFrontMatter({
      id: "pm-sem-drop",
      title: "no lexical hit",
      updated_at: "2026-02-18T00:04:00.000Z",
      priority: 2,
    });
    const docs = [semanticTop, semanticAndLexical, lexicalOnly, semanticDropped];
    listAllFrontMatterMock.mockResolvedValue(docs);
    readFileMock.mockImplementation(async (targetPath) => {
      const match = docs.find((item) => targetPath.endsWith(`${item.id}.md`));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      return serializeDocument(match, "semantic body");
    });
    readSettingsMock.mockResolvedValue({
      search: {
        max_results: 2,
        hybrid_semantic_weight: 0.2,
      },
      providers: {
        openai: {
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          api_key: "",
        },
      },
      vector_store: {
        qdrant: {
          url: "https://qdrant.example.test:6333",
          api_key: "",
        },
      },
    } as unknown as { id_prefix: string });

    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    let queryCallCount = 0;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const target = resolveFetchTarget(url);
      fetchCalls.push(target);
      if (target.endsWith("/v1/embeddings")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ data: [{ embedding: [0.9, 0.1] }] }),
          text: async () => "",
        } as unknown as Response;
      }
      if (target.endsWith("/collections/pm_items/points/search")) {
        queryCallCount += 1;
        const body = parseJsonBody<{ limit?: number }>(init?.body);
        expect(body.limit).toBe(queryCallCount === 1 ? 2 : 3);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            result: [
              { id: "pm-sem-top", score: 0.91 },
                { id: "pm-sem-top", score: 0.9 },
                { id: "pm-sem-lex", score: 0.58 },
                { id: "pm-missing", score: 0.7 },
                { id: "pm-sem-drop", score: 0.5 },
            ],
          }),
          text: async () => "",
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch target: ${target}`);
    }) as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../src/cli/commands/search.js");

      const semanticResult = await runSearch("tok", { mode: "semantic" }, { path: "/tmp/pm-search" });
      expect(semanticResult.mode).toBe("semantic");
      expect(semanticResult.items.map((entry) => entry.item.id)).toEqual(["pm-sem-top", "pm-sem-lex"]);
      expect(semanticResult.items.every((entry) => entry.matched_fields.includes("semantic"))).toBe(true);

      const hybridResult = await runSearch(
        "tok",
        { mode: "hybrid", includeLinked: true, limit: "3" },
        { path: "/tmp/pm-search" },
      );
      expect(hybridResult.mode).toBe("hybrid");
      expect(hybridResult.items.map((entry) => entry.item.id)).toEqual(["pm-lex-only", "pm-sem-lex", "pm-sem-top"]);
      expect(hybridResult.items[0]?.matched_fields).toContain("title");
      expect(hybridResult.items[1]?.matched_fields).toContain("semantic");
      expect(hybridResult.items[2]?.matched_fields).toContain("semantic");
      expect(hybridResult.filters).toMatchObject({ hybrid_semantic_weight: 0.2 });
      expect(fetchCalls).toEqual([
        "https://api.example.test/v1/embeddings",
        "https://qdrant.example.test:6333/collections/pm_items/points/search",
        "https://api.example.test/v1/embeddings",
        "https://qdrant.example.test:6333/collections/pm_items/points/search",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles hybrid normalization when score maps are empty or uniform", async () => {
    const itemA = makeFrontMatter({
      id: "pm-hybrid-a",
      title: "same",
      updated_at: "2026-02-18T00:01:00.000Z",
    });
    const itemB = makeFrontMatter({
      id: "pm-hybrid-b",
      title: "same",
      updated_at: "2026-02-18T00:00:00.000Z",
    });
    listAllFrontMatterMock.mockResolvedValue([itemA, itemB]);
    readFileMock.mockImplementation(async (targetPath) => {
      if (targetPath.endsWith("pm-hybrid-a.md")) {
        return serializeDocument(itemA, "body");
      }
      if (targetPath.endsWith("pm-hybrid-b.md")) {
        return serializeDocument(itemB, "body");
      }
      throw new Error(`Unexpected path: ${targetPath}`);
    });
    readSettingsMock.mockResolvedValue({
      search: {
        max_results: 3,
      },
      providers: {
        openai: {
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          api_key: "",
        },
      },
      vector_store: {
        qdrant: {
          url: "https://qdrant.example.test:6333",
          api_key: "",
        },
      },
    } as unknown as { id_prefix: string });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const target = resolveFetchTarget(url);
      if (target.endsWith("/v1/embeddings")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ data: [{ embedding: [1, 0] }] }),
          text: async () => "",
        } as unknown as Response;
      }
      if (target.endsWith("/collections/pm_items/points/search")) {
        const body = parseJsonBody<{ limit?: number }>(init?.body);
        expect(body.limit).toBe(3);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            result: [
              { id: "pm-hybrid-a", score: 1 },
              { id: "pm-hybrid-b", score: 1 },
            ],
          }),
          text: async () => "",
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch target: ${target}`);
    }) as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../src/cli/commands/search.js");
      const uniformScores = await runSearch("same", { mode: "hybrid" }, { path: "/tmp/pm-search" });
      expect(uniformScores.count).toBe(2);
      expect(uniformScores.items.map((entry) => entry.item.id)).toEqual(["pm-hybrid-a", "pm-hybrid-b"]);

      const emptyKeywordScores = await runSearch("vectoronly", { mode: "hybrid" }, { path: "/tmp/pm-search" });
      expect(emptyKeywordScores.count).toBe(2);
      expect(emptyKeywordScores.items.every((entry) => entry.matched_fields.includes("semantic"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("applies score_threshold as a mode-aware minimum score filter", async () => {
    const thresholdStrong = makeFrontMatter({
      id: "pm-threshold-strong",
      title: "tok tok tok",
      updated_at: "2026-02-18T00:02:00.000Z",
      priority: 1,
    });
    const thresholdWeak = makeFrontMatter({
      id: "pm-threshold-weak",
      title: "tok",
      updated_at: "2026-02-18T00:01:00.000Z",
      priority: 1,
    });
    const docs = [thresholdStrong, thresholdWeak];
    listAllFrontMatterMock.mockResolvedValue(docs);
    readFileMock.mockImplementation(async (targetPath) => {
      const match = docs.find((item) => targetPath.endsWith(`${item.id}.md`));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      return serializeDocument(match, "threshold body");
    });

    const semanticSettings = {
      search: {
        max_results: 5,
        score_threshold: 0.7,
      },
      providers: {
        openai: {
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          api_key: "",
        },
      },
      vector_store: {
        qdrant: {
          url: "https://qdrant.example.test:6333",
          api_key: "",
        },
      },
    } as unknown as { id_prefix: string };

    readSettingsMock
      .mockResolvedValueOnce({
        search: {
          score_threshold: 20,
        },
      } as unknown as { id_prefix: string })
      .mockResolvedValueOnce(semanticSettings)
      .mockResolvedValueOnce({
        ...semanticSettings,
        search: {
          max_results: 5,
          score_threshold: 0.5,
        },
      } as unknown as { id_prefix: string });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const target = resolveFetchTarget(url);
      if (target.endsWith("/v1/embeddings")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ data: [{ embedding: [0.9, 0.1] }] }),
          text: async () => "",
        } as unknown as Response;
      }
      if (target.endsWith("/collections/pm_items/points/search")) {
        const body = parseJsonBody<{ limit?: number }>(init?.body);
        expect(body.limit).toBe(5);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            result: [
              { id: "pm-threshold-strong", score: 0.91 },
              { id: "pm-threshold-weak", score: 0.58 },
            ],
          }),
          text: async () => "",
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch target: ${target}`);
    }) as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../src/cli/commands/search.js");

      const keywordResult = await runSearch("tok", { mode: "keyword" }, { path: "/tmp/pm-search" });
      expect(keywordResult.mode).toBe("keyword");
      expect(keywordResult.items.map((entry) => entry.item.id)).toEqual(["pm-threshold-strong"]);
      expect(keywordResult.filters).toMatchObject({ score_threshold: 20 });

      const semanticResult = await runSearch("tok", { mode: "semantic" }, { path: "/tmp/pm-search" });
      expect(semanticResult.mode).toBe("semantic");
      expect(semanticResult.items.map((entry) => entry.item.id)).toEqual(["pm-threshold-strong"]);
      expect(semanticResult.filters).toMatchObject({ score_threshold: 0.7 });

      const hybridResult = await runSearch("tok", { mode: "hybrid" }, { path: "/tmp/pm-search" });
      expect(hybridResult.mode).toBe("hybrid");
      expect(hybridResult.items.map((entry) => entry.item.id)).toEqual(["pm-threshold-strong"]);
      expect(hybridResult.filters).toMatchObject({ score_threshold: 0.5 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("includes linked docs/files/tests content when include-linked is enabled", async () => {
    const previousGlobalPath = process.env.PM_GLOBAL_PATH;
    const globalRoot = "/tmp/pm-search-global";
    process.env.PM_GLOBAL_PATH = globalRoot;
    try {
      const linkedOnlyMatch = makeFrontMatter({
        id: "pm-linked-only",
        title: "No keyword in core fields",
        description: "No linked token here",
        tags: ["search"],
        files: [
          { path: "docs/linked-project.md", scope: "project" },
          { path: "docs/linked-project.md", scope: "project" },
          { path: "docs/missing.md", scope: "project" },
          { path: ".", scope: "project" },
        ],
        docs: [{ path: "linked-global.md", scope: "global" }],
        tests: [
          { command: "node --version", scope: "project" },
          { path: "tests/linked-test.md", scope: "project" },
        ],
      });

      listAllFrontMatterMock.mockResolvedValue([linkedOnlyMatch]);
      readFileMock.mockImplementation(async (targetPath) => {
        if (targetPath.endsWith("pm-linked-only.md")) {
          return serializeDocument(linkedOnlyMatch, "body without keyword");
        }
        if (targetPath === path.resolve(process.cwd(), "docs/linked-project.md")) {
          return "linkedtoken from project file";
        }
        if (targetPath === path.resolve(globalRoot, "linked-global.md")) {
          return "linkedtoken from global doc";
        }
        if (targetPath === path.resolve(process.cwd(), "tests/linked-test.md")) {
          return "linkedtoken from linked test";
        }
        throw new Error(`ENOENT: ${targetPath}`);
      });

      const { runSearch } = await import("../../src/cli/commands/search.js");

      const withoutLinked = await runSearch("linkedtoken", {}, { path: "/tmp/pm-search" });
      expect(withoutLinked.count).toBe(0);
      expect(withoutLinked.filters).toMatchObject({ include_linked: false });

      const withLinked = await runSearch("linkedtoken", { includeLinked: true }, { path: "/tmp/pm-search" });
      expect(withLinked.count).toBe(1);
      expect(withLinked.items[0].item.id).toBe("pm-linked-only");
      expect(withLinked.items[0].matched_fields).toEqual(["linked_content"]);
      expect(withLinked.filters).toMatchObject({ include_linked: true });

      const noLinkedEntries = makeFrontMatter({
        id: "pm-no-linked-entries",
        title: "still no keyword",
      });
      listAllFrontMatterMock.mockResolvedValue([noLinkedEntries]);
      readFileMock.mockImplementation(async (targetPath) => {
        if (targetPath.endsWith("pm-no-linked-entries.md")) {
          return serializeDocument(noLinkedEntries, "body without keyword");
        }
        throw new Error(`ENOENT: ${targetPath}`);
      });

      const includeLinkedNoEntries = await runSearch("linkedtoken", { includeLinked: true }, { path: "/tmp/pm-search" });
      expect(includeLinkedNoEntries.count).toBe(0);
      expect(includeLinkedNoEntries.filters).toMatchObject({ include_linked: true });
    } finally {
      if (previousGlobalPath === undefined) {
        delete process.env.PM_GLOBAL_PATH;
      } else {
        process.env.PM_GLOBAL_PATH = previousGlobalPath;
      }
    }
  });

  it("ignores include-linked paths that resolve outside allowed roots", async () => {
    const previousGlobalPath = process.env.PM_GLOBAL_PATH;
    const globalRoot = "/tmp/pm-search-containment-global";
    process.env.PM_GLOBAL_PATH = globalRoot;
    try {
      const containedItem = makeFrontMatter({
        id: "pm-linked-contained",
        title: "No keyword in core fields",
        files: [{ path: "../escape-project.md", scope: "project" }],
        docs: [{ path: "../escape-global.md", scope: "global" }],
      });
      const escapedProjectPath = path.resolve(process.cwd(), "../escape-project.md");
      const escapedGlobalPath = path.resolve(globalRoot, "../escape-global.md");

      listAllFrontMatterMock.mockResolvedValue([containedItem]);
      readFileMock.mockImplementation(async (targetPath) => {
        if (targetPath.endsWith("pm-linked-contained.md")) {
          return serializeDocument(containedItem, "body without token");
        }
        if (targetPath === escapedProjectPath || targetPath === escapedGlobalPath) {
          return "escapetoken";
        }
        throw new Error(`ENOENT: ${targetPath}`);
      });

      const { runSearch } = await import("../../src/cli/commands/search.js");
      const result = await runSearch("escapetoken", { includeLinked: true }, { path: "/tmp/pm-search" });
      expect(result.count).toBe(0);
      expect(readFileMock).not.toHaveBeenCalledWith(escapedProjectPath, "utf8");
      expect(readFileMock).not.toHaveBeenCalledWith(escapedGlobalPath, "utf8");
      expect(runActiveOnReadHooksMock).not.toHaveBeenCalledWith({
        path: escapedProjectPath,
        scope: "project",
      });
      expect(runActiveOnReadHooksMock).not.toHaveBeenCalledWith({
        path: escapedGlobalPath,
        scope: "global",
      });
    } finally {
      if (previousGlobalPath === undefined) {
        delete process.env.PM_GLOBAL_PATH;
      } else {
        process.env.PM_GLOBAL_PATH = previousGlobalPath;
      }
    }
  });

  it("ignores include-linked paths whose symlink realpath escapes allowed roots", async () => {
    const previousGlobalPath = process.env.PM_GLOBAL_PATH;
    const globalRoot = "/tmp/pm-search-symlink-global";
    process.env.PM_GLOBAL_PATH = globalRoot;
    try {
      const symlinkItem = makeFrontMatter({
        id: "pm-linked-symlink-escape",
        title: "No keyword in core fields",
        files: [{ path: "docs/project-link.md", scope: "project" }],
        docs: [{ path: "docs/global-link.md", scope: "global" }],
      });
      const projectLinkedPath = path.resolve(process.cwd(), "docs/project-link.md");
      const globalLinkedPath = path.resolve(globalRoot, "docs/global-link.md");
      const escapedProjectRealpath = path.resolve(process.cwd(), "../project-realpath-escape.md");
      const escapedGlobalRealpath = path.resolve(globalRoot, "../global-realpath-escape.md");

      listAllFrontMatterMock.mockResolvedValue([symlinkItem]);
      readFileMock.mockImplementation(async (targetPath) => {
        if (targetPath.endsWith("pm-linked-symlink-escape.md")) {
          return serializeDocument(symlinkItem, "body without token");
        }
        if (targetPath === projectLinkedPath || targetPath === globalLinkedPath) {
          return "symlinktoken";
        }
        throw new Error(`ENOENT: ${targetPath}`);
      });
      realpathMock.mockImplementation(async (targetPath) => {
        if (targetPath === projectLinkedPath) {
          return escapedProjectRealpath;
        }
        if (targetPath === globalLinkedPath) {
          return escapedGlobalRealpath;
        }
        return targetPath;
      });

      const { runSearch } = await import("../../src/cli/commands/search.js");
      const result = await runSearch("symlinktoken", { includeLinked: true }, { path: "/tmp/pm-search-symlink" });
      expect(result.count).toBe(0);
      expect(readFileMock).not.toHaveBeenCalledWith(projectLinkedPath, "utf8");
      expect(readFileMock).not.toHaveBeenCalledWith(globalLinkedPath, "utf8");
      expect(runActiveOnReadHooksMock).not.toHaveBeenCalledWith({
        path: projectLinkedPath,
        scope: "project",
      });
      expect(runActiveOnReadHooksMock).not.toHaveBeenCalledWith({
        path: globalLinkedPath,
        scope: "global",
      });
    } finally {
      if (previousGlobalPath === undefined) {
        delete process.env.PM_GLOBAL_PATH;
      } else {
        process.env.PM_GLOBAL_PATH = previousGlobalPath;
      }
    }
  });

  it("skips include-linked entries when containment root or linked realpath resolution fails", async () => {
    const previousGlobalPath = process.env.PM_GLOBAL_PATH;
    const globalRoot = "/tmp/pm-search-realpath-fail-global";
    process.env.PM_GLOBAL_PATH = globalRoot;
    try {
      const realpathFailureItem = makeFrontMatter({
        id: "pm-linked-realpath-fail",
        title: "No keyword in core fields",
        files: [{ path: "docs/project-link.md", scope: "project" }],
        docs: [{ path: "docs/global-link.md", scope: "global" }],
      });
      const projectLinkedPath = path.resolve(process.cwd(), "docs/project-link.md");
      const globalLinkedPath = path.resolve(globalRoot, "docs/global-link.md");

      listAllFrontMatterMock.mockResolvedValue([realpathFailureItem]);
      readFileMock.mockImplementation(async (targetPath) => {
        if (targetPath.endsWith("pm-linked-realpath-fail.md")) {
          return serializeDocument(realpathFailureItem, "body without token");
        }
        if (targetPath === projectLinkedPath || targetPath === globalLinkedPath) {
          return "realpathfailtoken";
        }
        throw new Error(`ENOENT: ${targetPath}`);
      });
      realpathMock.mockImplementation(async (targetPath) => {
        if (targetPath === process.cwd()) {
          throw new Error("project root realpath failed");
        }
        if (targetPath === globalLinkedPath) {
          throw new Error("linked path realpath failed");
        }
        return targetPath;
      });

      const { runSearch } = await import("../../src/cli/commands/search.js");
      const result = await runSearch("realpathfailtoken", { includeLinked: true }, { path: "/tmp/pm-search-realpath-fail" });
      expect(result.count).toBe(0);
      expect(readFileMock).not.toHaveBeenCalledWith(projectLinkedPath, "utf8");
      expect(readFileMock).not.toHaveBeenCalledWith(globalLinkedPath, "utf8");
      expect(runActiveOnReadHooksMock).not.toHaveBeenCalledWith({
        path: projectLinkedPath,
        scope: "project",
      });
      expect(runActiveOnReadHooksMock).not.toHaveBeenCalledWith({
        path: globalLinkedPath,
        scope: "global",
      });
    } finally {
      if (previousGlobalPath === undefined) {
        delete process.env.PM_GLOBAL_PATH;
      } else {
        process.env.PM_GLOBAL_PATH = previousGlobalPath;
      }
    }
  });

  it("dispatches read hooks for item and linked content paths", async () => {
    const previousGlobalPath = process.env.PM_GLOBAL_PATH;
    const globalRoot = "/tmp/pm-search-hooks-global";
    process.env.PM_GLOBAL_PATH = globalRoot;
    try {
      const hookedItem = makeFrontMatter({
        id: "pm-hooked",
        title: "Hooked item",
        files: [{ path: "docs/hook-project.md", scope: "project" }],
        docs: [{ path: "hook-global.md", scope: "global" }],
      });

      listAllFrontMatterMock.mockResolvedValue([hookedItem]);
      readFileMock.mockImplementation(async (targetPath) => {
        if (targetPath.endsWith("pm-hooked.md")) {
          return serializeDocument(hookedItem, "body without hooktoken");
        }
        if (targetPath === path.resolve(process.cwd(), "docs/hook-project.md")) {
          return "hooktoken from project";
        }
        if (targetPath === path.resolve(globalRoot, "hook-global.md")) {
          return "hooktoken from global";
        }
        throw new Error(`ENOENT: ${targetPath}`);
      });

      const { runSearch } = await import("../../src/cli/commands/search.js");
      const result = await runSearch("hooktoken", { includeLinked: true }, { path: "/tmp/pm-search-hooks" });
      expect(result.count).toBe(1);

      expect(runActiveOnReadHooksMock).toHaveBeenCalledWith({
        path: path.join("/tmp/pm-search-hooks", "tasks", "pm-hooked.md"),
        scope: "project",
      });
      expect(runActiveOnReadHooksMock).toHaveBeenCalledWith({
        path: path.resolve(process.cwd(), "docs/hook-project.md"),
        scope: "project",
      });
      expect(runActiveOnReadHooksMock).toHaveBeenCalledWith({
        path: path.resolve(globalRoot, "hook-global.md"),
        scope: "global",
      });
    } finally {
      if (previousGlobalPath === undefined) {
        delete process.env.PM_GLOBAL_PATH;
      } else {
        process.env.PM_GLOBAL_PATH = previousGlobalPath;
      }
    }
  });

  it("sorts by score, terminal state, priority, updated_at, then id", async () => {
    const scoreTop = makeFrontMatter({
      id: "pm-score-top",
      title: "hittok hittok",
      priority: 4,
      updated_at: "2026-02-18T00:01:00.000Z",
    });
    const priorityFirst = makeFrontMatter({
      id: "pm-priority",
      title: "hittok",
      priority: 0,
      updated_at: "2026-02-18T00:01:00.000Z",
    });
    const updatedNew = makeFrontMatter({
      id: "pm-updated-new",
      title: "hittok",
      priority: 1,
      updated_at: "2026-02-18T00:06:00.000Z",
    });
    const updatedOld = makeFrontMatter({
      id: "pm-updated-old",
      title: "hittok",
      priority: 1,
      updated_at: "2026-02-18T00:05:00.000Z",
    });
    const idA = makeFrontMatter({
      id: "pm-id-a",
      title: "hittok",
      priority: 1,
      updated_at: "2026-02-18T00:00:00.000Z",
    });
    const idB = makeFrontMatter({
      id: "pm-id-b",
      title: "hittok",
      priority: 1,
      updated_at: "2026-02-18T00:00:00.000Z",
    });
    const terminal = makeFrontMatter({
      id: "pm-terminal",
      title: "hittok",
      status: "closed",
      priority: 0,
      updated_at: "2026-02-18T00:10:00.000Z",
    });
    const noHit = makeFrontMatter({
      id: "pm-no-hit",
      title: "different",
      priority: 1,
      updated_at: "2026-02-18T00:00:00.000Z",
    });

    const allItems = [idB, terminal, priorityFirst, noHit, updatedOld, updatedNew, scoreTop, idA];
    listAllFrontMatterMock.mockResolvedValueOnce(allItems);
    readFileMock.mockImplementation(async (targetPath) => {
      const match = allItems.find((item) => targetPath.endsWith(`${item.id}.md`));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      const body = match.id === "pm-no-hit" ? "no-match-body" : "hittok";
      return serializeDocument(match, body);
    });

    const { runSearch } = await import("../../src/cli/commands/search.js");
    const result = await runSearch("hittok", {}, { path: "/tmp/pm-search" });

    expect(result.items.map((entry) => entry.item.id)).toEqual([
      "pm-score-top",
      "pm-priority",
      "pm-updated-new",
      "pm-updated-old",
      "pm-id-a",
      "pm-id-b",
      "pm-terminal",
    ]);
  });

  it("applies deterministic exact-title token boost in keyword ranking", async () => {
    const exactTokenTitle = makeFrontMatter({
      id: "pm-exact-token",
      title: "token",
      updated_at: "2026-02-18T00:00:00.000Z",
    });
    const substringTitle = makeFrontMatter({
      id: "pm-substring-token",
      title: "tokenized",
      updated_at: "2026-02-18T00:00:00.000Z",
    });

    const allItems = [substringTitle, exactTokenTitle];
    listAllFrontMatterMock.mockResolvedValueOnce(allItems);
    readFileMock.mockImplementation(async (targetPath) => {
      const match = allItems.find((item) => targetPath.endsWith(`${item.id}.md`));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      return serializeDocument(match, "no token in body");
    });

    const { runSearch } = await import("../../src/cli/commands/search.js");
    const result = await runSearch("token", { mode: "keyword" }, { path: "/tmp/pm-search" });

    expect(result.items.map((entry) => entry.item.id)).toEqual(["pm-exact-token", "pm-substring-token"]);
    expect(result.items[0]?.score).toBeGreaterThan(result.items[1]?.score ?? 0);
  });

  it("resolves search tuning parameters from settings", async () => {
    const { resolveSearchTuning } = await import("../../src/cli/commands/search.js");
    const defaultTuning = resolveSearchTuning({});
    expect(defaultTuning.title_weight).toBe(8);

    const customTuning = resolveSearchTuning({
      search: {
        tuning: {
          title_weight: 42,
          body_weight: -1,
          tags_weight: "not-a-num",
        },
      },
    });
    expect(customTuning.title_weight).toBe(42);
    expect(customTuning.body_weight).toBe(1);
    expect(customTuning.tags_weight).toBe(6);
  });

  it("applies multi-factor tuning weights to influence ranking", async () => {
    const titleHit = makeFrontMatter({
      id: "pm-tuning-title",
      title: "tunetoken",
      updated_at: "2026-02-18T00:00:00.000Z",
    });
    const bodyHit = makeFrontMatter({
      id: "pm-tuning-body",
      title: "different",
      updated_at: "2026-02-18T00:00:00.000Z",
    });

    const allItems = [titleHit, bodyHit];
    listAllFrontMatterMock.mockResolvedValue(allItems);
    readFileMock.mockImplementation(async (targetPath) => {
      const match = allItems.find((item) => targetPath.endsWith(`${item.id}.md`));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      return serializeDocument(match, match.id === "pm-tuning-body" ? "tunetoken tunetoken" : "no token here");
    });

    const { runSearch } = await import("../../src/cli/commands/search.js");

    readSettingsMock.mockResolvedValueOnce({ id_prefix: "pm-" });
    const defaultResult = await runSearch("tunetoken", { mode: "keyword" }, { path: "/tmp/pm-search" });
    expect(defaultResult.items[0]?.item.id).toBe("pm-tuning-title");

    readSettingsMock.mockResolvedValueOnce({
      id_prefix: "pm-",
      search: {
        tuning: {
          title_weight: 1,
          title_exact_bonus: 0,
          body_weight: 20,
        },
      },
    } as unknown as { id_prefix: string });
    const tunedResult = await runSearch("tunetoken", { mode: "keyword" }, { path: "/tmp/pm-search" });
    expect(tunedResult.items[0]?.item.id).toBe("pm-tuning-body");
  });
});
