import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runClose } from "../../src/cli/commands/close.js";
import { runCopy } from "../../src/cli/commands/copy.js";
import { runCreate } from "../../src/cli/commands/create.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { listAllFrontMatter } from "../../src/core/store/item-store.js";
import { readSettings } from "../../src/core/store/settings.js";
import type { TempPmContext } from "../helpers/withTempPmPath.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

async function seedClosedSource(context: TempPmContext): Promise<{ id: string; body: string }> {
  const body = "copy source body";
  const created = await runCreate(
    {
      title: "copy-source",
      description: "copy source description",
      type: "Task",
      body,
      createMode: "progressive",
      tags: "alpha,beta",
      assignee: "seed-owner",
    },
    { path: context.pmPath },
  );
  await runClose(
    created.item.id,
    "done for copy seed",
    {
      author: "seed-author",
      message: "close source before copy",
    },
    { path: context.pmPath },
  );
  return { id: created.item.id, body };
}

describe("runCopy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-copy-not-init-"));
    try {
      await expect(runCopy("pm-missing", {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails with not found when source item does not exist", async () => {
    await withTempPmPath(async (context) => {
      await expect(runCopy("pm-does-not-exist", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("copies metadata/body to a new open item and records copied_from in history", async () => {
    await withTempPmPath(async (context) => {
      const source = await seedClosedSource(context);
      const result = await runCopy(
        source.id,
        {
          title: "copy-target-title",
          message: "copy seed message",
        },
        { path: context.pmPath },
      );

      expect(result.source_id).toBe(source.id);
      expect(result.item.id).not.toBe(source.id);
      expect(result.item.title).toBe("copy-target-title");
      expect(result.item.status).toBe("open");
      expect(result.item.closed_at).toBeUndefined();
      expect(result.item.close_reason).toBeUndefined();
      expect(result.warnings).toEqual([]);
      expect(result.changed_fields).toContain("id");
      expect(result.changed_fields).toContain("status");

      const copiedItem = context.runCli(["get", result.item.id, "--json", "--full"], { expectJson: true });
      expect(copiedItem.code).toBe(0);
      expect((copiedItem.json as { item: { body?: string } }).item.body).toBe(source.body);

      const copiedHistory = context.runCli(["history", result.item.id, "--json", "--full"], { expectJson: true });
      expect(copiedHistory.code).toBe(0);
      const firstEntry = (copiedHistory.json as { history: Array<{ author?: string; message?: string; op: string }> }).history[0];
      expect(firstEntry.op).toBe("create");
      expect(firstEntry.message).toBe(`copy seed message | copied_from=${source.id}`);
      expect(firstEntry.author).toBeTruthy();
    });
  });

  it("normalizes blank title/author/message inputs per copy semantics", async () => {
    await withTempPmPath(async (context) => {
      const source = await seedClosedSource(context);

      await expect(runCopy(source.id, { title: "   " }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });

      const copied = await runCopy(
        source.id,
        {
          author: "   ",
          message: "   ",
        },
        { path: context.pmPath },
      );

      const copiedHistory = context.runCli(["history", copied.item.id, "--json", "--full"], { expectJson: true });
      const firstEntry = (copiedHistory.json as { history: Array<{ author?: string; message?: string }> }).history[0];
      expect(firstEntry.author).toBe("unknown");
      expect(firstEntry.message).toBe(`copied_from=${source.id}`);
    });
  });

  it("uses settings author fallback and omits body from changed_fields when source body is empty", async () => {
    await withTempPmPath(async (context) => {
      const created = await runCreate(
        {
          title: "copy-source-empty-body",
          description: "copy source with empty body",
          type: "Task",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      const settings = await readSettings(context.pmPath);
      const previousAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const copied = await runCopy(created.item.id, {}, { path: context.pmPath });
        expect(copied.changed_fields).not.toContain("body");

        const copiedHistory = context.runCli(["history", copied.item.id, "--json", "--full"], { expectJson: true });
        const firstEntry = (copiedHistory.json as { history: Array<{ author?: string; message?: string }> }).history[0];
        const expectedAuthor = settings.author_default.trim().length > 0 ? settings.author_default : "unknown";
        expect(firstEntry.author).toBe(expectedAuthor);
        expect(firstEntry.message).toBe(`copied_from=${created.item.id}`);
      } finally {
        if (previousAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousAuthor;
        }
      }
    });
  });

  it("removes the partially written item file when history append fails", async () => {
    await withTempPmPath(async (context) => {
      const source = await seedClosedSource(context);
      const before = await listAllFrontMatter(context.pmPath);
      const historyModule = await import("../../src/core/history/history.js");
      vi.spyOn(historyModule, "appendHistoryEntry").mockRejectedValueOnce(new Error("history-write-failed"));

      await expect(runCopy(source.id, {}, { path: context.pmPath })).rejects.toThrow("history-write-failed");

      const after = await listAllFrontMatter(context.pmPath);
      expect(after).toHaveLength(before.length);
      expect(after.map((item) => item.id).sort((left, right) => left.localeCompare(right))).toEqual(
        before.map((item) => item.id).sort((left, right) => left.localeCompare(right)),
      );
    });
  });
});
