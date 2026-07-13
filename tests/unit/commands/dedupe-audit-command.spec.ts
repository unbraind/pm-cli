import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _testOnly as dedupeInternals, runDedupeAudit } from "../../../packages/pm-governance-audit/extensions/governance-audit/dedupe-audit.ts";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function createItem(
  context: TempPmContext,
  params: {
    title: string;
    type?: "Feature" | "Task" | "Issue" | "Chore";
    status?: "open" | "closed";
    parent?: string;
  },
): string {
  return createTestItemId(context, {
    title: params.title,
    type: params.type,
    status: params.status,
    parent: params.parent,
    tags: "dedupe,unit",
    estimate: "15",
    author: "test-author",
  });
}

function preparedCandidate(
  overrides: Partial<Parameters<typeof dedupeInternals.compareCandidates>[0]> = {},
): Parameters<typeof dedupeInternals.compareCandidates>[0] {
  const title = overrides.title ?? "Duplicate Candidate";
  return {
    id: "pm-a",
    title,
    type: "Task",
    status: "open",
    parent: null,
    priority: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    normalized_title: title.toLowerCase(),
    title_tokens: title.toLowerCase().split(/\s+/),
    ...overrides,
  };
}

describe("dedupe-audit helpers", () => {
  it("parses option helpers and rejects invalid raw values", () => {
    expect(dedupeInternals.parseMode(undefined)).toBe("title_exact");
    expect(dedupeInternals.parseMode(" PARENT_SCOPE ")).toBe("parent_scope");
    expect(dedupeInternals.parseStatus(undefined)).toBeUndefined();
    expect(dedupeInternals.parseStatus("in-progress")).toBe("in_progress");
    expect(dedupeInternals.parseThreshold(undefined)).toBeUndefined();
    expect(dedupeInternals.parseThreshold("0")).toBe(0);
    expect(dedupeInternals.parseThreshold("1")).toBe(1);
    expect(() => dedupeInternals.parseMode("nearest")).toThrow(/mode must be one of/);
    expect(() => dedupeInternals.parseStatus("waiting")).toThrow(/Status filter must be one of/);
    expect(() => dedupeInternals.parseThreshold("nan")).toThrow(/between 0 and 1/);
    expect(() => dedupeInternals.parseThreshold("-0.1")).toThrow(/between 0 and 1/);
  });

  it("orders canonical candidates by terminal state, priority, update time, and id", () => {
    const open = preparedCandidate({ id: "pm-open", status: "open" });
    const closed = preparedCandidate({ id: "pm-closed", status: "closed" });
    expect(dedupeInternals.compareCandidates(open, closed)).toBeLessThan(0);

    const highPriority = preparedCandidate({ id: "pm-high", priority: 0 });
    const lowPriority = preparedCandidate({ id: "pm-low", priority: 2 });
    expect(dedupeInternals.compareCandidates(highPriority, lowPriority)).toBeLessThan(0);

    const newer = preparedCandidate({ id: "pm-new", updated_at: "2026-01-03T00:00:00.000Z" });
    const older = preparedCandidate({ id: "pm-old", updated_at: "2026-01-01T00:00:00.000Z" });
    expect(dedupeInternals.compareCandidates(newer, older)).toBeLessThan(0);
    expect(dedupeInternals.compareCandidates(preparedCandidate({ id: "pm-a" }), preparedCandidate({ id: "pm-b" }))).toBeLessThan(0);
    // Unknown statuses exercise normalizeStatusInput(... ) ?? raw fallback.
    expect(
      dedupeInternals.compareCandidates(
        preparedCandidate({ id: "pm-unknown", status: "mystery" as never }),
        preparedCandidate({ id: "pm-open", status: "open" }),
      ),
    ).toBeGreaterThan(0);
  });

  it("builds and skips clusters for exact, parent, and fuzzy modes", () => {
    const first = preparedCandidate({ id: "pm-first", title: "Same Title", normalized_title: "same title", parent: "pm-parent" });
    const second = preparedCandidate({
      id: "pm-second",
      title: " same   title ",
      normalized_title: "same title",
      parent: "pm-parent",
      priority: 2,
    });
    const blank = preparedCandidate({ id: "pm-blank", title: "", normalized_title: "", title_tokens: [] });
    const otherParent = preparedCandidate({ id: "pm-other", title: "Same Title", normalized_title: "same title", parent: "pm-other" });

    expect(dedupeInternals.collectExactTitleClusters([first, second, blank])).toHaveLength(1);
    expect(dedupeInternals.collectParentScopedClusters([first, second, otherParent])).toHaveLength(1);
    expect(dedupeInternals.collectFuzzyTitleClusters([first], 0.5)).toEqual([]);
    const fuzzy = dedupeInternals.collectFuzzyTitleClusters(
      [
        preparedCandidate({ id: "pm-a", title_tokens: ["alpha", "beta"], normalized_title: "alpha beta" }),
        preparedCandidate({ id: "pm-b", title_tokens: ["beta", "alpha"], normalized_title: "beta alpha" }),
        preparedCandidate({ id: "pm-c", title_tokens: ["gamma"], normalized_title: "gamma" }),
      ],
      0.9,
    );
    expect(fuzzy).toHaveLength(1);
    expect(fuzzy[0]?.similarity).toMatchObject({ min: 1, max: 1 });
  });

  it("covers fuzzy cluster fallback math and secondary cluster sorting branches", () => {
    const singleton = preparedCandidate({ id: "pm-single", normalized_title: "singleton", title_tokens: ["singleton"] });
    const singletonCluster = dedupeInternals.clusterFromMembers(
      "title_fuzzy",
      "singleton",
      [singleton],
      "single-member-fallback",
      undefined,
    );
    expect(singletonCluster.similarity).toMatchObject({ min: 1, max: 1, threshold: 0.8 });

    // Force unionRoots into both the "already same root" and leftRoot>rightRoot paths.
    const fuzzy = dedupeInternals.collectFuzzyTitleClusters(
      [
        preparedCandidate({ id: "pm-a", normalized_title: "alpha", title_tokens: ["alpha"] }),
        preparedCandidate({ id: "pm-b", normalized_title: "beta", title_tokens: ["beta"] }),
        preparedCandidate({ id: "pm-c", normalized_title: "alpha beta", title_tokens: ["alpha", "beta"] }),
      ],
      0.5,
    );
    expect(fuzzy).toHaveLength(1);

    // Similarity short-circuits to 1 when normalized titles already match.
    const normalizedMatch = dedupeInternals.collectFuzzyTitleClusters(
      [
        preparedCandidate({ id: "pm-same-a", normalized_title: "same title", title_tokens: ["x"] }),
        preparedCandidate({ id: "pm-same-b", normalized_title: "same title", title_tokens: ["y"] }),
      ],
      0.9,
    );
    expect(normalizedMatch).toHaveLength(1);

    const exact = dedupeInternals.collectExactTitleClusters([
      preparedCandidate({ id: "pm-z2", title: "same one", normalized_title: "same one" }),
      preparedCandidate({ id: "pm-z1", title: "same one", normalized_title: "same one" }),
      preparedCandidate({ id: "pm-y1", title: "same two", normalized_title: "same two" }),
      preparedCandidate({ id: "pm-y2", title: "same two", normalized_title: "same two" }),
      preparedCandidate({ id: "pm-y3", title: "same two", normalized_title: "same two" }),
    ]);
    expect(exact).toHaveLength(2);
    expect(exact.map((cluster) => cluster.cluster_size).sort((left, right) => left - right)).toEqual([2, 3]);
  });

  it("covers already-unioned fuzzy pairs and canonical-id tie sorting", async () => {
    const transitiveFuzzy = dedupeInternals.collectFuzzyTitleClusters(
      [
        preparedCandidate({ id: "pm-a", normalized_title: "alpha beta", title_tokens: ["alpha", "beta"] }),
        preparedCandidate({ id: "pm-b", normalized_title: "beta alpha", title_tokens: ["beta", "alpha"] }),
        preparedCandidate({ id: "pm-c", normalized_title: "alpha beta again", title_tokens: ["alpha", "beta"] }),
      ],
      0.5,
    );
    expect(transitiveFuzzy).toHaveLength(1);

    await withTempPmPath(async (context) => {
      createItem(context, { title: "canonical sort a", status: "closed" });
      const clusterBOpen = createItem(context, { title: "canonical sort b", status: "open" });
      const clusterAOpen = createItem(context, { title: "canonical sort a", status: "open" });
      createItem(context, { title: "canonical sort b", status: "closed" });

      const result = await runDedupeAudit({ mode: "title_exact" }, { path: context.pmPath });
      const canonicalIds = result.clusters.map((cluster) => cluster.canonical.id);
      expect(canonicalIds).toEqual([clusterBOpen, clusterAOpen].sort((left, right) => left.localeCompare(right)));
    });
  });

  it("uses fuzzy cluster fallback keys when canonical ids are missing", () => {
    const clusters = dedupeInternals.collectFuzzyTitleClusters(
      [
        preparedCandidate({
          id: undefined as unknown as string,
          status: "open",
          normalized_title: "same canonical title",
          title_tokens: ["same", "canonical", "title"],
        }),
        preparedCandidate({
          id: "pm-closed",
          status: "closed",
          normalized_title: "same canonical title",
          title_tokens: ["same", "canonical", "title"],
        }),
      ],
      0.8,
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.key).toBe("cluster-1");
  });

  it("escapes merge suggestion commands", () => {
    const canonical = preparedCandidate({ id: "pm-main" });
    const duplicate = preparedCandidate({ id: 'pm-quote"' });

    const suggestion = dedupeInternals.toMergeSuggestion(duplicate, canonical, "title_exact");

    expect(suggestion.suggested_close_reason).toBe("Duplicate of pm-main");
    expect(suggestion.suggested_command).toContain('pm close pm-quote" "Duplicate of pm-main"');
    expect(suggestion.suggested_command).toContain('\\"');
  });
});

describe("runDedupeAudit", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-dedupe-audit-not-init-"));
    try {
      await expect(runDedupeAudit({ mode: "title_exact" }, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("finds exact-title duplicate clusters and emits merge suggestions", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, { title: "Fix cache bug" });
      createItem(context, { title: "  fix   cache bug  " });
      createItem(context, { title: "Different title" });

      const result = await runDedupeAudit({ mode: "title_exact" }, { path: context.pmPath });
      expect(result.mode).toBe("title_exact");
      expect(result.count).toBe(1);
      expect(result.clusters[0]?.key).toBe("fix cache bug");
      expect(result.clusters[0]?.cluster_size).toBe(2);
      expect(result.clusters[0]?.duplicates.length).toBe(1);
      expect(result.clusters[0]?.merge_suggestions.length).toBe(1);
      expect(result.clusters[0]?.merge_suggestions[0]?.suggested_command).toContain("pm close");
      expect(result.totals.items_considered).toBe(3);
      expect(result.totals.duplicate_candidates).toBe(2);
      expect(result.totals.merge_suggestions).toBe(1);
    });
  });

  it("scopes duplicate detection by parent in parent_scope mode", async () => {
    await withTempPmPath(async (context) => {
      const parentA = createItem(context, { title: "Parent A", type: "Feature" });
      const parentB = createItem(context, { title: "Parent B", type: "Feature" });
      createItem(context, { title: "Child Task Duplicate", parent: parentA });
      createItem(context, { title: "child task duplicate", parent: parentA });
      createItem(context, { title: "Child Task Duplicate", parent: parentB });

      const result = await runDedupeAudit({ mode: "parent_scope" }, { path: context.pmPath });
      expect(result.count).toBe(1);
      expect(result.clusters[0]?.cluster_size).toBe(2);
      expect(result.clusters[0]?.key).toBe(`${parentA}|child task duplicate`);
      expect(result.clusters[0]?.match_reason).toBe("same_parent_and_exact_normalized_title");
      expect(result.clusters[0]?.canonical.parent).toBe(parentA);
    });
  });

  it("finds fuzzy title duplicates when token similarity meets threshold", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, { title: "Vector refresh check only" });
      createItem(context, { title: "check only vector refresh" });
      createItem(context, { title: "unrelated planning title" });

      const result = await runDedupeAudit(
        {
          mode: "title_fuzzy",
          threshold: "0.9",
        },
        { path: context.pmPath },
      );

      expect(result.count).toBe(1);
      expect(result.filters.threshold).toBe(0.9);
      expect(result.clusters[0]?.cluster_size).toBe(2);
      expect(result.clusters[0]?.similarity).toMatchObject({
        metric: "token_jaccard",
        threshold: 0.9,
      });
      expect(result.clusters[0]?.similarity?.min).toBeGreaterThanOrEqual(0.9);
    });
  });

  it("validates mode, threshold, and limit options", async () => {
    await withTempPmPath(async (context) => {
      await expect(runDedupeAudit({ mode: "unknown" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runDedupeAudit(
          {
            mode: "title_fuzzy",
            threshold: "1.5",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runDedupeAudit(
          {
            mode: "title_exact",
            limit: "-1",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runDedupeAudit(
          {
            mode: "title_exact",
            limit: "1.25",
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("sorts larger clusters first and applies limit slicing", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, { title: "cluster a" });
      createItem(context, { title: "cluster a" });
      createItem(context, { title: "cluster a" });
      createItem(context, { title: "cluster b" });
      createItem(context, { title: "cluster b" });

      const result = await runDedupeAudit(
        {
          mode: "title_exact",
          limit: "1",
        },
        { path: context.pmPath },
      );

      expect(result.count).toBe(1);
      expect(result.clusters[0]?.cluster_size).toBe(3);
    });
  });

  it("forwards non-empty list warnings and omits empty warning arrays", async () => {
    await withTempPmPath(async (context) => {
      const listedItems = [
        {
          id: "pm-a",
          title: "Duplicate title",
          type: "Task",
          status: "open",
          parent: null,
          priority: 1,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "pm-b",
          title: "Duplicate title",
          type: "Task",
          status: "open",
          parent: null,
          priority: 1,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
        },
      ];

      vi.resetModules();
      vi.doMock("../../../src/cli/commands/list.js", () => ({
        runList: vi
          .fn()
          .mockResolvedValueOnce({
            items: listedItems,
            warnings: [],
            now: "2026-01-02T00:00:00.000Z",
          })
          .mockResolvedValueOnce({
            items: listedItems,
            warnings: ["synthetic_list_warning"],
            now: "2026-01-02T00:00:00.000Z",
          }),
      }));

      const { runDedupeAudit: mockedRunDedupeAudit } = await import("../../../packages/pm-governance-audit/extensions/governance-audit/dedupe-audit.ts");
      try {
        const withoutWarnings = await mockedRunDedupeAudit({ mode: "title_exact" }, { path: context.pmPath });
        expect(withoutWarnings.warnings).toBeUndefined();

        const withWarnings = await mockedRunDedupeAudit({ mode: "title_exact" }, { path: context.pmPath });
        expect(withWarnings.warnings).toEqual(["synthetic_list_warning"]);
      } finally {
        vi.doUnmock("../../../src/cli/commands/list.js");
        vi.resetModules();
      }
    });
  });
});
