import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { _testOnlyValidateCommand } from "../../../../src/sdk/governance/validate.js";
import { classifyStaleLinkedPaths } from "../../../../src/core/validate/stale-file-classification.js";
import { resolveRuntimeStatusRegistry } from "../../../../src/core/schema/runtime-schema.js";
import { SETTINGS_DEFAULTS } from "../../../../src/core/shared/constants.js";
import { buildLinkedFileRepairReport } from "../../../../src/sdk/governance/linked-file-report.js";
import { planStaleLinkPruneFixes } from "../../../../src/core/validate/fix-planning.js";
import type { StaleLinkOwnerInput } from "../../../../src/core/validate/missing-link-owners.js";

describe("linked file repair context", () => {
  it("counts the full population before bounding paths and owners, with custom lifecycle roles", () => {
    const registry = resolveRuntimeStatusRegistry({
      ...SETTINGS_DEFAULTS.schema,
      statuses: [
        ...SETTINGS_DEFAULTS.schema.statuses,
        { id: "archived", aliases: ["retired"], roles: ["terminal_done"] },
      ],
    });
    const links: StaleLinkOwnerInput[] = [
      {
        item_id: "old",
        path: "a.ts",
        link_kind: "files",
        classification: "deleted",
      },
      {
        item_id: "old",
        path: "b.ts",
        link_kind: "files",
        classification: "deleted",
      },
      {
        item_id: "unknown",
        path: "b.ts",
        link_kind: "docs",
        classification: "moved",
      },
      {
        item_id: "absent",
        path: "c.ts",
        link_kind: "files",
        classification: "deleted",
      },
    ];
    const lookup = (id: string) =>
      id === "absent"
        ? undefined
        : { status: id === "old" ? "retired" : "future-status" };
    const classification = classifyStaleLinkedPaths(
      ["b.ts"],
      ["one/b.ts", "two/b.ts"],
      1,
    );
    const bounded = buildLinkedFileRepairReport(
      [...links, links[0]!],
      classification,
      lookup,
      registry,
      1.9,
    );
    expect(bounded).toMatchObject({
      missing_linked_path_rows_count: 3,
      missing_linked_links_count: 4,
      active_missing_linked_links_count: 2,
      active_missing_linked_paths_count: 2,
      legacy_terminal_missing_linked_links_count: 2,
      legacy_closed_missing_linked_links_count: 0,
      missing_linked_path_rows_truncated: true,
      missing_linked_path_rows: [
        {
          path: "b.ts",
          link_count: 2,
          items_truncated: true,
          candidates_truncated: true,
          items: [{ id: "unknown" }],
        },
      ],
    });
    const full = buildLinkedFileRepairReport(
      links,
      classification,
      lookup,
      registry,
      Infinity,
    );
    expect(full.missing_linked_path_rows.map((row) => row.path)).toEqual([
      "b.ts",
      "c.ts",
      "a.ts",
    ]);
    expect(full.missing_linked_path_rows[0]!.items).toHaveLength(2);
    expect(full.missing_linked_path_rows[1]!.candidates).toEqual([]);
    expect(
      buildLinkedFileRepairReport(links, [], lookup, registry, -1)
        .missing_linked_path_rows,
    ).toEqual([]);
    expect(
      buildLinkedFileRepairReport(links, [], lookup, registry, NaN),
    ).toEqual(buildLinkedFileRepairReport(links, [], lookup, registry));
    expect(
      buildLinkedFileRepairReport([], [], lookup, registry)
        .missing_linked_path_rows_truncated,
    ).toBe(false);
  });

  it("retains ambiguous references for review instead of pruning them when classifications disagree", () => {
    const links: StaleLinkOwnerInput[] = [
      "malformed",
      "deleted",
      "malformed",
    ].map((classification) => ({
      item_id: "pm-owner",
      path: "old/a.ts:note",
      link_kind: "files",
      classification: classification as StaleLinkOwnerInput["classification"],
    }));
    const registry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);
    expect(
      buildLinkedFileRepairReport(links, [], () => undefined, registry)
        .missing_linked_path_rows[0]!.classification,
    ).toBe("malformed");
    expect(
      planStaleLinkPruneFixes(
        links.filter((link) => link.classification === "malformed"),
      ),
    ).toEqual([]);
    expect(
      classifyStaleLinkedPaths(["C:\\old\\file.ts"], ["src/file.ts"])[0]!
        .classification,
    ).toBe("moved");
  });
  it("never infers a destination from malformed multi-path or path-note literals", () => {
    const result = classifyStaleLinkedPaths(
      ["src/first.ts,src/last.ts", "src/last.ts:historic note", "old/last.ts"],
      ["src/last.ts"],
    );
    expect(result.map((row) => row.classification)).toEqual([
      "malformed",
      "malformed",
      "moved",
    ]);
    expect(result.slice(0, 2).every((row) => row.candidates.length === 0)).toBe(
      true,
    );
  });

  it("partitions holder lifecycle and keeps counts, owners and candidates in one row schema", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-linked-report-"));
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "src/current.ts"), "export {};\n");
      const items = ["closed", "canceled"].map((status, index) => ({
        id: `pm-owner${index}`,
        type: "Task",
        title: status,
        status,
        priority: 2,
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        body: "",
        files: [
          { path: "old/current.ts", scope: "project" as const },
          { path: "src/current.ts", scope: "project" as const },
        ],
      }));
      const registry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);
      const compact = await _testOnlyValidateCommand.buildFilesCheck(
        items,
        root,
        root,
        "default",
        false,
        false,
        registry,
      );
      expect(compact.check.status).toBe("ok");
      expect(compact.check.details).toMatchObject({
        active_missing_linked_links_count: 0,
        legacy_closed_missing_linked_links_count: 1,
        legacy_terminal_missing_linked_links_count: 2,
        missing_linked_links_count: 2,
        missing_linked_path_rows_count: 1,
        missing_linked_path_rows_truncated: false,
        missing_linked_path_rows: [
          {
            path: "old/current.ts",
            classification: "moved",
            candidates: ["src/current.ts"],
            link_count: 2,
          },
        ],
      });
      const full = await _testOnlyValidateCommand.buildFilesCheck(
        items,
        root,
        root,
        "default",
        false,
        true,
        registry,
      );
      expect(full.check.details.missing_linked_path_rows).toEqual(
        compact.check.details.missing_linked_path_rows,
      );
      items[0]!.status = "open";
      const active = await _testOnlyValidateCommand.buildFilesCheck(
        items,
        root,
        root,
        "default",
        false,
        false,
        registry,
      );
      expect(active.check.status).toBe("warn");
      expect(active.check.details.active_missing_linked_links_count).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
