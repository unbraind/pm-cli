import { describe, expect, it } from "vitest";
import {
  evaluateSimilarityGovernance,
  findDuplicateClusters,
  findSimilarItems,
  similarityAdvisoryWarnings,
  jaccardSimilarity,
  normalizeSimilarityText,
  prepareSimilarityText,
  readSettings,
  resolveItemTypeRegistry,
  scoreItemSimilarity,
  scorePreparedItemSimilarity,
  tokenizeSimilarityText,
} from "../../../src/sdk/index.js";
import { _testOnlySimilarity } from "../../../src/sdk/similarity.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import { _testOnly as metadataQueryIndexTestOnly } from "../../../src/core/store/item-metadata-query-index.js";
import { listAllDocumentCandidatesCached } from "../../../src/core/store/item-metadata-cache.js";

describe("SDK item similarity governance", () => {
  it("normalizes, tokenizes, and scores shared title signals", () => {
    expect(normalizeSimilarityText("  Add   Search  ")).toBe("add search");
    expect(tokenizeSimilarityText("Search search API-42")).toEqual([
      "search",
      "api",
      "42",
    ]);
    expect(tokenizeSimilarityText(" \t ")).toEqual([]);
    expect(jaccardSimilarity(["one", "two"], ["two", "three"])).toBe(1 / 3);
    expect(jaccardSimilarity([], [])).toBe(1);
    expect(scoreItemSimilarity("Add search", " add   search ")).toEqual({
      score: 1,
      reason: "exact_title",
    });
    expect(
      scoreItemSimilarity("Fix GH-672 import", "Investigate gh-672"),
    ).toEqual({ score: 0.99, reason: "issue_code" });
    expect(scoreItemSimilarity("Add search API", "Add search cache")).toEqual({
      score: 0.5,
      reason: "title_token_jaccard",
    });
    expect(
      scorePreparedItemSimilarity(
        prepareSimilarityText("Fix GH-672 import"),
        prepareSimilarityText("Investigate gh-672"),
      ),
    ).toEqual({ score: 0.99, reason: "issue_code" });
    expect(
      scoreItemSimilarity(
        "BD-30-A: production dependency",
        "BD-30-B: embedding response",
      ),
    ).toEqual({ score: 0.25, reason: "title_token_jaccard" });
    expect(
      scoreItemSimilarity(
        "BD-30-A: production dependency",
        "Investigate bd-30-a packaging",
      ),
    ).toEqual({ score: 0.99, reason: "issue_code" });
  });

  it("keeps letter-suffixed sibling work out of duplicate clusters", async () => {
    await withTempPmPath(async (context) => {
      for (const title of [
        "BD-30-A: sentence-transformers dependency missing from production",
        "BD-30-B: Embedding service returns zero vectors instead of real embeddings",
        "BD-30-C: Integration tests do not detect stub embedding service",
        "BD-30-D: End-to-end test does not verify real embedding generation",
      ]) {
        context.runCli([
          "create",
          "--title",
          title,
          "--type",
          "Task",
          "--json",
        ]);
      }

      await expect(
        findDuplicateClusters({ pmRoot: context.pmPath }),
      ).resolves.toMatchObject({ count: 0 });
    });
  });

  it("finds deterministic all-status clusters with explicit batch cost", async () => {
    await withTempPmPath(async (context) => {
      const ids = [
        "Canonical SDK context",
        "Canonical SDK context",
        "Canonical SDK context work",
        "Unrelated release workflow",
        "Second duplicate cluster",
        "Second duplicate cluster",
        "Weak common alpha beta gamma",
        "Weak common delta epsilon zeta",
      ].map((title) => {
        const result = context.runCli(
          ["create", "--title", title, "--type", "Task", "--json"],
          { expectJson: true },
        );
        return (result.json as { item: { id: string } }).item.id;
      });

      const result = await findDuplicateClusters({
        pmRoot: context.pmPath,
        threshold: 0.65,
      });
      expect(result).toMatchObject({
        count: 2,
        source: "metadata_scan",
        cost: {
          item_count: 8,
          candidate_pairs: 5,
          scored_pairs: 5,
        },
      });
      expect(
        result.clusters
          .flatMap((cluster) => cluster.items.map((item) => item.id))
          .sort(),
      ).toEqual([...ids.slice(0, 3), ...ids.slice(4, 6)].sort());
      expect(result.clusters[0]?.matches[0]).toMatchObject({
        score: 1,
        reason: "exact_title",
      });
      expect(result.clusters.map((cluster) => cluster.id)).toEqual(
        result.clusters
          .map((cluster) => cluster.id)
          .sort((left, right) => left.localeCompare(right)),
      );
      await expect(
        findDuplicateClusters({
          pmRoot: context.pmPath,
          statuses: [" all "],
        }),
      ).resolves.toMatchObject({ filters: { statuses: null } });
      await expect(
        findDuplicateClusters({
          pmRoot: context.pmPath,
          statuses: ["all", "open"],
        }),
      ).rejects.toThrow(/cannot be combined with other statuses/);

      await expect(
        findDuplicateClusters({
          pmRoot: context.pmPath,
          statuses: ["closed"],
        }),
      ).resolves.toMatchObject({ count: 0, cost: { item_count: 0 } });
      await expect(
        findDuplicateClusters({
          pmRoot: context.pmPath,
          since: "2999-01-01T00:00:00.000Z",
        }),
      ).resolves.toMatchObject({ count: 0, cost: { item_count: 0 } });
      await expect(
        findDuplicateClusters({
          pmRoot: context.pmPath,
          since: "not-a-date",
        }),
      ).rejects.toThrow(/valid ISO timestamp/);
      await expect(
        findDuplicateClusters({ pmRoot: context.pmPath, limit: 1_001 }),
      ).rejects.toThrow(/integer from 0 to 1000/);
      await expect(
        findDuplicateClusters({
          pmRoot: context.pmPath,
          statuses: ["not-a-runtime-status"],
        }),
      ).rejects.toThrow(/Unknown duplicate-cluster status/);
    });
  });

  it("fails closed when the disclosed batch candidate budget is exceeded", () => {
    const prepared = prepareSimilarityText("same title");
    expect(() =>
      _testOnlySimilarity.collectDuplicateCandidatePairs(
        [
          { item: { id: "pm-a" }, prepared },
          { item: { id: "pm-b" }, prepared },
        ] as never,
        0,
      ),
    ).toThrow(/candidate pairs/);
  });

  it("orders equal-score cluster evidence and handles a connected component without matches", () => {
    const items = ["pm-a", "pm-b", "pm-c"].map((id) => ({
      item: { id, title: id, status: "open", type: "Task" },
      prepared: prepareSimilarityText(id),
    }));
    const union = _testOnlySimilarity.createDuplicateUnionFind(items.length);
    union.parent[1] = 0;
    union.parent[2] = 0;
    const clusters = _testOnlySimilarity.buildDuplicateClusters(
      items as never,
      [
        {
          left_id: "pm-a",
          right_id: "pm-c",
          score: 0.8,
          reason: "title_token_jaccard",
        },
        {
          left_id: "pm-a",
          right_id: "pm-b",
          score: 0.8,
          reason: "title_token_jaccard",
        },
      ],
      union,
      10,
    );
    expect(clusters[0]?.matches.map((match) => match.right_id)).toEqual([
      "pm-b",
      "pm-c",
    ]);
    const unmatchedUnion = _testOnlySimilarity.createDuplicateUnionFind(2);
    unmatchedUnion.parent[1] = 0;
    expect(
      _testOnlySimilarity.buildDuplicateClusters(
        items.slice(0, 2) as never,
        [],
        unmatchedUnion,
        10,
      )[0]?.max_score,
    ).toBe(0);
  });

  it("returns bounded ranked candidates and validates query controls", async () => {
    await withTempPmPath(async (context) => {
      const first = context.runCli(
        ["create", "--title", "Ship SDK event API", "--type", "Task", "--json"],
        { expectJson: true },
      );
      const firstId = (first.json as { item: { id: string } }).item.id;
      context.runCli([
        "create",
        "--title",
        "Ship SDK event stream",
        "--type",
        "Feature",
        "--json",
      ]);
      const settings = await readSettings(context.pmPath);
      const typeRegistry = resolveItemTypeRegistry(settings);
      await listAllDocumentCandidatesCached(
        context.pmPath,
        settings.item_format,
        typeRegistry.type_to_folder,
        undefined,
        settings.schema,
        {
          includeBody: false,
          includeCollections: false,
          derivedIndexMinimumItems: 1,
          forceSourceScan: true,
        },
      );

      await expect(
        findSimilarItems(
          { title: "Ship SDK event API" },
          { pmRoot: context.pmPath, threshold: 0.4, limit: 1 },
        ),
      ).resolves.toMatchObject({
        count: 1,
        threshold: 0.4,
        source: "persistent_index",
        items: [{ id: firstId, score: 1, reason: "exact_title" }],
      });
      await expect(
        findSimilarItems(
          { title: "Ship SDK event API", excludeIds: [firstId] },
          { pmRoot: context.pmPath, threshold: 0.4 },
        ),
      ).resolves.toMatchObject({
        count: 1,
        items: [{ reason: "title_token_jaccard" }],
      });
      await expect(
        findSimilarItems(
          { title: "Ship SDK event API" },
          { pmRoot: context.pmPath, limit: 21 },
        ),
      ).rejects.toThrow(/integer from 0 to 20/);
      await expect(
        findSimilarItems(
          { title: "Ship SDK event API" },
          { pmRoot: context.pmPath, threshold: 1.1 },
        ),
      ).rejects.toThrow(/number from 0 to 1/);
      await expect(
        findSimilarItems({ title: " " }, { pmRoot: context.pmPath }),
      ).rejects.toThrow(/must not be empty/);
    });
  });

  it("advises by default and enforces explicit strict-mode bypasses", async () => {
    await withTempPmPath(async (context) => {
      const original = context.runCli(
        [
          "create",
          "--title",
          "Canonical context projection",
          "--type",
          "Task",
          "--json",
        ],
        { expectJson: true },
      );
      const originalId = (original.json as { item: { id: string } }).item.id;
      expect(
        context.runCli([
          "config",
          "project",
          "set",
          "governance_duplicate_detection_mode",
          "advisory",
        ]).code,
      ).toBe(0);
      const advisory = context.runCli(
        [
          "create",
          "--title",
          "Canonical context projection",
          "--type",
          "Task",
          "--json",
        ],
        { expectJson: true },
      );
      expect(advisory.json).toMatchObject({
        similarity_advisory: {
          mode: "advisory",
          bypassed: false,
          result: { items: [{ id: originalId, reason: "exact_title" }] },
        },
      });

      for (const [key, value] of [
        ["governance_duplicate_detection_mode", "strict"],
        ["governance_duplicate_detection_threshold", "0.9"],
        ["governance_duplicate_detection_limit", "2"],
      ]) {
        expect(
          context.runCli(["config", "project", "set", key, value]).code,
        ).toBe(0);
      }
      expect((await readSettings(context.pmPath)).governance).toMatchObject({
        duplicate_detection_mode: "strict",
        duplicate_detection_threshold: 0.9,
        duplicate_detection_limit: 2,
      });
      await expect(
        evaluateSimilarityGovernance(
          { title: "Canonical context projection" },
          { pmRoot: context.pmPath, mode: "strict" },
        ),
      ).rejects.toMatchObject({
        exitCode: 4,
        context: {
          code: "likely_duplicate",
          recovery: { suggested_flags: ["--allow-duplicate"] },
        },
      });
      const directAdvisory = await evaluateSimilarityGovernance(
        { title: "Canonical context projection" },
        { pmRoot: context.pmPath, mode: "advisory" },
      );
      expect(directAdvisory).toMatchObject({
        mode: "advisory",
        bypassed: false,
      });
      expect(similarityAdvisoryWarnings(directAdvisory).join(",")).toContain(
        originalId,
      );
      expect(similarityAdvisoryWarnings(undefined)).toEqual([]);
      const bypassed = context.runCli(
        ["copy", originalId, "--allow-duplicate", "--json"],
        { expectJson: true },
      );
      expect(bypassed.json).toMatchObject({
        similarity_advisory: {
          mode: "strict",
          bypassed: true,
        },
      });
    });
  });

  it("short-circuits disabled and empty-result governance", async () => {
    await expect(
      evaluateSimilarityGovernance(
        { title: "Not read in off mode" },
        { pmRoot: "/tmp/not-used", mode: "off" },
      ),
    ).resolves.toBeUndefined();
    await withTempPmPath(async (context) => {
      const restoreDatabaseSync =
        metadataQueryIndexTestOnly.setDatabaseSync(null);
      try {
        await expect(
          findSimilarItems(
            { title: "Fallback-only similarity primitive" },
            { pmRoot: context.pmPath },
          ),
        ).resolves.toMatchObject({
          source: "metadata_fallback",
          count: 0,
        });
      } finally {
        restoreDatabaseSync();
      }
      await expect(
        evaluateSimilarityGovernance(
          { title: "A uniquely phrased context primitive" },
          { pmRoot: context.pmPath, mode: "advisory" },
        ),
      ).resolves.toBeUndefined();
    });
  });
});
