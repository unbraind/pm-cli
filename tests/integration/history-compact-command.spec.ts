import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runHistory } from "../../src/cli/commands/history.js";
import {
  assertHistoryCompactTarget,
  runHistoryCompact,
  runHistoryCompactBulk,
} from "../../src/cli/commands/history-compact.js";
import * as fsUtilsModule from "../../src/core/fs/fs-utils.js";
import * as replayModule from "../../src/core/history/replay.js";
import * as historyRewriteModule from "../../src/core/history/history-rewrite.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createItem(context: TempPmContext, title: string): string {
  const result = context.runCli(
    ["create", "--json", "--title", title, "--description", "history compact target", "--type", "Task"],
    { expectJson: true },
  );
  expect(result.code).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
}

function getHistoryPath(context: TempPmContext, id: string): string {
  return path.join(context.pmPath, "history", `${id}.jsonl`);
}

function getTaskItemPath(context: TempPmContext, id: string): string {
  return path.join(context.pmPath, "tasks", `${id}.toon`);
}

async function tamperSecondBeforeHash(file: string): Promise<void> {
  const lines = (await readFile(file, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const second = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
  second.before_hash = "0".repeat(64);
  lines[1] = JSON.stringify(second);
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
}

async function rewriteEntryTimestamps(file: string, timestamps: string[]): Promise<void> {
  const lines = (await readFile(file, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const rewritten = lines.map((line, index) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (index < timestamps.length) {
      parsed.ts = timestamps[index];
    }
    return JSON.stringify(parsed);
  });
  await writeFile(file, `${rewritten.join("\n")}\n`, "utf8");
}

describe("history-compact command", () => {
  it("compacts the full stream to baseline + audit marker by default", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Full");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      expect(context.runCli(["append", id, "--body", "more history"]).code).toBe(0);

      const before = await runHistory(id, { verify: true }, { path: context.pmPath });
      expect(before.verification?.ok).toBe(true);
      expect(before.count).toBeGreaterThanOrEqual(3);

      const compacted = await runHistoryCompact(
        id,
        { author: "test-author", message: "Compact full stream for test" },
        { path: context.pmPath },
      );
      expect(compacted.changed).toBe(true);
      expect(compacted.compact_boundary.entries_compacted).toBe(before.count);
      expect(compacted.compact_boundary.entries_retained).toBe(0);
      expect(compacted.history.entries_after).toBe(2);
      expect(compacted.history.baseline_entry_added).toBe(true);
      expect(compacted.history.audit_entry_added).toBe(true);
      expect(compacted.history.verify_ok).toBe(true);

      const verified = await runHistory(id, { verify: true }, { path: context.pmPath });
      expect(verified.verification?.ok).toBe(true);
      const historyRaw = await readFile(getHistoryPath(context, id), "utf8");
      expect(historyRaw).toContain('"op":"history_compact_baseline"');
      expect(historyRaw).toContain('"op":"history_compact"');

      const restore = context.runCli(["restore", id, "1", "--json"], { expectJson: true });
      expect(restore.code).toBe(0);
    });
  });

  it("compacts only entries before a version boundary and keeps newer tail entries", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Prefix");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      expect(context.runCli(["append", id, "--body", "tail entry"]).code).toBe(0);

      const compacted = await runHistoryCompact(
        id,
        { before: "3", author: "test-author", message: "Compact first two entries" },
        { path: context.pmPath },
      );
      expect(compacted.changed).toBe(true);
      expect(compacted.compact_boundary.kind).toBe("version");
      expect(compacted.compact_boundary.entries_compacted).toBe(2);
      expect(compacted.compact_boundary.entries_retained).toBe(1);
      expect(compacted.compact_boundary.first_retained_entry).toBe(3);
      expect(compacted.history.entries_after).toBe(3);

      const after = await runHistory(id, { full: true, verify: true }, { path: context.pmPath });
      expect(after.verification?.ok).toBe(true);
      expect(after.history[0]?.op).toBe("history_compact_baseline");
      expect(after.history.some((entry) => entry.op === "append")).toBe(true);
      expect(after.history[after.history.length - 1]?.op).toBe("history_compact");
    });
  });

  it("rejects an empty --before value", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Empty Before");
      await expect(runHistoryCompact(id, { before: "   ", author: "test-author" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("non-empty value"),
      });
    });
  });

  it("rejects an out-of-range version boundary", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Invalid Version");
      await expect(runHistoryCompact(id, { before: "999", author: "test-author" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("version must be between"),
      });
    });
  });

  it("rejects a malformed timestamp boundary", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Invalid Timestamp");
      await expect(
        runHistoryCompact(id, { before: "definitely-not-a-timestamp", author: "test-author" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("Use a version number or ISO timestamp"),
      });
    });
  });

  it("compacts entries strictly before an ISO timestamp boundary", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Timestamp");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      expect(context.runCli(["append", id, "--body", "tail entry"]).code).toBe(0);
      const historyFile = getHistoryPath(context, id);
      await rewriteEntryTimestamps(historyFile, [
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:02.000Z",
      ]);

      const compacted = await runHistoryCompact(
        id,
        { before: "2026-01-01T00:00:02.000Z", author: "test-author" },
        { path: context.pmPath },
      );
      expect(compacted.compact_boundary.kind).toBe("timestamp");
      expect(compacted.changed).toBe(true);
      expect(compacted.compact_boundary.entries_compacted).toBe(2);
      expect(compacted.compact_boundary.entries_retained).toBe(1);
      expect(compacted.history.verify_ok).toBe(true);
    });
  });

  it("rejects invalid timestamps inside existing history entries", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Invalid Entry Timestamp");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      const historyFile = getHistoryPath(context, id);
      await rewriteEntryTimestamps(historyFile, ["invalid-timestamp-token"]);

      await expect(
        runHistoryCompact(id, { before: "2026-01-01T00:00:00.000Z", author: "test-author" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
        message: expect.stringContaining("invalid timestamp"),
      });
    });
  });

  it("uses the first timestamp boundary hit as the contiguous compact prefix", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Timestamp Prefix");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      expect(context.runCli(["append", id, "--body", "tail entry"]).code).toBe(0);
      const historyFile = getHistoryPath(context, id);
      await rewriteEntryTimestamps(historyFile, [
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:05.000Z",
        "2026-01-01T00:00:01.000Z",
      ]);

      const compacted = await runHistoryCompact(
        id,
        { before: "2026-01-01T00:00:03.000Z", author: "test-author" },
        { path: context.pmPath },
      );
      expect(compacted.compact_boundary.kind).toBe("timestamp");
      expect(compacted.changed).toBe(true);
      expect(compacted.compact_boundary.entries_compacted).toBe(1);
      expect(compacted.compact_boundary.entries_retained).toBe(2);
      expect(compacted.history.verify_ok).toBe(true);
    });
  });

  it("handles history-only subjects when the item file is missing", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact History Only Subject");
      expect(context.runCli(["append", id, "--body", "history-only tail"]).code).toBe(0);
      await rm(getTaskItemPath(context, id), { force: true });

      const compacted = await runHistoryCompact(id, { before: "2", author: "test-author" }, { path: context.pmPath });
      expect(compacted.changed).toBe(true);
      expect(compacted.item.exists).toBe(false);
      expect(compacted.item.path).toBeNull();
      expect(compacted.item.matched_chain_before).toBeNull();
      expect(compacted.history.verify_ok).toBe(true);
    });
  });

  it("returns both noop and chain-mismatch warnings in stable order", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Warning Sort");
      const itemFile = getTaskItemPath(context, id);
      const beforeRaw = await readFile(itemFile, "utf8");
      await writeFile(itemFile, beforeRaw.replace(/^title:.*$/m, 'title: "Tampered title to force chain mismatch"'), "utf8");

      const result = await runHistoryCompact(
        id,
        { before: "1", author: "test-author" },
        { path: context.pmPath },
      );
      expect(result.changed).toBe(false);
      expect(result.warnings).toEqual(["history_compact_item_chain_mismatch", "history_compact_noop_before_boundary"]);
    });
  });

  it("uses singular message variants when compacting exactly one entry", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Single Entry");
      const compacted = await runHistoryCompact(id, { author: "test-author" }, { path: context.pmPath });
      expect(compacted.changed).toBe(true);
      expect(compacted.compact_boundary.entries_compacted).toBe(1);
      expect(compacted.history.entries_after).toBe(2);

      const historyRaw = await readFile(getHistoryPath(context, id), "utf8");
      expect(historyRaw).toContain("after compacting 1 entry");
      expect(historyRaw).toContain("compacted full stream (1 entry)");
    });
  });

  it("fails when tracker settings are missing", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Missing Tracker Settings");
      const uninitializedPath = path.join(context.tempRoot, "not-initialized");
      await writeFile(path.join(context.tempRoot, "seed"), "seed", "utf8");
      await expect(runHistoryCompact(id, { author: "test-author" }, { path: uninitializedPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
        message: expect.stringContaining("Run pm init first"),
      });
    });
  });

  it("fails when the history stream file is missing", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Missing History Stream");
      await rm(getHistoryPath(context, id), { force: true });
      await expect(runHistoryCompact(id, { author: "test-author" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
        message: expect.stringContaining("No history stream exists"),
      });
    });
  });

  it("fails when the history stream exists but has no entries", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Empty History Stream");
      await writeFile(getHistoryPath(context, id), "", "utf8");
      await expect(runHistoryCompact(id, { author: "test-author" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("nothing to compact"),
      });
    });
  });

  it("supports dry-run compaction previews without rewriting history", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Dry Run");
      expect(context.runCli(["update", id, "--priority", "1"]).code).toBe(0);
      const historyFile = getHistoryPath(context, id);
      const beforeRaw = await readFile(historyFile, "utf8");

      const dryRun = await runHistoryCompact(
        id,
        { dryRun: true, author: "test-author" },
        { path: context.pmPath },
      );
      expect(dryRun.changed).toBe(true);
      expect(dryRun.dry_run).toBe(true);
      expect(dryRun.history.baseline_entry_added).toBe(true);
      expect(dryRun.history.audit_entry_added).toBe(false);
      expect(await readFile(historyFile, "utf8")).toBe(beforeRaw);
    });
  });

  it("surfaces patch-application failures with Error payloads", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Apply Failure Error");
      const verifySpy = vi.spyOn(replayModule, "verifyHistoryChain").mockReturnValue({ ok: true, errors: [] });
      const applySpy = vi.spyOn(replayModule, "tryApplyReplayPatch").mockReturnValue({
        ok: false,
        error: new Error("synthetic apply failure"),
      } as ReturnType<typeof replayModule.tryApplyReplayPatch>);

      try {
        await expect(runHistoryCompact(id, { author: "test-author" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.GENERIC_FAILURE,
          message: expect.stringContaining("synthetic apply failure"),
        });
      } finally {
        verifySpy.mockRestore();
        applySpy.mockRestore();
      }
    });
  });

  it("surfaces patch-application failures with non-Error payloads", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Apply Failure String");
      const verifySpy = vi.spyOn(replayModule, "verifyHistoryChain").mockReturnValue({ ok: true, errors: [] });
      const applySpy = vi.spyOn(replayModule, "tryApplyReplayPatch").mockReturnValue({
        ok: false,
        error: "synthetic apply failure string",
      } as ReturnType<typeof replayModule.tryApplyReplayPatch>);

      try {
        await expect(runHistoryCompact(id, { author: "test-author" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.GENERIC_FAILURE,
          message: expect.stringContaining("synthetic apply failure string"),
        });
      } finally {
        verifySpy.mockRestore();
        applySpy.mockRestore();
      }
    });
  });

  it("fails when replay detects before-hash drift despite precheck success", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Before Hash Drift");
      const verifySpy = vi.spyOn(replayModule, "verifyHistoryChain").mockReturnValue({ ok: true, errors: [] });
      const hashSpy = vi.spyOn(replayModule, "replayHash").mockReturnValue("synthetic-before-hash-mismatch");

      try {
        await expect(runHistoryCompact(id, { author: "test-author" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.CONFLICT,
          message: expect.stringContaining("before-hash drift"),
        });
      } finally {
        verifySpy.mockRestore();
        hashSpy.mockRestore();
      }
    });
  });

  it("fails when replay detects after-hash drift despite precheck success", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact After Hash Drift");
      await rm(getTaskItemPath(context, id), { force: true });

      const lines = (await readFile(getHistoryPath(context, id), "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const first = JSON.parse(lines[0] ?? "{}") as { before_hash?: string };
      const expectedBefore = first.before_hash ?? "";

      const verifySpy = vi.spyOn(replayModule, "verifyHistoryChain").mockReturnValue({ ok: true, errors: [] });
      const originalReplayHash = replayModule.replayHash;
      let callCount = 0;
      const hashSpy = vi.spyOn(replayModule, "replayHash").mockImplementation((document) => {
        callCount += 1;
        if (callCount === 1) {
          return expectedBefore;
        }
        return `synthetic-after-hash-${originalReplayHash(document)}`;
      });

      try {
        await expect(runHistoryCompact(id, { author: "test-author" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.CONFLICT,
          message: expect.stringContaining("after-hash drift"),
        });
      } finally {
        verifySpy.mockRestore();
        hashSpy.mockRestore();
      }
    });
  });

  it("fails when rewritten chain verification reports new errors", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Rewritten Verify Failure");
      const verifySpy = vi
        .spyOn(replayModule, "verifyHistoryChain")
        .mockReturnValueOnce({ ok: true, errors: [] })
        .mockReturnValueOnce({ ok: false, errors: ["synthetic_rewritten_chain_failure"] });

      try {
        await expect(runHistoryCompact(id, { author: "test-author" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.GENERIC_FAILURE,
          message: expect.stringContaining("synthetic_rewritten_chain_failure"),
        });
      } finally {
        verifySpy.mockRestore();
      }
    });
  });

  it("rolls back by deleting history when write fails and no prior history snapshot exists", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Rollback Delete");
      const driftSpy = vi
        .spyOn(historyRewriteModule, "verifyHistoryRewriteNoDrift")
        .mockResolvedValue({ historyRawUnderLock: null } as Awaited<ReturnType<typeof historyRewriteModule.verifyHistoryRewriteNoDrift>>);
      const writeSpy = vi.spyOn(fsUtilsModule, "writeFileAtomic").mockRejectedValueOnce(new Error("synthetic write failure"));

      try {
        await expect(runHistoryCompact(id, { author: "test-author" }, { path: context.pmPath })).rejects.toThrow("synthetic write failure");
      } finally {
        driftSpy.mockRestore();
        writeSpy.mockRestore();
      }
    });
  });

  it("deletes history from applyRewrite when executeHistoryRewrite reports no prior snapshot", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Execute Rewrite Delete");
      const executeSpy = vi.spyOn(historyRewriteModule, "executeHistoryRewrite").mockImplementation(async (params) => {
        await params.applyRewrite({ historyRawUnderLock: null } as never);
        return [];
      });
      const writeSpy = vi.spyOn(fsUtilsModule, "writeFileAtomic").mockRejectedValueOnce(new Error("synthetic write failure"));
      const historyPath = getHistoryPath(context, id);
      try {
        await expect(runHistoryCompact(id, { author: "test-author" }, { path: context.pmPath })).rejects.toThrow(
          "synthetic write failure",
        );
        await expect(readFile(historyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        executeSpy.mockRestore();
        writeSpy.mockRestore();
      }
    });
  });

  it("rolls back by restoring prior history when write fails mid-flight", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Rollback Restore");
      const driftSpy = vi.spyOn(historyRewriteModule, "verifyHistoryRewriteNoDrift").mockResolvedValue({
        historyRawUnderLock: "{\"ts\":\"2026-01-01T00:00:00.000Z\"}\n",
      } as Awaited<ReturnType<typeof historyRewriteModule.verifyHistoryRewriteNoDrift>>);
      const writeSpy = vi
        .spyOn(fsUtilsModule, "writeFileAtomic")
        .mockRejectedValueOnce(new Error("synthetic write failure"))
        .mockResolvedValueOnce(undefined as Awaited<ReturnType<typeof fsUtilsModule.writeFileAtomic>>);

      try {
        await expect(runHistoryCompact(id, { author: "test-author" }, { path: context.pmPath })).rejects.toThrow("synthetic write failure");
        expect(writeSpy).toHaveBeenCalledTimes(2);
      } finally {
        driftSpy.mockRestore();
        writeSpy.mockRestore();
      }
    });
  });

  it("returns no-op when --before points at the first version", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Noop");
      const historyFile = getHistoryPath(context, id);
      const beforeRaw = await readFile(historyFile, "utf8");

      const result = await runHistoryCompact(
        id,
        { before: "1", author: "test-author" },
        { path: context.pmPath },
      );
      expect(result.changed).toBe(false);
      expect(result.compact_boundary.entries_compacted).toBe(0);
      expect(result.history.baseline_entry_added).toBe(false);
      expect(result.history.audit_entry_added).toBe(false);
      expect(result.warnings).toContain("history_compact_noop_before_boundary");
      expect(await readFile(historyFile, "utf8")).toBe(beforeRaw);
    });
  });

  it("fails when the existing history chain is already invalid", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Compact Invalid Chain");
      expect(context.runCli(["update", id, "--priority", "2"]).code).toBe(0);
      await tamperSecondBeforeHash(getHistoryPath(context, id));

      await expect(runHistoryCompact(id, { author: "test-author" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
        message: expect.stringContaining("history-repair"),
      });
    });
  });
});

function deepenStream(context: TempPmContext, id: string, updates: number): void {
  for (let index = 0; index < updates; index += 1) {
    expect(context.runCli(["update", id, "--priority", String(index % 5)]).code).toBe(0);
  }
}

function setCompactPolicy(context: TempPmContext, enabled: boolean, maxEntries: number): void {
  expect(context.runCli(["config", "project", "set", "history_compact_policy_enabled", String(enabled)]).code).toBe(0);
  expect(context.runCli(["config", "project", "set", "history_compact_policy_max_entries", String(maxEntries)]).code).toBe(0);
}

describe("assertHistoryCompactTarget", () => {
  it("requires at least one selector", () => {
    expect(() => assertHistoryCompactTarget(undefined, {})).toThrow(/provide an item <id>/);
  });

  it("rejects a positional id combined with bulk selectors", () => {
    expect(() => assertHistoryCompactTarget("pm-a", { scope: "closed" })).toThrow(/mutually exclusive/);
    expect(() => assertHistoryCompactTarget("pm-a", { ids: ["pm-b"] })).toThrow(/mutually exclusive/);
    expect(() => assertHistoryCompactTarget("pm-a", { allOver: 5 })).toThrow(/mutually exclusive/);
  });

  it("rejects --ids combined with a scan selector", () => {
    expect(() => assertHistoryCompactTarget(undefined, { ids: ["pm-a"], scope: "closed" })).toThrow(
      /--ids is mutually exclusive/,
    );
    expect(() => assertHistoryCompactTarget(undefined, { ids: ["pm-a"], allOver: 5 })).toThrow(
      /--ids is mutually exclusive/,
    );
  });

  it("accepts a single valid selector", () => {
    expect(() => assertHistoryCompactTarget("pm-a", {})).not.toThrow();
    expect(() => assertHistoryCompactTarget(undefined, { ids: ["pm-a"] })).not.toThrow();
    expect(() => assertHistoryCompactTarget(undefined, { scope: "all-streams" })).not.toThrow();
    expect(() => assertHistoryCompactTarget(undefined, { allOver: 5 })).not.toThrow();
    // An empty ids list is not a selector on its own; a scan selector still satisfies the contract.
    expect(() => assertHistoryCompactTarget(undefined, { ids: [], scope: "closed" })).not.toThrow();
  });
});

describe("history-compact bulk mode", () => {
  it("scans all streams, compacts the deep ones, and skips already-compact streams", async () => {
    await withTempPmPath(async (context) => {
      const deep = createItem(context, "Bulk Deep");
      deepenStream(context, deep, 6);
      const shallow = createItem(context, "Bulk Shallow");

      const result = await runHistoryCompactBulk({ scope: "all-streams", author: "test-author" }, { path: context.pmPath });

      expect(result.bulk).toBe(true);
      expect(result.mode).toBe("scan");
      expect(result.totals.streams_considered).toBe(2);
      expect(result.totals.items_compacted).toBe(1);
      expect(result.totals.items_errored).toBe(0);
      const deepRow = result.results.find((row) => row.id === deep);
      expect(deepRow).toMatchObject({ outcome: "compacted", changed: true });
      expect(deepRow!.entries_before).toBeGreaterThan(deepRow!.entries_after!);
      const shallowRow = result.results.find((row) => row.id === shallow);
      expect(shallowRow).toMatchObject({ outcome: "skipped", skip_reason: "already_compact" });

      const verified = await runHistory(deep, { verify: true }, { path: context.pmPath });
      expect(verified.verification?.ok).toBe(true);
    });
  });

  it("does not write under --dry-run", async () => {
    await withTempPmPath(async (context) => {
      const deep = createItem(context, "Bulk DryRun");
      deepenStream(context, deep, 6);
      const before = await readFile(getHistoryPath(context, deep), "utf8");

      const result = await runHistoryCompactBulk(
        { scope: "all-streams", dryRun: true, author: "test-author" },
        { path: context.pmPath },
      );

      expect(result.dry_run).toBe(true);
      expect(result.totals.items_compacted).toBe(1);
      expect(await readFile(getHistoryPath(context, deep), "utf8")).toBe(before);
    });
  });

  it("scope=closed only compacts terminal items", async () => {
    await withTempPmPath(async (context) => {
      const open = createItem(context, "Bulk Open");
      deepenStream(context, open, 6);
      const closed = createItem(context, "Bulk Closed");
      deepenStream(context, closed, 6);
      expect(context.runCli(["close", closed, "done"]).code).toBe(0);

      const result = await runHistoryCompactBulk({ scope: "closed", author: "test-author" }, { path: context.pmPath });

      expect(result.scope).toBe("closed");
      expect(result.results.find((row) => row.id === open)).toMatchObject({ skip_reason: "scope_mismatch" });
      expect(result.results.find((row) => row.id === closed)).toMatchObject({ outcome: "compacted" });
    });
  });

  it("ids mode compacts an explicit list and reports no_stream for unknown ids", async () => {
    await withTempPmPath(async (context) => {
      const target = createItem(context, "Bulk Ids");
      deepenStream(context, target, 6);

      const result = await runHistoryCompactBulk(
        { ids: [target, "pm-nope"], author: "test-author" },
        { path: context.pmPath },
      );

      expect(result.mode).toBe("ids");
      expect(result.results.find((row) => row.id === target)).toMatchObject({ outcome: "compacted" });
      expect(result.results.find((row) => row.id === "pm-nope")).toMatchObject({
        outcome: "skipped",
        skip_reason: "no_stream",
      });
    });
  });

  it("--all-over threshold selects only streams above N", async () => {
    await withTempPmPath(async (context) => {
      const deep = createItem(context, "Bulk Over Deep");
      deepenStream(context, deep, 8);
      const mid = createItem(context, "Bulk Over Mid");
      deepenStream(context, mid, 3);

      const result = await runHistoryCompactBulk({ allOver: 5, author: "test-author" }, { path: context.pmPath });

      expect(result.criteria.all_over).toBe(5);
      expect(result.results.find((row) => row.id === deep)).toMatchObject({ outcome: "compacted" });
      expect(result.results.find((row) => row.id === mid)).toMatchObject({ skip_reason: "below_threshold" });
    });
  });

  it("uses the enabled compact policy max_entries as the default scan threshold", async () => {
    await withTempPmPath(async (context) => {
      const deep = createItem(context, "Bulk Policy");
      deepenStream(context, deep, 6);
      setCompactPolicy(context, true, 4);

      const result = await runHistoryCompactBulk({ scope: "all-streams", dryRun: true }, { path: context.pmPath });

      expect(result.criteria.policy_threshold_applied).toBe(true);
      expect(result.criteria.all_over).toBe(4);
    });
  });

  it("honours an explicit --min-entries floor", async () => {
    await withTempPmPath(async (context) => {
      const stream = createItem(context, "Bulk MinEntries");
      deepenStream(context, stream, 6);

      const result = await runHistoryCompactBulk(
        { scope: "all-streams", minEntries: 100, author: "test-author" },
        { path: context.pmPath },
      );

      expect(result.criteria.min_entries).toBe(100);
      expect(result.results.find((row) => row.id === stream)).toMatchObject({ skip_reason: "already_compact" });
    });
  });

  it("collects per-stream errors without aborting the pass", async () => {
    await withTempPmPath(async (context) => {
      const healthy = createItem(context, "Bulk Healthy");
      deepenStream(context, healthy, 6);
      const broken = createItem(context, "Bulk Broken");
      deepenStream(context, broken, 6);
      await tamperSecondBeforeHash(getHistoryPath(context, broken));

      const result = await runHistoryCompactBulk(
        { ids: [healthy, broken], author: "test-author" },
        { path: context.pmPath },
      );

      expect(result.totals.items_compacted).toBe(1);
      expect(result.totals.items_errored).toBe(1);
      const brokenRow = result.results.find((row) => row.id === broken);
      expect(brokenRow).toMatchObject({ outcome: "errored" });
      expect(brokenRow!.error).toContain("history-repair");
    });
  });

  it("treats an orphan history stream (no matching item) as unbucketed under scope=closed", async () => {
    await withTempPmPath(async (context) => {
      const orphan = createItem(context, "Bulk Orphan");
      deepenStream(context, orphan, 6);
      // Remove the item document but keep its history stream so it has no lifecycle bucket.
      await rm(getTaskItemPath(context, orphan), { force: true });

      const result = await runHistoryCompactBulk({ scope: "closed", author: "test-author" }, { path: context.pmPath });

      expect(result.results.find((row) => row.id === orphan)).toMatchObject({ skip_reason: "scope_mismatch" });
    });
  });

  it("returns an empty pass when no history streams exist", async () => {
    await withTempPmPath(async (context) => {
      await rm(path.join(context.pmPath, "history"), { recursive: true, force: true });
      const result = await runHistoryCompactBulk({ scope: "all-streams" }, { path: context.pmPath });
      expect(result.totals.streams_considered).toBe(0);
      expect(result.results).toEqual([]);
    });
  });

  it("requires an initialized tracker", async () => {
    await expect(
      runHistoryCompactBulk({ scope: "all-streams" }, { path: "/tmp/pm-compact-bulk-missing-root" }),
    ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.NOT_FOUND });
  });
});
