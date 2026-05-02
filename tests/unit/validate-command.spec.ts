import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runClose } from "../../src/cli/commands/close.js";
import { runInit } from "../../src/cli/commands/init.js";
import { runValidate } from "../../src/cli/commands/validate.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
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
      expect(result.ok).toBe(false);
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
      expect(result.ok).toBe(false);
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
      expect(result.ok).toBe(false);
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
      expect(result.ok).toBe(false);
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
      expect(warnResult.warnings).toContain("validate_lifecycle_dependency_cycles_error:1");
      const errorLifecycleCheck = checkByName(warnResult, "lifecycle");
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

  it("supports strict metadata profile requirements", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-metadata-strict-profile");
      const result = await runValidate({ checkMetadata: true, metadataProfile: "strict" }, { path: context.pmPath });
      expect(result.ok).toBe(false);
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
      expect(result.ok).toBe(false);
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
      expect(result.ok).toBe(false);
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
      expect(result.ok).toBe(false);
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
