import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDedupeAudit } from "../../src/cli/commands/dedupe-audit.js";
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
