import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runClose } from "../../src/cli/commands/close.js";
import * as docsCommand from "../../src/cli/commands/docs.js";
import * as filesCommand from "../../src/cli/commands/files.js";
import * as updateCommand from "../../src/cli/commands/update.js";
import { runHistoryRedact } from "../../src/cli/commands/history-redact.js";
import { runInit } from "../../src/cli/commands/init.js";
import { runValidate } from "../../src/cli/commands/validate.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import {
  DEFAULT_GRANTED_FIX_SCOPES,
  partitionFixesByGrant,
  planCloseReasonBackfillFixes,
  planResolutionBackfillFixes,
  planStaleLinkPruneFixes,
  planTerminalParentFixes,
  resolveGrantedFixScopes,
  toFixOutputRow,
  type ValidateFixRecord,
} from "../../src/core/validate/fix-planning.js";
import { buildMissingByTypeCounts } from "../../src/core/validate/missing-by-type.js";
import {
  classifyStaleLinkedPaths,
  summarizeStaleLinkedPathClassifications,
} from "../../src/core/validate/stale-file-classification.js";
import { createTestItemId } from "../helpers/itemFactory.js";
import type { TempPmContext } from "../helpers/withTempPmPath.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

function createTask(context: TempPmContext, title: string): string {
  return createTestItemId(context, {
    title,
    tags: "validate,unit",
    estimate: "15",
  });
}

function seedDependencyCycle(context: TempPmContext): [string, string, string] {
  const first = createTask(context, "validate-lifecycle-dependency-cycle-a");
  const second = createTask(context, "validate-lifecycle-dependency-cycle-b");
  const third = createTask(context, "validate-lifecycle-dependency-cycle-c");
  const cycleEdges: Array<{ from: string; to: string }> = [
    { from: first, to: second },
    { from: second, to: third },
    { from: third, to: first },
  ];
  for (const edge of cycleEdges) {
    const updated = context.runCli(
      [
        "update",
        edge.from,
        "--json",
        "--dep",
        `id=${edge.to},kind=blocks,author=seed-author,created_at=now`,
        "--message",
        "Seed lifecycle dependency cycle edge",
      ],
      { expectJson: true },
    );
    expect(updated.code).toBe(0);
  }
  return [first, second, third];
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
        "lifecycle",
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

  it("supports lifecycle-only scoped checks", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-lifecycle-only");
      const result = await runValidate({ checkLifecycle: true }, { path: context.pmPath });
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]?.name).toBe("lifecycle");
      expect(result.checks[0]?.status).toBe("ok");
      const lifecycleCheck = checkByName(result, "lifecycle");
      const details = lifecycleCheck.details as {
        stale_blocker_checks_enabled: boolean;
        stale_blocker_reason_pattern_source: string;
        closure_like_blocked_reason_pattern_source: string;
        closure_like_resolution_pattern_source: string;
        closure_like_actual_result_pattern_source: string;
      };
      expect(details.stale_blocker_checks_enabled).toBe(false);
      expect(details.stale_blocker_reason_pattern_source).toBe("default");
      expect(details.closure_like_blocked_reason_pattern_source).toBe("default");
      expect(details.closure_like_resolution_pattern_source).toBe("default");
      expect(details.closure_like_actual_result_pattern_source).toBe("default");
    });
  });

  it("reports lifecycle drift for active closure-like metadata and terminal parents", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createTask(context, "validate-lifecycle-terminal-parent");
      const childId = createTask(context, "validate-lifecycle-active-child");
      await runClose(parentId, "done", {}, { path: context.pmPath });

      const seeded = context.runCli(
        [
          "update",
          childId,
          "--json",
          "--parent",
          parentId,
          "--resolution",
          "Closed with implementation evidence captured for lifecycle validation.",
          "--actual-result",
          "Work completed and recorded with linked artifacts for lifecycle validation.",
          "--message",
          "Seed lifecycle drift fields",
        ],
        { expectJson: true },
      );
      expect(seeded.code).toBe(0);

      const result = await runValidate({ checkLifecycle: true }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
      expect(result.warnings).toContain("validate_lifecycle_active_closure_like_metadata:1");
      expect(result.warnings).toContain("validate_lifecycle_active_terminal_parent:1");
      const lifecycleCheck = checkByName(result, "lifecycle");
      expect(lifecycleCheck.status).toBe("warn");
      const details = lifecycleCheck.details as {
        active_closure_like_metadata_items: number;
        active_terminal_parent_items: number;
        active_closure_like_metadata_rows: string[];
        active_terminal_parent_rows: string[];
      };
      expect(details.active_closure_like_metadata_items).toBe(1);
      expect(details.active_terminal_parent_items).toBe(1);
      expect(details.active_closure_like_metadata_rows[0]).toContain(childId);
      expect(details.active_terminal_parent_rows[0]).toContain(childId);
      expect(details.active_terminal_parent_rows[0]).toContain(parentId);
    });
  });

  it("supports optional stale blocker diagnostics in lifecycle checks", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-lifecycle-stale-blockers");
      const seeded = context.runCli(
        [
          "update",
          id,
          "--json",
          "--blocked-by",
          "pm-stale-blocker",
          "--blocked-reason",
          "No active blocker currently; this is stale context for lifecycle diagnostics.",
          "--message",
          "Seed stale blocker metadata",
        ],
        { expectJson: true },
      );
      expect(seeded.code).toBe(0);

      const result = await runValidate({ checkStaleBlockers: true }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
      expect(result.warnings).toContain("validate_lifecycle_stale_blockers:1");
      const lifecycleCheck = checkByName(result, "lifecycle");
      expect(lifecycleCheck.status).toBe("warn");
      const details = lifecycleCheck.details as {
        stale_blocker_checks_enabled: boolean;
        stale_blocker_items: number;
        stale_blocker_rows: string[];
      };
      expect(details.stale_blocker_checks_enabled).toBe(true);
      expect(details.stale_blocker_items).toBe(1);
      expect(details.stale_blocker_rows[0]).toContain(id);
    });
  });

  it("uses configured lifecycle pattern settings and reports pattern sources", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-lifecycle-pattern-settings");
      const seeded = context.runCli(
        [
          "update",
          id,
          "--json",
          "--status",
          "blocked",
          "--blocked-by",
          "pm-pattern-blocker",
          "--blocked-reason",
          "Awaiting legal review before execution can continue.",
          "--resolution",
          "handoff review pending and should be treated as closure-like metadata for this project.",
          "--message",
          "Seed lifecycle pattern settings metadata",
        ],
        { expectJson: true },
      );
      expect(seeded.code).toBe(0);

      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        validation: {
          lifecycle_stale_blocker_reason_patterns: string[];
          lifecycle_closure_like_blocked_reason_patterns: string[];
          lifecycle_closure_like_resolution_patterns: string[];
          lifecycle_closure_like_actual_result_patterns: string[];
        };
      };
      settings.validation.lifecycle_stale_blocker_reason_patterns = ["awaiting legal review"];
      settings.validation.lifecycle_closure_like_resolution_patterns = ["handoff review pending"];
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const result = await runValidate({ checkStaleBlockers: true }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
      expect(result.warnings).toContain("validate_lifecycle_stale_blockers:1");
      expect(result.warnings).toContain("validate_lifecycle_active_closure_like_metadata:1");

      const lifecycleCheck = checkByName(result, "lifecycle");
      const details = lifecycleCheck.details as {
        stale_blocker_reason_patterns: string[];
        stale_blocker_reason_pattern_source: string;
        closure_like_resolution_patterns: string[];
        closure_like_resolution_pattern_source: string;
        closure_like_blocked_reason_pattern_source: string;
        closure_like_actual_result_pattern_source: string;
      };
      expect(details.stale_blocker_reason_patterns).toEqual(["awaiting legal review"]);
      expect(details.stale_blocker_reason_pattern_source).toBe("settings");
      expect(details.closure_like_resolution_patterns).toEqual(["handoff review pending"]);
      expect(details.closure_like_resolution_pattern_source).toBe("settings");
      expect(details.closure_like_blocked_reason_pattern_source).toBe("default");
      expect(details.closure_like_actual_result_pattern_source).toBe("default");
    });
  });

  it("reports dependency-cycle diagnostics in lifecycle checks by default", async () => {
    await withTempPmPath(async (context) => {
      const [first, second, third] = seedDependencyCycle(context);
      const result = await runValidate({ checkLifecycle: true }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
      expect(result.warnings).toContain("validate_lifecycle_dependency_cycles:1");
      const lifecycleCheck = checkByName(result, "lifecycle");
      expect(lifecycleCheck.status).toBe("warn");
      const details = lifecycleCheck.details as {
        dependency_cycle_severity_policy: string;
        dependency_cycle_count: number;
        dependency_cycle_item_count: number;
        dependency_cycle_item_ids: string[];
        dependency_cycle_sample_paths: string[];
      };
      expect(details.dependency_cycle_severity_policy).toBe("warn");
      expect(details.dependency_cycle_count).toBe(1);
      expect(details.dependency_cycle_item_count).toBe(3);
      expect(details.dependency_cycle_item_ids).toEqual([first, second, third].sort((left, right) => left.localeCompare(right)));
      expect(details.dependency_cycle_sample_paths).toHaveLength(1);
      const cyclePath = details.dependency_cycle_sample_paths[0] ?? "";
      const cycleSegments = cyclePath.split("->");
      expect(cycleSegments[0]).toBe(cycleSegments[cycleSegments.length - 1]);
      expect(cyclePath).toContain(first);
      expect(cyclePath).toContain(second);
      expect(cyclePath).toContain(third);
    });
  });

  it("supports dependency-cycle severity policy overrides", async () => {
    await withTempPmPath(async (context) => {
      seedDependencyCycle(context);

      const warnResult = await runValidate(
        { checkLifecycle: true, dependencyCycleSeverity: "error" },
        { path: context.pmPath },
      );
      expect(warnResult.ok).toBe(false);
      expect(warnResult.has_warnings).toBe(true);
      expect(warnResult.warnings).toContain("validate_lifecycle_dependency_cycles_error:1");
      expect(warnResult.warnings.some((warning) => warning.endsWith("_error:1"))).toBe(true);
      const errorLifecycleCheck = checkByName(warnResult, "lifecycle");
      expect(errorLifecycleCheck.status).toBe("error");
      const errorDetails = errorLifecycleCheck.details as {
        dependency_cycle_severity_policy: string;
        dependency_cycle_count: number;
      };
      expect(errorDetails.dependency_cycle_severity_policy).toBe("error");
      expect(errorDetails.dependency_cycle_count).toBe(1);

      const offResult = await runValidate(
        { checkLifecycle: true, dependencyCycleSeverity: "off" },
        { path: context.pmPath },
      );
      expect(offResult.ok).toBe(true);
      expect(offResult.warnings.some((warning) => warning.startsWith("validate_lifecycle_dependency_cycles"))).toBe(false);
      const offLifecycleCheck = checkByName(offResult, "lifecycle");
      expect(offLifecycleCheck.status).toBe("ok");
      const offDetails = offLifecycleCheck.details as {
        dependency_cycle_severity_policy: string;
        dependency_cycle_count: number;
      };
      expect(offDetails.dependency_cycle_severity_policy).toBe("off");
      expect(offDetails.dependency_cycle_count).toBe(1);
    });
  });

  it("rejects unknown dependency-cycle severity values", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-lifecycle-invalid-cycle-severity");
      await expect(
        runValidate({ checkLifecycle: true, dependencyCycleSeverity: "invalid" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
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
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
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
      const testsHeaderPattern = /tests\[(\d+)\](\{[^}]+\}:)/m;
      const headerMatch = before.match(testsHeaderPattern);
      expect(headerMatch).not.toBeNull();
      const currentCount = Number(headerMatch?.[1] ?? "0");
      const afterCount = currentCount + 1;
      const afterWithHeader = before.replace(
        testsHeaderPattern,
        `tests[${afterCount}]${headerMatch?.[2] ?? "{command,path,scope,timeout_seconds,env_set,env_clear,shared_host_safe,note}:"}`,
      );
      const testFields = (headerMatch?.[2] ?? "{command,path,scope}:")
        .replace(/^\{/, "")
        .replace(/\}:$/, "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const legacyPathOnlyRow = testFields
        .map((field) => {
          if (field === "command") return "null";
          if (field === "path") return "tests/path-only.spec.ts";
          if (field === "scope") return "project";
          return "null";
        })
        .join(",");
      const after = afterWithHeader.replace(
        /\nbody:/m,
        `\n  ${legacyPathOnlyRow}\nbody:`,
      );
      expect(after).not.toBe(before);
      await writeFile(itemPath, after, "utf8");

      const result = await runValidate({ checkCommandReferences: true }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
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

  it("keeps default command-reference diagnostics compact and expands them with verbose diagnostics", async () => {
    await withTempPmPath(async (context) => {
      const ownerId = createTask(context, "validate-command-reference-compact");
      for (let index = 0; index < 7; index += 1) {
        const linked = context.runCli(
          [
            "test",
            ownerId,
            "--json",
            "--add",
            `command=pm get pm-stale-${index},scope=project,note=stale-reference-${index}`,
          ],
          { expectJson: true },
        );
        expect(linked.code).toBe(0);
      }

      const compact = await runValidate({ checkCommandReferences: true }, { path: context.pmPath });
      const compactDetails = checkByName(compact, "command_references").details as {
        stale_pm_ids: string[];
        stale_pm_ids_truncated: boolean;
        stale_pm_id_reference_rows: string[];
        stale_pm_id_reference_rows_truncated: boolean;
      };
      expect(compactDetails.stale_pm_ids).toHaveLength(5);
      expect(compactDetails.stale_pm_ids_truncated).toBe(true);
      expect(compactDetails.stale_pm_id_reference_rows).toHaveLength(5);
      expect(compactDetails.stale_pm_id_reference_rows_truncated).toBe(true);

      const verbose = await runValidate(
        { checkCommandReferences: true, verboseDiagnostics: true },
        { path: context.pmPath },
      );
      const verboseDetails = checkByName(verbose, "command_references").details as {
        stale_pm_ids: string[];
        stale_pm_ids_truncated: boolean;
        stale_pm_id_reference_rows: string[];
        stale_pm_id_reference_rows_truncated: boolean;
      };
      expect(verboseDetails.stale_pm_ids).toHaveLength(7);
      expect(verboseDetails.stale_pm_ids_truncated).toBe(false);
      expect(verboseDetails.stale_pm_id_reference_rows).toHaveLength(7);
      expect(verboseDetails.stale_pm_id_reference_rows_truncated).toBe(false);
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
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
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
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
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

  it("supports strict metadata profile requirements", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-metadata-strict-profile");
      const result = await runValidate({ checkMetadata: true, metadataProfile: "strict" }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
      expect(result.warnings).toContain("validate_metadata_missing_reviewer:1");
      expect(result.warnings).toContain("validate_metadata_missing_risk:1");
      expect(result.warnings).toContain("validate_metadata_missing_confidence:1");
      expect(result.warnings).toContain("validate_metadata_missing_sprint:1");
      expect(result.warnings).toContain("validate_metadata_missing_release:1");
      const metadataCheck = checkByName(result, "metadata");
      const details = metadataCheck.details as {
        metadata_profile: string;
        required_fields: string[];
      };
      expect(details.metadata_profile).toBe("strict");
      expect(details.required_fields).toEqual(
        expect.arrayContaining(["author", "acceptance_criteria", "estimated_minutes", "close_reason", "reviewer", "risk", "confidence", "sprint", "release"]),
      );
    });
  });

  it("uses custom metadata profile required fields from settings", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-metadata-custom-profile");
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        validation: { metadata_profile: string; metadata_required_fields: string[] };
        governance?: { preset?: string; metadata_profile?: string };
      };
      settings.validation.metadata_profile = "custom";
      settings.validation.metadata_required_fields = ["sprint", "release"];
      settings.governance = {
        ...(settings.governance ?? {}),
        preset: "custom",
        metadata_profile: "custom",
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const result = await runValidate({ checkMetadata: true }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
      expect(result.warnings).toContain("validate_metadata_missing_sprint:1");
      expect(result.warnings).toContain("validate_metadata_missing_release:1");
      expect(result.warnings.some((warning) => warning.startsWith("validate_metadata_missing_reviewer:"))).toBe(false);

      const metadataCheck = checkByName(result, "metadata");
      const details = metadataCheck.details as {
        metadata_profile: string;
        required_fields: string[];
        metadata_profile_fallback_to_core: boolean;
      };
      expect(details.metadata_profile).toBe("custom");
      expect(details.required_fields).toEqual(["release", "sprint"]);
      expect(details.metadata_profile_fallback_to_core).toBe(false);
    });
  });

  it("falls back to core metadata fields when custom profile has no required-fields configured", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-metadata-custom-empty");
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        validation: { metadata_profile: string; metadata_required_fields: string[] };
        governance?: { preset?: string; metadata_profile?: string };
      };
      settings.validation.metadata_profile = "custom";
      settings.validation.metadata_required_fields = [];
      settings.governance = {
        ...(settings.governance ?? {}),
        preset: "custom",
        metadata_profile: "custom",
      };
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const result = await runValidate({ checkMetadata: true }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
      expect(result.warnings).toContain("validate_metadata_custom_profile_missing_required_fields:0");

      const metadataCheck = checkByName(result, "metadata");
      const details = metadataCheck.details as {
        metadata_profile: string;
        metadata_profile_fallback_to_core: boolean;
        required_fields: string[];
      };
      expect(details.metadata_profile).toBe("custom");
      expect(details.metadata_profile_fallback_to_core).toBe(true);
      expect(details.required_fields).toEqual(["author", "acceptance_criteria", "estimated_minutes", "close_reason"]);
    });
  });

  it("lets --metadata-profile override configured settings profile", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-metadata-profile-override");
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        validation: { metadata_profile: string };
      };
      settings.validation.metadata_profile = "strict";
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const result = await runValidate({ checkMetadata: true, metadataProfile: "core" }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
      const metadataCheck = checkByName(result, "metadata");
      const details = metadataCheck.details as { metadata_profile: string; metadata_profile_source: string };
      expect(details.metadata_profile).toBe("core");
      expect(details.metadata_profile_source).toBe("option");
    });
  });

  it("rejects unknown --metadata-profile values", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-metadata-profile-invalid");
      await expect(runValidate({ checkMetadata: true, metadataProfile: "invalid" }, { path: context.pmPath })).rejects.toMatchObject<
        PmCliError
      >({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("reports closed items missing resolution metadata", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-resolution-gap");
      await runClose(id, "done", {}, { path: context.pmPath });

      const result = await runValidate({ checkResolution: true }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
      expect(result.warnings).toContain("validate_resolution_missing_fields:1");
      const resolutionCheck = checkByName(result, "resolution");
      expect(resolutionCheck.status).toBe("warn");
      const details = resolutionCheck.details as {
        checked_closed_items: number;
        missing_resolution_items: number;
        missing_resolution_remediation_hints: string[];
      };
      expect(details.checked_closed_items).toBe(1);
      expect(details.missing_resolution_items).toBe(1);
      expect(details.missing_resolution_remediation_hints).toHaveLength(1);
      expect(details.missing_resolution_remediation_hints[0]).toContain(`pm update ${id}`);
      expect(details.missing_resolution_remediation_hints[0]).toContain("--resolution");
      expect(details.missing_resolution_remediation_hints[0]).toContain("--expected-result");
      expect(details.missing_resolution_remediation_hints[0]).toContain("--actual-result");
    });
  });

  it("keeps default resolution diagnostics compact and expands them with verbose diagnostics", async () => {
    await withTempPmPath(async (context) => {
      const closedIds: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        const id = createTask(context, `validate-resolution-gap-${index}`);
        await runClose(id, "done", {}, { path: context.pmPath });
        closedIds.push(id);
      }

      const compact = await runValidate({ checkResolution: true }, { path: context.pmPath });
      const compactDetails = checkByName(compact, "resolution").details as {
        missing_resolution_items: number;
        missing_resolution_remediation_hints: string[];
        missing_resolution_remediation_hints_truncated: boolean;
      };
      expect(compactDetails.missing_resolution_items).toBe(7);
      expect(compactDetails.missing_resolution_remediation_hints).toHaveLength(5);
      expect(compactDetails.missing_resolution_remediation_hints_truncated).toBe(true);

      const verbose = await runValidate(
        { checkResolution: true, verboseDiagnostics: true },
        { path: context.pmPath },
      );
      const verboseDetails = checkByName(verbose, "resolution").details as {
        missing_resolution_remediation_hints: string[];
        missing_resolution_remediation_hints_truncated: boolean;
      };
      expect(verboseDetails.missing_resolution_remediation_hints).toHaveLength(closedIds.length);
      expect(verboseDetails.missing_resolution_remediation_hints_truncated).toBe(false);
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
      const details = resolutionCheck.details as {
        missing_resolution_items: number;
        missing_resolution_remediation_hints: string[];
      };
      expect(details.missing_resolution_items).toBe(0);
      expect(details.missing_resolution_remediation_hints).toEqual([]);
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
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
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
          "path=src,note=existing-directory-link,scope=project",
          "--add",
          "path=src/really-gone.ts,scope=project,note=missing-file-link",
          "--add",
          "path=global/skip-me.ts,scope=global,note=global-link",
          "--add",
          "path=./,scope=project,note=empty-normalized-path",
        ],
        { expectJson: true },
      );
      expect(addedFiles.code).toBe(0);

      const result = await runValidate({ checkFiles: true }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
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
      expect(details.missing_linked_paths).toContain("src/really-gone.ts");
      expect(details.missing_linked_paths).not.toContain("src");
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

  it("uses tracker-root workspace when cwd is nested under tracker root", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-validate-workspace-root-"));
    const trackerRoot = path.join(tempDir, "tracker-root");
    const nestedCwd = path.join(trackerRoot, "extensions", "nested");
    const previousCwd = process.cwd();
    try {
      await runInit(undefined, { path: trackerRoot });
      await mkdir(path.join(trackerRoot, "src"), { recursive: true });
      await writeFile(path.join(trackerRoot, "src", "root.ts"), "export const root = true;\n", "utf8");
      await mkdir(nestedCwd, { recursive: true });
      process.chdir(nestedCwd);

      const result = await runValidate({ checkFiles: true }, { path: trackerRoot });
      const filesCheck = checkByName(result, "files");
      const details = filesCheck.details as {
        workspace_root: string;
        candidate_scan_source: string;
        candidate_total: number;
      };
      expect(details.workspace_root).toBe(path.resolve(trackerRoot));
      expect(details.candidate_scan_source).toBe("default-curated");
      expect(details.candidate_total).toBeGreaterThanOrEqual(1);
    } finally {
      process.chdir(previousCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
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
        file_list_detail_mode: string;
        file_list_summary_limit: number;
        include_pm_internals: boolean;
        include_pm_internals_requested: boolean;
        candidate_total_raw: number;
        candidate_total: number;
        pm_internal_excluded_count: number;
        excluded_by_reason: {
          pm_internals?: {
            count: number;
            paths: string[];
            paths_truncated: boolean;
            paths_total: number;
          };
        };
        orphaned_paths_count: number;
      };
      expect(defaultDetails.file_list_detail_mode).toBe("summary");
      expect(defaultDetails.file_list_summary_limit).toBe(40);
      expect(defaultDetails.include_pm_internals).toBe(false);
      expect(defaultDetails.include_pm_internals_requested).toBe(false);
      expect(defaultDetails.candidate_total_raw).toBe(2);
      expect(defaultDetails.candidate_total).toBe(1);
      expect(defaultDetails.pm_internal_excluded_count).toBe(1);
      expect(defaultDetails.excluded_by_reason.pm_internals?.count).toBe(1);
      expect(defaultDetails.excluded_by_reason.pm_internals?.paths_total).toBe(1);
      expect(defaultDetails.excluded_by_reason.pm_internals?.paths_truncated).toBe(false);
      expect(defaultDetails.excluded_by_reason.pm_internals?.paths.some((entry) => entry.endsWith(`${id}.toon`))).toBe(true);
      expect(defaultDetails.orphaned_paths_count).toBe(0);

      const verboseResult = await runValidate(
        {
          checkFiles: true,
          scanMode: "tracked-all",
          verboseFileLists: true,
        },
        { path: context.pmPath },
      );
      const verboseDetails = checkByName(verboseResult, "files").details as {
        file_list_detail_mode: string;
        include_pm_internals: boolean;
        pm_internal_excluded_count: number;
        excluded_by_reason: {
          pm_internals?: {
            count: number;
            paths: string[];
            paths_total: number;
            paths_truncated: boolean;
          };
        };
      };
      expect(verboseDetails.file_list_detail_mode).toBe("full");
      expect(verboseDetails.include_pm_internals).toBe(false);
      expect(verboseDetails.pm_internal_excluded_count).toBe(1);
      expect(verboseDetails.excluded_by_reason.pm_internals?.count).toBe(1);
      expect(verboseDetails.excluded_by_reason.pm_internals?.paths_total).toBe(1);
      expect(verboseDetails.excluded_by_reason.pm_internals?.paths_truncated).toBe(false);
      expect(verboseDetails.excluded_by_reason.pm_internals?.paths.some((entry) => entry.endsWith(`${id}.toon`))).toBe(true);

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
        include_pm_internals_requested: boolean;
        candidate_total_raw: number;
        candidate_total: number;
        pm_internal_excluded_count: number;
        excluded_by_reason: Record<string, unknown>;
        orphaned_paths_count: number;
      };
      expect(includeDetails.include_pm_internals).toBe(true);
      expect(includeDetails.include_pm_internals_requested).toBe(true);
      expect(includeDetails.candidate_total_raw).toBe(2);
      expect(includeDetails.candidate_total).toBe(2);
      expect(includeDetails.pm_internal_excluded_count).toBe(0);
      expect(includeDetails.excluded_by_reason).toEqual({});
      expect(includeDetails.orphaned_paths_count).toBe(1);
      expect(includeResult.warnings).toContain("validate_files_orphaned_paths:1");
    });
  });

  it("supports tracked-all-strict mode with explicit no-exclusion behavior", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-files-tracked-all-strict");
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

      const strictResult = await runValidate({ checkFiles: true, scanMode: "tracked-all-strict" }, { path: context.pmPath });
      const strictDetails = checkByName(strictResult, "files").details as {
        scan_mode_requested: string;
        scan_mode_applied: string;
        strict_tracked_all_mode: boolean;
        strict_mode_forces_pm_internals: boolean;
        strict_mode_forces_pm_internals_notice: string | null;
        include_pm_internals: boolean;
        include_pm_internals_requested: boolean;
        candidate_total_raw: number;
        candidate_total: number;
        pm_internal_excluded_count: number;
        excluded_by_reason: Record<string, unknown>;
      };

      expect(strictDetails.scan_mode_requested).toBe("tracked-all-strict");
      expect(strictDetails.scan_mode_applied).toBe("tracked-all-strict");
      expect(strictDetails.strict_tracked_all_mode).toBe(true);
      expect(strictDetails.strict_mode_forces_pm_internals).toBe(true);
      expect(strictDetails.strict_mode_forces_pm_internals_notice).toContain("force-enables PM internals");
      expect(strictDetails.include_pm_internals_requested).toBe(false);
      expect(strictDetails.include_pm_internals).toBe(true);
      expect(strictDetails.candidate_total_raw).toBe(2);
      expect(strictDetails.candidate_total).toBe(2);
      expect(strictDetails.pm_internal_excluded_count).toBe(0);
      expect(strictDetails.excluded_by_reason).toEqual({});
      expect(strictResult.warnings).toContain("validate_files_tracked_all_strict_forces_pm_internals");
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
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
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
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
      expect(result.warnings).toContain("validate_history_drift_missing_streams:2");
      expect(result.warnings).toContain("validate_history_drift_unreadable_streams:1");
      expect(result.warnings).toContain("validate_history_drift_hash_mismatches:1");
      const historyCheck = checkByName(result, "history_drift");
      expect(historyCheck.status).toBe("warn");
      const details = historyCheck.details as {
        drifted_items_count: number;
        counts: { missing_streams: number; unreadable_streams: number; hash_mismatches: number; chain_mismatches: number };
      };
      expect(details.drifted_items_count).toBe(4);
      expect(details.counts).toEqual({
        missing_streams: 2,
        unreadable_streams: 1,
        hash_mismatches: 1,
        chain_mismatches: 0,
      });
    });
  });

  it("reports history drift when streams are unreadable", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-history-unreadable");
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      await writeFile(historyPath, "{not-json}\n", "utf8");

      const result = await runValidate({ checkHistoryDrift: true }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
      expect(result.warnings).toContain("validate_history_drift_unreadable_streams:1");
      const historyCheck = checkByName(result, "history_drift");
      expect(historyCheck.status).toBe("warn");
      const details = historyCheck.details as { counts: { unreadable_streams: number } };
      expect(details.counts.unreadable_streams).toBe(1);
    });
  });

  it("keeps history drift checks green after audited redaction rewrites", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-history-redact-drift");
      const leakedPath = "/home/steve/private/drift";
      context.runCli(
        ["append", id, "--json", "--body", `drift ${leakedPath}`, "--author", "seed-author", "--message", "append drift payload"],
        { expectJson: true },
      );

      const redaction = await runHistoryRedact(
        id,
        {
          literal: leakedPath,
          replacement: "[redacted_path]",
          author: "seed-author",
        },
        { path: context.pmPath },
      );
      expect(redaction.changed).toBe(true);
      expect(redaction.history.verify_ok).toBe(true);

      const result = await runValidate({ checkHistoryDrift: true }, { path: context.pmPath });
      const historyCheck = checkByName(result, "history_drift");
      expect(historyCheck.status).toBe("ok");
      expect(result.warnings).not.toEqual(expect.arrayContaining(["validate_history_drift_hash_mismatches:1"]));
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
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
      expect(result.warnings).toContain("validate_history_drift_hash_mismatches:1");
      const historyCheck = checkByName(result, "history_drift");
      expect(historyCheck.status).toBe("warn");
      const details = historyCheck.details as { counts: { hash_mismatches: number } };
      expect(details.counts.hash_mismatches).toBe(1);
    });
  });

  it("reports history drift when the history chain fails but the latest item hash still matches", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-history-chain-mismatch");
      const updated = context.runCli(
        [
          "update",
          id,
          "--json",
          "--status",
          "in_progress",
          "--author",
          "seed-author",
          "--message",
          "Add second history entry",
        ],
        { expectJson: true },
      );
      expect(updated.code).toBe(0);

      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const lines = (await readFile(historyPath, "utf8"))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const firstEntry = JSON.parse(lines[0]) as { after_hash: string };
      firstEntry.after_hash = "tampered-after-hash";
      lines[0] = JSON.stringify(firstEntry);
      await writeFile(historyPath, `${lines.join("\n")}\n`, "utf8");

      const result = await runValidate({ checkHistoryDrift: true }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
      expect(result.warnings).toContain("validate_history_drift_chain_mismatches:1");
      expect(result.warnings).not.toContain("validate_history_drift_hash_mismatches:1");
      const historyCheck = checkByName(result, "history_drift");
      expect(historyCheck.status).toBe("warn");
      const details = historyCheck.details as {
        drifted_items_count: number;
        counts: { hash_mismatches: number; chain_mismatches: number };
      };
      expect(details.drifted_items_count).toBe(1);
      expect(details.counts.hash_mismatches).toBe(0);
      expect(details.counts.chain_mismatches).toBe(1);
    });
  });

  it("attaches executable fix_hints to the metadata check when --fix-hints is requested", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-metadata-fix-hints");
      const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
      const before = await readFile(itemPath, "utf8");
      const withoutAc = before.replace(/^acceptance_criteria:.*\n/m, "");
      const after = withoutAc.replace(/^estimated_minutes:.*\n/m, "");
      expect(after).not.toBe(before);
      await writeFile(itemPath, after, "utf8");

      const result = await runValidate({ checkMetadata: true, fixHints: true }, { path: context.pmPath });
      expect(result.has_warnings).toBe(true);
      const metadataCheck = checkByName(result, "metadata");
      expect(metadataCheck.status).toBe("warn");
      const fixHints = (metadataCheck.details as { fix_hints?: string[] }).fix_hints;
      expect(Array.isArray(fixHints)).toBe(true);
      expect(fixHints?.length ?? 0).toBeGreaterThan(0);
      expect(fixHints?.every((hint) => typeof hint === "string")).toBe(true);
      expect(fixHints?.some((hint) => hint.startsWith("pm update <id> --acceptance-criteria"))).toBe(true);
    });
  });

  it("aliases the resolution check per-row remediation commands into fix_hints", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-resolution-fix-hints");
      await runClose(id, "done", {}, { path: context.pmPath });

      const result = await runValidate({ checkResolution: true, fixHints: true }, { path: context.pmPath });
      expect(result.has_warnings).toBe(true);
      const resolutionCheck = checkByName(result, "resolution");
      expect(resolutionCheck.status).toBe("warn");
      const details = resolutionCheck.details as {
        fix_hints?: string[];
        missing_resolution_remediation_hints: string[];
      };
      expect(Array.isArray(details.fix_hints)).toBe(true);
      // fix_hints aliases the existing per-row remediation commands verbatim.
      expect(details.fix_hints).toEqual(details.missing_resolution_remediation_hints);
      expect(details.fix_hints?.length ?? 0).toBeGreaterThan(0);
      const firstHint = details.fix_hints?.[0] ?? "";
      expect(firstHint).toContain(id);
      expect(firstHint).toContain("--resolution");
      expect(firstHint).toContain(`pm update ${id}`);
    });
  });

  it("omits fix_hints from every check when --fix-hints is not requested", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-metadata-no-fix-hints");
      const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
      const before = await readFile(itemPath, "utf8");
      const withoutAc = before.replace(/^acceptance_criteria:.*\n/m, "");
      const after = withoutAc.replace(/^estimated_minutes:.*\n/m, "");
      expect(after).not.toBe(before);
      await writeFile(itemPath, after, "utf8");

      const result = await runValidate({ checkMetadata: true }, { path: context.pmPath });
      expect(result.has_warnings).toBe(true);
      expect(result.checks.every((check) => !Object.prototype.hasOwnProperty.call(check.details, "fix_hints"))).toBe(
        true,
      );
    });
  });

  it("groups missing required-field counts per item type in metadata details", async () => {
    await withTempPmPath(async (context) => {
      // Bare creates leave acceptance_criteria and estimated_minutes unset.
      const bareTask = context.runCli(["create", "--json", "--title", "missing-by-type-task", "--type", "Task"], {
        expectJson: true,
      });
      expect(bareTask.code).toBe(0);
      const bareFeature = context.runCli(
        ["create", "--json", "--title", "missing-by-type-feature", "--type", "Feature"],
        { expectJson: true },
      );
      expect(bareFeature.code).toBe(0);
      const completeTask = createTask(context, "missing-by-type-complete");
      expect(completeTask.length).toBeGreaterThan(0);

      const result = await runValidate({ checkMetadata: true }, { path: context.pmPath });
      const metadataCheck = checkByName(result, "metadata");
      const details = metadataCheck.details as { missing_by_type: Record<string, Record<string, number>> };
      expect(details.missing_by_type).toEqual({
        Feature: { acceptance_criteria: 1, estimated_minutes: 1 },
        Task: { acceptance_criteria: 1, estimated_minutes: 1 },
      });
    });
  });

  it("rejects --dry-run without --auto-fix or --prune-missing and --fix-scope without --auto-fix", async () => {
    await withTempPmPath(async (context) => {
      await expect(runValidate({ dryRun: true }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runValidate({ fixScope: ["lifecycle"] }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runValidate({ autoFix: true, fixScope: ["bogus"] }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("previews resolution backfills with --auto-fix --dry-run and applies them without --dry-run", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "auto-fix-resolution-backfill");
      await runClose(id, "verified in review", {}, { path: context.pmPath });

      const preview = await runValidate({ autoFix: true, dryRun: true }, { path: context.pmPath });
      expect(preview.checks.map((entry) => entry.name)).toEqual(["metadata", "resolution", "lifecycle"]);
      expect(preview.fixes).toBeDefined();
      expect(preview.fixes?.mode).toBe("dry_run");
      expect(preview.fixes?.granted_fix_scopes).toEqual(["metadata", "resolution"]);
      expect(preview.fixes?.applied_fixes).toEqual([]);
      expect(preview.fixes?.planned_fixes).toEqual([
        {
          item_id: id,
          check: "resolution",
          field: "resolution",
          command: `pm update ${id} --resolution "verified in review"`,
          gate: "resolution",
        },
      ]);

      const applied = await runValidate({ autoFix: true }, { path: context.pmPath });
      expect(applied.fixes?.mode).toBe("apply");
      expect(applied.fixes?.applied_count).toBe(1);
      expect(applied.fixes?.failed_count).toBe(0);
      expect(applied.fixes?.applied_fixes).toEqual(applied.fixes?.planned_fixes);

      const after = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(after.code).toBe(0);
      expect((after.json as { item: { resolution?: string } }).item.resolution).toBe("verified in review");

      // Convergence: a re-run plans nothing.
      const rerun = await runValidate({ autoFix: true }, { path: context.pmPath });
      expect(rerun.fixes?.planned_count).toBe(0);
    });
  });

  it("withholds lifecycle terminal-parent fixes until --fix-scope lifecycle is granted", async () => {
    await withTempPmPath(async (context) => {
      const grandparentId = createTask(context, "auto-fix-grandparent");
      const parentId = createTestItemId(context, {
        title: "auto-fix-terminal-parent",
        tags: "validate,unit",
        estimate: "15",
        parent: grandparentId,
      });
      const childId = createTestItemId(context, {
        title: "auto-fix-active-child",
        tags: "validate,unit",
        estimate: "15",
        parent: parentId,
      });
      await runClose(parentId, "parent done", {}, { path: context.pmPath });

      const preview = await runValidate(
        { checkLifecycle: true, autoFix: true, dryRun: true },
        { path: context.pmPath },
      );
      expect(preview.fixes?.planned_fixes).toEqual([
        {
          item_id: childId,
          check: "lifecycle",
          field: "parent",
          command: `pm update ${childId} --parent ${grandparentId}`,
          gate: "lifecycle",
        },
      ]);
      expect(preview.fixes?.gated_count).toBe(1);

      // Without the explicit lifecycle grant nothing is applied.
      const withheld = await runValidate({ checkLifecycle: true, autoFix: true }, { path: context.pmPath });
      expect(withheld.fixes?.applied_count).toBe(0);
      expect(withheld.fixes?.gated_count).toBe(1);
      expect(withheld.fixes?.gated_fixes[0]).toMatchObject({
        item_id: childId,
        gate: "lifecycle",
        gate_hint: "Withheld: re-run with --fix-scope lifecycle to apply.",
      });

      const granted = await runValidate(
        { checkLifecycle: true, autoFix: true, fixScope: ["lifecycle"] },
        { path: context.pmPath },
      );
      expect(granted.fixes?.granted_fix_scopes).toEqual(["lifecycle"]);
      expect(granted.fixes?.applied_count).toBe(1);
      expect(granted.fixes?.failed_count).toBe(0);

      const after = context.runCli(["get", childId, "--json"], { expectJson: true });
      expect((after.json as { item: { parent?: string } }).item.parent).toBe(grandparentId);
    });
  });

  it("clears the parent link when no active grandparent exists and an exact --fix-scope withholds safe fixes", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createTask(context, "auto-fix-rootless-terminal-parent");
      const childId = createTestItemId(context, {
        title: "auto-fix-rootless-child",
        tags: "validate,unit",
        estimate: "15",
        parent: parentId,
      });
      await runClose(parentId, "parent done", {}, { path: context.pmPath });

      // --fix-scope lifecycle is an exact allowlist: the closed parent's own
      // missing-resolution backfill is planned but withheld as gated.
      const result = await runValidate({ autoFix: true, fixScope: ["lifecycle"] }, { path: context.pmPath });
      expect(result.fixes?.planned_fixes).toContainEqual({
        item_id: childId,
        check: "lifecycle",
        field: "parent",
        command: `pm update ${childId} --unset parent`,
        gate: "lifecycle",
      });
      expect(result.fixes?.gated_fixes.map((row) => row.item_id)).toEqual([parentId]);
      expect(result.fixes?.applied_count).toBe(1);

      const after = context.runCli(["get", childId, "--json"], { expectJson: true });
      expect((after.json as { item: { parent?: string } }).item.parent).toBeUndefined();
      const parentAfter = context.runCli(["get", parentId, "--json"], { expectJson: true });
      expect((parentAfter.json as { item: { resolution?: string } }).item.resolution).toBeUndefined();
    });
  });

  it("backfills close_reason from resolution under the metadata fix scope", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "auto-fix-close-reason-backfill");
      await runClose(id, "done", {}, { path: context.pmPath });
      const seeded = context.runCli(
        ["update", id, "--json", "--resolution", "shipped in v2", "--unset", "close-reason", "--message", "seed"],
        { expectJson: true },
      );
      expect(seeded.code).toBe(0);

      const result = await runValidate({ checkMetadata: true, autoFix: true }, { path: context.pmPath });
      expect(result.fixes?.applied_fixes).toEqual([
        {
          item_id: id,
          check: "metadata",
          field: "close_reason",
          command: `pm update ${id} --close-reason "shipped in v2"`,
          gate: "metadata",
        },
      ]);
      const after = context.runCli(["get", id, "--json"], { expectJson: true });
      expect((after.json as { item: { close_reason?: string } }).item.close_reason).toBe("shipped in v2");
    });
  });

  it("classifies stale linked paths as moved or deleted and prunes only deleted links", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "prune-missing-links");
      const workspaceRoot = path.dirname(path.dirname(context.pmPath));
      const newDir = path.join(workspaceRoot, "src", "new");
      await mkdir(newDir, { recursive: true });
      await writeFile(path.join(newDir, "moved-file.ts"), "export const moved = true;\n", "utf8");

      const linkedFiles = context.runCli(
        [
          "files",
          id,
          "--json",
          "--add",
          "path=src/old/moved-file.ts,scope=project",
          "--add",
          "path=src/gone/deleted-file.ts,scope=project",
          "--add",
          "path=src/gone/another-deleted-file.ts,scope=project",
        ],
        { expectJson: true },
      );
      expect(linkedFiles.code).toBe(0);
      const linkedDocs = context.runCli(
        [
          "docs",
          id,
          "--json",
          "--add",
          "path=docs/gone-doc.md,scope=project",
          "--add",
          "path=docs/another-gone-doc.md,scope=project",
        ],
        {
          expectJson: true,
        },
      );
      expect(linkedDocs.code).toBe(0);

      const preview = await runValidate({ pruneMissing: true, dryRun: true }, { path: context.pmPath });
      expect(preview.checks.map((entry) => entry.name)).toEqual(["files"]);
      const filesCheck = checkByName(preview, "files");
      const details = filesCheck.details as {
        missing_linked_paths_moved_count: number;
        missing_linked_paths_deleted_count: number;
        missing_linked_path_classifications: string[];
      };
      expect(details.missing_linked_paths_moved_count).toBe(1);
      expect(details.missing_linked_paths_deleted_count).toBe(4);
      expect(details.missing_linked_path_classifications).toEqual([
        "docs/another-gone-doc.md:deleted",
        "docs/gone-doc.md:deleted",
        "src/gone/another-deleted-file.ts:deleted",
        "src/gone/deleted-file.ts:deleted",
        "src/old/moved-file.ts:moved:src/new/moved-file.ts",
      ]);
      expect(preview.fixes?.mode).toBe("dry_run");
      expect(preview.fixes?.planned_fixes).toEqual([
        { item_id: id, check: "files", field: "docs", command: `pm docs ${id} --remove "docs/another-gone-doc.md"` },
        { item_id: id, check: "files", field: "docs", command: `pm docs ${id} --remove "docs/gone-doc.md"` },
        {
          item_id: id,
          check: "files",
          field: "files",
          command: `pm files ${id} --remove "src/gone/another-deleted-file.ts"`,
        },
        { item_id: id, check: "files", field: "files", command: `pm files ${id} --remove "src/gone/deleted-file.ts"` },
      ]);

      const filesSpy = vi.spyOn(filesCommand, "runFiles");
      const docsSpy = vi.spyOn(docsCommand, "runDocs");
      try {
        const applied = await runValidate({ pruneMissing: true }, { path: context.pmPath });
        expect(applied.fixes?.applied_count).toBe(4);
        expect(applied.fixes?.failed_count).toBe(0);
        const removeFileCalls = filesSpy.mock.calls.filter((call) => call[1]?.remove !== undefined);
        const removeDocCalls = docsSpy.mock.calls.filter((call) => call[1]?.remove !== undefined);
        expect(removeFileCalls).toHaveLength(1);
        expect(removeFileCalls[0]?.[1]?.remove).toEqual(["src/gone/another-deleted-file.ts", "src/gone/deleted-file.ts"]);
        expect(removeDocCalls).toHaveLength(1);
        expect(removeDocCalls[0]?.[1]?.remove).toEqual(["docs/another-gone-doc.md", "docs/gone-doc.md"]);
      } finally {
        filesSpy.mockRestore();
        docsSpy.mockRestore();
      }

      const filesAfter = context.runCli(["files", id, "--json", "--list"], { expectJson: true });
      expect(
        ((filesAfter.json as { files: Array<{ path: string }> }).files ?? []).map((entry) => entry.path),
      ).toEqual(["src/old/moved-file.ts"]);
      const docsAfter = context.runCli(["docs", id, "--json", "--list"], { expectJson: true });
      expect((docsAfter.json as { docs: Array<{ path: string }> }).docs ?? []).toEqual([]);
    });
  });

  it("reports failed batched prune fixes without aborting validation", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "prune-missing-link-failure");
      const linkedFiles = context.runCli(
        [
          "files",
          id,
          "--json",
          "--add",
          "path=src/gone/failure-a.ts,scope=project",
          "--add",
          "path=src/gone/failure-b.ts,scope=project",
        ],
        { expectJson: true },
      );
      expect(linkedFiles.code).toBe(0);

      const filesSpy = vi.spyOn(filesCommand, "runFiles").mockRejectedValueOnce(new Error("files prune failed"));
      try {
        const result = await runValidate({ pruneMissing: true }, { path: context.pmPath });

        expect(result.fixes?.mode).toBe("apply");
        expect(result.fixes?.planned_count).toBe(2);
        expect(result.fixes?.applied_count).toBe(0);
        expect(result.fixes?.failed_count).toBe(2);
        expect(result.fixes?.failed_fixes).toEqual([
          {
            item_id: id,
            check: "files",
            field: "files",
            command: `pm files ${id} --remove "src/gone/failure-a.ts"`,
            error: "files prune failed",
          },
          {
            item_id: id,
            check: "files",
            field: "files",
            command: `pm files ${id} --remove "src/gone/failure-b.ts"`,
            error: "files prune failed",
          },
        ]);
      } finally {
        filesSpy.mockRestore();
      }
    });
  });

  it("reports failed scalar auto-fixes without aborting validation", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "resolution-failure");
      await runClose(id, "closed without resolution", {}, { path: context.pmPath });

      const updateSpy = vi.spyOn(updateCommand, "runUpdate").mockRejectedValueOnce(new Error("update failed"));
      try {
        const result = await runValidate({ autoFix: true }, { path: context.pmPath });

        expect(result.fixes?.mode).toBe("apply");
        expect(result.fixes?.planned_count).toBeGreaterThanOrEqual(1);
        expect(result.fixes?.applied_count).toBe(0);
        expect(result.fixes?.failed_fixes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              item_id: id,
              check: "resolution",
              field: "resolution",
              command: `pm update ${id} --resolution "closed without resolution"`,
              error: "update failed",
            }),
          ]),
        );
      } finally {
        updateSpy.mockRestore();
      }
    });
  });
});

describe("validate fix planning core modules", () => {
  it("plans resolution backfills only for rows missing resolution, deriving from close_reason", () => {
    const fixes = planResolutionBackfillFixes([
      { id: "pm-a", missing_fields: ["resolution"], close_reason: "merged PR #5" },
      { id: "pm-b", missing_fields: ["resolution", "expected_result"] },
      { id: "pm-c", missing_fields: ["expected_result", "actual_result"], close_reason: "irrelevant" },
      { id: "pm-d", missing_fields: ["resolution"], close_reason: "   " },
    ]);
    expect(fixes).toEqual([
      {
        item_id: "pm-a",
        check: "resolution",
        field: "resolution",
        kind: "set_resolution",
        value: "merged PR #5",
        command: 'pm update pm-a --resolution "merged PR #5"',
        gate: "resolution",
      },
      {
        item_id: "pm-b",
        check: "resolution",
        field: "resolution",
        kind: "set_resolution",
        value: "completed",
        command: 'pm update pm-b --resolution "completed"',
        gate: "resolution",
      },
      {
        item_id: "pm-d",
        check: "resolution",
        field: "resolution",
        kind: "set_resolution",
        value: "completed",
        command: 'pm update pm-d --resolution "completed"',
        gate: "resolution",
      },
    ]);
  });

  it("escapes quotes and backslashes in equivalent commands", () => {
    const fixes = planResolutionBackfillFixes([
      { id: "pm-q", missing_fields: ["resolution"], close_reason: 'fixed "edge\\case"' },
    ]);
    expect(fixes[0]?.command).toBe('pm update pm-q --resolution "fixed \\"edge\\\\case\\""');
  });

  it("plans close_reason backfills only when a resolution source exists", () => {
    const fixes = planCloseReasonBackfillFixes([
      { id: "pm-a", resolution: "shipped" },
      { id: "pm-b" },
      { id: "pm-c", resolution: "  " },
    ]);
    expect(fixes).toEqual([
      {
        item_id: "pm-a",
        check: "metadata",
        field: "close_reason",
        kind: "set_close_reason",
        value: "shipped",
        command: 'pm update pm-a --close-reason "shipped"',
        gate: "metadata",
      },
    ]);
  });

  it("plans reparent fixes toward active grandparents and unset-parent fixes otherwise", () => {
    const fixes = planTerminalParentFixes([
      { id: "pm-a", parent_id: "pm-p", grandparent_id: "pm-g", grandparent_active: true },
      { id: "pm-b", parent_id: "pm-p" },
      { id: "pm-c", parent_id: "pm-p", grandparent_id: "pm-g", grandparent_active: false },
    ]);
    expect(fixes).toEqual([
      {
        item_id: "pm-a",
        check: "lifecycle",
        field: "parent",
        kind: "reparent",
        parent_id: "pm-g",
        command: "pm update pm-a --parent pm-g",
        gate: "lifecycle",
      },
      {
        item_id: "pm-b",
        check: "lifecycle",
        field: "parent",
        kind: "unset_parent",
        command: "pm update pm-b --unset parent",
        gate: "lifecycle",
      },
      {
        item_id: "pm-c",
        check: "lifecycle",
        field: "parent",
        kind: "unset_parent",
        command: "pm update pm-c --unset parent",
        gate: "lifecycle",
      },
    ]);
  });

  it("plans link prunes for deleted classifications only, across files and docs", () => {
    const fixes = planStaleLinkPruneFixes([
      { item_id: "pm-a", path: "src/gone.ts", link_kind: "files", classification: "deleted" },
      { item_id: "pm-a", path: "docs/gone.md", link_kind: "docs", classification: "deleted" },
      { item_id: "pm-b", path: "src/moved.ts", link_kind: "files", classification: "moved" },
    ]);
    expect(fixes).toEqual([
      {
        item_id: "pm-a",
        check: "files",
        field: "files",
        kind: "prune_file_link",
        path: "src/gone.ts",
        command: 'pm files pm-a --remove "src/gone.ts"',
      },
      {
        item_id: "pm-a",
        check: "files",
        field: "docs",
        kind: "prune_doc_link",
        path: "docs/gone.md",
        command: 'pm docs pm-a --remove "docs/gone.md"',
      },
    ]);
  });

  it("resolves granted fix scopes from defaults, repeats, comma lists, and aliases", () => {
    expect([...resolveGrantedFixScopes(undefined)].sort()).toEqual([...DEFAULT_GRANTED_FIX_SCOPES].sort());
    expect([...resolveGrantedFixScopes([])].sort()).toEqual([...DEFAULT_GRANTED_FIX_SCOPES].sort());
    expect([...resolveGrantedFixScopes(["lifecycle"])]).toEqual(["lifecycle"]);
    expect([...resolveGrantedFixScopes(["metadata,LIFECYCLE", "resolution"])].sort()).toEqual([
      "lifecycle",
      "metadata",
      "resolution",
    ]);
    expect(() => resolveGrantedFixScopes(["bogus"])).toThrowError(PmCliError);
    expect(() => resolveGrantedFixScopes(["  "])).toThrowError(PmCliError);
  });

  it("partitions fixes by granted gate scopes", () => {
    const gatedFix: ValidateFixRecord = {
      item_id: "pm-a",
      check: "lifecycle",
      field: "parent",
      kind: "unset_parent",
      command: "pm update pm-a --unset parent",
      gate: "lifecycle",
    };
    const ungatedFix: ValidateFixRecord = {
      item_id: "pm-b",
      check: "files",
      field: "files",
      kind: "prune_file_link",
      path: "src/gone.ts",
      command: 'pm files pm-b --remove "src/gone.ts"',
    };
    const withheld = partitionFixesByGrant([gatedFix, ungatedFix], new Set(["metadata", "resolution"]));
    expect(withheld.applicable).toEqual([ungatedFix]);
    expect(withheld.gated).toEqual([gatedFix]);
    const granted = partitionFixesByGrant([gatedFix, ungatedFix], new Set(["lifecycle"]));
    expect(granted.applicable).toEqual([gatedFix, ungatedFix]);
    expect(granted.gated).toEqual([]);
  });

  it("serializes compact fix output rows with optional gates", () => {
    expect(
      toFixOutputRow({
        item_id: "pm-a",
        check: "resolution",
        field: "resolution",
        kind: "set_resolution",
        value: "done",
        command: 'pm update pm-a --resolution "done"',
        gate: "resolution",
      }),
    ).toEqual({
      item_id: "pm-a",
      check: "resolution",
      field: "resolution",
      command: 'pm update pm-a --resolution "done"',
      gate: "resolution",
    });
    expect(
      toFixOutputRow({
        item_id: "pm-b",
        check: "files",
        field: "files",
        kind: "prune_file_link",
        path: "src/gone.ts",
        command: 'pm files pm-b --remove "src/gone.ts"',
      }),
    ).toEqual({
      item_id: "pm-b",
      check: "files",
      field: "files",
      command: 'pm files pm-b --remove "src/gone.ts"',
    });
  });

  it("classifies stale linked paths by basename with sorted, capped candidates", () => {
    const classified = classifyStaleLinkedPaths(
      ["src/old/app.ts", "docs/gone.md", "root-file.ts"],
      ["src/z/app.ts", "src/a/app.ts", "src/b/app.ts", "src/c/app.ts", "root-file.ts", ""],
      3,
    );
    expect(classified).toEqual([
      {
        path: "src/old/app.ts",
        classification: "moved",
        candidates: ["src/a/app.ts", "src/b/app.ts", "src/c/app.ts"],
        candidates_truncated: true,
      },
      { path: "docs/gone.md", classification: "deleted", candidates: [], candidates_truncated: false },
      // The identical missing path itself never counts as a relink candidate.
      { path: "root-file.ts", classification: "deleted", candidates: [], candidates_truncated: false },
    ]);
    expect(summarizeStaleLinkedPathClassifications(classified)).toEqual([
      "src/old/app.ts:moved:src/a/app.ts",
      "docs/gone.md:deleted",
      "root-file.ts:deleted",
    ]);
  });

  it("classifies stale linked Windows-style paths by basename", () => {
    expect(classifyStaleLinkedPaths(["src\\old\\app.ts"], ["src/new/app.ts"])).toEqual([
      {
        path: "src\\old\\app.ts",
        classification: "moved",
        candidates: ["src/new/app.ts"],
        candidates_truncated: false,
      },
    ]);
  });

  it("falls back to the default candidate limit for invalid limits and floors fractional limits", () => {
    const moved = classifyStaleLinkedPaths(
      ["lib/util.ts"],
      ["a/util.ts", "b/util.ts", "c/util.ts", "d/util.ts", "e/util.ts"],
      0,
    );
    expect(moved[0]?.candidates).toHaveLength(3);
    expect(moved[0]?.candidates_truncated).toBe(true);
    const floored = classifyStaleLinkedPaths(["lib/util.ts"], ["a/util.ts", "b/util.ts", "c/util.ts"], 2.7);
    expect(floored[0]?.candidates).toEqual(["a/util.ts", "b/util.ts"]);
    expect(floored[0]?.candidates_truncated).toBe(true);
    const exact = classifyStaleLinkedPaths(["lib/util.ts"], ["a/util.ts"], 5);
    expect(exact[0]?.candidates).toEqual(["a/util.ts"]);
    expect(exact[0]?.candidates_truncated).toBe(false);
  });

  it("aggregates missing-field occurrences into sorted per-type counts", () => {
    expect(buildMissingByTypeCounts([])).toEqual({});
    expect(
      buildMissingByTypeCounts([
        { item_type: "Task", field: "close_reason" },
        { item_type: "Task", field: "close_reason" },
        { item_type: "Task", field: "author" },
        { item_type: "Bug", field: "close_reason" },
      ]),
    ).toEqual({
      Bug: { close_reason: 1 },
      Task: { author: 1, close_reason: 2 },
    });
  });
});
