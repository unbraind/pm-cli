import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runGraph } from "../../src/cli/commands/graph.js";
import { runHealth } from "../../src/cli/commands/health.js";
import { runValidate } from "../../src/cli/commands/validate.js";
import { clearItemMetadataEnvelopeMemo } from "../../src/core/store/item-metadata-cache.js";
import type { GraphAnalyzeResult } from "../../src/sdk/graph/run.js";
import { createTaskFixture } from "../helpers/createTaskFixture.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../helpers/withTempPmPath.js";

function injectHierarchyState(
  context: TempPmContext,
  holderId: string,
  options: {
    dependencyTargets?: string[];
    parent?: string;
    terminal?: boolean;
  },
): void {
  const itemPath = path.join(context.pmPath, "tasks", `${holderId}.toon`);
  const raw = readFileSync(itemPath, "utf8");
  const dependencyTargets = options.dependencyTargets ?? [];
  const dependencies =
    dependencyTargets.length === 0
      ? ""
      : `\ndependencies[${dependencyTargets.length}]{id,kind,created_at,author}:\n${dependencyTargets
          .map(
            (targetId) =>
              `  ${targetId},child_of,"2026-08-21T00:00:00.000Z",surface-contract`,
          )
          .join("\n")}`;
  writeFileSync(
    itemPath,
    raw
      .replace(/^(status: open)$/m, options.terminal ? "status: closed" : "$1")
      .replace(
        /^(priority:.*)$/m,
        `$1${options.parent ? `\nparent: ${options.parent}` : ""}${dependencies}`,
      ),
    "utf8",
  );
}

describe("hierarchy governance surface parity", () => {
  it("reports the same dependency-backed active cycle in validate, health, and graph analyze", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(
        context,
        "pm-surface-a",
        "Cross-surface hierarchy fixture",
      );
      createTaskFixture(
        context,
        "pm-surface-b",
        "Cross-surface hierarchy fixture",
      );
      injectHierarchyState(context, "pm-surface-a", {
        dependencyTargets: ["pm-surface-b"],
      });
      injectHierarchyState(context, "pm-surface-b", {
        dependencyTargets: ["pm-surface-a"],
      });
      clearItemMetadataEnvelopeMemo();

      const validate = await runValidate(
        { checkLifecycle: true },
        { path: context.pmPath },
      );
      const lifecycle = validate.checks.find(
        (check) => check.name === "lifecycle",
      )!;
      expect(lifecycle.details.parent_cycle_count).toBe(1);
      expect(validate.warnings).toContain("validate_hierarchy_parent_cycle:1");

      const health = await runHealth(
        { path: context.pmPath },
        { skipDrift: true, skipVectors: true },
      );
      const integrity = health.checks.find(
        (check) => check.name === "integrity",
      )!;
      const hierarchy = integrity.details.hierarchy_integrity as {
        cycles: Array<{ item_ids: string[]; legacy_terminal: boolean }>;
        relations: { count: number; sample: unknown[]; truncated: boolean };
      };
      expect(hierarchy.cycles).toEqual([
        {
          item_ids: ["pm-surface-a", "pm-surface-b"],
          legacy_terminal: false,
        },
      ]);
      expect(hierarchy.relations).toMatchObject({
        count: 2,
        truncated: false,
      });
      expect(health.warnings).toContain(
        "integrity_hierarchy_cycle:pm-surface-a,pm-surface-b",
      );
      expect(health.ok).toBe(false);

      const graph = (await runGraph(
        "analyze",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphAnalyzeResult;
      expect(graph.hierarchy.cycle_count).toBe(1);
      expect(graph.hierarchy.active_cycle_count).toBe(1);
      expect(graph.hierarchy.legacy_cycle_count).toBe(0);
      expect(graph.hierarchy.acyclic).toBe(false);
      expect(graph.hierarchy.cycles).toEqual([
        ["pm-surface-a", "pm-surface-b"],
      ]);
    });
  });

  it("classifies terminal-only hierarchy cycles as legacy and advisory", async () => {
    await withTempPmPath(async (context) => {
      createTaskFixture(
        context,
        "pm-legacy-a",
        "Cross-surface hierarchy fixture",
      );
      createTaskFixture(
        context,
        "pm-legacy-b",
        "Cross-surface hierarchy fixture",
      );
      injectHierarchyState(context, "pm-legacy-a", {
        dependencyTargets: ["pm-legacy-b"],
        terminal: true,
      });
      injectHierarchyState(context, "pm-legacy-b", {
        dependencyTargets: ["pm-legacy-a"],
        terminal: true,
      });
      clearItemMetadataEnvelopeMemo();

      const validate = await runValidate(
        { checkLifecycle: true },
        { path: context.pmPath },
      );
      expect(validate.warnings).toContain(
        "validate_legacy_hierarchy_parent_cycle:1",
      );
      expect(validate.warnings).not.toContain(
        "validate_hierarchy_parent_cycle:1",
      );
      const strictValidate = await runValidate(
        { checkLifecycle: true, parentCycleSeverity: "error" },
        { path: context.pmPath },
      );
      expect(strictValidate.warnings).toContain(
        "validate_legacy_hierarchy_parent_cycle:1",
      );
      expect(strictValidate.warnings).not.toContain(
        "validate_legacy_hierarchy_parent_cycle_error:1",
      );

      const health = await runHealth(
        { path: context.pmPath },
        { skipDrift: true, skipVectors: true },
      );
      expect(health.warnings).toContain(
        "integrity_legacy_hierarchy_cycle:pm-legacy-a,pm-legacy-b",
      );
      expect(health.ok).toBe(true);
      expect(
        health.checks.find((check) => check.name === "integrity"),
      ).toMatchObject({
        status: "ok",
        ok: true,
      });
      const graph = (await runGraph(
        "analyze",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphAnalyzeResult;
      expect(graph.hierarchy).toMatchObject({
        cycle_count: 1,
        active_cycle_count: 0,
        legacy_cycle_count: 1,
      });
    });
  });

  it("separates terminal-only cardinality and divergence debt in graph summaries", async () => {
    await withTempPmPath(async (context) => {
      for (const id of ["pm-parent-a", "pm-parent-b", "pm-legacy-child"]) {
        createTaskFixture(context, id, "Cross-surface hierarchy fixture");
      }
      injectHierarchyState(context, "pm-parent-a", { terminal: true });
      injectHierarchyState(context, "pm-parent-b", { terminal: true });
      injectHierarchyState(context, "pm-legacy-child", {
        dependencyTargets: ["pm-parent-b"],
        parent: "pm-parent-a",
        terminal: true,
      });
      clearItemMetadataEnvelopeMemo();

      const graph = (await runGraph(
        "analyze",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphAnalyzeResult;
      expect(graph.hierarchy).toMatchObject({
        cardinality_violation_count: 1,
        active_cardinality_violation_count: 0,
        legacy_cardinality_violation_count: 1,
        parent_divergence_count: 1,
        active_parent_divergence_count: 0,
        legacy_parent_divergence_count: 1,
      });
    });
  });
});
