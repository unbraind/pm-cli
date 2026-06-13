import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { _testOnly as dedupeInternals, runDedupeAudit } from "../../src/cli/commands/dedupe-audit.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createItem(
  context: TempPmContext,
  params: {
    title: string;
    type?: "Feature" | "Task" | "Issue" | "Chore";
    status?: "open" | "closed";
    parent?: string;
  },
): string {
  const args = [
    "create",
    "--json",
    "--title",
    params.title,
    "--description",
    `${params.title} description`,
    "--type",
    params.type ?? "Task",
    "--status",
    params.status ?? "open",
    "--priority",
    "1",
    "--tags",
    "dedupe,unit",
    "--body",
    "",
    "--deadline",
    "none",
    "--estimate",
    "15",
    "--acceptance-criteria",
    `${params.title} acceptance`,
    "--author",
    "test-author",
    "--message",
    `Create ${params.title}`,
    "--assignee",
    "none",
    "--dep",
    "none",
    "--comment",
    "none",
    "--note",
    "none",
    "--learning",
    "none",
    "--file",
    "none",
    "--test",
    "none",
    "--doc",
    "none",
  ];
  if (params.parent) {
    args.push("--parent", params.parent);
  }
  const created = context.runCli(args, { expectJson: true });
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
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
});
