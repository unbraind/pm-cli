import { appendFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatBuiltInOutput } from "../../../../src/core/output/output.js";
import {
  PM_READ_OUTPUT_POSITIONAL_ROW_PATHS,
  readOutputPositionalRowPaths,
} from "../../../../src/sdk/read-output/positional-rows.js";
import { PM_READ_OUTPUT_TAIL_RETENTION_POLICIES } from "../../../../src/sdk/read-output/tail-retention.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

/**
 * pm-e3hfv8: a TOON annotation listing renders one row per stored entry, a
 * malformed null included, so its length matches its count. pm-fkhdy8: TOON
 * get --fields renders every empty collection inside a selected item field or
 * facet, at any depth, as JSON delivers it.
 */

const COLLECTIONS = ["comments", "notes", "learnings"] as const;
const ROW = { index: 1, created_at: "2026-11-08T00:00:00.000Z", author: "a", text: "first" };

describe("pm-e3hfv8 TOON position-addressed annotation rows", () => {
  it("declares exactly the annotation collections, which are also the tail-retention surfaces", () => {
    expect(Object.keys(PM_READ_OUTPUT_POSITIONAL_ROW_PATHS).sort()).toEqual([...COLLECTIONS].sort());
    for (const collection of COLLECTIONS) {
      expect(readOutputPositionalRowPaths(collection)).toEqual([collection]);
      expect(PM_READ_OUTPUT_TAIL_RETENTION_POLICIES[collection]?.paths).toEqual([collection]);
    }
    expect(readOutputPositionalRowPaths("files")).toEqual([]);
    expect(readOutputPositionalRowPaths("toString")).toEqual([]);
    expect(readOutputPositionalRowPaths(undefined)).toEqual([]);
  });

  it("renders a null row so the rendered length matches the count, keeping the general null-dropping policy", () => {
    const listing = { id: "pm-a", comments: [ROW, null, 42], count: 3 };
    const toon = formatBuiltInOutput(listing, "toon", false, { positionalRowPaths: ["comments"] });
    expect(toon).toBe(
      'id: "pm-a"\ncomments[3]:\n  - index: 1\n    created_at: "2026-11-08T00:00:00.000Z"\n    author: a\n    text: first\n  - null\n  - 42\ncount: 3\n',
    );
    // Negative control: without the declaration the sparse policy still drops the null row.
    expect(formatBuiltInOutput(listing, "toon")).toContain("comments[2]:");
    expect(formatBuiltInOutput(listing, "toon")).not.toContain("- null");
    // JSON is unchanged.
    expect(JSON.parse(formatBuiltInOutput(listing, "json"))).toEqual(listing);
  });

  it("keeps rows whose compaction is empty, a collection of only null rows, and every other key", () => {
    expect(formatBuiltInOutput({ id: "pm-a", notes: [null, null], count: 2 }, "toon", false, { positionalRowPaths: ["notes"] })).toBe(
      'id: "pm-a"\nnotes[2]: null,null\ncount: 2\n',
    );
    expect(formatBuiltInOutput({ learnings: [[], ROW] }, "toon", false, { positionalRowPaths: ["learnings"] })).toContain("learnings[2]:");
    // A listing without a dropped row renders byte-for-byte as before.
    const wellFormed = { id: "pm-a", comments: [ROW], count: 1, total_count: 1 };
    expect(formatBuiltInOutput(wellFormed, "toon", false, { positionalRowPaths: ["comments"] })).toBe(formatBuiltInOutput(wellFormed, "toon"));
    // A path that is not an array, a scalar result and an undeclared collection are left alone.
    expect(formatBuiltInOutput({ comments: "x", other: [null] }, "toon", false, { positionalRowPaths: ["comments", "missing"] })).toBe('comments: "x"\n');
    expect(formatBuiltInOutput("value", "toon", false, { positionalRowPaths: ["comments"] })).toBe('"value"\n');
    // Keys the sparse policy dropped stay dropped beside a restored collection.
    expect(formatBuiltInOutput({ id: null, comments: [null] }, "toon", false, { positionalRowPaths: ["comments"] })).toBe("comments[1]: null\n");
  });

  it.each(COLLECTIONS)("renders every stored %s row through the CLI, matching JSON and the count", async (collection) => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: `TOON ${collection}` });
      await appendFile(
        path.join(context.pmPath, "tasks", `${id}.toon`),
        `${collection}[3]:\n  - created_at: "2026-11-07T00:00:00.000Z"\n    author: someone\n    text: stored\n  - null\n  - 42\n`,
        "utf8",
      );
      const json = context.runCli([collection, id, "--json"], { expectJson: true }).json as Record<string, unknown>;
      expect(json).toMatchObject({ count: 3 });
      expect(json[collection]).toEqual([expect.objectContaining({ index: 1 }), null, 42]);
      const toon = context.runCli([collection, id]);
      expect(toon.code, toon.stderr).toBe(0);
      expect(toon.stdout).toContain(`${collection}[3]:`);
      expect(toon.stdout).toContain("\n  - null\n  - 42\n");
      expect(toon.stdout).toContain("count: 3\n");
    });
  }, 60_000);
});

describe("pm-fkhdy8 TOON get --fields keeps nested empty collections", () => {
  const complete = { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: [] };
  const preserve = { preserveEmptyItemCollections: true };

  it("restores empty collections inside selected facets and item fields, recursively", () => {
    const selection = {
      item: { id: "pm-a", plan_scope: { goal: "g", paths: [], nested: { more: [], gone: null } } },
      linked: { files: [{ path: "a.ts", scope: "project" }], tests: [], docs: [] },
      schedule: { deadline: "2026-12-01T00:00:00.000Z", start_at: null, reminders: [], events: [] },
      omission_receipt: complete,
    };
    expect(formatBuiltInOutput(selection, "toon", false, preserve)).toBe(
      [
        "item:",
        '  id: "pm-a"',
        "  plan_scope:",
        '    goal: "g"',
        "    paths: []",
        "    nested:",
        "      more: []",
        "linked:",
        "  files[1]{path,scope}:",
        "    a.ts,project",
        "  tests: []",
        "  docs: []",
        "schedule:",
        '  deadline: "2026-12-01T00:00:00.000Z"',
        "  reminders: []",
        "  events: []",
        "omission_receipt: complete",
        "",
      ].join("\n"),
    );
    // Negative control: a read that is not an explicit selection keeps the sparse policy.
    const sparse = formatBuiltInOutput(selection, "toon");
    expect(sparse).not.toContain("tests: []");
    expect(sparse).not.toContain("paths: []");
    // JSON is unchanged.
    expect(JSON.parse(formatBuiltInOutput(selection, "json"))).toEqual(selection);
  });

  it("restores empties inside array rows by position, re-deriving rows the policy dropped", () => {
    const toon = formatBuiltInOutput(
      { item: { id: "pm-a", plan_steps: [{ id: "s1", deps: [] }], matrix: [[], ["x"], null, [[]]] } },
      "toon",
      false,
      preserve,
    );
    expect(toon).toContain("deps: []");
    expect(toon).toContain("matrix[3]:");
    expect(toon).toMatch(/matrix\[3\]:\n {4}- \[0\]:\n {4}- \[1\]: x\n {4}- \[1\]:\n {6}- \[0\]:/u);
    // A selected facet whose only member is empty, and a facet that is entirely empty, still render.
    expect(formatBuiltInOutput({ item: { id: "pm-a" }, linked: { tests: [] }, claim_state: {} }, "toon", false, preserve)).toBe(
      'item:\n  id: "pm-a"\nlinked:\n  tests: []\nclaim_state: {}\n',
    );
    // A facet holding only nulls stays dropped, and non-facet envelope keys keep the sparse policy.
    expect(formatBuiltInOutput({ item: { id: "pm-a" }, claim_state: { assignee: null }, receipts: { rows: [] } }, "toon", false, preserve)).toBe(
      'item:\n  id: "pm-a"\n',
    );
    // A non-empty array the policy reduced to nothing keeps the policy's verdict.
    expect(formatBuiltInOutput({ item: { id: "pm-a", tags: [null] } }, "toon", false, preserve)).toBe('item:\n  id: "pm-a"\n');
  });

  it("renders selected nested empty collections through the CLI exactly as JSON delivers them", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Nested empties" });
      expect(context.runCli(["files", id, "--add", "path=README.md,scope=project"]).code).toBe(0);
      const toon = context.runCli(["get", id, "--fields", "id,linked"]);
      expect(toon.code, toon.stderr).toBe(0);
      expect(toon.stdout).toContain("linked:\n  files[1]{path,scope}:\n    README.md,project\n  tests: []\n  docs: []\n");
      const json = context.runCli(["get", id, "--fields", "id,linked", "--json"], { expectJson: true }).json as Record<string, unknown>;
      expect(json.linked).toEqual({ files: [{ path: "README.md", scope: "project" }], tests: [], docs: [] });
      // A default read keeps the sparse presentation.
      expect(context.runCli(["get", id]).stdout).not.toContain("tests: []");
    });
  }, 60_000);
});
