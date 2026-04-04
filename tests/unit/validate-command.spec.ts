import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runClose } from "../../src/cli/commands/close.js";
import { runInit } from "../../src/cli/commands/init.js";
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
      expect(result.checks.map((entry) => entry.name)).toEqual([
        "metadata",
        "resolution",
        "files",
        "command_references",
        "history_drift",
      ]);
    });
  });

  it("supports command-reference-only scoped checks", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-command-reference-only");
      const result = await runValidate({ checkCommandReferences: true }, { path: context.pmPath });
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]?.name).toBe("command_references");
      expect(result.checks[0]?.status).toBe("ok");
    });
  });

  it("reports stale linked command PM-id references", async () => {
    await withTempPmPath(async (context) => {
      const ownerId = createTask(context, "validate-command-reference-stale");
      const linked = context.runCli(
        [
          "test",
          ownerId,
          "--json",
          "--add",
          "command=pm get pm-missing-reference,scope=project,note=stale-reference",
        ],
        { expectJson: true },
      );
      expect(linked.code).toBe(0);

      const result = await runValidate({ checkCommandReferences: true }, { path: context.pmPath });
      expect(result.ok).toBe(false);
      expect(result.warnings).toContain("validate_command_references_stale_pm_ids:1");
      const commandCheck = checkByName(result, "command_references");
      expect(commandCheck.status).toBe("warn");
      const details = commandCheck.details as {
        linked_commands_scanned: number;
        stale_pm_id_references_count: number;
        stale_pm_ids: string[];
      };
      expect(details.linked_commands_scanned).toBe(1);
      expect(details.stale_pm_id_references_count).toBe(1);
      expect(details.stale_pm_ids).toContain("pm-missing-reference");
    });
  });

  it("ignores path-only and non-reference commands while sorting stale PM-id diagnostics", async () => {
    await withTempPmPath(async (context) => {
      const ownerId = createTask(context, "validate-command-reference-mixed");
      for (const addEntry of [
        "command=node --version,scope=project,note=non-reference",
        "command=pm get pm-zref1,scope=project,note=stale-z",
        "command=pm get pm-aref1,scope=project,note=stale-a",
      ]) {
        const linked = context.runCli(["test", ownerId, "--json", "--add", addEntry], { expectJson: true });
        expect(linked.code).toBe(0);
      }

      const itemPath = path.join(context.pmPath, "tasks", `${ownerId}.toon`);
      const before = await readFile(itemPath, "utf8");
      const testsHeaderPattern =
        /tests\[(\d+)\]\{command,path,scope,timeout_seconds,env_set,env_clear,shared_host_safe,note\}:/m;
      const headerMatch = before.match(testsHeaderPattern);
      expect(headerMatch).not.toBeNull();
      const currentCount = Number(headerMatch?.[1] ?? "0");
      const afterCount = currentCount + 1;
      const afterWithHeader = before.replace(
        testsHeaderPattern,
        `tests[${afterCount}]{command,path,scope,timeout_seconds,env_set,env_clear,shared_host_safe,note}:`,
      );
      const after = afterWithHeader.replace(
        /\nbody:/m,
        "\n  null,tests/path-only.spec.ts,project,null,null,null,null,null\nbody:",
      );
      expect(after).not.toBe(before);
      await writeFile(itemPath, after, "utf8");

      const result = await runValidate({ checkCommandReferences: true }, { path: context.pmPath });
      expect(result.ok).toBe(false);
      const commandCheck = checkByName(result, "command_references");
      expect(commandCheck.status).toBe("warn");
      const details = commandCheck.details as {
        linked_commands_scanned: number;
        stale_pm_ids: string[];
        stale_pm_id_references_count: number;
      };
      expect(details.linked_commands_scanned).toBe(3);
      expect(details.stale_pm_ids).toEqual(["pm-aref1", "pm-zref1"]);
      expect(details.stale_pm_id_references_count).toBe(2);
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
        candidate_total: number;
        candidate_scanned: number;
        scanned_candidate_files: number;
      };
      expect(details.missing_linked_paths_count).toBe(0);
      expect(details.orphaned_paths_count).toBe(0);
      expect(details.candidate_total).toBe(0);
      expect(details.candidate_scanned).toBe(0);
      expect(details.scanned_candidate_files).toBe(0);
    });
  });

  it("supports tracked-all scan mode and explicit candidate totals", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-files-tracked-all");
      const workspaceRoot = path.dirname(path.dirname(context.pmPath));
      const srcDir = path.join(workspaceRoot, "src");
      const miscDir = path.join(workspaceRoot, "misc");
      await Promise.all([mkdir(srcDir, { recursive: true }), mkdir(miscDir, { recursive: true })]);
      await Promise.all([
        writeFile(path.join(srcDir, "tracked.ts"), "export const tracked = true;\n", "utf8"),
        writeFile(path.join(miscDir, "audit.txt"), "audit\n", "utf8"),
      ]);

      const linked = context.runCli(
        [
          "files",
          id,
          "--json",
          "--add",
          "path=src/tracked.ts,scope=project,note=tracked",
          "--add",
          "path=misc/audit.txt,scope=project,note=audit",
        ],
        { expectJson: true },
      );
      expect(linked.code).toBe(0);

      const gitInit = spawnSync("git", ["init"], { cwd: workspaceRoot, encoding: "utf8" });
      expect(gitInit.status).toBe(0);
      const gitAdd = spawnSync("git", ["add", "src/tracked.ts", "misc/audit.txt"], { cwd: workspaceRoot, encoding: "utf8" });
      expect(gitAdd.status).toBe(0);

      const result = await runValidate({ checkFiles: true, scanMode: "tracked-all" }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      const filesCheck = checkByName(result, "files");
      expect(filesCheck.status).toBe("ok");
      const details = filesCheck.details as {
        scan_mode_requested: string;
        scan_mode_applied: string;
        candidate_scan_source: string;
        linked_project_paths: number;
        candidate_total: number;
        candidate_scanned: number;
        scanned_candidate_files: number;
        orphaned_paths_count: number;
      };
      expect(details.scan_mode_requested).toBe("tracked-all");
      expect(details.scan_mode_applied).toBe("tracked-all");
      expect(details.candidate_scan_source).toBe("tracked-git");
      expect(details.linked_project_paths).toBe(2);
      expect(details.candidate_total).toBe(2);
      expect(details.candidate_scanned).toBe(2);
      expect(details.scanned_candidate_files).toBe(2);
      expect(details.orphaned_paths_count).toBe(0);
    });
  });

  it("uses cwd fallback for non-standard PM root layouts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-validate-workspace-fallback-"));
    const workspaceRoot = path.join(tempDir, "workspace");
    const customPmRoot = path.join(workspaceRoot, "pm-data");
    const previousCwd = process.cwd();
    try {
      await mkdir(workspaceRoot, { recursive: true });
      process.chdir(workspaceRoot);
      await runInit(undefined, { path: customPmRoot });
      await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
      await writeFile(path.join(workspaceRoot, "src", "fallback.ts"), "export const fallback = true;\n", "utf8");

      const result = await runValidate({ checkFiles: true }, { path: customPmRoot });
      const filesCheck = checkByName(result, "files");
      expect(filesCheck.status).toBe("warn");
      const details = filesCheck.details as { candidate_total: number; candidate_scan_source: string };
      expect(details.candidate_scan_source).toBe("default-curated");
      expect(details.candidate_total).toBe(1);
    } finally {
      process.chdir(previousCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rethrows non-ENOENT errors while scanning project directories", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-files-readdir-error");
      const workspaceRoot = path.dirname(path.dirname(context.pmPath));
      await writeFile(path.join(workspaceRoot, "src"), "not-a-directory\n", "utf8");
      await expect(runValidate({ checkFiles: true }, { path: context.pmPath })).rejects.toMatchObject<{ code: string }>({
        code: "ENOTDIR",
      });
    });
  });

  it("skips non-file dirent entries while scanning default candidates", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-files-symlink-skip");
      const workspaceRoot = path.dirname(path.dirname(context.pmPath));
      const srcDir = path.join(workspaceRoot, "src");
      await mkdir(srcDir, { recursive: true });
      const realFile = path.join(srcDir, "real.ts");
      await writeFile(realFile, "export const real = true;\n", "utf8");
      await symlink(realFile, path.join(srcDir, "real-link.ts"));

      const result = await runValidate({ checkFiles: true }, { path: context.pmPath });
      const filesCheck = checkByName(result, "files");
      expect(filesCheck.status).toBe("warn");
      const details = filesCheck.details as { candidate_total: number; scanned_candidate_files: number };
      expect(details.candidate_total).toBe(1);
      expect(details.scanned_candidate_files).toBe(1);
    });
  });

  it("excludes PM internals from tracked-all by default and supports explicit inclusion", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-files-tracked-all-pm-internals");
      const workspaceRoot = path.dirname(path.dirname(context.pmPath));
      const srcDir = path.join(workspaceRoot, "src");
      await mkdir(srcDir, { recursive: true });
      await writeFile(path.join(srcDir, "tracked.ts"), "export const tracked = true;\n", "utf8");

      const linked = context.runCli(["files", id, "--json", "--add", "path=src/tracked.ts,scope=project,note=tracked"], { expectJson: true });
      expect(linked.code).toBe(0);

      const gitInit = spawnSync("git", ["init"], { cwd: workspaceRoot, encoding: "utf8" });
      expect(gitInit.status).toBe(0);
      const internalTaskPath = path.relative(workspaceRoot, path.join(context.pmPath, "tasks", `${id}.toon`)).replaceAll("\\", "/");
      const gitAdd = spawnSync("git", ["add", "src/tracked.ts", internalTaskPath], { cwd: workspaceRoot, encoding: "utf8" });
      expect(gitAdd.status).toBe(0);

      const defaultResult = await runValidate({ checkFiles: true, scanMode: "tracked-all" }, { path: context.pmPath });
      const defaultDetails = checkByName(defaultResult, "files").details as {
        include_pm_internals: boolean;
        candidate_total_raw: number;
        candidate_total: number;
        pm_internal_excluded_count: number;
        orphaned_paths_count: number;
      };
      expect(defaultDetails.include_pm_internals).toBe(false);
      expect(defaultDetails.candidate_total_raw).toBe(2);
      expect(defaultDetails.candidate_total).toBe(1);
      expect(defaultDetails.pm_internal_excluded_count).toBe(1);
      expect(defaultDetails.orphaned_paths_count).toBe(0);

      const includeResult = await runValidate(
        {
          checkFiles: true,
          scanMode: "tracked-all",
          includePmInternals: true,
        },
        { path: context.pmPath },
      );
      const includeDetails = checkByName(includeResult, "files").details as {
        include_pm_internals: boolean;
        candidate_total_raw: number;
        candidate_total: number;
        pm_internal_excluded_count: number;
        orphaned_paths_count: number;
      };
      expect(includeDetails.include_pm_internals).toBe(true);
      expect(includeDetails.candidate_total_raw).toBe(2);
      expect(includeDetails.candidate_total).toBe(2);
      expect(includeDetails.pm_internal_excluded_count).toBe(0);
      expect(includeDetails.orphaned_paths_count).toBe(1);
      expect(includeResult.warnings).toContain("validate_files_orphaned_paths:1");
    });
  });

  it("rejects unknown scan-mode values", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-files-invalid-scan-mode");
      await expect(runValidate({ checkFiles: true, scanMode: "unknown-mode" }, { path: context.pmPath })).rejects.toMatchObject<
        PmCliError
      >({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("normalizes blank and explicit default scan-mode values", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-files-default-scan-mode-normalization");
      const blankMode = await runValidate({ checkFiles: true, scanMode: "   " }, { path: context.pmPath });
      const blankDetails = checkByName(blankMode, "files").details as { scan_mode_requested: string; scan_mode_applied: string };
      expect(blankDetails.scan_mode_requested).toBe("default");
      expect(blankDetails.scan_mode_applied).toBe("default");

      const explicitDefaultMode = await runValidate({ checkFiles: true, scanMode: "default" }, { path: context.pmPath });
      const explicitDetails = checkByName(explicitDefaultMode, "files").details as {
        scan_mode_requested: string;
        scan_mode_applied: string;
      };
      expect(explicitDetails.scan_mode_requested).toBe("default");
      expect(explicitDetails.scan_mode_applied).toBe("default");
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
