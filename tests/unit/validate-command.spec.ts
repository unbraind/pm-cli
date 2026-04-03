import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runClose } from "../../src/cli/commands/close.js";
import { runValidate } from "../../src/cli/commands/validate.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import type { TempPmContext } from "../helpers/withTempPmPath.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

function createTask(context: TempPmContext, title: string): string {
  const created = context.runCli(
    [
      "create",
      "--json",
      "--title",
      title,
      "--description",
      `${title} description`,
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--tags",
      "validate,unit",
      "--body",
      "",
      "--deadline",
      "none",
      "--estimate",
      "15",
      "--acceptance-criteria",
      `${title} acceptance`,
      "--author",
      "seed-author",
      "--message",
      `Create ${title}`,
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
    ],
    { expectJson: true },
  );
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

function checkByName(result: Awaited<ReturnType<typeof runValidate>>, name: string): Record<string, unknown> {
  const found = result.checks.find((entry) => entry.name === name);
  expect(found).toBeDefined();
  return found as unknown as Record<string, unknown>;
}

describe("runValidate", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-validate-not-init-"));
    try {
      await expect(runValidate({}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs all checks by default", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-default-checks");
      const result = await runValidate({}, { path: context.pmPath });
      expect(result.checks.map((entry) => entry.name)).toEqual(["metadata", "resolution", "files", "history_drift"]);
    });
  });

  it("returns ok for requested metadata-only checks when fields are complete", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-metadata-only");
      const result = await runValidate({ checkMetadata: true }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]?.name).toBe("metadata");
      expect(result.checks[0]?.status).toBe("ok");
    });
  });

  it("reports metadata warnings for missing estimate and closed close_reason", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-metadata-missing-fields");
      await runClose(id, "done", {}, { path: context.pmPath });

      const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
      const before = await readFile(itemPath, "utf8");
      const withoutEstimate = before.replace(/^estimated_minutes:.*\n/m, "");
      const after = withoutEstimate.replace(/^close_reason:.*\n/m, "");
      expect(after).not.toBe(before);
      await writeFile(itemPath, after, "utf8");

      const result = await runValidate({ checkMetadata: true }, { path: context.pmPath });
      expect(result.ok).toBe(false);
      expect(result.warnings).toContain("validate_metadata_missing_estimate:1");
      expect(result.warnings).toContain("validate_metadata_missing_close_reason:1");
      const metadataCheck = checkByName(result, "metadata");
      expect(metadataCheck.status).toBe("warn");
      const details = metadataCheck.details as {
        counts: { missing_estimated_minutes: number; closed_missing_close_reason: number };
      };
      expect(details.counts.missing_estimated_minutes).toBe(1);
      expect(details.counts.closed_missing_close_reason).toBe(1);
    });
  });

  it("reports metadata warnings for missing author and acceptance criteria", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-metadata-missing-author-ac");
      const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
      const before = await readFile(itemPath, "utf8");
      const withoutAuthor = before.replace(/^author:.*\n/m, "");
      const after = withoutAuthor.replace(/^acceptance_criteria:.*\n/m, "");
      expect(after).not.toBe(before);
      await writeFile(itemPath, after, "utf8");

      const result = await runValidate({ checkMetadata: true }, { path: context.pmPath });
      expect(result.ok).toBe(false);
      expect(result.warnings).toContain("validate_metadata_missing_author:1");
      expect(result.warnings).toContain("validate_metadata_missing_acceptance_criteria:1");
      const metadataCheck = checkByName(result, "metadata");
      expect(metadataCheck.status).toBe("warn");
      const details = metadataCheck.details as {
        counts: { missing_author: number; missing_acceptance_criteria: number };
      };
      expect(details.counts.missing_author).toBe(1);
      expect(details.counts.missing_acceptance_criteria).toBe(1);
    });
  });

  it("reports closed items missing resolution metadata", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-resolution-gap");
      await runClose(id, "done", {}, { path: context.pmPath });

      const result = await runValidate({ checkResolution: true }, { path: context.pmPath });
      expect(result.ok).toBe(false);
      expect(result.warnings).toContain("validate_resolution_missing_fields:1");
      const resolutionCheck = checkByName(result, "resolution");
      expect(resolutionCheck.status).toBe("warn");
      const details = resolutionCheck.details as {
        checked_closed_items: number;
        missing_resolution_items: number;
      };
      expect(details.checked_closed_items).toBe(1);
      expect(details.missing_resolution_items).toBe(1);
    });
  });

  it("returns ok for closed items with complete resolution metadata", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-resolution-complete");
      const updated = context.runCli(
        [
          "update",
          id,
          "--json",
          "--resolution",
          "Applied fix",
          "--expected-result",
          "Expected behavior",
          "--actual-result",
          "Actual behavior",
          "--message",
          "Backfill resolution metadata",
        ],
        { expectJson: true },
      );
      expect(updated.code).toBe(0);
      await runClose(id, "done", {}, { path: context.pmPath });

      const result = await runValidate({ checkResolution: true }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
      const resolutionCheck = checkByName(result, "resolution");
      expect(resolutionCheck.status).toBe("ok");
      const details = resolutionCheck.details as { missing_resolution_items: number };
      expect(details.missing_resolution_items).toBe(0);
    });
  });

  it("reports missing linked file paths", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-missing-file-link");
      const linked = context.runCli(
        ["files", id, "--json", "--add", "path=src/never-created.ts,scope=project,note=missing-link"],
        { expectJson: true },
      );
      expect(linked.code).toBe(0);

      const result = await runValidate({ checkFiles: true }, { path: context.pmPath });
      expect(result.ok).toBe(false);
      expect(result.warnings).toContain("validate_files_missing_linked_paths:1");
      const filesCheck = checkByName(result, "files");
      expect(filesCheck.status).toBe("warn");
      const details = filesCheck.details as { missing_linked_paths_count: number };
      expect(details.missing_linked_paths_count).toBe(1);
    });
  });

  it("handles file-check edge cases for scope, absolute paths, and orphan detection", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-files-edge-cases");
      const workspaceRoot = path.dirname(path.dirname(context.pmPath));
      const srcDir = path.join(workspaceRoot, "src");
      const docsDir = path.join(workspaceRoot, "docs");
      const testsDir = path.join(workspaceRoot, "tests");
      const nestedDir = path.join(srcDir, "nested");
      const ignoredDir = path.join(srcDir, "node_modules");
      await Promise.all([
        mkdir(srcDir, { recursive: true }),
        mkdir(docsDir, { recursive: true }),
        mkdir(testsDir, { recursive: true }),
        mkdir(nestedDir, { recursive: true }),
        mkdir(ignoredDir, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(srcDir, "linked.ts"), "export const linked = true;\n", "utf8"),
        writeFile(path.join(srcDir, ".hidden.ts"), "hidden\n", "utf8"),
        writeFile(path.join(nestedDir, "nested.ts"), "export const nested = true;\n", "utf8"),
        writeFile(path.join(ignoredDir, "ignored.ts"), "ignored\n", "utf8"),
        writeFile(path.join(docsDir, "guide.md"), "# guide\n", "utf8"),
        writeFile(path.join(testsDir, "sample.spec.ts"), "export {};\n", "utf8"),
      ]);
      const absoluteLinkedPath = path.join(srcDir, "linked.ts");
      const addedFiles = context.runCli(
        [
          "files",
          id,
          "--json",
          "--add",
          `path=${absoluteLinkedPath},scope=project,note=absolute`,
          "--add",
          "path=src,note=directory-not-file,scope=project",
          "--add",
          "path=global/skip-me.ts,scope=global,note=global-link",
          "--add",
          "path=./,scope=project,note=empty-normalized-path",
        ],
        { expectJson: true },
      );
      expect(addedFiles.code).toBe(0);

      const result = await runValidate({ checkFiles: true }, { path: context.pmPath });
      expect(result.ok).toBe(false);
      expect(result.warnings).toContain("validate_files_missing_linked_paths:1");
      expect(result.warnings.some((warning) => warning.startsWith("validate_files_orphaned_paths:"))).toBe(true);
      const filesCheck = checkByName(result, "files");
      expect(filesCheck.status).toBe("warn");
      const details = filesCheck.details as {
        missing_linked_paths_count: number;
        orphaned_paths_count: number;
        missing_linked_paths: string[];
      };
      expect(details.missing_linked_paths_count).toBe(1);
      expect(details.orphaned_paths_count).toBeGreaterThan(0);
      expect(details.missing_linked_paths).toContain("src");
    });
  });

  it("returns ok for file checks when no project candidates or links exist", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-files-empty");
      const result = await runValidate({ checkFiles: true }, { path: context.pmPath });
      const filesCheck = checkByName(result, "files");
      expect(filesCheck.status).toBe("ok");
      const details = filesCheck.details as {
        missing_linked_paths_count: number;
        orphaned_paths_count: number;
        scanned_candidate_files: number;
      };
      expect(details.missing_linked_paths_count).toBe(0);
      expect(details.orphaned_paths_count).toBe(0);
      expect(details.scanned_candidate_files).toBe(0);
    });
  });

  it("reports history drift when streams are missing", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-history-drift");
      await rm(path.join(context.pmPath, "history", `${id}.jsonl`), { force: true });

      const result = await runValidate({ checkHistoryDrift: true }, { path: context.pmPath });
      expect(result.ok).toBe(false);
      expect(result.warnings).toContain("validate_history_drift_missing_streams:1");
      const historyCheck = checkByName(result, "history_drift");
      expect(historyCheck.status).toBe("warn");
      const details = historyCheck.details as { counts: { missing_streams: number } };
      expect(details.counts.missing_streams).toBe(1);
    });
  });

  it("aggregates missing, unreadable, and hash-mismatch history drift warnings", async () => {
    await withTempPmPath(async (context) => {
      const missingId = createTask(context, "validate-history-missing-stream");
      const emptyId = createTask(context, "validate-history-empty-stream");
      const unreadableId = createTask(context, "validate-history-after-hash-missing");
      const mismatchId = createTask(context, "validate-history-hash-drift");

      await rm(path.join(context.pmPath, "history", `${missingId}.jsonl`), { force: true });
      await writeFile(path.join(context.pmPath, "history", `${emptyId}.jsonl`), "", "utf8");
      await writeFile(path.join(context.pmPath, "history", `${unreadableId}.jsonl`), "{\"after_hash\":\"\"}\n", "utf8");

      const mismatchPath = path.join(context.pmPath, "tasks", `${mismatchId}.toon`);
      const mismatchBefore = await readFile(mismatchPath, "utf8");
      const mismatchAfter = mismatchBefore.replace(/^title:.*$/m, "title: validate-history-hash-drift-mutated");
      expect(mismatchAfter).not.toBe(mismatchBefore);
      await writeFile(mismatchPath, mismatchAfter, "utf8");

      const result = await runValidate({ checkHistoryDrift: true }, { path: context.pmPath });
      expect(result.ok).toBe(false);
      expect(result.warnings).toContain("validate_history_drift_missing_streams:2");
      expect(result.warnings).toContain("validate_history_drift_unreadable_streams:1");
      expect(result.warnings).toContain("validate_history_drift_hash_mismatches:1");
      const historyCheck = checkByName(result, "history_drift");
      expect(historyCheck.status).toBe("warn");
      const details = historyCheck.details as {
        drifted_items_count: number;
        counts: { missing_streams: number; unreadable_streams: number; hash_mismatches: number };
      };
      expect(details.drifted_items_count).toBe(4);
      expect(details.counts).toEqual({
        missing_streams: 2,
        unreadable_streams: 1,
        hash_mismatches: 1,
      });
    });
  });

  it("reports history drift when streams are unreadable", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-history-unreadable");
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await writeFile(historyPath, "{not-json}\n", "utf8");

      const result = await runValidate({ checkHistoryDrift: true }, { path: context.pmPath });
      expect(result.ok).toBe(false);
      expect(result.warnings).toContain("validate_history_drift_unreadable_streams:1");
      const historyCheck = checkByName(result, "history_drift");
      expect(historyCheck.status).toBe("warn");
      const details = historyCheck.details as { counts: { unreadable_streams: number } };
      expect(details.counts.unreadable_streams).toBe(1);
    });
  });

  it("reports history drift when current item hash mismatches latest history", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-history-hash-mismatch");
      const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
      const before = await readFile(itemPath, "utf8");
      const after = before.replace(/^title:.*$/m, "title: validate-history-hash-mismatch-mutated");
      expect(after).not.toBe(before);
      await writeFile(itemPath, after, "utf8");

      const result = await runValidate({ checkHistoryDrift: true }, { path: context.pmPath });
      expect(result.ok).toBe(false);
      expect(result.warnings).toContain("validate_history_drift_hash_mismatches:1");
      const historyCheck = checkByName(result, "history_drift");
      expect(historyCheck.status).toBe("warn");
      const details = historyCheck.details as { counts: { hash_mismatches: number } };
      expect(details.counts.hash_mismatches).toBe(1);
    });
  });
});
