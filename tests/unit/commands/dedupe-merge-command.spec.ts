import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _testOnly as mergeInternals,
  runDedupeMerge,
} from "../../../packages/pm-governance-audit/extensions/governance-audit/dedupe-merge.ts";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../../helpers/withTempPmPath.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function createItem(
  context: TempPmContext,
  params: {
    title: string;
    type?: string;
    status?: "open" | "closed";
    parent?: string;
  },
): string {
  return createTestItemId(context, {
    title: params.title,
    type: params.type,
    status: params.status,
    parent: params.parent,
    tags: "dedupe-merge,unit",
    estimate: "15",
    author: "test-author",
  });
}

function getItem(
  context: TempPmContext,
  id: string,
): { parent?: string; status: string; duplicate_of?: string } {
  const result = context.runCli(["get", id, "--json"], { expectJson: true });
  expect(result.code).toBe(0);
  return (
    result.json as {
      item: { parent?: string; status: string; duplicate_of?: string };
    }
  ).item;
}

describe("runDedupeMerge", () => {
  it("rejects an uninitialized tracker", async () => {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "pm-dedupe-merge-uninit-"),
    );
    try {
      await expect(
        runDedupeMerge({ keep: "pm-a", close: "pm-b" }, { path: tempDir }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      } as PmCliError);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("previews a merge without mutating by default (dry-run)", async () => {
    await withTempPmPath(async (context) => {
      const keep = createItem(context, {
        title: "Canonical security work",
        type: "Feature",
      });
      const duplicate = createItem(context, {
        title: "Duplicate security work",
      });
      const activeChild = createItem(context, {
        title: "Active child task",
        parent: duplicate,
      });
      const closedChild = createItem(context, {
        title: "Closed child task",
        status: "closed",
        parent: duplicate,
      });

      const result = await runDedupeMerge(
        { keep, close: duplicate },
        { path: context.pmPath },
      );

      expect(result.mode).toBe("dry_run");
      expect(result.canonical_id).toBe(keep);
      expect(result.duplicates).toHaveLength(1);
      const outcome = result.duplicates[0];
      expect(
        outcome.reparented_children.map((child) => child.child_id),
      ).toEqual([activeChild]);
      expect(outcome.reparented_children[0].applied).toBe(false);
      expect(outcome.skipped_children.map((child) => child.child_id)).toEqual([
        closedChild,
      ]);
      expect(outcome.close.applied).toBe(false);
      expect(outcome.close.skipped_reason).toBe("dry_run");
      expect(result.totals).toMatchObject({
        duplicates: 1,
        children_reparented: 0,
        children_skipped: 1,
        closed: 0,
      });

      // Nothing was actually written.
      expect(getItem(context, activeChild).parent).toBe(duplicate);
      expect(getItem(context, duplicate).status).toBe("open");
    });
  });

  it("applies a merge: re-parents active children and closes duplicates as duplicate_of", async () => {
    await withTempPmPath(async (context) => {
      const keep = createItem(context, {
        title: "Canonical infra cleanup",
        type: "Feature",
      });
      const dup1 = createItem(context, {
        title: "Duplicate infra cleanup one",
      });
      const dup2 = createItem(context, {
        title: "Duplicate infra cleanup two",
      });
      const child = createItem(context, {
        title: "Child of dup1",
        parent: dup1,
      });

      const result = await runDedupeMerge(
        {
          keep,
          close: `${dup1},${dup2}`,
          apply: true,
          author: "merge-bot",
          message: "consolidate infra",
        },
        { path: context.pmPath },
      );

      expect(result.mode).toBe("apply");
      expect(result.totals).toMatchObject({
        duplicates: 2,
        children_reparented: 1,
        closed: 2,
      });
      expect(result.warnings).toEqual([]);

      expect(getItem(context, child).parent).toBe(keep);
      const closedDup1 = getItem(context, dup1);
      expect(closedDup1.status).toBe("closed");
      expect(closedDup1.duplicate_of).toBe(keep);
      expect(getItem(context, dup2).duplicate_of).toBe(keep);
    });
  });

  it("skips re-parenting when --skip-children (reparentChildren=false) is set", async () => {
    await withTempPmPath(async (context) => {
      const keep = createItem(context, { title: "Canonical keep no children" });
      const duplicate = createItem(context, {
        title: "Duplicate keep no children",
      });
      const child = createItem(context, {
        title: "Untouched child",
        parent: duplicate,
      });

      const result = await runDedupeMerge(
        { keep, close: duplicate, apply: true, reparentChildren: false },
        { path: context.pmPath },
      );

      const outcome = result.duplicates[0];
      expect(outcome.reparented_children).toEqual([]);
      expect(outcome.skipped_children).toEqual([]);
      expect(result.totals.children_reparented).toBe(0);
      expect(getItem(context, child).parent).toBe(duplicate);
      expect(getItem(context, duplicate).status).toBe("closed");
    });
  });

  it("skips closing an already-terminal duplicate but still re-parents its active children", async () => {
    await withTempPmPath(async (context) => {
      const keep = createItem(context, {
        title: "Canonical for terminal duplicate",
      });
      const terminalDup = createItem(context, {
        title: "Already closed duplicate",
        status: "closed",
      });
      const child = createItem(context, {
        title: "Child of terminal duplicate",
        parent: terminalDup,
      });

      const result = await runDedupeMerge(
        { keep, close: terminalDup, apply: true },
        { path: context.pmPath },
      );

      const outcome = result.duplicates[0];
      expect(outcome.close.applied).toBe(false);
      expect(outcome.close.skipped_reason).toBe("already_terminal");
      expect(
        result.warnings.some((warning) =>
          warning.startsWith(`close_skipped_terminal:${terminalDup}`),
        ),
      ).toBe(true);
      expect(
        outcome.reparented_children.map((child) => child.child_id),
      ).toEqual([child]);
      expect(getItem(context, child).parent).toBe(keep);
    });
  });

  it("records warnings when re-parent or close mutations fail", async () => {
    await withTempPmPath(async (context) => {
      const keep = createItem(context, { title: "Canonical warning target" });
      const duplicate = createItem(context, {
        title: "Duplicate warning target",
      });
      const duplicateTwo = createItem(context, {
        title: "Duplicate warning target two",
      });
      const duplicateThree = createItem(context, {
        title: "Duplicate close warning target",
      });
      const child = createItem(context, {
        title: "Locked child warning target",
        parent: duplicate,
      });
      const childTwo = createItem(context, {
        title: "Locked child warning target two",
        parent: duplicateTwo,
      });
      vi.resetModules();
      vi.doMock(
        "../../../src/cli/commands/update.js",
        async (importOriginal) => {
          const actual =
            await importOriginal<
              typeof import("../../../src/cli/commands/update.js")
            >();
          let updateCalls = 0;
          return {
            ...actual,
            runUpdate: vi.fn(async () => {
              updateCalls += 1;
              if (updateCalls === 1) {
                throw "blocked update";
              }
              throw new Error("blocked update error");
            }),
          };
        },
      );
      vi.doMock(
        "../../../src/cli/commands/close.js",
        async (importOriginal) => {
          const actual =
            await importOriginal<
              typeof import("../../../src/cli/commands/close.js")
            >();
          let closeCalls = 0;
          return {
            ...actual,
            runClose: vi.fn(async () => {
              closeCalls += 1;
              if (closeCalls === 1) {
                throw "blocked close";
              }
              throw new Error("blocked close error");
            }),
          };
        },
      );
      const mockedMerge =
        await import("../../../packages/pm-governance-audit/extensions/governance-audit/dedupe-merge.ts");

      const result = await mockedMerge.runDedupeMerge(
        {
          keep,
          close: `${duplicate},${duplicateTwo},${duplicateThree}`,
          apply: true,
          author: "merge-bot",
        },
        { path: context.pmPath },
      );

      const outcome = result.duplicates[0];
      expect(outcome.reparented_children).toEqual([
        expect.objectContaining({ child_id: child, applied: false }),
      ]);
      expect(outcome.close).toMatchObject({
        applied: false,
        skipped_reason: "failed",
      });
      const secondOutcome = result.duplicates[1];
      expect(secondOutcome.reparented_children).toEqual([
        expect.objectContaining({ child_id: childTwo, applied: false }),
      ]);
      expect(secondOutcome.close).toMatchObject({
        applied: false,
        skipped_reason: "failed",
      });
      const thirdOutcome = result.duplicates[2];
      expect(thirdOutcome.reparented_children).toEqual([]);
      expect(thirdOutcome.close).toMatchObject({
        applied: false,
        skipped_reason: "failed",
      });
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          `reparent_failed:${child}:blocked update`,
          `reparent_failed:${childTwo}:blocked update error`,
          `close_failed:${duplicateThree}:blocked close`,
        ]),
      );
      expect(
        result.warnings.some((warning) =>
          warning.startsWith(`close_failed:${duplicate}:`),
        ),
      ).toBe(false);
      expect(
        result.warnings.some((warning) =>
          warning.startsWith(`close_failed:${duplicateTwo}:`),
        ),
      ).toBe(false);
      expect(getItem(context, child).parent).toBe(duplicate);
      expect(getItem(context, duplicate).status).toBe("open");
      expect(getItem(context, childTwo).parent).toBe(duplicateTwo);
      expect(getItem(context, duplicateTwo).status).toBe("open");
      expect(getItem(context, duplicateThree).status).toBe("open");
    });
  });

  it("skips an already-terminal duplicate without warning when duplicate_of already points at the canonical", async () => {
    await withTempPmPath(async (context) => {
      const keep = createItem(context, { title: "Canonical already marked" });
      const duplicate = createItem(context, {
        title: "Already marked duplicate",
      });
      const child = createItem(context, {
        title: "Child of already marked duplicate",
        parent: duplicate,
      });
      const close = context.runCli(
        [
          "close",
          duplicate,
          "--duplicate-of",
          keep,
          "--author",
          "test-author",
          "--json",
        ],
        { expectJson: true },
      );
      expect(close.code).toBe(0);

      const result = await runDedupeMerge(
        { keep, close: duplicate, apply: true },
        { path: context.pmPath },
      );

      const outcome = result.duplicates[0];
      expect(outcome.close).toMatchObject({
        applied: false,
        skipped_reason: "already_terminal",
      });
      expect(result.warnings).toEqual([]);
      expect(
        outcome.reparented_children.map((entry) => entry.child_id),
      ).toEqual([child]);
      expect(getItem(context, child).parent).toBe(keep);
    });
  });

  it("validates required ids and rejects merging an item with itself", async () => {
    await withTempPmPath(async (context) => {
      const keep = createItem(context, { title: "Canonical validation" });

      await expect(
        runDedupeMerge({ close: keep }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      } as PmCliError);
      await expect(
        runDedupeMerge({ keep }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      } as PmCliError);
      await expect(
        runDedupeMerge({ keep, close: keep }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      } as PmCliError);
      await expect(
        runDedupeMerge(
          { keep, close: keep.replace(/^pm-/, "") },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      } as PmCliError);
      await expect(
        runDedupeMerge(
          { keep: "pm-missing", close: keep },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      } as PmCliError);
      await expect(
        runDedupeMerge({ keep, close: "pm-missing" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      } as PmCliError);
    });
  });

  it("exposes pure parsers through _testOnly", () => {
    expect(mergeInternals.parseRequiredId(" pm-a ", "--keep")).toBe("pm-a");
    expect(() => mergeInternals.parseRequiredId("  ", "--keep")).toThrow(
      PmCliError,
    );
    expect(
      mergeInternals.parseDuplicateIds("pm-a, pm-b, pm-a", "pm-keep"),
    ).toEqual(["pm-a", "pm-b"]);
    expect(
      mergeInternals.parseDuplicateIds(["pm-a", "pm-b,pm-c"], "pm-keep"),
    ).toEqual(["pm-a", "pm-b", "pm-c"]);
    expect(() => mergeInternals.parseDuplicateIds("", "pm-keep")).toThrow(
      PmCliError,
    );
    expect(() =>
      mergeInternals.parseDuplicateIds("pm-keep", "pm-keep"),
    ).toThrow(PmCliError);
  });
});
