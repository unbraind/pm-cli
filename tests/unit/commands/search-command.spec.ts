import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { ItemFrontMatter } from "../../../src/types.js";
import { EXIT_CODE, SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";
import { serializeItemDocument } from "../../../src/core/item/item-format.js";
import { readJsonFixture } from "../../helpers/fixtures.js";

const {
  pathExistsMock,
  readSettingsMock,
  listAllFrontMatterMock,
  readFileMock,
  realpathMock,
  runActiveOnReadHooksMock,
  spawnSyncMock,
} = vi.hoisted(() => ({
  pathExistsMock: vi.fn<() => Promise<boolean>>(),
  readSettingsMock: vi.fn<() => Promise<{ id_prefix: string }>>(),
  listAllFrontMatterMock: vi.fn<() => Promise<ItemFrontMatter[]>>(),
  readFileMock: vi.fn<(targetPath: string, encoding: string) => Promise<string>>(),
  realpathMock: vi.fn<(targetPath: string) => Promise<string>>(),
  runActiveOnReadHooksMock: vi.fn<() => Promise<string[]>>(),
  spawnSyncMock: vi.fn(),
}));
let activeExtensionRegistrations: Record<string, unknown> | null = null;

function createExtensionRegistrations(): Record<string, unknown> {
  return {
    commands: [],
    flags: [],
    item_fields: [],
    item_types: [],
    migrations: [],
    importers: [],
    exporters: [],
    search_providers: [],
    vector_store_adapters: [],
  };
}

vi.mock("../../../src/core/fs/fs-utils.js", () => ({
  pathExists: pathExistsMock,
}));

vi.mock("../../../src/core/store/settings.js", () => ({
  readSettings: readSettingsMock,
}));

vi.mock("../../../src/core/store/item-store.js", () => ({
  listAllFrontMatter: listAllFrontMatterMock,
}));

vi.mock("../../../src/core/extensions/index.js", () => ({
  runActiveOnReadHooks: runActiveOnReadHooksMock,
  hasActiveOnReadHooks: () => false,
  getActiveExtensionRegistrations: () => activeExtensionRegistrations,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: readFileMock,
    realpath: realpathMock,
  },
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
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
    reminders: overrides.reminders,
    events: overrides.events,
    files: overrides.files,
    tests: overrides.tests,
    docs: overrides.docs,
    close_reason: overrides.close_reason,
    parent: overrides.parent,
    sprint: overrides.sprint,
    release: overrides.release,
  };
}

function serializeDocument(frontMatter: ItemFrontMatter, body: string): string {
  return `${JSON.stringify(frontMatter, null, 2)}\n\n${body}`;
}

function makeDefaultSettings() {
  return structuredClone(SETTINGS_DEFAULTS);
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
    spawnSyncMock.mockReset();
    activeExtensionRegistrations = null;

    pathExistsMock.mockResolvedValue(true);
    readSettingsMock.mockResolvedValue({ id_prefix: "pm-" });
    listAllFrontMatterMock.mockResolvedValue([]);
    realpathMock.mockImplementation(async (targetPath) => targetPath);
    runActiveOnReadHooksMock.mockResolvedValue([]);
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "",
    });
  });

  it("fails when tracker is not initialized", async () => {
    pathExistsMock.mockResolvedValueOnce(false);
    const { runSearch } = await import("../../../src/cli/commands/search.js");
    await expect(runSearch("token", {}, { path: "/tmp/not-init" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.NOT_FOUND,
    });
  });

  it("applies active content and governance-missing filters in the search predicate (kept vs excluded)", async () => {
    // Two items both match the keyword query so both reach the filter predicate.
    // One carries notes + reviewer (governance-present), the other carries neither.
    const withNotes: ItemFrontMatter = {
      ...makeFrontMatter({
        id: "pm-search-filter-rich",
        title: "token rich",
        description: "token rich description",
        tags: ["token"],
        notes: [{ author: "a", created_at: "2026-02-18T00:00:00.000Z", text: "a note" }],
      }),
      // makeFrontMatter does not copy reviewer; attach it explicitly so the
      // serialized document carries governance-present metadata.
      reviewer: "rev",
    };
    const bare = makeFrontMatter({
      id: "pm-search-filter-bare",
      title: "token bare",
      description: "token bare description",
      tags: ["token"],
    });
    listAllFrontMatterMock.mockResolvedValue([withNotes, bare]);
    readFileMock.mockImplementation(async (targetPath: string) => {
      if (targetPath.includes("pm-search-filter-rich")) {
        return serializeDocument(withNotes, "token body");
      }
      return serializeDocument(bare, "token body");
    });

    const { runSearch } = await import("../../../src/cli/commands/search.js");

    // Content filter active: --has-notes keeps the noted item, excludes the bare one.
    const hasNotes = await runSearch("token", { hasNotes: true }, { path: "/tmp/pm-search" });
    expect(hasNotes.items.map((hit) => hit.item.id)).toEqual(["pm-search-filter-rich"]);

    // Governance-missing filter active: --filter-reviewer-missing keeps the bare item,
    // excludes the one carrying a reviewer.
    const reviewerMissing = await runSearch(
      "token",
      { filterReviewerMissing: true },
      { path: "/tmp/pm-search" },
    );
    expect(reviewerMissing.items.map((hit) => hit.item.id)).toEqual(["pm-search-filter-bare"]);
  });

  it("matches exact and short item IDs as first-class search hits", async () => {
    const target = makeFrontMatter({
      id: "pm-fk49",
      title: "Game Engine & Core Architecture",
      description: "No literal id token in content",
    });
    const other = makeFrontMatter({
      id: "pm-other",
      title: "fk49 mentioned elsewhere",
      description: "This item should rank below the exact id match",
    });
    listAllFrontMatterMock.mockResolvedValue([other, target]);
    readFileMock.mockImplementation(async (targetPath: string) => {
      if (targetPath.includes("pm-fk49")) {
        return serializeDocument(target, "body without lookup token");
      }
      return serializeDocument(other, "fk49 body mention");
    });

    const { runSearch } = await import("../../../src/cli/commands/search.js");

    const exact = await runSearch("pm-fk49", {}, { path: "/tmp/pm-search" });
    expect(exact.items[0]?.item.id).toBe("pm-fk49");
    expect(exact.items[0]?.matched_fields).toEqual(["id"]);

    const short = await runSearch("fk49", {}, { path: "/tmp/pm-search" });
    expect(short.items[0]?.item.id).toBe("pm-fk49");
    expect(short.items[0]?.matched_fields).toEqual(["id"]);

    const customIdTarget = makeFrontMatter({
      id: "custom-fk49",
      title: "Custom prefix item",
      description: "No literal id token in content",
    });
    readSettingsMock.mockResolvedValue({ ...makeDefaultSettings(), id_prefix: "custom-" } as never);
    listAllFrontMatterMock.mockResolvedValue([customIdTarget]);
    readFileMock.mockResolvedValue(serializeDocument(customIdTarget, "body without lookup token"));
    const custom = await runSearch("fk49", {}, { path: "/tmp/pm-search" });
    expect(custom.items[0]?.item.id).toBe("custom-fk49");
    expect(custom.items[0]?.matched_fields).toEqual(["id"]);
  });

  it("ranks exact dashed ID matches above items that only mention the ID (GH-295)", async () => {
    const target = makeFrontMatter({
      id: "pm-jxyj",
      title: "Target item",
      description: "No exact id mention in description",
      comments: [{ author: "a", created_at: "2026-02-18T00:00:00.000Z", text: "pm-jxyj self reference" }],
    });
    const descriptionMention = makeFrontMatter({
      id: "pm-mention-description",
      title: "Mention elsewhere",
      description: "pm-jxyj pm-jxyj pm-jxyj",
    });
    const commentMention = makeFrontMatter({
      id: "pm-mention-comment",
      title: "Comment mention",
      comments: [{ author: "a", created_at: "2026-02-18T00:00:00.000Z", text: "pm-jxyj pm-jxyj" }],
    });
    listAllFrontMatterMock.mockResolvedValue([descriptionMention, commentMention, target]);
    readFileMock.mockImplementation(async (targetPath: string) => {
      if (targetPath.includes("pm-jxyj")) return serializeDocument(target, "body without lookup token");
      if (targetPath.includes("pm-mention-description")) return serializeDocument(descriptionMention, "body");
      return serializeDocument(commentMention, "body");
    });

    const { runSearch } = await import("../../../src/cli/commands/search.js");
    const result = await runSearch("pm-jxyj", { mode: "keyword" }, { path: "/tmp/pm-search" });

    expect(result.items[0]?.item.id).toBe("pm-jxyj");
    expect(result.items[0]?.matched_fields).toEqual(["id"]);
    expect(result.items[0]?.score).toBeGreaterThan(result.items[1]?.score ?? 0);
  });

  it("resolves search max-results and score-threshold fallbacks deterministically", async () => {
    const { resolveSearchMaxResults, resolveSearchScoreThreshold, resolveHybridSemanticWeight } = await import(
      "../../../src/cli/commands/search.js"
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

  it("applies per-query semantic-weight override for hybrid mode and warns on invalid override", async () => {
    const { runSearch } = await import("../../../src/cli/commands/search.js");
    const semanticSearchSettings = {
      search: {
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
    } as unknown as { id_prefix: string };

    readSettingsMock.mockResolvedValueOnce(semanticSearchSettings);
    const validOverride = await runSearch(
      "token",
      { mode: "hybrid", semanticWeight: "0.9" },
      { path: "/tmp/pm-search" },
    );
    expect(validOverride.mode).toBe("hybrid");
    expect(validOverride.filters).toMatchObject({ hybrid_semantic_weight: 0.9 });
    expect(validOverride.warnings).toBeUndefined();

    readSettingsMock.mockResolvedValueOnce(semanticSearchSettings);
    const invalidOverride = await runSearch(
      "token",
      { mode: "hybrid", semanticWeight: "not-a-number" },
      { path: "/tmp/pm-search" },
    );
    expect(invalidOverride.mode).toBe("hybrid");
    expect(invalidOverride.filters).toMatchObject({ hybrid_semantic_weight: 0.2 });
    expect(invalidOverride.warnings).toContain(
      "search_hybrid_semantic_weight_override_invalid:using_settings_default",
    );
  });

  it("validates query, mode, and filter inputs", async () => {
    const { runSearch } = await import("../../../src/cli/commands/search.js");

    await expect(runSearch("   ", {}, { path: "/tmp/pm-search" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    const keywordDefaultNoSemantic = await runSearch("token", {}, { path: "/tmp/pm-search" });
    expect(keywordDefaultNoSemantic.mode).toBe("keyword");
    expect(keywordDefaultNoSemantic.count).toBe(0);
    // Explicit semantic/hybrid with no embedding provider degrades to keyword
    // search (never blocks the agent) and reports a fallback warning.
    const semanticUnconfigured = await runSearch("token", { mode: "semantic" }, { path: "/tmp/pm-search" });
    expect(semanticUnconfigured.mode).toBe("keyword");
    expect(semanticUnconfigured.warnings).toContain("search_semantic_fallback:error:using_keyword_mode");
    const hybridUnconfigured = await runSearch("token", { mode: "hybrid" }, { path: "/tmp/pm-search" });
    expect(hybridUnconfigured.mode).toBe("keyword");
    expect(hybridUnconfigured.warnings).toContain("search_hybrid_fallback:error:using_keyword_mode");
    readSettingsMock.mockResolvedValueOnce({
      providers: {
        openai: {
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          api_key: "",
        },
      },
    } as unknown as { id_prefix: string });
    // Provider present but no vector store also degrades instead of failing.
    const semanticNoVector = await runSearch("token", { mode: "semantic" }, { path: "/tmp/pm-search" });
    expect(semanticNoVector.mode).toBe("keyword");
    expect(semanticNoVector.warnings).toContain("search_semantic_fallback:error:using_keyword_mode");
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
    const defaultKeywordNoItems = await runSearch("token", {}, { path: "/tmp/pm-search" });
    expect(defaultKeywordNoItems.mode).toBe("keyword");
    expect(defaultKeywordNoItems.count).toBe(0);
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
    readSettingsMock.mockResolvedValueOnce(openAiSemanticSettings);
    const flexibleDateFilter = await runSearch(
      "token",
      { mode: "keyword", deadlineBefore: "2026-02-21T00-00Z" },
      { path: "/tmp/pm-search" },
    );
    expect(flexibleDateFilter.count).toBe(0);
    expect(flexibleDateFilter.filters).toMatchObject({
      deadline_before: "2026-02-21T00-00Z",
    });
    readSettingsMock.mockResolvedValueOnce(openAiSemanticSettings);
    const monthRelativeFilter = await runSearch(
      "token",
      { mode: "keyword", deadlineBefore: "+1m" },
      { path: "/tmp/pm-search" },
    );
    expect(monthRelativeFilter.count).toBe(0);
    expect(typeof monthRelativeFilter.filters.deadline_before).toBe("string");
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

  it("keeps the SDK default keyword-first even when Ollama auto-defaults are available", async () => {
    readSettingsMock.mockResolvedValue(makeDefaultSettings() as unknown as { id_prefix: string });
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return {
          status: 0,
          stdout: "ollama version is 0.0.0",
          stderr: "",
        };
      }
      if (args[0] === "list") {
        return {
          status: 0,
          stdout: "NAME ID SIZE MODIFIED\nqwen3-embedding:0.6b abc 380 MB now\n",
          stderr: "",
        };
      }
      return {
        status: 1,
        stdout: "",
        stderr: "",
      };
    });

    const { runSearch } = await import("../../../src/cli/commands/search.js");
    const result = await runSearch("token", {}, { path: "/tmp/pm-search" });
    expect(result.mode).toBe("keyword");
    expect(result.count).toBe(0);
  });

  it("does not invoke implicit Ollama semantic execution for default search", async () => {
    readSettingsMock.mockResolvedValue(makeDefaultSettings() as unknown as { id_prefix: string });
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return {
          status: 0,
          stdout: "ollama version is 0.0.0",
          stderr: "",
        };
      }
      if (args[0] === "list") {
        return {
          status: 0,
          stdout: "NAME ID SIZE MODIFIED\nqwen3-embedding:0.6b abc 380 MB now\n",
          stderr: "",
        };
      }
      return {
        status: 1,
        stdout: "",
        stderr: "",
      };
    });
    const autoItem = makeFrontMatter({
      id: "pm-ollama-auto-fallback",
      title: "token title",
      description: "token description",
      tags: ["token"],
    });
    listAllFrontMatterMock.mockResolvedValue([autoItem]);
    readFileMock.mockResolvedValue(serializeDocument(autoItem, "token body"));

    const fetchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const implicitResult = await runSearch("token", {}, { path: "/tmp/pm-search" });
      expect(implicitResult.mode).toBe("keyword");
      expect(implicitResult.count).toBe(1);
      expect(implicitResult.items[0].item.id).toBe("pm-ollama-auto-fallback");
      expect(implicitResult.warnings).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      // Explicit hybrid with an unreachable embedding backend degrades to keyword.
      const hybridFallback = await runSearch("token", { mode: "hybrid" }, { path: "/tmp/pm-search" });
      expect(hybridFallback.mode).toBe("keyword");
      expect(hybridFallback.count).toBe(1);
      expect(hybridFallback.warnings?.some((warning) => warning.startsWith("search_hybrid_fallback:"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps default search keyword-first when auto semantic execution would time out", async () => {
    readSettingsMock.mockResolvedValue(makeDefaultSettings() as unknown as { id_prefix: string });
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return {
          status: 0,
          stdout: "ollama version is 0.0.0",
          stderr: "",
        };
      }
      if (args[0] === "list") {
        return {
          status: 0,
          stdout: "NAME ID SIZE MODIFIED\nqwen3-embedding:0.6b abc 380 MB now\n",
          stderr: "",
        };
      }
      return {
        status: 1,
        stdout: "",
        stderr: "",
      };
    });
    const autoItem = makeFrontMatter({
      id: "pm-ollama-timeout-fallback",
      title: "token timeout",
      description: "token timeout description",
      tags: ["token"],
    });
    listAllFrontMatterMock.mockResolvedValue([autoItem]);
    readFileMock.mockResolvedValue(serializeDocument(autoItem, "token body"));

    const fetchMock = vi.fn(async () => {
      throw new Error("Embedding request timed out after 8000ms");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const implicitResult = await runSearch("token", {}, { path: "/tmp/pm-search" });
      expect(implicitResult.mode).toBe("keyword");
      expect(implicitResult.count).toBe(1);
      expect(implicitResult.warnings).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps default search keyword-first for configured semantic providers", async () => {
    const configuredItem = makeFrontMatter({
      id: "pm-configured-timeout-fallback",
      title: "token configured timeout",
      description: "token timeout description",
      tags: ["token"],
    });
    readSettingsMock.mockResolvedValue({
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
    listAllFrontMatterMock.mockResolvedValue([configuredItem]);
    readFileMock.mockResolvedValue(serializeDocument(configuredItem, "token body"));

    const fetchMock = vi.fn(async () => {
      throw new Error("Embedding request timed out after 8000ms");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const implicitResult = await runSearch("token", {}, { path: "/tmp/pm-search" });
      expect(implicitResult.mode).toBe("keyword");
      expect(implicitResult.count).toBe(1);
      expect(implicitResult.warnings).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      // Explicit hybrid with a timing-out embedding backend degrades to keyword.
      const hybridFallback = await runSearch("token", { mode: "hybrid" }, { path: "/tmp/pm-search" });
      expect(hybridFallback.mode).toBe("keyword");
      expect(hybridFallback.count).toBe(1);
      expect(hybridFallback.warnings?.some((warning) => warning.startsWith("search_hybrid_fallback:"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
      const { runSearch } = await import("../../../src/cli/commands/search.js");
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

  it("executes a configured extension search provider for semantic mode", async () => {
    const extensionItem = makeFrontMatter({
      id: "pm-ext-provider",
      title: "extension provider item",
    });
    listAllFrontMatterMock.mockResolvedValue([extensionItem]);
    readFileMock.mockResolvedValue(serializeDocument(extensionItem, "extension body"));
    readSettingsMock.mockResolvedValue({
      search: {
        provider: "ext-provider",
      },
    } as unknown as { id_prefix: string });
    activeExtensionRegistrations = createExtensionRegistrations();
    (activeExtensionRegistrations.search_providers as Array<Record<string, unknown>>).push({
      layer: "project",
      name: "provider-ext",
      definition: {
        name: "ext-provider",
        query: () => [{ id: "pm-ext-provider", score: 0.91 }],
      },
      runtime_definition: {
        name: "ext-provider",
        query: () => [{ id: "pm-ext-provider", score: 0.91 }],
      },
    });

    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should not be called when extension provider handles semantic search");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("extension", { mode: "semantic" }, { path: "/tmp/pm-search" });
      expect(result.mode).toBe("semantic");
      expect(result.count).toBe(1);
      expect(result.items[0].item.id).toBe("pm-ext-provider");
      expect(result.items[0].matched_fields).toEqual(["provider:ext-provider"]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("degrades to keyword when an extension provider throws and built-in fallback is unavailable", async () => {
    const extensionItem = makeFrontMatter({
      id: "pm-ext-provider-error",
      title: "extension provider item",
    });
    listAllFrontMatterMock.mockResolvedValue([extensionItem]);
    readFileMock.mockResolvedValue(serializeDocument(extensionItem, "extension body"));
    readSettingsMock.mockResolvedValue({
      search: {
        provider: "ext-provider",
      },
    } as unknown as { id_prefix: string });
    activeExtensionRegistrations = createExtensionRegistrations();
    (activeExtensionRegistrations.search_providers as Array<Record<string, unknown>>).push({
      layer: "project",
      name: "provider-ext",
      definition: {
        name: "ext-provider",
      },
      runtime_definition: {
        name: "ext-provider",
        query: () => {
          throw new Error("provider failed");
        },
      },
    });

    const { runSearch } = await import("../../../src/cli/commands/search.js");
    const result = await runSearch("extension", { mode: "semantic" }, { path: "/tmp/pm-search" });
    expect(result.mode).toBe("keyword");
    expect(result.count).toBe(1);
    expect(result.warnings?.some((warning) => warning.startsWith("search_semantic_fallback:"))).toBe(true);
  });

  it("supports extension vector adapter queries for semantic mode", async () => {
    const semanticItem = makeFrontMatter({
      id: "pm-vector-adapter",
      title: "vector extension",
    });
    listAllFrontMatterMock.mockResolvedValue([semanticItem]);
    readFileMock.mockResolvedValue(serializeDocument(semanticItem, "semantic body"));
    readSettingsMock.mockResolvedValue({
      providers: {
        openai: {
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          api_key: "",
        },
      },
      vector_store: {
        adapter: "ext-vector",
      },
    } as unknown as { id_prefix: string });
    activeExtensionRegistrations = createExtensionRegistrations();
    (activeExtensionRegistrations.vector_store_adapters as Array<Record<string, unknown>>).push({
      layer: "project",
      name: "vector-ext",
      definition: {
        name: "ext-vector",
      },
      runtime_definition: {
        name: "ext-vector",
        query: () => [{ id: "pm-vector-adapter", score: 0.87 }],
      },
    });

    const fetchMock = vi.fn(async (url: unknown) => {
      if (!String(url).includes("/v1/embeddings")) {
        throw new Error(`Unexpected fetch target: ${String(url)}`);
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: [{ index: 0, embedding: [0.1, 0.2] }],
        }),
        text: async () => "",
      } as unknown as Response;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("vector", { mode: "semantic" }, { path: "/tmp/pm-search" });
      expect(result.mode).toBe("semantic");
      expect(result.count).toBe(1);
      expect(result.items[0].item.id).toBe("pm-vector-adapter");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("warns that semantic results are effectively lexical when vector matching contributes no hits", async () => {
    const semanticItem = makeFrontMatter({
      id: "pm-empty-corpus",
      title: "vector extension",
    });
    listAllFrontMatterMock.mockResolvedValue([semanticItem]);
    readFileMock.mockResolvedValue(serializeDocument(semanticItem, "semantic body"));
    readSettingsMock.mockResolvedValue({
      providers: {
        openai: {
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          api_key: "",
        },
      },
      vector_store: {
        adapter: "ext-vector",
      },
    } as unknown as { id_prefix: string });
    activeExtensionRegistrations = createExtensionRegistrations();
    (activeExtensionRegistrations.vector_store_adapters as Array<Record<string, unknown>>).push({
      layer: "project",
      name: "vector-ext",
      definition: { name: "ext-vector" },
      runtime_definition: {
        name: "ext-vector",
        // Empty vector matches: the query runs successfully but vector ranking
        // contributes nothing for this query/filter set.
        query: () => [],
      },
    });

    const fetchMock = vi.fn(async (url: unknown) => {
      if (!String(url).includes("/v1/embeddings")) {
        throw new Error(`Unexpected fetch target: ${String(url)}`);
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: [{ index: 0, embedding: [0.1, 0.2] }],
        }),
        text: async () => "",
      } as unknown as Response;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      // Semantic: ran without error, but no vector matches => mode stays semantic,
      // a degraded warning flags the lexical fallback, and the (now genuinely
      // lexical) keyword hits are returned so the agent still gets results.
      const semanticResult = await runSearch("vector", { mode: "semantic" }, { path: "/tmp/pm-search" });
      expect(semanticResult.mode).toBe("semantic");
      expect(semanticResult.warnings).toContain("search_semantic_degraded:no_vector_matches:results_are_lexical");
      expect(semanticResult.count).toBe(1);
      expect(semanticResult.items[0].item.id).toBe("pm-empty-corpus");

      // Hybrid still surfaces keyword hits but flags the degraded semantic stage.
      const hybridResult = await runSearch("vector", { mode: "hybrid" }, { path: "/tmp/pm-search" });
      expect(hybridResult.mode).toBe("hybrid");
      expect(hybridResult.warnings).toContain("search_hybrid_degraded:no_vector_matches:results_are_lexical");
      expect(hybridResult.count).toBe(1);
      expect(hybridResult.items[0].item.id).toBe("pm-empty-corpus");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not warn about degraded vector matching when semantic matches exist", async () => {
    const semanticItem = makeFrontMatter({
      id: "pm-corpus-present",
      title: "vector extension",
    });
    listAllFrontMatterMock.mockResolvedValue([semanticItem]);
    readFileMock.mockResolvedValue(serializeDocument(semanticItem, "semantic body"));
    readSettingsMock.mockResolvedValue({
      providers: {
        openai: {
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          api_key: "",
        },
      },
      vector_store: {
        adapter: "ext-vector",
      },
    } as unknown as { id_prefix: string });
    activeExtensionRegistrations = createExtensionRegistrations();
    (activeExtensionRegistrations.vector_store_adapters as Array<Record<string, unknown>>).push({
      layer: "project",
      name: "vector-ext",
      definition: { name: "ext-vector" },
      runtime_definition: {
        name: "ext-vector",
        query: () => [{ id: "pm-corpus-present", score: 0.87 }],
      },
    });

    const fetchMock = vi.fn(async (url: unknown) => {
      if (!String(url).includes("/v1/embeddings")) {
        throw new Error(`Unexpected fetch target: ${String(url)}`);
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2] }] }),
        text: async () => "",
      } as unknown as Response;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("vector", { mode: "semantic" }, { path: "/tmp/pm-search" });
      expect(result.mode).toBe("semantic");
      expect(result.count).toBe(1);
      expect(result.warnings ?? []).not.toContain("search_semantic_degraded:no_vector_matches:results_are_lexical");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("degrades to keyword when extension vector adapter query fails without built-in fallback", async () => {
    const semanticItem = makeFrontMatter({
      id: "pm-vector-adapter-fail",
      title: "vector extension fail",
    });
    listAllFrontMatterMock.mockResolvedValue([semanticItem]);
    readFileMock.mockResolvedValue(serializeDocument(semanticItem, "semantic body"));
    readSettingsMock.mockResolvedValue({
      providers: {
        openai: {
          base_url: "https://api.example.test/v1",
          model: "text-embedding-3-small",
          api_key: "",
        },
      },
      vector_store: {
        adapter: "ext-vector",
      },
    } as unknown as { id_prefix: string });
    activeExtensionRegistrations = createExtensionRegistrations();
    (activeExtensionRegistrations.vector_store_adapters as Array<Record<string, unknown>>).push({
      layer: "project",
      name: "vector-ext",
      definition: { name: "ext-vector" },
      runtime_definition: {
        name: "ext-vector",
        query: () => {
          throw new Error("vector adapter failed");
        },
      },
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        data: [{ index: 0, embedding: [0.1, 0.2] }],
      }),
      text: async () => "",
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("vector", { mode: "semantic" }, { path: "/tmp/pm-search" });
      expect(result.mode).toBe("keyword");
      expect(result.count).toBe(1);
      expect(result.warnings?.some((warning) => warning.startsWith("search_semantic_fallback:"))).toBe(true);
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

    const { runSearch } = await import("../../../src/cli/commands/search.js");
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

    const calendarHeavy = makeFrontMatter({
      id: "pm-calendar",
      title: "calendar workflow",
      reminders: [{ at: "2026-02-18T09:00:00.000Z", text: "agent reminder token" }],
      events: [
        {
          start_at: "2026-02-18T10:00:00.000Z",
          end_at: "2026-02-18T11:00:00.000Z",
          title: "roadmap sync token",
          description: "calendar event description token",
          location: "room-token",
          all_day: true,
        },
        {
          start_at: "2026-02-18T12:00:00.000Z",
          title: "regular event token",
          all_day: false,
        },
      ],
    });
    listAllFrontMatterMock.mockResolvedValueOnce([calendarHeavy]);
    readFileMock.mockResolvedValueOnce(serializeDocument(calendarHeavy, ""));
    readFileMock.mockResolvedValueOnce(serializeDocument(calendarHeavy, ""));
    const calendarSearch = await runSearch("roadmap reminder room-token all day", { mode: "keyword" }, { path: "/tmp/pm-search" });
    expect(calendarSearch.count).toBe(1);
    expect(calendarSearch.items[0].item.id).toBe("pm-calendar");
    expect(calendarSearch.items[0].matched_fields).toEqual(["events", "reminders"]);

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

  it("keeps keyword search readable for malformed legacy array fields", async () => {
    const malformed = {
      ...makeFrontMatter({
        id: "pm-legacy-malformed",
        title: "legacy malformed item",
        description: "contains stabletoken",
      }),
      tags: undefined,
      status: undefined,
      comments: undefined,
      notes: undefined,
      learnings: undefined,
      dependencies: undefined,
    } as unknown as ItemFrontMatter;

    listAllFrontMatterMock.mockResolvedValueOnce([malformed]);
    readFileMock.mockResolvedValueOnce(serializeDocument(malformed, ""));

    const { runSearch } = await import("../../../src/cli/commands/search.js");
    const result = await runSearch("stabletoken", { mode: "keyword" }, { path: "/tmp/pm-search" });

    expect(result.count).toBe(1);
    expect(result.items[0].item.id).toBe("pm-legacy-malformed");
    expect(result.items[0].matched_fields).toEqual(["description"]);
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
      const { runSearch } = await import("../../../src/cli/commands/search.js");

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

  it("expands semantic queries when search.query_expansion is enabled", async () => {
    const docA = makeFrontMatter({
      id: "pm-qe-a",
      title: "project alpha",
      updated_at: "2026-02-18T00:01:00.000Z",
    });
    const docB = makeFrontMatter({
      id: "pm-qe-b",
      title: "project beta",
      updated_at: "2026-02-18T00:02:00.000Z",
    });
    const docs = [docA, docB];
    listAllFrontMatterMock.mockResolvedValue(docs);
    readFileMock.mockImplementation(async (targetPath) => {
      const match = docs.find((item) => targetPath.endsWith(`${item.id}.md`));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      return serializeDocument(match, "query expansion body");
    });
    readSettingsMock.mockResolvedValue({
      search: {
        max_results: 5,
        query_expansion: {
          enabled: true,
          provider: "openai",
        },
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
    let queryCallCount = 0;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const target = resolveFetchTarget(url);
      if (target.endsWith("/v1/embeddings")) {
        const body = parseJsonBody<{ input?: string | string[] }>(init?.body);
        const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            data: inputs.map((_entry, index) => ({ index, embedding: [index + 1, 0.1] })),
          }),
          text: async () => "",
        } as unknown as Response;
      }
      if (target.endsWith("/collections/pm_items/points/search")) {
        queryCallCount += 1;
        const callIndex = queryCallCount;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            result: callIndex === 1
              ? [{ id: "pm-qe-a", score: 0.5 }]
              : callIndex === 2
                ? [{ id: "pm-qe-b", score: 0.9 }]
                : [],
          }),
          text: async () => "",
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch target: ${target}`);
    }) as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("project status", { mode: "semantic" }, { path: "/tmp/pm-search" });
      expect(result.mode).toBe("semantic");
      expect(result.items.map((entry) => entry.item.id)).toEqual(["pm-qe-b", "pm-qe-a"]);
      expect(result.filters).toMatchObject({
        query_expansion_enabled: true,
        query_expansion_provider: "openai",
      });
      expect(queryCallCount).toBeGreaterThan(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("warns when configured query-expansion provider is unavailable", async () => {
    const doc = makeFrontMatter({
      id: "pm-qe-fallback",
      title: "release notes",
      updated_at: "2026-02-18T00:01:00.000Z",
    });
    listAllFrontMatterMock.mockResolvedValue([doc]);
    readFileMock.mockResolvedValue(serializeDocument(doc, "fallback body"));
    readSettingsMock.mockResolvedValue({
      search: {
        query_expansion: {
          enabled: true,
          provider: "ext-missing-provider",
        },
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
        const body = parseJsonBody<{ input?: string | string[] }>(init?.body);
        const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            data: inputs.map((_entry, index) => ({ index, embedding: [0.7 + index, 0.2] })),
          }),
          text: async () => "",
        } as unknown as Response;
      }
      if (target.endsWith("/collections/pm_items/points/search")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ result: [{ id: "pm-qe-fallback", score: 0.8 }] }),
          text: async () => "",
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch target: ${target}`);
    }) as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("release", { mode: "semantic" }, { path: "/tmp/pm-search" });
      expect(result.mode).toBe("semantic");
      expect(result.warnings).toContain("search_query_expansion_provider_unavailable:ext-missing-provider:using_builtin");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reranks hybrid candidates when search.rerank is enabled", async () => {
    const docA = makeFrontMatter({
      id: "pm-rerank-a",
      title: "tok alpha",
      updated_at: "2026-02-18T00:01:00.000Z",
    });
    const docB = makeFrontMatter({
      id: "pm-rerank-b",
      title: "tok beta",
      updated_at: "2026-02-18T00:02:00.000Z",
    });
    const docs = [docA, docB];
    listAllFrontMatterMock.mockResolvedValue(docs);
    readFileMock.mockImplementation(async (targetPath) => {
      const match = docs.find((item) => targetPath.endsWith(`${item.id}.md`));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      return serializeDocument(match, "rerank body");
    });
    readSettingsMock.mockResolvedValue({
      search: {
        max_results: 5,
        rerank: {
          enabled: true,
          model: "rerank-model-v1",
          top_k: 2,
        },
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
    let embeddingCallCount = 0;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const target = resolveFetchTarget(url);
      if (target.endsWith("/v1/embeddings")) {
        embeddingCallCount += 1;
        if (embeddingCallCount === 1) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ data: [{ embedding: [1, 0] }] }),
            text: async () => "",
          } as unknown as Response;
        }
        const body = parseJsonBody<{ model?: string; input?: string | string[] }>(init?.body);
        const rerankInputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
        expect(body.model).toBe("rerank-model-v1");
        expect(rerankInputs).toHaveLength(3);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            data: [
              { index: 0, embedding: [1, 0] },
              { index: 1, embedding: [0, 1] },
              { index: 2, embedding: [1, 0] },
            ],
          }),
          text: async () => "",
        } as unknown as Response;
      }
      if (target.endsWith("/collections/pm_items/points/search")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            result: [
              { id: "pm-rerank-a", score: 0.95 },
              { id: "pm-rerank-b", score: 0.9 },
            ],
          }),
          text: async () => "",
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch target: ${target}`);
    }) as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("tok", { mode: "hybrid" }, { path: "/tmp/pm-search" });
      expect(result.mode).toBe("hybrid");
      expect(result.items[0]?.item.id).toBe("pm-rerank-b");
      expect(result.items[0]?.matched_fields).toContain("rerank");
      expect(result.filters).toMatchObject({
        rerank_enabled: true,
        rerank_model: "rerank-model-v1",
        rerank_top_k: 2,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps reranked candidates ahead of non-reranked candidates", async () => {
    const docA = makeFrontMatter({
      id: "pm-rerank-priority-a",
      title: "tok alpha",
      updated_at: "2026-02-18T00:01:00.000Z",
    });
    const docB = makeFrontMatter({
      id: "pm-rerank-priority-b",
      title: "tok beta",
      updated_at: "2026-02-18T00:02:00.000Z",
    });
    const docs = [docA, docB];
    listAllFrontMatterMock.mockResolvedValue(docs);
    readFileMock.mockImplementation(async (targetPath) => {
      const match = docs.find((item) => targetPath.endsWith(`${item.id}.md`));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      return serializeDocument(match, "rerank priority body");
    });
    readSettingsMock.mockResolvedValue({
      search: {
        max_results: 5,
        rerank: {
          enabled: true,
          model: "rerank-model-v1",
          top_k: 1,
        },
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
    let embeddingCallCount = 0;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const target = resolveFetchTarget(url);
      if (target.endsWith("/v1/embeddings")) {
        embeddingCallCount += 1;
        if (embeddingCallCount === 1) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ data: [{ embedding: [1, 0] }] }),
            text: async () => "",
          } as unknown as Response;
        }
        const body = parseJsonBody<{ input?: string | string[] }>(init?.body);
        const rerankInputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
        expect(rerankInputs).toHaveLength(2);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            data: [
              { index: 0, embedding: [1, 0] },
              { index: 1, embedding: [0, 1] },
            ],
          }),
          text: async () => "",
        } as unknown as Response;
      }
      if (target.endsWith("/collections/pm_items/points/search")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            result: [
              { id: "pm-rerank-priority-a", score: 0.95 },
              { id: "pm-rerank-priority-b", score: 0.9 },
            ],
          }),
          text: async () => "",
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch target: ${target}`);
    }) as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("tok", { mode: "hybrid" }, { path: "/tmp/pm-search" });
      expect(result.mode).toBe("hybrid");
      expect(result.items.map((entry) => entry.item.id)).toEqual([
        "pm-rerank-priority-a",
        "pm-rerank-priority-b",
      ]);
      expect(result.items[0]?.matched_fields).toContain("rerank");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to hybrid scores when rerank embeddings fail", async () => {
    const docA = makeFrontMatter({
      id: "pm-rerank-fail-a",
      title: "tok alpha",
      updated_at: "2026-02-18T00:01:00.000Z",
    });
    const docB = makeFrontMatter({
      id: "pm-rerank-fail-b",
      title: "tok beta",
      updated_at: "2026-02-18T00:02:00.000Z",
    });
    const docs = [docA, docB];
    listAllFrontMatterMock.mockResolvedValue(docs);
    readFileMock.mockImplementation(async (targetPath) => {
      const match = docs.find((item) => targetPath.endsWith(`${item.id}.md`));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      return serializeDocument(match, "rerank fallback body");
    });
    readSettingsMock.mockResolvedValue({
      search: {
        rerank: {
          enabled: true,
          model: "rerank-model-v1",
          top_k: 2,
        },
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
    let embeddingCallCount = 0;
    globalThis.fetch = (async (url: unknown) => {
      const target = resolveFetchTarget(url);
      if (target.endsWith("/v1/embeddings")) {
        embeddingCallCount += 1;
        if (embeddingCallCount === 1) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ data: [{ embedding: [1, 0] }] }),
            text: async () => "",
          } as unknown as Response;
        }
        throw new Error("rerank provider unavailable");
      }
      if (target.endsWith("/collections/pm_items/points/search")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            result: [
              { id: "pm-rerank-fail-a", score: 0.9 },
              { id: "pm-rerank-fail-b", score: 0.8 },
            ],
          }),
          text: async () => "",
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch target: ${target}`);
    }) as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("tok", { mode: "hybrid" }, { path: "/tmp/pm-search" });
      expect(result.mode).toBe("hybrid");
      expect(result.warnings).toContain("search_rerank_failed:using_hybrid_scores");
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
      const { runSearch } = await import("../../../src/cli/commands/search.js");
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
      const { runSearch } = await import("../../../src/cli/commands/search.js");

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

      const { runSearch } = await import("../../../src/cli/commands/search.js");

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

      const { runSearch } = await import("../../../src/cli/commands/search.js");
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

      const { runSearch } = await import("../../../src/cli/commands/search.js");
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

      const { runSearch } = await import("../../../src/cli/commands/search.js");
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

      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("hooktoken", { includeLinked: true }, { path: "/tmp/pm-search-hooks" });
      expect(result.count).toBe(1);

      expect(runActiveOnReadHooksMock).toHaveBeenCalledWith({
        path: path.resolve("/tmp/pm-search-hooks", "tasks", "pm-hooked.md"),
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

    const { runSearch } = await import("../../../src/cli/commands/search.js");
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

    const { runSearch } = await import("../../../src/cli/commands/search.js");
    const result = await runSearch("token", { mode: "keyword" }, { path: "/tmp/pm-search" });

    expect(result.items.map((entry) => entry.item.id)).toEqual(["pm-exact-token", "pm-substring-token"]);
    expect(result.items[0]?.score).toBeGreaterThan(result.items[1]?.score ?? 0);
  });

  it("supports --title-exact filtering for query/title parity", async () => {
    const exactTitle = makeFrontMatter({
      id: "pm-title-exact",
      title: "Cross-Epic Realism Dependency Council",
      updated_at: "2026-02-18T00:00:00.000Z",
    });
    const nearMatch = makeFrontMatter({
      id: "pm-title-near",
      title: "Cross-Epic Realism Governance Council",
      updated_at: "2026-02-18T00:00:00.000Z",
    });

    const allItems = [nearMatch, exactTitle];
    listAllFrontMatterMock.mockResolvedValueOnce(allItems);
    readFileMock.mockImplementation(async (targetPath) => {
      const match = allItems.find((item) => targetPath.endsWith(`${item.id}.md`));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      return serializeDocument(match, "cross-epic realism dependency council");
    });

    const { runSearch } = await import("../../../src/cli/commands/search.js");
    const result = await runSearch(
      "Cross-Epic Realism Dependency Council",
      { mode: "keyword", titleExact: true },
      { path: "/tmp/pm-search" },
    );

    expect(result.filters).toMatchObject({ title_exact: true });
    expect(result.items.map((entry) => entry.item.id)).toEqual(["pm-title-exact"]);
  });

  it("supports --phrase-exact filtering for normalized phrase matches", async () => {
    const phraseInBody = makeFrontMatter({
      id: "pm-phrase-body",
      title: "Scheduling note",
      description: "Contains full phrase in body only",
    });
    const tokenOnly = makeFrontMatter({
      id: "pm-token-only",
      title: "Cross-Epic Council",
      description: "Contains related tokens but no exact phrase",
    });

    const allItems = [tokenOnly, phraseInBody];
    listAllFrontMatterMock.mockResolvedValueOnce(allItems);
    readFileMock.mockImplementation(async (targetPath) => {
      const match = allItems.find((item) => targetPath.endsWith(`${item.id}.md`));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      if (match.id === "pm-phrase-body") {
        return serializeDocument(match, "Planning uses the Cross-Epic Realism Dependency Council cadence.");
      }
      return serializeDocument(
        match,
        "cross-epic realism dependency details exist but council keyword is detached and phrase is broken",
      );
    });

    const { runSearch } = await import("../../../src/cli/commands/search.js");
    const result = await runSearch(
      "Cross-Epic Realism Dependency Council",
      { mode: "keyword", phraseExact: true },
      { path: "/tmp/pm-search" },
    );

    expect(result.filters).toMatchObject({ phrase_exact: true });
    expect(result.items.map((entry) => entry.item.id)).toEqual(["pm-phrase-body"]);
  });

  it("boosts exact long-phrase title matches above partial lexical overlap noise", async () => {
    const exactTitle = makeFrontMatter({
      id: "pm-long-phrase-exact-title",
      title: "Cross-Epic Realism Dependency Council",
      updated_at: "2026-02-18T00:00:00.000Z",
    });
    const noisyPartial = makeFrontMatter({
      id: "pm-long-phrase-noise",
      title: "Operational cadence sync",
      description: [
        Array.from({ length: 9 }, () => "cross-epic").join(" "),
        Array.from({ length: 9 }, () => "realism").join(" "),
        Array.from({ length: 9 }, () => "dependency").join(" "),
        Array.from({ length: 9 }, () => "council").join(" "),
      ].join(" "),
      updated_at: "2026-02-18T00:00:00.000Z",
    });

    const allItems = [noisyPartial, exactTitle];
    listAllFrontMatterMock.mockResolvedValueOnce(allItems);
    readFileMock.mockImplementation(async (targetPath) => {
      const match = allItems.find((item) => targetPath.endsWith(`${item.id}.md`));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      return serializeDocument(match, "no exact phrase in body");
    });

    const { runSearch } = await import("../../../src/cli/commands/search.js");
    const result = await runSearch(
      "Cross-Epic Realism Dependency Council",
      { mode: "keyword" },
      { path: "/tmp/pm-search" },
    );

    expect(result.items[0]?.item.id).toBe("pm-long-phrase-exact-title");
    expect(result.items[0]?.score).toBeGreaterThan(result.items[1]?.score ?? 0);
  });

  it("resolves search tuning parameters from settings", async () => {
    const { resolveSearchTuning } = await import("../../../src/cli/commands/search.js");
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

    const { runSearch } = await import("../../../src/cli/commands/search.js");

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

  it("falls back to alternate item format path when preferred file is missing", async () => {
    const fallbackItem = makeFrontMatter({
      id: "pm-fallback-format",
      title: "Fallback format title",
      description: "Preferred TOON file missing",
    });
    listAllFrontMatterMock.mockResolvedValue([fallbackItem]);
    readSettingsMock.mockResolvedValue({
      id_prefix: "pm-",
      item_format: "toon",
    } as unknown as { id_prefix: string });
    readFileMock.mockImplementation(async (targetPath) => {
      if (targetPath.endsWith(".toon")) {
        throw new Error("ENOENT preferred format");
      }
      if (targetPath.endsWith(".md")) {
        return serializeDocument(fallbackItem, "fallback body");
      }
      throw new Error(`Unexpected path: ${targetPath}`);
    });

    const { runSearch } = await import("../../../src/cli/commands/search.js");
    const result = await runSearch("fallback", { mode: "keyword" }, { path: "/tmp/pm-search" });
    expect(result.items[0]?.item.id).toBe("pm-fallback-format");
    expect(runActiveOnReadHooksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.stringMatching(/pm-fallback-format\.md$/),
      }),
    );
  });

  it("falls back from json_markdown preference to TOON item file when markdown path is missing", async () => {
    const fallbackItem = makeFrontMatter({
      id: "pm-fallback-toon",
      title: "Fallback toon title",
      description: "Preferred markdown file missing",
    });
    listAllFrontMatterMock.mockResolvedValue([fallbackItem]);
    readSettingsMock.mockResolvedValue({
      id_prefix: "pm-",
      item_format: "json_markdown",
    } as unknown as { id_prefix: string });
    readFileMock.mockImplementation(async (targetPath) => {
      if (targetPath.endsWith(".md")) {
        throw new Error("ENOENT preferred markdown");
      }
      if (targetPath.endsWith(".toon")) {
        return serializeItemDocument(
          {
            metadata: fallbackItem,
            body: "fallback toon body",
          },
          { format: "toon" },
        );
      }
      throw new Error(`Unexpected path: ${targetPath}`);
    });

    const { runSearch } = await import("../../../src/cli/commands/search.js");
    const result = await runSearch("fallback", { mode: "keyword" }, { path: "/tmp/pm-search" });
    expect(result.items[0]?.item.id).toBe("pm-fallback-toon");
    expect(runActiveOnReadHooksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.stringMatching(/pm-fallback-toon\.toon$/),
      }),
    );
  });

  it("supports compact/full/fields projections and validates projection flags", async () => {
    const projectedItem = makeFrontMatter({
      id: "pm-projection",
      title: "Projection title token",
      status: "in_progress",
      priority: 2,
      type: "Task",
      updated_at: "2026-02-18T00:03:00.000Z",
    });
    listAllFrontMatterMock.mockResolvedValue([projectedItem]);
    readFileMock.mockResolvedValue(serializeDocument(projectedItem, "projection token body"));

    const { runSearch } = await import("../../../src/cli/commands/search.js");

    const fullResult = await runSearch("token", { mode: "keyword" }, { path: "/tmp/pm-search" });
    expect(fullResult.projection).toEqual({
      mode: "full",
      fields: null,
    });
    expect(fullResult.items[0]).toMatchObject({
      item: {
        id: "pm-projection",
      },
      matched_fields: expect.arrayContaining(["title"]),
    });

    const compactResult = await runSearch("token", { mode: "keyword", compact: true }, { path: "/tmp/pm-search" });
    expect((compactResult as Record<string, unknown>).projection).toBeUndefined();
    expect((compactResult as Record<string, unknown>).now).toBeUndefined();
    expect(compactResult.items[0]).toMatchObject({
      id: "pm-projection",
      title: "Projection title token",
      status: "in_progress",
      type: "Task",
      priority: 2,
      score: expect.any(Number),
      matched_fields: expect.arrayContaining(["title"]),
    });
    expect((compactResult.items[0] as Record<string, unknown>).item).toBeUndefined();

    const fieldResult = await runSearch(
      "token",
      { mode: "keyword", fields: "id,score,item.title,item.status" },
      { path: "/tmp/pm-search" },
    );
    expect(fieldResult.projection).toEqual({
      mode: "fields",
      fields: ["id", "score", "item.title", "item.status"],
    });
    const projected = fieldResult.items[0] as Record<string, unknown>;
    expect(projected.id).toBe("pm-projection");
    expect(typeof projected.score).toBe("number");
    expect(projected["item.title"]).toBe("Projection title token");
    expect(projected["item.status"]).toBe("in_progress");

    await expect(runSearch("token", { mode: "keyword", fields: "id,titel" }, { path: "/tmp/pm-search" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
      message: expect.stringContaining("Unknown search --fields value(s): titel"),
    });

    await expect(
      runSearch("token", { mode: "keyword", compact: true, full: true }, { path: "/tmp/pm-search" }),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
    await expect(runSearch("token", { mode: "keyword", fields: " , " }, { path: "/tmp/pm-search" })).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
  });

  it("filters the keyword corpus by --status before the query and echoes the raw value", async () => {
    const openHit = makeFrontMatter({
      id: "pm-status-open",
      title: "statustoken open work",
      description: "statustoken open description",
      status: "open",
    });
    const closedHit = makeFrontMatter({
      id: "pm-status-closed",
      title: "statustoken closed work",
      description: "statustoken closed description",
      status: "closed",
    });
    const docs = [openHit, closedHit];
    listAllFrontMatterMock.mockResolvedValue(docs);
    readFileMock.mockImplementation(async (targetPath) => {
      const match = docs.find((item) => targetPath.endsWith(`${item.id}.md`));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      return serializeDocument(match, "statustoken body");
    });

    const { runSearch } = await import("../../../src/cli/commands/search.js");

    // --status open excludes the closed item via the open workflow-group alias.
    const openResult = await runSearch("statustoken", { mode: "keyword", status: "open" }, { path: "/tmp/pm-search" });
    expect(openResult.count).toBe(1);
    expect(openResult.items[0].item.id).toBe("pm-status-open");
    expect(openResult.filters.status).toBe("open");

    // --status closed returns only the closed item via the closed alias.
    const closedResult = await runSearch(
      "statustoken",
      { mode: "keyword", status: "closed" },
      { path: "/tmp/pm-search" },
    );
    expect(closedResult.count).toBe(1);
    expect(closedResult.items[0].item.id).toBe("pm-status-closed");
    expect(closedResult.filters.status).toBe("closed");

    // No --status leaves the corpus unfiltered and echoes null.
    const noStatus = await runSearch("statustoken", { mode: "keyword" }, { path: "/tmp/pm-search" });
    expect(noStatus.count).toBe(2);
    expect(noStatus.filters.status).toBeNull();
  });

  it("rejects an unrecognized --status token strictly with a did-you-mean hint", async () => {
    const { runSearch } = await import("../../../src/cli/commands/search.js");
    await expect(
      runSearch("statustoken", { mode: "keyword", status: "opne" }, { path: "/tmp/pm-search" }),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
      message: expect.stringContaining('Invalid --status value "opne"'),
    });
    await expect(
      runSearch("statustoken", { mode: "keyword", status: "opne" }, { path: "/tmp/pm-search" }),
    ).rejects.toThrow(/Did you mean "open"\?/);
  });

  // GH-281 (pm-oqgf): exact full-ID / short-ID matches must rank #1 in EVERY
  // mode, not just keyword. In semantic & hybrid mode a high-semantic body
  // mention used to out-rank the exact-ID target because the keyword
  // contribution is capped by hybrid_semantic_weight.
  it("forces an exact full-ID match to rank #1 in hybrid mode over a higher-semantic competitor", async () => {
    const target = makeFrontMatter({
      id: "pm-fk49",
      title: "Game Engine Core Architecture",
      description: "No literal id token in content",
      updated_at: "2026-02-18T00:01:00.000Z",
    });
    // Competitor carries a far stronger semantic score AND a literal body
    // mention of the target id, so under the default 0.7 semantic weight it
    // would out-rank the exact-id target without the GH-281 guarantee.
    const rival = makeFrontMatter({
      id: "pm-rival",
      title: "pm-fk49 mentioned in the title and body",
      description: "pm-fk49 appears here too",
      updated_at: "2026-02-18T00:02:00.000Z",
    });
    const docs = [rival, target];
    listAllFrontMatterMock.mockResolvedValue(docs);
    readFileMock.mockImplementation(async (targetPath: string) => {
      const match = docs.find((item) => targetPath.includes(item.id));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      return serializeDocument(match, match.id === "pm-rival" ? "pm-fk49 body mention pm-fk49" : "body without lookup token");
    });
    readSettingsMock.mockResolvedValue({
      search: {
        // Default weight: keyword contribution caps at 0.3 — pre-fix the rival wins.
        hybrid_semantic_weight: 0.7,
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
    globalThis.fetch = (async (url: unknown) => {
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
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            result: [
              { id: "pm-rival", score: 0.99 },
              { id: "pm-fk49", score: 0.05 },
            ],
          }),
          text: async () => "",
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch target: ${target}`);
    }) as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const hybrid = await runSearch("pm-fk49", { mode: "hybrid" }, { path: "/tmp/pm-search" });
      expect(hybrid.mode).toBe("hybrid");
      expect(hybrid.items[0]?.item.id).toBe("pm-fk49");
      expect(hybrid.items[0]?.matched_fields).toEqual(["id"]);
      // The competitor is still present, just ranked below the exact-id target.
      expect(hybrid.items.map((entry) => entry.item.id)).toContain("pm-rival");
      expect(hybrid.items[0]!.score).toBeGreaterThan(hybrid.items[1]!.score);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ranks full-ID above short-ID when both are exact matches in hybrid mode, both above a higher-semantic rival", async () => {
    // Query "fk49" exactly matches TWO items: item "fk49" matches as a FULL id
    // (score 1000) and item "pm-fk49" matches as a SHORT id (prefix "pm-"
    // stripped → "fk49", score 900). The full-ID band slot must rank above the
    // short-ID band slot, and both must out-rank the higher-semantic rival.
    const fullIdMatch = makeFrontMatter({
      id: "fk49",
      title: "full id exact target",
      description: "no id token here",
      updated_at: "2026-02-18T00:01:00.000Z",
    });
    const shortIdMatch = makeFrontMatter({
      id: "pm-fk49",
      title: "short id exact target",
      description: "no id token here",
      updated_at: "2026-02-18T00:01:30.000Z",
    });
    const rival = makeFrontMatter({
      id: "pm-rival",
      title: "fk49 fk49 fk49 in title",
      description: "fk49 body mention",
      updated_at: "2026-02-18T00:02:00.000Z",
    });
    const docs = [rival, fullIdMatch, shortIdMatch];
    listAllFrontMatterMock.mockResolvedValue(docs);
    readFileMock.mockImplementation(async (targetPath: string) => {
      const match = docs.find((item) => targetPath.includes(item.id));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      return serializeDocument(match, match.id === "pm-rival" ? "fk49 fk49 body" : "no lookup token");
    });
    readSettingsMock.mockResolvedValue({
      id_prefix: "pm-",
      search: { hybrid_semantic_weight: 0.7 },
      providers: {
        openai: { base_url: "https://api.example.test/v1", model: "text-embedding-3-small", api_key: "" },
      },
      vector_store: { qdrant: { url: "https://qdrant.example.test:6333", api_key: "" } },
    } as unknown as { id_prefix: string });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
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
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            result: [
              { id: "pm-rival", score: 0.99 },
              { id: "pm-fk49", score: 0.02 },
            ],
          }),
          text: async () => "",
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch target: ${target}`);
    }) as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const hybrid = await runSearch("fk49", { mode: "hybrid" }, { path: "/tmp/pm-search" });
      expect(hybrid.mode).toBe("hybrid");
      // Full id ("fk49") above short id ("pm-fk49"); both above the rival.
      expect(hybrid.items.slice(0, 2).map((entry) => entry.item.id)).toEqual(["fk49", "pm-fk49"]);
      expect(hybrid.items[0]?.matched_fields).toEqual(["id"]);
      expect(hybrid.items[1]?.matched_fields).toEqual(["id"]);
      expect(hybrid.items[0]!.score).toBeGreaterThan(hybrid.items[1]!.score);
      expect(hybrid.items[1]!.score).toBeGreaterThan(hybrid.items[2]!.score);
      expect(hybrid.items.map((entry) => entry.item.id)).toContain("pm-rival");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forces an exact full-ID match to rank #1 in semantic mode even with no vector hit and a raised --min-score", async () => {
    const target = makeFrontMatter({
      id: "pm-fk49",
      title: "semantic exact target",
      description: "no id token here",
      updated_at: "2026-02-18T00:01:00.000Z",
    });
    const rival = makeFrontMatter({
      id: "pm-rival",
      title: "unrelated heading",
      description: "unrelated",
      updated_at: "2026-02-18T00:02:00.000Z",
    });
    const docs = [rival, target];
    listAllFrontMatterMock.mockResolvedValue(docs);
    readFileMock.mockImplementation(async (targetPath: string) => {
      const match = docs.find((item) => targetPath.includes(item.id));
      if (!match) {
        throw new Error(`Unexpected path: ${targetPath}`);
      }
      return serializeDocument(match, "semantic body");
    });
    readSettingsMock.mockResolvedValue({
      providers: {
        openai: { base_url: "https://api.example.test/v1", model: "text-embedding-3-small", api_key: "" },
      },
      vector_store: { qdrant: { url: "https://qdrant.example.test:6333", api_key: "" } },
    } as unknown as { id_prefix: string });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
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
        // Only the rival carries a vector hit; the exact-id target has none, so
        // pre-fix it would be absent from a pure-semantic result entirely.
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ result: [{ id: "pm-rival", score: 0.99 }] }),
          text: async () => "",
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch target: ${target}`);
    }) as typeof globalThis.fetch;

    try {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      // --min-score above the reserved band's lower neighbors must not drop the
      // exact-id hit (threshold exemption).
      const semantic = await runSearch("pm-fk49", { mode: "semantic", minScore: "5" }, { path: "/tmp/pm-search" });
      expect(semantic.mode).toBe("semantic");
      expect(semantic.items[0]?.item.id).toBe("pm-fk49");
      expect(semantic.items[0]?.matched_fields).toEqual(["id"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("classifyImplicitSemanticFallbackReason", () => {
  it("classifies timeouts from message and from a nested cause code", async () => {
    const { classifyImplicitSemanticFallbackReason } = await import("../../../src/cli/commands/search.js");
    expect(classifyImplicitSemanticFallbackReason(new Error("Embedding request timed out after 30000ms"))).toBe("timeout");
    const etimedout = new Error("fetch failed");
    (etimedout as Error & { cause?: unknown }).cause = { code: "ETIMEDOUT" };
    expect(classifyImplicitSemanticFallbackReason(etimedout)).toBe("timeout");
  });

  it("classifies undici 'fetch failed' connection errors via error.cause.code", async () => {
    const { classifyImplicitSemanticFallbackReason } = await import("../../../src/cli/commands/search.js");
    // undici surfaces ECONNREFUSED as a generic 'fetch failed' message with the
    // real syscall code on cause.code — must be labelled connection, not error.
    const refused = new Error("fetch failed");
    (refused as Error & { cause?: unknown }).cause = { code: "ECONNREFUSED" };
    expect(classifyImplicitSemanticFallbackReason(refused)).toBe("connection");

    const reset = new Error("fetch failed");
    (reset as Error & { cause?: unknown }).cause = { code: "ECONNRESET" };
    expect(classifyImplicitSemanticFallbackReason(reset)).toBe("connection");

    // Bare "fetch failed" with no cause still degrades to connection.
    expect(classifyImplicitSemanticFallbackReason(new Error("fetch failed"))).toBe("connection");
  });

  it("falls back to error for unrelated failures and walks bounded cause depth", async () => {
    const { classifyImplicitSemanticFallbackReason, collectErrorCauseCodes } = await import(
      "../../../src/cli/commands/search.js"
    );
    expect(classifyImplicitSemanticFallbackReason(new Error("No embedding provider configured"))).toBe("error");
    // Nested cause chain: the deep ENOTFOUND is still found within the depth budget.
    const deep = new Error("outer");
    (deep as Error & { cause?: unknown }).cause = { message: "mid", cause: { code: "ENOTFOUND" } };
    expect(classifyImplicitSemanticFallbackReason(deep)).toBe("connection");
    expect(collectErrorCauseCodes(deep)).toContain("enotfound");
    expect(collectErrorCauseCodes("plain string")).toBe("");
  });

  // GH-181 / pm-cstl / pm-13nx: match-mode, all-terms coverage ranking, default
  // keyword limit + total, --count, --min-score override, and list filter parity.
  describe("keyword relevance control and filter parity", () => {
    function makeBody(frontMatter: ItemFrontMatter, body: string): string {
      return serializeDocument(frontMatter, body);
    }

    it("ranks all-terms coverage above partial matches in default (or) mode and surfaces matched_all_terms only internally", async () => {
      const allTerms = makeFrontMatter({ id: "pm-all", title: "alpha beta gamma" });
      const partial = makeFrontMatter({ id: "pm-partial", title: "alpha only" });
      listAllFrontMatterMock.mockResolvedValueOnce([partial, allTerms]);
      readFileMock.mockImplementation(async (targetPath) => {
        if (targetPath.endsWith("pm-all.md")) return makeBody(allTerms, "body");
        if (targetPath.endsWith("pm-partial.md")) return makeBody(partial, "body");
        throw new Error(`Unexpected path: ${targetPath}`);
      });
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("alpha beta gamma", { mode: "keyword", full: true }, { path: "/tmp/pm-search" });
      expect(result.count).toBe(2);
      expect(result.items[0].item.id).toBe("pm-all");
      expect(result.items[1].item.id).toBe("pm-partial");
      expect(result.filters.match_mode).toBe("or");
      // matched_all_terms is an internal ranking signal — never projected into rows.
      expect("matched_all_terms" in result.items[0]).toBe(false);
    });

    it("hard-filters with --match-mode and (every distinct token must match)", async () => {
      const allTerms = makeFrontMatter({ id: "pm-all", title: "alpha beta gamma" });
      const partial = makeFrontMatter({ id: "pm-partial", title: "alpha only" });
      listAllFrontMatterMock.mockResolvedValue([partial, allTerms]);
      readFileMock.mockImplementation(async (targetPath) => {
        if (targetPath.endsWith("pm-all.md")) return makeBody(allTerms, "body");
        if (targetPath.endsWith("pm-partial.md")) return makeBody(partial, "body");
        throw new Error(`Unexpected path: ${targetPath}`);
      });
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const andResult = await runSearch("alpha beta gamma", { matchMode: "and" }, { path: "/tmp/pm-search" });
      expect(andResult.count).toBe(1);
      expect(andResult.items[0].item.id).toBe("pm-all");
      expect(andResult.filters.match_mode).toBe("and");
    });

    it("requires a contiguous phrase with --match-mode exact", async () => {
      const phrase = makeFrontMatter({ id: "pm-phrase", title: "alpha beta gamma" });
      const scattered = makeFrontMatter({ id: "pm-scattered", title: "alpha gamma beta" });
      listAllFrontMatterMock.mockResolvedValue([phrase, scattered]);
      readFileMock.mockImplementation(async (targetPath) => {
        if (targetPath.endsWith("pm-phrase.md")) return makeBody(phrase, "body");
        if (targetPath.endsWith("pm-scattered.md")) return makeBody(scattered, "body");
        throw new Error(`Unexpected path: ${targetPath}`);
      });
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const exact = await runSearch("alpha beta gamma", { matchMode: "exact" }, { path: "/tmp/pm-search" });
      expect(exact.count).toBe(1);
      expect(exact.items[0].item.id).toBe("pm-phrase");
    });

    it("rejects an invalid --match-mode value", async () => {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      await expect(runSearch("token", { matchMode: "nope" }, { path: "/tmp/pm-search" })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
    });

    it("applies the default keyword limit (max_results) and reports total when truncating", async () => {
      const items = Array.from({ length: 5 }, (_, index) =>
        makeFrontMatter({ id: `pm-k${index}`, title: "alpha" }),
      );
      listAllFrontMatterMock.mockResolvedValue(items);
      readFileMock.mockImplementation(async (targetPath) => {
        const match = items.find((item) => targetPath.endsWith(`${item.id}.md`));
        if (match) return makeBody(match, "body");
        throw new Error(`Unexpected path: ${targetPath}`);
      });
      readSettingsMock.mockResolvedValue({ id_prefix: "pm-", search: { max_results: 2 } } as unknown as {
        id_prefix: string;
      });
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const limited = await runSearch("alpha", { mode: "keyword" }, { path: "/tmp/pm-search" });
      // No --limit → falls back to max_results=2; total reflects the 5 matches.
      expect(limited.count).toBe(2);
      expect(limited.total).toBe(5);
    });

    it("returns only the count with --count and omits hit rows", async () => {
      const items = Array.from({ length: 3 }, (_, index) =>
        makeFrontMatter({ id: `pm-c${index}`, title: "alpha" }),
      );
      listAllFrontMatterMock.mockResolvedValue(items);
      readFileMock.mockImplementation(async (targetPath) => {
        const match = items.find((item) => targetPath.endsWith(`${item.id}.md`));
        if (match) return makeBody(match, "body");
        throw new Error(`Unexpected path: ${targetPath}`);
      });
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const counted = await runSearch("alpha", { mode: "keyword", count: true, full: true }, { path: "/tmp/pm-search" });
      expect(counted.count_only).toBe(true);
      expect(counted.count).toBe(3);
      expect(counted.total).toBe(3);
      expect(counted.items).toEqual([]);
      // Compact-summary count-only path.
      const compactCounted = await runSearch(
        "alpha",
        { mode: "keyword", count: true, compact: true },
        { path: "/tmp/pm-search" },
      );
      expect(compactCounted.count_only).toBe(true);
      expect(compactCounted.count).toBe(3);
      expect(compactCounted.items).toEqual([]);
    });

    it("keeps the count-only shape when --count matches nothing (empty-result path)", async () => {
      listAllFrontMatterMock.mockResolvedValue([makeFrontMatter({ id: "pm-none", title: "alpha" })]);
      readFileMock.mockImplementation(async (targetPath) => {
        if (targetPath.endsWith("pm-none.md")) return makeBody(makeFrontMatter({ id: "pm-none", title: "alpha" }), "body");
        throw new Error(`Unexpected path: ${targetPath}`);
      });
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      // No token matches "zzznomatch" -> filteredDocuments empty -> emptySearchResult path.
      const verbose = await runSearch("zzznomatch", { mode: "keyword", count: true, full: true }, { path: "/tmp/pm-search" });
      expect(verbose.count_only).toBe(true);
      expect(verbose.count).toBe(0);
      expect(verbose.total).toBe(0);
      expect(verbose.items).toEqual([]);
      const compact = await runSearch(
        "zzznomatch",
        { mode: "keyword", count: true, compact: true },
        { path: "/tmp/pm-search" },
      );
      expect(compact.count_only).toBe(true);
      expect(compact.total).toBe(0);
      expect(compact.items).toEqual([]);
    });

    it("applies --min-score as a per-query override of the persistent threshold", async () => {
      const item = makeFrontMatter({ id: "pm-min", title: "alpha" });
      listAllFrontMatterMock.mockResolvedValue([item]);
      readFileMock.mockImplementation(async (targetPath) => {
        if (targetPath.endsWith("pm-min.md")) return makeBody(item, "body");
        throw new Error(`Unexpected path: ${targetPath}`);
      });
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const dropped = await runSearch("alpha", { mode: "keyword", minScore: "1000" }, { path: "/tmp/pm-search" });
      expect(dropped.count).toBe(0);
      expect(dropped.filters.score_threshold).toBe(1000);
      const kept = await runSearch("alpha", { mode: "keyword", minScore: "0" }, { path: "/tmp/pm-search" });
      expect(kept.count).toBe(1);
      expect(kept.filters.score_threshold).toBe(0);
    });

    it("rejects an invalid --min-score value", async () => {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      await expect(runSearch("token", { minScore: "-1" }, { path: "/tmp/pm-search" })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runSearch("token", { minScore: "not-a-number" }, { path: "/tmp/pm-search" })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
    });

    it("applies pm list filter parity (updated/created windows, assignee, sprint, release, parent)", async () => {
      const target = makeFrontMatter({
        id: "pm-target",
        title: "alpha",
        assignee: "alice",
        sprint: "S1",
        release: "R1",
        parent: "pm-epic",
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-10T00:00:00.000Z",
      });
      const other = makeFrontMatter({
        id: "pm-other",
        title: "alpha",
        assignee: "bob",
        sprint: "S2",
        release: "R2",
        parent: "pm-other-epic",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      });
      listAllFrontMatterMock.mockResolvedValue([target, other]);
      readFileMock.mockImplementation(async (targetPath) => {
        if (targetPath.endsWith("pm-target.md")) return makeBody(target, "body");
        if (targetPath.endsWith("pm-other.md")) return makeBody(other, "body");
        throw new Error(`Unexpected path: ${targetPath}`);
      });
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const byAssignee = await runSearch("alpha", { mode: "keyword", assignee: "alice" }, { path: "/tmp/pm-search" });
      expect(byAssignee.count).toBe(1);
      expect(byAssignee.items[0].item.id).toBe("pm-target");
      expect(byAssignee.filters.assignee).toBe("alice");

      const bySprintRelease = await runSearch(
        "alpha",
        { mode: "keyword", sprint: "S1", release: "R1", parent: "pm-epic" },
        { path: "/tmp/pm-search" },
      );
      expect(bySprintRelease.count).toBe(1);
      expect(bySprintRelease.items[0].item.id).toBe("pm-target");

      const byUpdatedWindow = await runSearch(
        "alpha",
        { mode: "keyword", updatedAfter: "2026-02-01T00:00:00.000Z", createdAfter: "2026-02-01T00:00:00.000Z" },
        { path: "/tmp/pm-search" },
      );
      expect(byUpdatedWindow.count).toBe(1);
      expect(byUpdatedWindow.items[0].item.id).toBe("pm-target");

      const byUpdatedBefore = await runSearch(
        "alpha",
        { mode: "keyword", updatedBefore: "2026-02-01T00:00:00.000Z", createdBefore: "2026-02-01T00:00:00.000Z" },
        { path: "/tmp/pm-search" },
      );
      expect(byUpdatedBefore.count).toBe(1);
      expect(byUpdatedBefore.items[0].item.id).toBe("pm-other");
    });

    it("rejects --assignee none/null (matching pm list)", async () => {
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      await expect(runSearch("token", { assignee: "none" }, { path: "/tmp/pm-search" })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
    });

    it("echoes new filters and match_mode in the compact filter summary", async () => {
      const item = makeFrontMatter({ id: "pm-cf", title: "alpha", assignee: "alice", sprint: "S1" });
      listAllFrontMatterMock.mockResolvedValue([item]);
      readFileMock.mockImplementation(async (targetPath) => {
        if (targetPath.endsWith("pm-cf.md")) return makeBody(item, "body");
        throw new Error(`Unexpected path: ${targetPath}`);
      });
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const compact = await runSearch(
        "alpha",
        { mode: "keyword", compact: true, matchMode: "and", assignee: "alice", sprint: "S1" },
        { path: "/tmp/pm-search" },
      );
      expect(compact.filters).toMatchObject({ match_mode: "and", assignee: "alice", sprint: "S1" });
    });
  });
});

describe("inline query syntax and highlighting (GH-157)", () => {
  function makeDoc(
    overrides: Partial<ItemFrontMatter> & Pick<ItemFrontMatter, "id">,
    body = "",
  ): { metadata: ItemFrontMatter; body: string } {
    return { metadata: makeFrontMatter(overrides), body };
  }

  describe("parseInlineQueryFilters", () => {
    it("extracts recognized field:value tokens, keeps colon-bearing values, and returns the residual query", async () => {
      const { _testOnlySearchCommand } = await import("../../../src/cli/commands/search.js");
      const result = _testOnlySearchCommand.parseInlineQueryFilters("auth tag:area:search status:open relevance");
      expect(result.residualQuery).toBe("auth relevance");
      expect(result.inlineFilters).toEqual({ tag: "area:search", status: "open" });
    });

    it("captures the first occurrence per field and leaves later duplicates plus unknown prefixes in the residual", async () => {
      const { _testOnlySearchCommand } = await import("../../../src/cli/commands/search.js");
      const result = _testOnlySearchCommand.parseInlineQueryFilters("type:Task type:Bug foo:bar plain status:");
      // First type wins; the duplicate, the unknown field, the bare word, and the
      // empty-valued token all fall through to the residual query.
      expect(result.inlineFilters).toEqual({ type: "Task" });
      expect(result.residualQuery).toBe("type:Bug foo:bar plain status:");
    });

    it("returns an empty filter set for a query with no inline tokens", async () => {
      const { _testOnlySearchCommand } = await import("../../../src/cli/commands/search.js");
      const result = _testOnlySearchCommand.parseInlineQueryFilters("just plain words");
      expect(result.inlineFilters).toEqual({});
      expect(result.residualQuery).toBe("just plain words");
    });
  });

  describe("applyInlineQueryFilters", () => {
    it("applies an inline value only when the flag is unset and never mutates the input", async () => {
      const { _testOnlySearchCommand } = await import("../../../src/cli/commands/search.js");
      const warnings: string[] = [];
      const options = { priority: "2" } as Record<string, unknown>;
      const merged = _testOnlySearchCommand.applyInlineQueryFilters(
        options,
        { tag: "area:search", priority: "1" },
        warnings,
      );
      expect(merged.tag).toBe("area:search");
      // Explicit flag wins; the conflicting inline token is recorded, not silent.
      expect(merged.priority).toBe("2");
      expect(warnings).toEqual(["search_inline_filter_ignored:priority:flag_takes_precedence"]);
      expect(options).toEqual({ priority: "2" });
    });
  });

  describe("markTokenRuns", () => {
    it("wraps case-insensitive matches and escapes regex metacharacters in tokens", async () => {
      const { _testOnlySearchCommand } = await import("../../../src/cli/commands/search.js");
      expect(_testOnlySearchCommand.markTokenRuns("Auth and AUTH", ["auth"])).toBe("«Auth» and «AUTH»");
      // A token carrying regex-special characters must match literally.
      expect(_testOnlySearchCommand.markTokenRuns("c++ and c++", ["c++"])).toBe("«c++» and «c++»");
    });

    it("returns the text unchanged when there are no non-empty tokens", async () => {
      const { _testOnlySearchCommand } = await import("../../../src/cli/commands/search.js");
      expect(_testOnlySearchCommand.markTokenRuns("unchanged", [""])).toBe("unchanged");
    });

    it("prefers the longest token so a prefix token does not shadow a longer match", async () => {
      const { _testOnlySearchCommand } = await import("../../../src/cli/commands/search.js");
      // "auth" is a prefix of "authority"; length-descending ordering must mark
      // the full "authority" rather than «auth»ority.
      expect(_testOnlySearchCommand.markTokenRuns("authority check", ["auth", "authority"])).toBe(
        "«authority» check",
      );
    });
  });

  describe("highlightFieldSnippet", () => {
    it("returns null for empty text and for text with no token match", async () => {
      const { _testOnlySearchCommand } = await import("../../../src/cli/commands/search.js");
      expect(_testOnlySearchCommand.highlightFieldSnippet("", ["auth"])).toBeNull();
      expect(_testOnlySearchCommand.highlightFieldSnippet("nothing here", ["auth", ""])).toBeNull();
    });

    it("wraps the match without ellipsis when the field fits the window", async () => {
      const { _testOnlySearchCommand } = await import("../../../src/cli/commands/search.js");
      expect(_testOnlySearchCommand.highlightFieldSnippet("Fix auth login bug", ["auth"])).toBe(
        "Fix «auth» login bug",
      );
    });

    it("anchors the window on the earliest matching token across the token set", async () => {
      const { _testOnlySearchCommand } = await import("../../../src/cli/commands/search.js");
      // "alpha" is listed first but appears later than "beta"; the window must
      // anchor on the earliest match (beta) regardless of token order.
      expect(_testOnlySearchCommand.highlightFieldSnippet("zzz beta yyy alpha", ["alpha", "beta"])).toBe(
        "zzz «beta» yyy «alpha»",
      );
    });

    it("windows long text around the first match with leading and trailing ellipsis", async () => {
      const { _testOnlySearchCommand } = await import("../../../src/cli/commands/search.js");
      const long = `${"x".repeat(80)} needle ${"y".repeat(80)}`;
      const snippet = _testOnlySearchCommand.highlightFieldSnippet(long, ["needle"]);
      expect(snippet).not.toBeNull();
      expect(snippet?.startsWith("…")).toBe(true);
      expect(snippet?.endsWith("…")).toBe(true);
      expect(snippet).toContain("«needle»");
    });
  });

  describe("buildHitHighlights", () => {
    it("emits snippets for matched document fields in order and skips synthetic and unmatched fields", async () => {
      const { _testOnlySearchCommand } = await import("../../../src/cli/commands/search.js");
      const document = makeDoc({ id: "pm-hl", title: "Auth flow", tags: ["area:auth"] }, "auth body");
      const highlights = _testOnlySearchCommand.buildHitHighlights(
        document,
        // "semantic" is synthetic (no document field), "description" has no match.
        ["description", "semantic", "tags", "title"],
        ["auth"],
      );
      expect(highlights).toEqual([
        { field: "tags", snippet: "area:«auth»" },
        { field: "title", snippet: "«Auth» flow" },
      ]);
    });
  });

  describe("runSearch wiring", () => {
    beforeEach(() => {
      pathExistsMock.mockReset();
      readSettingsMock.mockReset();
      listAllFrontMatterMock.mockReset();
      readFileMock.mockReset();
      realpathMock.mockReset();
      runActiveOnReadHooksMock.mockReset();
      spawnSyncMock.mockReset();
      activeExtensionRegistrations = null;
      pathExistsMock.mockResolvedValue(true);
      readSettingsMock.mockResolvedValue({ id_prefix: "pm-" });
      realpathMock.mockImplementation(async (targetPath) => targetPath);
      runActiveOnReadHooksMock.mockResolvedValue([]);
      spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });
    });

    function seedAuthCorpus(): void {
      const authItem = makeFrontMatter({
        id: "pm-lgn1",
        title: "Fix auth login bug",
        description: "auth handling",
        tags: ["area:auth"],
      });
      const searchItem = makeFrontMatter({
        id: "pm-rnk2",
        title: "Improve auth in search",
        description: "auth ranking",
        tags: ["area:search"],
      });
      listAllFrontMatterMock.mockResolvedValue([authItem, searchItem]);
      readFileMock.mockImplementation(async (targetPath: string) =>
        targetPath.includes("pm-lgn1") ? serializeDocument(authItem, "auth body") : serializeDocument(searchItem, "auth body"),
      );
    }

    it("parses an inline tag token from the query string and applies it as a filter", async () => {
      seedAuthCorpus();
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("auth tag:area:auth", {}, { path: "/tmp/pm-search" });
      expect(result.query).toBe("auth");
      expect(result.filters).toMatchObject({ tag: "area:auth" });
      expect(result.items.map((hit) => (hit as { item: ItemFrontMatter }).item.id)).toEqual(["pm-lgn1"]);
    });

    it("lets an explicit flag win over a conflicting inline token and warns", async () => {
      seedAuthCorpus();
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("auth tag:area:search", { tag: "area:auth" }, { path: "/tmp/pm-search" });
      expect(result.filters).toMatchObject({ tag: "area:auth" });
      expect(result.warnings).toContain("search_inline_filter_ignored:tag:flag_takes_precedence");
    });

    it("rejects a query whose inline tokens consume every search term", async () => {
      seedAuthCorpus();
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      await expect(runSearch("tag:area:auth", {}, { path: "/tmp/pm-search" })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
    });

    it("attaches per-field highlights on full hits when --highlight is set", async () => {
      seedAuthCorpus();
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("auth", { full: true, highlight: true }, { path: "/tmp/pm-search" });
      const first = result.items[0] as { highlights?: Array<{ field: string; snippet: string }> };
      expect(
        first.highlights?.some((entry) => entry.field === "title" && entry.snippet.toLowerCase().includes("«auth»")),
      ).toBe(true);
    });

    it("adds highlights to the compact projection field set and echoes it", async () => {
      seedAuthCorpus();
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("auth", { compact: true, highlight: true }, { path: "/tmp/pm-search" });
      const first = result.items[0] as Record<string, unknown>;
      expect(first).toHaveProperty("highlights");
    });

    it("does not duplicate highlights in an explicit --fields projection that already requests it", async () => {
      seedAuthCorpus();
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch(
        "auth",
        { fields: "id,highlights", highlight: true },
        { path: "/tmp/pm-search" },
      );
      const verbose = result as { projection?: { fields: string[] | null } };
      expect(verbose.projection?.fields).toEqual(["id", "highlights"]);
    });

    it("omits highlights entirely when --highlight is not set", async () => {
      seedAuthCorpus();
      const { runSearch } = await import("../../../src/cli/commands/search.js");
      const result = await runSearch("auth", { full: true }, { path: "/tmp/pm-search" });
      const first = result.items[0] as Record<string, unknown>;
      expect(first).not.toHaveProperty("highlights");
    });
  });
});
