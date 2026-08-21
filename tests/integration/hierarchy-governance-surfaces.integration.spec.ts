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

function injectHierarchyDependency(
  context: TempPmContext,
  holderId: string,
  targetId: string,
  terminal = false,
): void {
  const itemPath = path.join(context.pmPath, "tasks", `${holderId}.toon`);
  const raw = readFileSync(itemPath, "utf8");
  writeFileSync(
    itemPath,
    raw
      .replace(/^(status: open)$/m, terminal ? "status: closed" : "$1")
      .replace(
        /^(priority:.*)$/m,
        `$1\ndependencies[1]{id,kind,created_at,author}:\n  ${targetId},child_of,"2026-08-21T00:00:00.000Z",surface-contract`,
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
      injectHierarchyDependency(context, "pm-surface-a", "pm-surface-b");
      injectHierarchyDependency(context, "pm-surface-b", "pm-surface-a");
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
      };
      expect(hierarchy.cycles).toEqual([
        {
          item_ids: ["pm-surface-a", "pm-surface-b"],
          legacy_terminal: false,
        },
      ]);
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
      injectHierarchyDependency(context, "pm-legacy-a", "pm-legacy-b", true);
      injectHierarchyDependency(context, "pm-legacy-b", "pm-legacy-a", true);
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

      const health = await runHealth(
        { path: context.pmPath },
        { skipDrift: true, skipVectors: true },
      );
    expect(health.warnings).toContain(
      "integrity_legacy_hierarchy_cycle:pm-legacy-a,pm-legacy-b",
    );
    expect(health.ok).toBe(true);
    expect(health.checks.find((check) => check.name === "integrity")).toMatchObject({
      status: "ok",
      ok: true,
    });
    });
  });
});
