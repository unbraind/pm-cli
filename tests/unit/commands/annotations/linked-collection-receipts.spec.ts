import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDocs } from "../../../../src/sdk/docs.js";
import { runFiles } from "../../../../src/sdk/files.js";
import {
  projectLinkedCollectionMutation,
  writtenLinkedEntries,
} from "../../../../src/sdk/linked-artifacts.js";
import { buildBackgroundTestCommandArgs } from "../../../../src/sdk/test/command-args.js";
import { runTest, type TestResult } from "../../../../src/sdk/test/execution.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../../../helpers/withTempPmPath.js";

/**
 * pm-gh1700: test, files and docs writes return the entries they wrote plus
 * the comments-style mutation and omission receipts, so the response no
 * longer grows with the stored list; --full-history / fullHistory / full
 * restores the whole collection on every transport.
 */

const RESTORE = {
  selector: "full_history",
  cli_flag: "--full-history",
  sdk_option: "fullHistory",
  mcp_option: "full",
} as const;

const originalProfile = process.env.PM_MCP_PROFILE;
beforeEach(() => {
  process.env.PM_MCP_PROFILE = "full";
});
afterEach(() => {
  if (originalProfile === undefined) delete process.env.PM_MCP_PROFILE;
  else process.env.PM_MCP_PROFILE = originalProfile;
});

async function callTool(context: TempPmContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = await import("../../../../src/mcp/server.js");
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await server.processRpcLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { path: context.pmPath, ...args } } }),
    );
    const response = JSON.parse(writeSpy.mock.calls.map(([chunk]) => String(chunk)).join("")) as {
      result: { structuredContent: { result: Record<string, unknown> } };
    };
    return response.result.structuredContent.result;
  } finally {
    writeSpy.mockRestore();
  }
}

async function linkTests(context: TempPmContext, id: string, from: number, to: number): Promise<void> {
  for (let index = from; index <= to; index += 1) {
    await runTest(id, { add: [`command=node -e ${String(index).padStart(2, "0")},scope=project`] }, { path: context.pmPath });
  }
}

describe("pm-gh1700 linked-test mutation receipts", () => {
  it("returns a receipt whose size does not grow with the linked-test list", async () => {
    await withTempPmPath(async (context) => {
      const small = createTestItemId(context, { title: "two linked tests" });
      const large = createTestItemId(context, { title: "twenty-six linked tests" });
      await linkTests(context, small, 1, 2);
      await linkTests(context, large, 1, 26);
      const add = (id: string) => runTest(id, { add: ["command=node -e 99,scope=project,note=new"] }, { path: context.pmPath });
      const strip = (result: TestResult) => JSON.stringify({ ...result, id: "", tests: result.tests.map((test) => ({ ...test, provenance: undefined })) });

      const smallReceipt = await add(small);
      const largeReceipt = await add(large);

      expect(largeReceipt).toMatchObject({
        changed: true,
        count: 1,
        total_count: 27,
        returned_count: 1,
        has_more: true,
        mutation_receipt: { changed_count: 1, removed_count: 0, full_history_included: false },
        omission_receipt: {
          has_omissions: true,
          omitted_field_group_count: 1,
          omitted_field_groups: [{ name: "tests_history", restore_with: RESTORE }],
        },
      });
      expect(largeReceipt.tests).toEqual([expect.objectContaining({ command: "node -e 99", note: "new" })]);
      // Only the stored count's digits differ between a 3-test and a 27-test item.
      expect(Math.abs(strip(largeReceipt).length - strip(smallReceipt).length)).toBeLessThanOrEqual(1);
      expect(largeReceipt).not.toHaveProperty("failure_categories");
    });
  });

  it("reports the linked test as storage saved it, not the submitted spelling", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "normalized linked test" });
      const added = await runTest(id, { addJson: [JSON.stringify({ command: "node -e 1", path: "tests\\a.mjs", scope: "project" })] }, { path: context.pmPath });
      expect(added.tests).toEqual([expect.objectContaining({ command: "node -e 1", path: "tests/a.mjs" })]);
      // The returned path is the stored one, so removing by it matches.
      const removed = await runTest(id, { remove: [`path=${added.tests[0]!.path}`] }, { path: context.pmPath });
      expect(removed).toMatchObject({ removed: 1, total_count: 0 });
    });
  });

  it("reports failure categories only on runs and restores every linked test with fullHistory", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "receipt restore" });
      await linkTests(context, id, 1, 3);

      const duplicate = await runTest(id, { add: ["command=node -e 01,scope=project"] }, { path: context.pmPath });
      expect(duplicate).toMatchObject({ changed: false, tests: [], count: 0, total_count: 3, mutation_receipt: { changed_count: 0 } });

      const removed = await runTest(id, { removeIndex: [3] }, { path: context.pmPath });
      expect(removed).toMatchObject({ tests: [], removed: 1, total_count: 2, mutation_receipt: { changed_count: 0, removed_count: 1 } });
      expect(removed).not.toHaveProperty("failure_categories");

      const edited = await runTest(id, { updateIndex: "2", setJson: JSON.stringify({ note: "edited" }) }, { path: context.pmPath });
      expect(edited).toMatchObject({ updated_index: 2, count: 1, total_count: 2, mutation_receipt: { changed_count: 1 } });
      expect(edited.tests).toEqual([expect.objectContaining({ command: "node -e 02", note: "edited" })]);
      expect(edited).not.toHaveProperty("failure_categories");
      const unchangedEdit = await runTest(id, { updateIndex: "2", setJson: JSON.stringify({ note: "edited" }) }, { path: context.pmPath });
      expect(unchangedEdit).toMatchObject({ changed: false, tests: [], mutation_receipt: { changed_count: 0 } });

      const listed = await runTest(id, {}, { path: context.pmPath });
      expect(listed.tests).toHaveLength(2);
      expect(listed).not.toHaveProperty("failure_categories");
      expect(listed).not.toHaveProperty("mutation_receipt");

      const ran = await runTest(id, { run: true, onlyIndex: 1 }, { path: context.pmPath });
      expect(ran.failure_categories).toMatchObject({ timeout: 0, spawn_error: 0 });

      // The omission receipt's selector restores the whole collection after a write.
      const full = await runTest(id, { add: ["command=node -e 04,scope=project"], fullHistory: true }, { path: context.pmPath });
      expect(full.tests.map((test) => test.command)).toEqual(["node -e 01", "node -e 02", "node -e 04"]);
      expect(full).toMatchObject({
        count: 3,
        total_count: 3,
        has_more: false,
        mutation_receipt: { changed_count: 1, full_history_included: true },
        omission_receipt: { has_omissions: false, omitted_field_groups: [] },
      });
      const fullEdit = await runTest(id, { updateIndex: "1", setJson: JSON.stringify({ note: "first" }), fullHistory: true }, { path: context.pmPath });
      expect(fullEdit.tests).toHaveLength(3);
    });
  });

  it("keeps the caller's receipt shape when a refusal's recovery replays the invocation", () => {
    expect(buildBackgroundTestCommandArgs("pm-x", { removeIndex: [2], fullHistory: true, measure: ["coverage=1"] })).toContain("--full-history");
    expect(buildBackgroundTestCommandArgs("pm-x", { removeIndex: [2] })).not.toContain("--full-history");
  });
});

describe("pm-gh1700 linked file and doc mutation receipts", () => {
  it("returns only the written links, with removal counts and the written paths' validation", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "bounded file receipts" });
      for (let index = 1; index <= 10; index += 1) {
        await runFiles(id, { add: [`path=src/f${String(index).padStart(2, "0")}.ts,scope=project`] }, { path: context.pmPath });
      }

      const added = await runFiles(id, { add: ["path=src/new.ts,scope=project,note=n"] }, { path: context.pmPath });
      expect(added).toMatchObject({
        files: [{ path: "src/new.ts", scope: "project", note: "n" }],
        changed: true,
        count: 1,
        total_count: 11,
        returned_count: 1,
        has_more: true,
        validation: { checked: 1, missing_paths: ["src/new.ts"] },
        mutation_receipt: { changed_count: 1, removed_count: 0, full_history_included: false },
        omission_receipt: { has_omissions: true, omitted_field_groups: [{ name: "files_history", restore_with: RESTORE }] },
      });

      const retried = await runFiles(id, { add: ["path=src/new.ts,scope=project,note=n"] }, { path: context.pmPath });
      expect(retried).toMatchObject({ changed: false, files: [], count: 0, mutation_receipt: { changed_count: 0 } });
      expect(retried.validation).toBeUndefined();

      const revised = await runFiles(id, { add: ["path=src/new.ts,scope=project,note=n2"] }, { path: context.pmPath });
      expect(revised.files).toEqual([{ path: "src/new.ts", scope: "project", note: "n2" }]);

      const migrated = await runFiles(id, { migrate: ["from=src/f0,to=lib/f0"] }, { path: context.pmPath });
      expect(migrated).toMatchObject({ count: 9, total_count: 11, migrations_applied: 9, mutation_receipt: { changed_count: 9, removed_count: 0 } });

      // A migration onto an existing link collapses the pair: one stored entry is removed.
      await runFiles(id, { add: ["path=lib/f10.ts,scope=project"] }, { path: context.pmPath });
      const collapsed = await runFiles(id, { migrate: ["from=src/f10,to=lib/f10"] }, { path: context.pmPath });
      expect(collapsed).toMatchObject({ total_count: 11, mutation_receipt: { removed_count: 1 } });

      const removed = await runFiles(id, { remove: ["src/new.ts"] }, { path: context.pmPath });
      expect(removed).toMatchObject({ files: [], count: 0, total_count: 10, mutation_receipt: { changed_count: 0, removed_count: 1 } });
      expect(removed.validation).toBeUndefined();

      // --validate-paths still judges the whole stored list, while the response stays bounded.
      const validated = await runFiles(id, { add: ["path=src/x.ts,scope=project"], validatePaths: true }, { path: context.pmPath });
      expect(validated.files).toHaveLength(1);
      expect(validated.validation?.checked).toBe(11);

      const full = await runFiles(id, { add: ["path=src/y.ts,scope=project"], fullHistory: true }, { path: context.pmPath });
      expect(full).toMatchObject({ count: 12, total_count: 12, has_more: false, mutation_receipt: { full_history_included: true } });
      expect(full.validation?.checked).toBe(12);

      const listed = await runFiles(id, {}, { path: context.pmPath });
      expect(listed.files).toHaveLength(12);
      expect(listed).not.toHaveProperty("mutation_receipt");
      expect(listed).not.toHaveProperty("total_count");
    });
  });

  it("returns the doc it wrote even when storage orders the collection differently from the draft", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "storage order" });
      await runDocs(id, { add: ["path=z.md,scope=global"] }, { path: context.pmPath });
      const added = await runDocs(id, { add: ["path=a.md,scope=project"] }, { path: context.pmPath });
      expect(added.docs).toEqual([{ path: "a.md", scope: "project" }]);
      expect(added.validation?.missing_paths).toEqual(["a.md"]);
      const files = await runFiles(id, { add: ["path=z.ts,scope=global", "path=a.ts,scope=project,note=n"] }, { path: context.pmPath });
      expect(files.files).toEqual(expect.arrayContaining([{ path: "z.ts", scope: "global" }, { path: "a.ts", scope: "project", note: "n" }]));
      expect(files.files).toHaveLength(2);
    });
  });

  it("answers a glob that matches nothing with a zero-change receipt, not the full listing", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "empty glob" });
      await runFiles(id, { add: ["path=a.ts,scope=project", "path=b.ts,scope=project"] }, { path: context.pmPath });
      for (const run of [runFiles, runDocs] as const) {
        const empty = await run(id, { addGlob: ["__no_matches__/*.ts"] }, { path: context.pmPath });
        expect(empty).toMatchObject({ changed: false, count: 0, mutation_receipt: { changed_count: 0, removed_count: 0 } });
        expect(empty.validation).toBeUndefined();
      }
      const files = await runFiles(id, { addGlob: ["__no_matches__/*.ts"] }, { path: context.pmPath });
      expect(files).toMatchObject({ files: [], total_count: 2, has_more: true, omission_receipt: { has_omissions: true } });
      const full = await runFiles(id, { addGlob: ["__no_matches__/*.ts"], fullHistory: true }, { path: context.pmPath });
      expect(full).toMatchObject({ count: 2, total_count: 2, mutation_receipt: { full_history_included: true } });
    });
  });

  it("bounds doc writes with the same receipt and marks a complete response", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "bounded doc receipts" });
      const first = await runDocs(id, { add: ["path=README.md,scope=project"] }, { path: context.pmPath });
      expect(first).toMatchObject({
        docs: [{ path: "README.md", scope: "project" }],
        count: 1,
        total_count: 1,
        has_more: false,
        mutation_receipt: { changed_count: 1, full_history_included: true },
        omission_receipt: { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: [] },
      });
      const second = await runDocs(id, { add: ["path=docs/A.md,scope=project"] }, { path: context.pmPath });
      expect(second).toMatchObject({
        docs: [{ path: "docs/A.md" }],
        total_count: 2,
        omission_receipt: { omitted_field_groups: [{ name: "docs_history", restore_with: RESTORE }] },
      });
    });
  });
});

describe("pm-gh1700 transport parity", () => {
  it("bounds CLI writes by default and restores the collection with --full-history", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "cli receipts" });
      await linkTests(context, id, 1, 3);
      await runFiles(id, { add: ["path=a.ts,scope=project", "path=b.ts,scope=project"] }, { path: context.pmPath });

      const bounded = context.runCli(["test", id, "--add", "command=node -e 9,scope=project", "--json"], { expectJson: true, preserveDefaultMutationOutput: true });
      expect(bounded.code, bounded.stderr).toBe(0);
      expect(bounded.json).toMatchObject({ count: 1, total_count: 4, mutation_receipt: { full_history_included: false } });
      expect(bounded.json).not.toHaveProperty("failure_categories");
      const full = context.runCli(["test", id, "--add", "command=node -e 8,scope=project", "--full-history", "--json"], { expectJson: true, preserveDefaultMutationOutput: true });
      expect((full.json as TestResult).tests).toHaveLength(5);

      const files = context.runCli(["files", id, "--add", "path=c.ts,scope=project", "--full-history", "--json"], { expectJson: true, preserveDefaultMutationOutput: true });
      expect(files.json).toMatchObject({ count: 3, total_count: 3, mutation_receipt: { full_history_included: true } });
      const docs = context.runCli(["docs", id, "--add", "path=README.md,scope=project", "--json"], { expectJson: true, preserveDefaultMutationOutput: true });
      expect(docs.json).toMatchObject({ count: 1, total_count: 1 });
    });
  });

  it("bounds MCP writes by default and restores the collection with full", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "mcp receipts" });
      await linkTests(context, id, 1, 2);
      await runFiles(id, { add: ["path=a.ts,scope=project"] }, { path: context.pmPath });

      const bounded = await callTool(context, "pm_test", { id, add: ["command=node -e 7,scope=project"] });
      expect(bounded).toMatchObject({ count: 1, total_count: 3, mutation_receipt: { full_history_included: false } });
      const full = await callTool(context, "pm_test", { id, add: ["command=node -e 6,scope=project"], full: true });
      expect(full).toMatchObject({ count: 4, total_count: 4, mutation_receipt: { full_history_included: true } });

      const files = await callTool(context, "pm_files", { id, add: ["path=b.ts,scope=project"], full: true });
      expect(files).toMatchObject({ count: 2, total_count: 2 });
      const docs = await callTool(context, "pm_docs", { id, add: ["path=README.md,scope=project"] });
      expect(docs).toMatchObject({ count: 1, total_count: 1, mutation_receipt: { changed_count: 1 } });
    });
  });
});

describe("pm-gh1700 linked-collection receipt primitives", () => {
  it("treats only new or rewritten values as written, as a multiset", () => {
    const a = { path: "a", scope: "project" };
    const b = { path: "b", scope: "project" };
    expect(writtenLinkedEntries([a, b], [a, b])).toEqual([]);
    expect(writtenLinkedEntries([a], [a, { ...b, note: "n" }])).toEqual([{ ...b, note: "n" }]);
    expect(writtenLinkedEntries([a], [a, a])).toEqual([a]);
    expect(writtenLinkedEntries([], [a])).toEqual([a]);
    // An undefined-valued key is absent once persisted, so it does not make an entry new.
    expect(writtenLinkedEntries([a], [{ ...a, note: undefined }])).toEqual([]);
  });

  it("names the restore selector only when entries were withheld", () => {
    const bounded = projectLinkedCollectionMutation({ collectionKey: "files", stored: [1, 2, 3], written: [3], removedCount: 2, fullHistory: false });
    expect(bounded).toMatchObject({
      entries: [3],
      total_count: 3,
      returned_count: 1,
      has_more: true,
      mutation_receipt: { changed_count: 1, removed_count: 2, full_history_included: false },
      omission_receipt: { has_omissions: true, omitted_field_group_count: 1 },
    });
    const full = projectLinkedCollectionMutation({ collectionKey: "docs", stored: [1, 2], written: [2], removedCount: 0, fullHistory: true });
    expect(full).toMatchObject({ entries: [1, 2], has_more: false, mutation_receipt: { changed_count: 1, full_history_included: true } });
    expect(full.omission_receipt).toEqual({ has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: [] });
  });
});
