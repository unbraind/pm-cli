import { describe, expect, it } from "vitest";
import {
  evaluateSimilarityGovernance,
  findSimilarItems,
  similarityAdvisoryWarnings,
  jaccardSimilarity,
  normalizeSimilarityText,
  readSettings,
  resolveItemTypeRegistry,
  scoreItemSimilarity,
  tokenizeSimilarityText,
} from "../../../src/sdk/index.js";
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
        [
          "copy",
          originalId,
          "--allow-duplicate",
          "--json",
        ],
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
