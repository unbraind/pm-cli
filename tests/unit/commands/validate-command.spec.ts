import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runClose } from "../../../src/cli/commands/close.js";
import * as docsCommand from "../../../src/sdk/docs.js";
import * as filesCommand from "../../../src/sdk/files.js";
import * as updateCommand from "../../../src/cli/commands/update.js";
import { runHistoryRedact } from "../../../src/cli/commands/history-redact.js";
import { runInit } from "../../../src/cli/commands/init.js";
import { _testOnlyValidateCommand as validateInternals, runValidate } from "../../../src/cli/commands/validate.js";
import { EXIT_CODE, SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";
import { resolveRuntimeStatusRegistry } from "../../../src/core/schema/runtime-schema.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
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
} from "../../../src/core/validate/fix-planning.js";
import { buildMissingByTypeCounts } from "../../../src/core/validate/missing-by-type.js";
import {
  classifyStaleLinkedPaths,
  summarizeStaleLinkedPathClassifications,
} from "../../../src/core/validate/stale-file-classification.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import type { TempPmContext } from "../../helpers/withTempPmPath.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

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

function seedParentCycle(context: TempPmContext, length: 2 | 3 = 3): string[] {
  const ids =
    length === 2
      ? [createTask(context, "validate-parent-cycle-a"), createTask(context, "validate-parent-cycle-b")]
      : [
          createTask(context, "validate-parent-cycle-a"),
          createTask(context, "validate-parent-cycle-b"),
          createTask(context, "validate-parent-cycle-c"),
        ];
  // Wire each item's parent to the next, closing the ring back to the first
  // (A->B->...->A) so the composition graph contains a true cycle.
  for (let index = 0; index < ids.length; index += 1) {
    const child = ids[index]!;
    const parent = ids[(index + 1) % ids.length]!;
    const updated = context.runCli(
      ["update", child, "--parent", parent, "--json", "--message", "Seed parent-hierarchy cycle edge"],
      { expectJson: true },
    );
    expect(updated.code).toBe(0);
  }
  return ids;
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
        "dependency_references",
        "files",
        "command_references",
        "history_drift",
        "format_version",
      ]);
    });
  });

  it("covers metadata summary helper defensive fallback branches", () => {
    type MetadataPolicy = Parameters<typeof validateInternals.buildMissingFieldOccurrences>[0];
    type MissingByField = Parameters<typeof validateInternals.buildMissingFieldOccurrences>[1];
    type ItemsById = Parameters<typeof validateInternals.buildMissingFieldOccurrences>[2];
    type ItemForValidate = ItemsById extends Map<string, infer Item> ? Item : never;
    const metadataPolicy = {
      required_fields: ["author", "acceptance_criteria", "close_reason", "estimated_minutes"],
    } as MetadataPolicy;
    const missingByField = {
      acceptance_criteria: ["pm-known", "pm-unknown-type"],
      close_reason: ["pm-closed"],
      estimated_minutes: ["pm-estimate"],
    } as MissingByField;
    const itemsById = new Map<string, ItemForValidate>([
      ["pm-known", { type: "Bug" } as ItemForValidate],
      ["pm-unknown-type", { type: "" } as ItemForValidate],
      ["pm-closed", { resolution: "Fixed" } as ItemForValidate],
      ["pm-estimate", { type: "Task" } as ItemForValidate],
    ]);

    expect(validateInternals.buildMissingFieldOccurrences(metadataPolicy, missingByField, itemsById)).toEqual([
      { item_type: "Bug", field: "acceptance_criteria" },
      { item_type: "Unknown", field: "acceptance_criteria" },
      { item_type: "Unknown", field: "close_reason" },
      { item_type: "Task", field: "estimated_minutes" },
    ]);
    expect(validateInternals.buildMetadataCounts(metadataPolicy, missingByField)).toMatchObject({
      missing_acceptance_criteria: 2,
      closed_missing_close_reason: 1,
      missing_estimated_minutes: 1,
    });
    expect(
      validateInternals.buildCloseReasonBackfillRows(
        { required_fields: ["author"] } as MetadataPolicy,
        missingByField,
        itemsById,
      ),
    ).toEqual([]);
    expect(
      validateInternals.buildCloseReasonBackfillRows(
        { required_fields: ["close_reason"] } as MetadataPolicy,
        {} as MissingByField,
        itemsById,
      ),
    ).toEqual([]);
    expect(validateInternals.buildCloseReasonBackfillRows(metadataPolicy, missingByField, itemsById)).toEqual([
      { id: "pm-closed", resolution: "Fixed" },
    ]);
    expect(
      validateInternals.buildEstimateBackfillRows(
        { required_fields: ["author"] } as MetadataPolicy,
        missingByField,
        itemsById,
      ),
    ).toEqual([]);
    expect(
      validateInternals.buildEstimateBackfillRows(
        { required_fields: ["estimated_minutes"] } as MetadataPolicy,
        {} as MissingByField,
        itemsById,
      ),
    ).toEqual([]);
    expect(validateInternals.buildEstimateBackfillRows(metadataPolicy, missingByField, itemsById)).toEqual([
      { id: "pm-estimate", type: "Task" },
    ]);
  });

  it("reports a clean format-version check for a baseline tracker", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-format-version-baseline");
      const result = await runValidate({}, { path: context.pmPath });
      const check = checkByName(result, "format_version");
      expect(check.status).toBe("ok");
      expect(check.details).toMatchObject({
        current_format_version: 1,
        outdated_items_count: 0,
        ahead_items_count: 0,
      });
      expect(result.warnings.some((warning) => warning.startsWith("validate_format_version_"))).toBe(false);
    });
  });

  it("errors when an item was written by a newer format version", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-format-version-baseline");
      await writeFile(
        path.join(context.pmPath, "tasks", "pm-ahead.toon"),
        [
          "id: pm-ahead",
          "title: Future format item",
          'description: ""',
          "type: Task",
          "pm_format_version: 2",
          "status: open",
          "priority: 2",
          "tags: []",
          'created_at: "2026-02-22T00:00:00.000Z"',
          'updated_at: "2026-02-22T00:00:00.000Z"',
          "author: test-author",
          'body: ""',
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runValidate({}, { path: context.pmPath });
      const check = checkByName(result, "format_version");
      expect(check.status).toBe("error");
      expect(check.details).toMatchObject({ ahead_items_count: 1, ahead_items: ["pm-ahead"] });
      expect(result.ok).toBe(false);
      expect(result.warnings).toEqual(expect.arrayContaining(["validate_format_version_ahead_items:1"]));
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
      expect(result.checks).toHaveLength(2);
      expect(result.checks[0]?.name).toBe("lifecycle");
      expect(result.checks[0]?.status).toBe("ok");
      expect(result.checks[1]?.name).toBe("dependency_references");
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

  it("reports dangling structured dependency references with remediation", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "dangling-dependency");
      context.runCli(["update", id, "--dep", "id=pm-ghost,kind=blocked_by", "--json"], { expectJson: true });
      const secondId = createTask(context, "second-dangling-dependency");
      context.runCli(["update", secondId, "--dep", "id=pm-phantom,kind=blocked_by", "--json"], { expectJson: true });
      const result = await runValidate({ checkLifecycle: true }, { path: context.pmPath });
      const check = checkByName(result, "dependency_references");
      expect(check.status).toBe("warn");
      expect(check.details).toMatchObject({ dangling_reference_count: 2 });
      expect((check.details.remediation_hints as string[])[0]).toContain("--replace-deps");
      const sourceAwareCheck = validateInternals.buildDependencyReferencesCheck([
        {
          id: "pm-source-aware",
          status: "open",
          blocked_by: "pm-scalar-missing",
          dependencies: [{ id: "pm-edge-missing", kind: "blocked_by" }],
        },
      ] as never, true).check;
      expect(sourceAwareCheck.details.remediation_hints).toEqual([
        "pm update pm-source-aware --replace-deps '<correct dependency edges>'",
        "pm update pm-source-aware --unset blocked_by",
      ]);
      const multiRowCheck = validateInternals.buildDependencyReferencesCheck([
        { id: "pm-b", parent: "pm-missing-b", dependencies: [] },
        { id: "pm-a", parent: "pm-missing-a", dependencies: [] },
      ] as never, true).check;
      expect(multiRowCheck.details.dangling_reference_rows).toEqual([
        "pm-a:pm-missing-a:parent",
        "pm-b:pm-missing-b:parent",
      ]);
      expect(multiRowCheck.details.remediation_hints).toEqual([
        "pm update pm-a --unset parent",
        "pm update pm-b --unset parent",
      ]);
      const partitionedCheck = validateInternals.buildDependencyReferencesCheck([
        { id: "pm-active", status: "open", parent: "pm-active-missing", dependencies: [] },
        {
          id: "pm-closed",
          status: "closed",
          blocked_by: "no-active-blocker",
          dependencies: [{ id: "pm-legacy-missing", kind: "related" }],
        },
      ] as never, true).check;
      expect(partitionedCheck.status).toBe("warn");
      expect(partitionedCheck.details).toMatchObject({
        dangling_reference_count: 3,
        active_dangling_reference_count: 1,
        legacy_terminal_dangling_reference_count: 2,
        legacy_closed_dangling_reference_count: 2,
        no_active_blocker_sentinel_count: 1,
      });
      expect(partitionedCheck.details.remediation_hints).toEqual([
        "pm update pm-active --unset parent",
      ]);

      const historicalOnlyCheck = validateInternals.buildDependencyReferencesCheck([
        {
          id: "pm-closed",
          status: "closed",
          blocked_by: "no-active-blocker",
          dependencies: [],
        },
      ] as never, true).check;
      expect(historicalOnlyCheck.status).toBe("ok");
      expect(historicalOnlyCheck.details).toMatchObject({
        dangling_reference_count: 1,
        active_dangling_reference_count: 0,
        legacy_terminal_dangling_reference_count: 1,
      });
      expect(historicalOnlyCheck.details.remediation_hints).toEqual([]);

      const activeSentinelCheck = validateInternals.buildDependencyReferencesCheck([
        {
          id: "pm-active-sentinel",
          status: "open",
          blocked_by: "no-active-blocker",
          dependencies: [],
        },
      ] as never, true).check;
      expect(activeSentinelCheck.details).toMatchObject({
        active_dangling_reference_count: 1,
        no_active_blocker_sentinel_count: 1,
      });

      const canceledOnlyCheck = validateInternals.buildDependencyReferencesCheck([
        {
          id: "pm-canceled",
          status: "canceled",
          parent: "pm-historical-missing",
          dependencies: [],
        },
      ] as never, true).check;
      expect(canceledOnlyCheck.details).toMatchObject({
        legacy_terminal_dangling_reference_count: 1,
        legacy_closed_dangling_reference_count: 0,
      });
    });
  });

  it("covers validate helper edge branches for lifecycle, files, and fix application", async () => {
    const statusRegistry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);
    expect(validateInternals.toMeaningfulString(" none ")).toBeUndefined();
    expect(validateInternals.toMeaningfulString("value")).toBe("value");
    expect(validateInternals.linkedArtifactPathExceedsFilesystemLimits(`src/${"a".repeat(5000)}.ts`)).toBe(true);
    expect(validateInternals.linkedArtifactPathExceedsFilesystemLimits(`src/${"a".repeat(256)}.ts`)).toBe(true);
    expect(validateInternals.linkedArtifactPathExceedsFilesystemLimits(`src\\${"a".repeat(256)}.ts`)).toBe(true);
    expect(validateInternals.linkedArtifactPathExceedsFilesystemLimits("src/normal.ts")).toBe(false);
    expect(validateInternals.resolveValidateMetadataProfile("   ")).toBe("core");
    expect(validateInternals.resolveDependencyCycleSeverity("   ")).toBe("warn");
    expect(
      validateInternals.isMetadataFieldMissing(
        { id: "pm-confidence", confidence: Number.POSITIVE_INFINITY } as never,
        "confidence",
        statusRegistry,
        false,
      ),
    ).toBe(true);
    expect([...validateInternals.resolveRequestedChecks({ checkMetadata: true, pruneMissing: true })]).toEqual([
      "metadata",
      "files",
    ]);
    const checkWithoutHints = {
      name: "resolution",
      status: "warn",
      details: {},
    } as never;
    validateInternals.attachValidateFixHints(checkWithoutHints, []);
    expect(checkWithoutHints.details).toEqual({});

    // The duplicate-issue-code metadata warning must resolve to an executable
    // fix command now that it is in the shared remediation registry (pm-sdbo).
    const metadataCheckWithDuplicates = {
      name: "metadata",
      status: "warn",
      details: {},
    } as never;
    validateInternals.attachValidateFixHints(metadataCheckWithDuplicates, [
      "validate_metadata_duplicate_issue_codes:2",
    ]);
    expect((metadataCheckWithDuplicates.details as { fix_hints?: string[] }).fix_hints).toEqual([
      'pm update <id> --title "<distinct title>"',
    ]);

    const graph = validateInternals.buildLifecycleDependencyGraph([
      {
        id: "pm-a",
        definition_of_ready: "Ready after pm-c and pm-b are both prepared.",
        dependencies: [
          { id: "pm-b", kind: "blocks" },
          { id: "none", kind: "blocks" },
        ],
      },
      {
        id: "pm-b",
        dependencies: [{ id: "pm-a", kind: "blocks" }],
      },
      {
        id: "pm-c",
        dependencies: [{ id: "pm-c", kind: "blocks" }],
      },
      {
        id: "pm-d",
        definition_of_ready: "No pm item references here.",
        dependencies: [
          { id: "pm-a", kind: "related" },
          { id: "pm-c", kind: "related_to" },
          { id: "pm-b", kind: null },
        ],
      },
      {
        id: "pm-e",
        dependencies: [{ id: "pm-a", kind: "custom_precedes" }],
      },
    ] as never);
    expect(graph.get("pm-a")).toEqual(["pm-b", "pm-c"]);
    expect(graph.get("pm-d")).toEqual([]);
    expect(graph.get("pm-e")).toEqual([]);
    expect(validateInternals.extractItemIds("Ready after work-2 and pm-3.", "work")).toEqual(["work-2"]);
    expect(validateInternals.extractItemIds("Ready after x.pm-2", "x.pm")).toEqual(["x.pm-2"]);
    expect(validateInternals.extractItemIds("Ready after (x.pm-2), not ax.pm-3", "x.pm")).toEqual(["x.pm-2"]);
    expect(validateInternals.extractItemIds("Ready after pm-2", " ")).toEqual(["pm-2"]);
    expect(validateInternals.extractItemIds("Ready after pm-2", "pm-")).toEqual(["pm-2"]);
    const customPrefixGraph = validateInternals.buildLifecycleDependencyGraph(
      [
        { id: "work-1", status: "open", definition_of_ready: "Ready after work-2" },
        { id: "work-2", status: "open", blocked_by: "work-1" },
      ] as never,
      "work",
    );
    expect(customPrefixGraph.get("work-1")).toEqual(["work-2"]);
    expect(validateInternals.findLifecycleDependencyCycleComponents(graph)).toEqual([["pm-a", "pm-b"], ["pm-c"]]);
    expect(validateInternals.resolveLifecycleDependencyCycleSamplePath(["pm-c"], graph)).toEqual(["pm-c", "pm-c"]);
    expect(
      validateInternals.resolveLifecycleDependencyCycleSamplePath(
        ["pm-a", "pm-z"],
        new Map([
          ["pm-a", ["pm-z"]],
          ["pm-z", []],
        ]),
      ),
    ).toEqual(["pm-a", "pm-z", "pm-a"]);

    // Parent-hierarchy cycle helpers (pm-8vul / GH-280). The child->[parent]
    // graph guards against dangling parent refs and ignores "none"/blank values,
    // and scans across ALL items (no active-only filter).
    expect(validateInternals.resolveParentCycleSeverity("   ")).toBe("warn");
    expect(validateInternals.resolveParentCycleSeverity("ERROR")).toBe("error");
    const parentGraph = validateInternals.buildLifecycleParentGraph([
      { id: "pm-pa", parent: "pm-pb" },
      { id: "pm-pb", parent: "pm-pa" },
      { id: "pm-pc", parent: "none" },
      { id: "pm-pd", parent: "pm-missing" },
      { id: "pm-pe" },
      // Case-insensitive parent resolution (matches PR #279): an uppercase
      // parent ref must still resolve to its canonical lowercase item id so a
      // casing mismatch can never hide a cycle edge.
      { id: "pm-pf", parent: "PM-PA" },
    ] as never);
    expect(parentGraph.get("pm-pa")).toEqual(["pm-pb"]);
    expect(parentGraph.get("pm-pb")).toEqual(["pm-pa"]);
    expect(parentGraph.get("pm-pc")).toEqual([]);
    expect(parentGraph.get("pm-pd")).toEqual([]);
    expect(parentGraph.get("pm-pe")).toEqual([]);
    expect(parentGraph.get("pm-pf")).toEqual(["pm-pa"]);
    const parentCycles = validateInternals.detectLifecycleParentCycles([
      { id: "pm-pa", parent: "pm-pb" },
      { id: "pm-pb", parent: "pm-pa" },
      { id: "pm-pc", parent: "none" },
    ] as never);
    expect(parentCycles.cycle_count).toBe(1);
    expect(parentCycles.cycle_item_ids).toEqual(["pm-pa", "pm-pb"]);
    expect(parentCycles.cycle_sample_paths[0]).toContain("pm-pa");
    expect(parentCycles.cycle_sample_paths[0]).toContain("pm-pb");

    const lifecyclePolicy = {
      stale_blocker_reason_patterns: ["no active blocker", "stale blocker"],
      stale_blocker_reason_pattern_source: "settings",
      closure_like_metadata_field_patterns: {
        blocked_reason: ["resolved"],
        resolution: ["done"],
        actual_result: ["shipped"],
      },
      closure_like_metadata_field_pattern_sources: {
        blocked_reason: "settings",
        resolution: "settings",
        actual_result: "settings",
      },
    } as const;
    const lifecycleResult = validateInternals.buildLifecycleCheck(
      [
        {
          id: "pm-blocked",
          type: "Task",
          title: "Blocked item",
          status: "blocked",
          blocked_by: undefined,
          blocked_reason: "No active blocker and stale blocker queue",
          dependencies: [],
        },
      ] as never,
      true,
      "warn",
      "warn",
      statusRegistry,
      lifecyclePolicy,
      true,
    );
    expect(lifecycleResult.warnings).toContain("validate_lifecycle_stale_blockers:1");

    expect(validateInternals.classifyOrphanedPath("src/demo.ts")).toBe("source_unowned");
    expect(validateInternals.classifyOrphanedPath("src/README.md")).toBe("source_unowned");
    expect(validateInternals.classifyOrphanedPath("tests/fixtures.md")).toBe("tests_unowned");
    expect(validateInternals.classifyOrphanedPath("README.md")).toBe("docs_unowned");
    expect(validateInternals.sharedDirectoryPrefixLength("docs/a/b/orphan.md", "docs/a/c/owned.md")).toBe(2);
    const orphanRows = validateInternals.buildOrphanedPathRows(
      ["docs/ops/nested/orphan.md", "docs/tie/orphan.md"],
      [
        {
          id: "pm-owner",
          type: "Task",
          title: "Directory owner",
          status: "open",
          docs: [
            { path: "docs/ops/", scope: "project" },
            { path: "docs/ops/nested/orphan.md", scope: "project" },
            { path: "   ", scope: "project" },
          ],
        },
        {
          id: "pm-tie-b",
          type: "Task",
          title: "Tie B",
          status: "open",
          docs: [{ path: "docs/tie/b.md", scope: "project" }],
        },
        {
          id: "pm-tie-a",
          type: "Task",
          title: "Tie A",
          status: "open",
          docs: [{ path: "docs/tie/a.md", scope: "project" }],
        },
      ] as never,
    );
    expect(orphanRows[0]?.owner_candidate).toMatchObject({ id: "pm-owner", confidence: "path_prefix" });
    expect(orphanRows[1]?.owner_candidate).toMatchObject({ id: "pm-tie-a", confidence: "same_directory" });
    expect(
      validateInternals.buildOrphanedPathRows(
        ["docs/ops/new/orphan.md"],
        [
          {
            id: "pm-shared",
            type: "Task",
            title: "Shared prefix owner",
            status: "open",
            docs: [{ path: "docs/ops/owned/guide.md", scope: "project" }],
          },
        ] as never,
      )[0]?.owner_candidate,
    ).toMatchObject({ id: "pm-shared", confidence: "shared_directory" });
    expect(
      validateInternals.buildOrphanedPathRows(
        ["docs/ops/new/orphan.md"],
        [
          {
            id: "pm-a-shared",
            type: "Task",
            title: "Sibling owner",
            status: "open",
            docs: [{ path: "docs/ops/owned/guide.md", scope: "project" }],
          },
          {
            id: "pm-z-same",
            type: "Task",
            title: "Same directory owner",
            status: "open",
            docs: [{ path: "docs/ops/new/owned.md", scope: "project" }],
          },
        ] as never,
      )[0]?.owner_candidate,
    ).toMatchObject({ id: "pm-z-same", confidence: "same_directory" });
    expect(
      validateInternals.summarizeOrphanedPathRows([
        {
          path: "docs/quote.md",
          classification: "docs_unowned",
          owner_candidate: null,
          remediation_hint: 'pm docs <id> --add path=docs/quote.md,note="backslash \\\\ and quote"',
        },
      ]),
    ).toEqual([
      'docs/quote.md:docs_unowned owner_candidate=unowned hint="pm docs <id> --add path=docs/quote.md,note=\\"backslash \\\\\\\\ and quote\\""',
    ]);

    await withTempPmPath(async (context) => {
      const filesResult = await validateInternals.buildFilesCheck(
        [
          {
            id: "pm-dev-null",
            type: "Task",
            title: "Device path",
            status: "open",
            files: [{ scope: "project", path: "/dev/null" }],
            docs: [],
          },
        ] as never,
        process.cwd(),
        context.pmPath,
        "default",
        false,
        false,
      );
      expect(filesResult.warnings).toContain("validate_files_missing_linked_paths:1");
    });

    await expect(
      validateInternals.applyValidateFix(
        { kind: "prune_file_link", item_id: "pm-a", path: "missing.ts", gate: "files" } as never,
        {},
      ),
    ).rejects.toThrow("Unsupported non-batched fix kind: prune_file_link");
    await expect(
      validateInternals.applyValidateFix(
        { kind: "prune_doc_link", item_id: "pm-a", path: "missing.md", gate: "files" } as never,
        {},
      ),
    ).rejects.toThrow("Unsupported non-batched fix kind: prune_doc_link");

    const missingWorkspace = path.join(os.tmpdir(), `pm-validate-missing-${Date.now()}`, "workspace");
    expect(validateInternals.resolveWorkspaceRoot(missingWorkspace).length).toBeGreaterThan(0);
  });

  it("treats remote (URL) doc/file references as a benign category, never missing or prunable (pm-k2n4)", async () => {
    await withTempPmPath(async (context) => {
      const remoteUrl = "https://github.com/unbraind/pm-cli/pull/362";
      const filesResult = await validateInternals.buildFilesCheck(
        [
          {
            id: "pm-remote-ref",
            type: "Task",
            title: "Remote and local linked artifacts",
            status: "open",
            files: [{ scope: "project", path: "does-not-exist-local-xyz.ts" }],
            docs: [
              { scope: "project", path: remoteUrl },
              { scope: "project", path: "ssh://git@example.com/repo.git" },
            ],
          },
        ] as never,
        process.cwd(),
        context.pmPath,
        "default",
        false,
        true,
      );
      const details = filesResult.check.details as {
        remote_linked_paths_count: number;
        remote_linked_paths: string[];
        missing_linked_paths: string[];
        missing_linked_paths_count: number;
      };
      // Both remote references are surfaced in the benign remote category.
      expect(details.remote_linked_paths_count).toBe(2);
      expect(details.remote_linked_paths).toEqual([remoteUrl, "ssh://git@example.com/repo.git"]);
      // The genuinely-missing local file is still flagged; the URLs are not.
      expect(details.missing_linked_paths).toEqual(["does-not-exist-local-xyz.ts"]);
      expect(details.missing_linked_paths_count).toBe(1);
      expect(details.missing_linked_paths).not.toContain(remoteUrl);
      // --prune-missing must never target a remote reference (no data loss).
      expect(filesResult.staleLinkPruneRows.map((row) => row.path)).toEqual(["does-not-exist-local-xyz.ts"]);
    });
  });

  it("summarizes duplicate logical issue codes as advisory warnings with truncation (GH-235)", () => {
    // No duplicates → empty projection, no warning.
    expect(validateInternals.summarizeDuplicateIssueCodes([], false)).toEqual({ rows: [], truncated: false, warnings: [] });

    const oneDuplicate = [{ code: "ISSUE-4", count: 2, ids: ["pm-a", "pm-b"], titles: ["ISSUE-4: a", "ISSUE-4: b"] }];
    const summarized = validateInternals.summarizeDuplicateIssueCodes(oneDuplicate, false);
    expect(summarized.truncated).toBe(false);
    expect(summarized.warnings).toEqual(["validate_metadata_duplicate_issue_codes:1"]);
    expect(summarized.rows[0]).toMatchObject({
      code: "ISSUE-4",
      count: 2,
      ids: ["pm-a", "pm-b"],
      remediation_hint: expect.stringContaining('share issue code "ISSUE-4"'),
    });

    // More than the diagnostic summary limit (5) → truncated unless verbose.
    const many = Array.from({ length: 7 }, (_unused, index) => ({
      code: `CODE-${index}`,
      count: 2,
      ids: [`pm-${index}-a`, `pm-${index}-b`],
      titles: [`CODE-${index}: a`, `CODE-${index}: b`],
    }));
    const compact = validateInternals.summarizeDuplicateIssueCodes(many, false);
    expect(compact.rows).toHaveLength(5);
    expect(compact.truncated).toBe(true);
    expect(compact.warnings).toEqual(["validate_metadata_duplicate_issue_codes:7"]);

    const verbose = validateInternals.summarizeDuplicateIssueCodes(many, true);
    expect(verbose.rows).toHaveLength(7);
    expect(verbose.truncated).toBe(false);
  });

  it("exempts terminal items from planning-field gaps unless strict enforcement is requested (GH-276)", () => {
    const statusRegistry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);
    const closedBare = { id: "pm-closed", status: "closed" } as never;
    const canceledBare = { id: "pm-canceled", status: "canceled" } as never;
    const openBare = { id: "pm-open", status: "open" } as never;

    for (const field of ["acceptance_criteria", "estimated_minutes"] as const) {
      // core profile (enforcePlanningFieldsOnTerminal = false): closed + canceled
      // items short-circuit to "not missing" — terminal_done AND terminal_canceled.
      expect(validateInternals.isMetadataFieldMissing(closedBare, field, statusRegistry, false)).toBe(false);
      expect(validateInternals.isMetadataFieldMissing(canceledBare, field, statusRegistry, false)).toBe(false);
      // strict profile (enforcePlanningFieldsOnTerminal = true): the short-circuit
      // is skipped, so a terminal item missing the field IS still reported.
      expect(validateInternals.isMetadataFieldMissing(closedBare, field, statusRegistry, true)).toBe(true);
      // open/active items are never exempt regardless of enforcement flag.
      expect(validateInternals.isMetadataFieldMissing(openBare, field, statusRegistry, false)).toBe(true);
    }

    // A NON-exempt field (author) on a terminal item is still reported under core:
    // TERMINAL_EXEMPT_PLANNING_FIELDS.has("author") is false, so the short-circuit
    // never fires.
    expect(validateInternals.isMetadataFieldMissing(closedBare, "author", statusRegistry, false)).toBe(true);
  });

  it("does not flag closed/canceled items for missing planning fields under the core profile (GH-276)", async () => {
    await withTempPmPath(async (context) => {
      const closedId = createTask(context, "validate-terminal-exempt-closed");
      const canceledId = createTask(context, "validate-terminal-exempt-canceled");
      await runClose(closedId, "done", {}, { path: context.pmPath });
      const canceled = context.runCli(
        ["update", canceledId, "--json", "--status", "canceled", "--message", "Cancel for terminal-exempt test"],
        { expectJson: true },
      );
      expect(canceled.code).toBe(0);

      // Strip the planning fields from both terminal items so they would be
      // flagged if the terminal exemption did not apply.
      for (const id of [closedId, canceledId]) {
        const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
        const before = await readFile(itemPath, "utf8");
        const withoutEstimate = before.replace(/^estimated_minutes:.*\n/m, "");
        const after = withoutEstimate.replace(/^acceptance_criteria:.*\n/m, "");
        expect(after).not.toBe(before);
        await writeFile(itemPath, after, "utf8");
      }

      const result = await runValidate({ checkMetadata: true }, { path: context.pmPath });
      expect(
        result.warnings.some((warning) => warning.startsWith("validate_metadata_missing_estimate:")),
      ).toBe(false);
      expect(
        result.warnings.some((warning) => warning.startsWith("validate_metadata_missing_acceptance_criteria:")),
      ).toBe(false);
      const metadataCheck = checkByName(result, "metadata");
      const details = metadataCheck.details as {
        counts: Record<string, number>;
        missing_estimated_minutes_item_ids?: string[];
        missing_acceptance_criteria_item_ids?: string[];
      };
      expect(details.counts.missing_estimated_minutes).toBeUndefined();
      expect(details.counts.missing_acceptance_criteria).toBeUndefined();
      expect(details.missing_estimated_minutes_item_ids ?? []).not.toContain(closedId);
      expect(details.missing_estimated_minutes_item_ids ?? []).not.toContain(canceledId);
      expect(details.missing_acceptance_criteria_item_ids ?? []).not.toContain(closedId);
      expect(details.missing_acceptance_criteria_item_ids ?? []).not.toContain(canceledId);
    });
  });

  it("still flags closed items for missing planning fields under the strict profile (GH-276)", async () => {
    await withTempPmPath(async (context) => {
      const closedId = createTask(context, "validate-terminal-strict-closed");
      await runClose(closedId, "done", {}, { path: context.pmPath });

      const itemPath = path.join(context.pmPath, "tasks", `${closedId}.toon`);
      const before = await readFile(itemPath, "utf8");
      const withoutEstimate = before.replace(/^estimated_minutes:.*\n/m, "");
      const after = withoutEstimate.replace(/^acceptance_criteria:.*\n/m, "");
      expect(after).not.toBe(before);
      await writeFile(itemPath, after, "utf8");

      const result = await runValidate(
        { checkMetadata: true, metadataProfile: "strict" },
        { path: context.pmPath },
      );
      expect(result.warnings).toContain("validate_metadata_missing_estimate:1");
      expect(result.warnings).toContain("validate_metadata_missing_acceptance_criteria:1");
      const details = checkByName(result, "metadata").details as {
        counts: { missing_estimated_minutes: number; missing_acceptance_criteria: number };
        missing_estimated_minutes_item_ids: string[];
        missing_acceptance_criteria_item_ids: string[];
      };
      expect(details.counts.missing_estimated_minutes).toBe(1);
      expect(details.counts.missing_acceptance_criteria).toBe(1);
      expect(details.missing_estimated_minutes_item_ids).toContain(closedId);
      expect(details.missing_acceptance_criteria_item_ids).toContain(closedId);
    });
  });

  it("still flags open items for missing planning fields under the core profile (GH-276)", async () => {
    await withTempPmPath(async (context) => {
      const openId = createTask(context, "validate-terminal-open-active");

      const itemPath = path.join(context.pmPath, "tasks", `${openId}.toon`);
      const before = await readFile(itemPath, "utf8");
      const withoutEstimate = before.replace(/^estimated_minutes:.*\n/m, "");
      const after = withoutEstimate.replace(/^acceptance_criteria:.*\n/m, "");
      expect(after).not.toBe(before);
      await writeFile(itemPath, after, "utf8");

      const result = await runValidate({ checkMetadata: true }, { path: context.pmPath });
      expect(result.warnings).toContain("validate_metadata_missing_estimate:1");
      expect(result.warnings).toContain("validate_metadata_missing_acceptance_criteria:1");
      const details = checkByName(result, "metadata").details as {
        missing_estimated_minutes_item_ids: string[];
        missing_acceptance_criteria_item_ids: string[];
      };
      expect(details.missing_estimated_minutes_item_ids).toContain(openId);
      expect(details.missing_acceptance_criteria_item_ids).toContain(openId);
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
          parentId.toUpperCase(),
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

  it("reports cycles that cross blocked_by and definition_of_ready references", async () => {
    await withTempPmPath(async (context) => {
      const blockedId = createTask(context, "validate-lifecycle-logical-cycle-blocked");
      const blockerId = createTask(context, "validate-lifecycle-logical-cycle-blocker");
      const blocked = context.runCli(
        ["update", blockedId, "--blocked-by", blockerId, "--status", "blocked", "--json"],
        { expectJson: true },
      );
      expect(blocked.code).toBe(0);
      const ready = context.runCli(
        [
          "update",
          blockerId,
          "--definition-of-ready",
          `Reporting workflow must be functional in ${blockedId} before this can start.`,
          "--json",
        ],
        { expectJson: true },
      );
      expect(ready.code).toBe(0);

      const result = await runValidate({ checkLifecycle: true }, { path: context.pmPath });
      expect(result.warnings).toContain("validate_lifecycle_dependency_cycles:1");
      const details = checkByName(result, "lifecycle").details as {
        dependency_cycle_item_ids: string[];
        dependency_cycle_sample_paths: string[];
      };
      expect(details.dependency_cycle_item_ids).toEqual([blockedId, blockerId].sort((left, right) => left.localeCompare(right)));
      expect(details.dependency_cycle_sample_paths[0]).toContain(blockedId);
      expect(details.dependency_cycle_sample_paths[0]).toContain(blockerId);
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

  it("reports a two-item parent-hierarchy cycle (A->B->A) in lifecycle checks", async () => {
    await withTempPmPath(async (context) => {
      const [first, second] = seedParentCycle(context, 2);
      const result = await runValidate({ checkLifecycle: true }, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.has_warnings).toBe(true);
      expect(result.warnings).toContain("validate_hierarchy_parent_cycle:1");
      const lifecycleCheck = checkByName(result, "lifecycle");
      expect(lifecycleCheck.status).toBe("warn");
      const details = lifecycleCheck.details as {
        parent_cycle_severity_policy: string;
        parent_cycle_count: number;
        parent_cycle_item_count: number;
        parent_cycle_item_ids: string[];
        parent_cycle_item_ids_truncated: boolean;
        parent_cycle_sample_paths: string[];
        parent_cycle_sample_paths_truncated: boolean;
      };
      expect(details.parent_cycle_severity_policy).toBe("warn");
      expect(details.parent_cycle_count).toBe(1);
      expect(details.parent_cycle_item_count).toBe(2);
      expect(details.parent_cycle_item_ids).toEqual([first, second].sort((left, right) => left.localeCompare(right)));
      expect(details.parent_cycle_item_ids_truncated).toBe(false);
      expect(details.parent_cycle_sample_paths).toHaveLength(1);
      expect(details.parent_cycle_sample_paths_truncated).toBe(false);
      const cyclePath = details.parent_cycle_sample_paths[0] ?? "";
      const cycleSegments = cyclePath.split("->");
      expect(cycleSegments[0]).toBe(cycleSegments[cycleSegments.length - 1]);
      expect(cyclePath).toContain(first);
      expect(cyclePath).toContain(second);
    });
  });

  it("reports a three-item parent-hierarchy cycle (A->B->C->A)", async () => {
    await withTempPmPath(async (context) => {
      const ids = seedParentCycle(context, 3);
      const result = await runValidate({ checkLifecycle: true }, { path: context.pmPath });
      expect(result.warnings).toContain("validate_hierarchy_parent_cycle:1");
      const details = checkByName(result, "lifecycle").details as {
        parent_cycle_count: number;
        parent_cycle_item_count: number;
        parent_cycle_item_ids: string[];
        parent_cycle_sample_paths: string[];
      };
      expect(details.parent_cycle_count).toBe(1);
      expect(details.parent_cycle_item_count).toBe(3);
      expect(details.parent_cycle_item_ids).toEqual([...ids].sort((left, right) => left.localeCompare(right)));
      const cyclePath = details.parent_cycle_sample_paths[0] ?? "";
      for (const id of ids) {
        expect(cyclePath).toContain(id);
      }
    });
  });

  it("supports parent-cycle severity policy overrides", async () => {
    await withTempPmPath(async (context) => {
      seedParentCycle(context, 2);

      const errorResult = await runValidate(
        { checkLifecycle: true, parentCycleSeverity: "error" },
        { path: context.pmPath },
      );
      expect(errorResult.ok).toBe(false);
      expect(errorResult.has_warnings).toBe(true);
      expect(errorResult.warnings).toContain("validate_hierarchy_parent_cycle_error:1");
      const errorLifecycleCheck = checkByName(errorResult, "lifecycle");
      expect(errorLifecycleCheck.status).toBe("error");
      const errorDetails = errorLifecycleCheck.details as {
        parent_cycle_severity_policy: string;
        parent_cycle_count: number;
      };
      expect(errorDetails.parent_cycle_severity_policy).toBe("error");
      expect(errorDetails.parent_cycle_count).toBe(1);

      const offResult = await runValidate(
        { checkLifecycle: true, parentCycleSeverity: "off" },
        { path: context.pmPath },
      );
      expect(offResult.ok).toBe(true);
      expect(offResult.warnings.some((warning) => warning.startsWith("validate_hierarchy_parent_cycle"))).toBe(false);
      const offLifecycleCheck = checkByName(offResult, "lifecycle");
      expect(offLifecycleCheck.status).toBe("ok");
      const offDetails = offLifecycleCheck.details as {
        parent_cycle_severity_policy: string;
        parent_cycle_count: number;
      };
      expect(offDetails.parent_cycle_severity_policy).toBe("off");
      expect(offDetails.parent_cycle_count).toBe(1);
    });
  });

  it("does not flag a normal (acyclic) parent hierarchy", async () => {
    await withTempPmPath(async (context) => {
      const root = createTask(context, "validate-parent-acyclic-root");
      const child = createTask(context, "validate-parent-acyclic-child");
      const grandchild = createTask(context, "validate-parent-acyclic-grandchild");
      for (const edge of [
        { child, parent: root },
        { child: grandchild, parent: child },
      ]) {
        const updated = context.runCli(
          ["update", edge.child, "--parent", edge.parent, "--json", "--message", "Seed acyclic parent edge"],
          { expectJson: true },
        );
        expect(updated.code).toBe(0);
      }
      const result = await runValidate({ checkLifecycle: true }, { path: context.pmPath });
      expect(result.warnings.some((warning) => warning.startsWith("validate_hierarchy_parent_cycle"))).toBe(false);
      const details = checkByName(result, "lifecycle").details as {
        parent_cycle_count: number;
        parent_cycle_item_count: number;
        parent_cycle_item_ids: string[];
      };
      expect(details.parent_cycle_count).toBe(0);
      expect(details.parent_cycle_item_count).toBe(0);
      expect(details.parent_cycle_item_ids).toEqual([]);
    });
  });

  it("rejects unknown parent-cycle severity values", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-lifecycle-invalid-parent-cycle-severity");
      await expect(
        runValidate({ checkLifecycle: true, parentCycleSeverity: "invalid" }, { path: context.pmPath }),
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

  it("reports closed close_reason gaps while exempting a closed item's planning estimate (GH-276)", async () => {
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
      // GH-276: estimated_minutes is a planning field exempt on terminal items
      // under the core profile, so a closed item's missing estimate is no longer
      // reported. close_reason is closure metadata (not a planning field) and is
      // still flagged.
      expect(
        result.warnings.some((warning) => warning.startsWith("validate_metadata_missing_estimate:")),
      ).toBe(false);
      expect(result.warnings).toContain("validate_metadata_missing_close_reason:1");
      const metadataCheck = checkByName(result, "metadata");
      expect(metadataCheck.status).toBe("warn");
      const details = metadataCheck.details as {
        counts: { missing_estimated_minutes?: number; closed_missing_close_reason: number };
      };
      expect(details.counts.missing_estimated_minutes).toBeUndefined();
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
        ...settings.governance,
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
        ...settings.governance,
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
      expect(preview.checks.map((entry) => entry.name)).toEqual(["metadata", "resolution", "lifecycle", "dependency_references"]);
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
      const missingGrandparentId = createTask(context, "auto-fix-missing-grandparent");
      const missingGrandparentParentId = createTestItemId(context, {
        title: "auto-fix-terminal-missing-grandparent",
        tags: "validate,unit",
        estimate: "15",
        parent: missingGrandparentId.toUpperCase(),
      });
      const childId = createTestItemId(context, {
        title: "auto-fix-active-child",
        tags: "validate,unit",
        estimate: "15",
        parent: parentId.toUpperCase(),
      });
      const missingGrandparentChildId = createTestItemId(context, {
        title: "auto-fix-active-missing-grandparent-child",
        tags: "validate,unit",
        estimate: "15",
        parent: missingGrandparentParentId.toUpperCase(),
      });
      const deletedGrandparent = context.runCli(["delete", missingGrandparentId, "--force", "--json"], { expectJson: true });
      expect(deletedGrandparent.code).toBe(0);
      await runClose(parentId, "parent done", {}, { path: context.pmPath });
      await runClose(missingGrandparentParentId, "missing grandparent parent done", {}, { path: context.pmPath });

      const preview = await runValidate(
        { checkLifecycle: true, autoFix: true, dryRun: true },
        { path: context.pmPath },
      );
      expect(preview.fixes?.planned_fixes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          item_id: childId,
          check: "lifecycle",
          field: "parent",
          command: `pm update ${childId} --parent ${grandparentId}`,
          gate: "lifecycle",
        }),
        expect.objectContaining({
          item_id: missingGrandparentChildId,
          command: `pm update ${missingGrandparentChildId} --unset parent`,
        }),
      ]));
      expect(preview.fixes?.gated_count).toBe(2);

      // Without the explicit lifecycle grant nothing is applied.
      const withheld = await runValidate({ checkLifecycle: true, autoFix: true }, { path: context.pmPath });
      expect(withheld.fixes?.applied_count).toBe(0);
      expect(withheld.fixes?.gated_count).toBe(2);
      expect(withheld.fixes?.gated_fixes[0]).toMatchObject({
        gate: "lifecycle",
        gate_hint: "Withheld: re-run with --fix-scope lifecycle to apply.",
      });

      const granted = await runValidate(
        { checkLifecycle: true, autoFix: true, fixScope: ["lifecycle"] },
        { path: context.pmPath },
      );
      expect(granted.fixes?.granted_fix_scopes).toEqual(["lifecycle"]);
      expect(granted.fixes?.applied_count).toBe(2);
      expect(granted.fixes?.failed_count).toBe(0);

      const after = context.runCli(["get", childId, "--json"], { expectJson: true });
      expect((after.json as { item: { parent?: string } }).item.parent).toBe(grandparentId);
      const missingGrandparentAfter = context.runCli(["get", missingGrandparentChildId, "--json"], { expectJson: true });
      expect((missingGrandparentAfter.json as { item: { parent?: string } }).item.parent).toBeUndefined();
    });
  });

  it("withholds estimate backfills until --fix-scope estimates and uses per-type/override defaults (GH-212)", async () => {
    await withTempPmPath(async (context) => {
      const taskId = createTask(context, "auto-fix-estimate-task");
      const epicId = createTestItemId(context, {
        title: "auto-fix-estimate-epic",
        type: "Epic",
        tags: "validate,unit",
        estimate: "30",
      });
      // Strip estimated_minutes so the metadata check flags both items.
      for (const [id, folder] of [
        [taskId, "tasks"],
        [epicId, "epics"],
      ] as const) {
        const itemPath = path.join(context.pmPath, folder, `${id}.toon`);
        const before = await readFile(itemPath, "utf8");
        const after = before.replace(/^estimated_minutes:.*\n/m, "");
        expect(after).not.toBe(before);
        await writeFile(itemPath, after, "utf8");
      }

      // Default scopes do NOT grant estimates: both are planned but gated.
      const preview = await runValidate({ autoFix: true, dryRun: true }, { path: context.pmPath });
      const estimatePlans = (preview.fixes?.planned_fixes ?? []).filter((fix) => fix.field === "estimated_minutes");
      expect(estimatePlans).toEqual(
        expect.arrayContaining([
          { item_id: taskId, check: "metadata", field: "estimated_minutes", command: `pm update ${taskId} --estimate 120`, gate: "estimates" },
          { item_id: epicId, check: "metadata", field: "estimated_minutes", command: `pm update ${epicId} --estimate 2880`, gate: "estimates" },
        ]),
      );
      const gatedEstimates = (preview.fixes?.gated_fixes ?? []).filter((fix) => fix.field === "estimated_minutes");
      expect(gatedEstimates).toHaveLength(2);
      expect(gatedEstimates[0]).toMatchObject({ gate_hint: "Withheld: re-run with --fix-scope estimates to apply." });

      // A per-type override from settings wins over the built-in default.
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { validation?: Record<string, unknown> };
      settings.validation = { ...settings.validation, estimate_defaults_by_type: { Epic: 999 } };
      await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");

      const granted = await runValidate({ autoFix: true, fixScope: ["estimates"] }, { path: context.pmPath });
      expect(granted.fixes?.granted_fix_scopes).toEqual(["estimates"]);
      const appliedEstimates = (granted.fixes?.applied_fixes ?? []).filter((fix) => fix.field === "estimated_minutes");
      expect(appliedEstimates).toHaveLength(2);
      expect(granted.fixes?.failed_count).toBe(0);

      const epicAfter = context.runCli(["get", epicId, "--json"], { expectJson: true });
      expect((epicAfter.json as { item: { estimated_minutes?: number } }).item.estimated_minutes).toBe(999);
      const taskAfter = context.runCli(["get", taskId, "--json"], { expectJson: true });
      expect((taskAfter.json as { item: { estimated_minutes?: number } }).item.estimated_minutes).toBe(120);
    });
  });

  it("attributes owners to missing linked paths in the files check (GH-210)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "owns-a-stale-link");
      const workspaceRoot = path.dirname(path.dirname(context.pmPath));
      const stalePath = path.join(workspaceRoot, "goes-away.txt");
      await writeFile(stalePath, "temporary", "utf8");
      const linked = context.runCli(["files", id, "--add", "goes-away.txt", "--json"], { expectJson: true });
      expect(linked.code).toBe(0);
      await rm(stalePath, { force: true });

      // Default: token-efficient compact one-liners naming the owner.
      const compact = await runValidate({ checkFiles: true }, { path: context.pmPath });
      const compactDetails = checkByName(compact, "files").details as {
        missing_linked_path_rows_count: number;
        missing_linked_path_rows: string[];
      };
      expect(compactDetails.missing_linked_path_rows_count).toBe(1);
      expect(compactDetails.missing_linked_path_rows[0]).toBe(
        `goes-away.txt:deleted owner=${id} status=open field=files title="owns-a-stale-link"`,
      );

      // Verbose: full structured rows (the GH-210 JSON shape).
      const verbose = await runValidate({ checkFiles: true, verboseFileLists: true }, { path: context.pmPath });
      const verboseDetails = checkByName(verbose, "files").details as {
        missing_linked_path_rows: Array<{
          path: string;
          classification: string;
          items: Array<{ id: string; type: string; status: string; field: string; title: string }>;
        }>;
      };
      expect(verboseDetails.missing_linked_path_rows).toEqual([
        {
          path: "goes-away.txt",
          classification: "deleted",
          items: [{ id, type: "Task", title: "owns-a-stale-link", status: "open", field: "files" }],
        },
      ]);
    });
  });

  it("classifies orphaned paths with compact remediation rows", async () => {
    await withTempPmPath(async (context) => {
      createTask(context, "validate-files-orphan-unowned");
      const workspaceRoot = path.dirname(path.dirname(context.pmPath));
      await mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
      await writeFile(path.join(workspaceRoot, "docs", "orphan-guide.md"), "orphan", "utf8");

      const result = await runValidate({ checkFiles: true }, { path: context.pmPath });
      expect(result.warnings).toContain("validate_files_orphaned_paths:1");
      const details = checkByName(result, "files").details as {
        orphaned_path_classifications: string[];
        orphaned_path_rows_count: number;
        orphaned_path_rows: string[];
      };
      expect(details.orphaned_path_classifications).toEqual([
        "docs/orphan-guide.md:docs_unowned:owner_candidate=unowned",
      ]);
      expect(details.orphaned_path_rows_count).toBe(1);
      expect(details.orphaned_path_rows[0]).toContain("docs/orphan-guide.md:docs_unowned owner_candidate=unowned");
      expect(details.orphaned_path_rows[0]).toContain("pm docs <id> --add path=docs/orphan-guide.md");
    });
  });

  it("reports verbose orphaned path rows with owner candidates", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "validate-files-orphan-owner-candidate");
      const workspaceRoot = path.dirname(path.dirname(context.pmPath));
      await mkdir(path.join(workspaceRoot, "docs", "ops"), { recursive: true });
      await writeFile(path.join(workspaceRoot, "docs", "ops", "owned.md"), "owned", "utf8");
      await writeFile(path.join(workspaceRoot, "docs", "ops", "orphan.md"), "orphan", "utf8");
      const linked = context.runCli(["docs", id, "--add", "docs/ops/owned.md", "--json"], { expectJson: true });
      expect(linked.code).toBe(0);

      const result = await runValidate(
        { checkFiles: true, scanMode: "tracked-all", verboseFileLists: true },
        { path: context.pmPath },
      );
      const details = checkByName(result, "files").details as {
        orphaned_path_rows: Array<{
          path: string;
          classification: string;
          owner_candidate: { id: string; type: string; title: string; status: string; confidence: string } | null;
          remediation_hint: string;
        }>;
      };
      expect(details.orphaned_path_rows).toEqual([
        {
          path: "docs/ops/orphan.md",
          classification: "docs_unowned",
          owner_candidate: {
            id,
            type: "Task",
            title: "validate-files-orphan-owner-candidate",
            status: "open",
            confidence: "same_directory",
          },
          remediation_hint: `pm docs ${id} --add path=docs/ops/orphan.md,scope=project,note="<why this artifact belongs to the item>"`,
        },
      ]);
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

  it("does not classify unreadable linked artifacts as missing prune targets", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "unreadable-linked-artifact");
      const overlongPath = `src/${"a".repeat(5000)}.ts`;
      const linkedFiles = context.runCli(["files", id, "--json", "--add", `path=${overlongPath},scope=project`], { expectJson: true });
      expect(linkedFiles.code).toBe(0);

      const result = await runValidate({ pruneMissing: true, dryRun: true }, { path: context.pmPath });
      expect(checkByName(result, "files").details).toMatchObject({
        missing_linked_paths: [],
      });
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
