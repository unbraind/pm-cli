import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertHistoryRepairTarget,
  runHistoryRepair,
  runHistoryRepairAll,
  type HistoryRepairAllResult,
} from "../../../src/cli/commands/history-repair.js";
import * as fsUtilsModule from "../../../src/core/fs/fs-utils.js";
import * as driftScanModule from "../../../src/core/history/drift-scan.js";
import * as historyRewriteModule from "../../../src/core/history/history-rewrite.js";
import * as replayModule from "../../../src/core/history/replay.js";
import * as lockModule from "../../../src/core/lock/lock.js";
import * as itemStoreModule from "../../../src/core/store/item-store.js";
import * as historyCommandModule from "../../../src/cli/commands/history.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

function createItem(context: TempPmContext, title: string): string {
  const result = context.runCli(
    ["create", "--json", "--title", title, "--description", "drift target", "--type", "Task"],
    { expectJson: true },
  );
  expect(result.code).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
}

function historyPath(context: TempPmContext, id: string): string {
  return path.join(context.pmPath, "history", `${id}.jsonl`);
}

function itemPath(context: TempPmContext, id: string): string {
  return path.join(context.pmPath, "tasks", `${id}.toon`);
}

async function tamperChain(file: string): Promise<void> {
  const lines = (await readFile(file, "utf8")).split(/\n/).filter(Boolean);
  const entry = JSON.parse(lines[1]);
  entry.before_hash = "0".repeat(64);
  lines[1] = JSON.stringify(entry);
  await writeFile(file, `${lines.join("\n")}\n`);
}

async function setSettingsAuthorDefault(pmPath: string, authorDefault: string): Promise<void> {
  const settingsPath = path.join(pmPath, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  settings.author_default = authorDefault;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

describe("history-repair command", () => {
  it("re-anchors a drifted chain and reconciles with the on-disk item", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Repair me");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      expect(context.runCli(["update", id, "--priority", "1"]).code).toBe(0);

      // Inject chain drift (tampered hash) and item drift (hand-edit the toon file).
      await tamperChain(historyPath(context, id));
      const item = itemPath(context, id);
      await writeFile(item, (await readFile(item, "utf8")).replace("drift target", "drift HANDEDITED"));

      const driftBefore = context.runCli(["validate", "--check-history-drift", "--json"], { expectJson: true });
      const driftCheck = (driftBefore.json as { checks: { name: string; details: { drifted_items_count: number } }[] }).checks.find(
        (c) => c.name === "history_drift",
      );
      expect(driftCheck?.details.drifted_items_count).toBe(1);

      // Dry-run reports impact but does not write.
      const dry = context.runCli(["history-repair", id, "--dry-run", "--json"], { expectJson: true });
      expect(dry.code).toBe(0);
      const dryResult = dry.json as { changed: boolean; history: { chain_drift_before: boolean; reconciled_with_item: boolean } };
      expect(dryResult.changed).toBe(true);
      expect(dryResult.history.chain_drift_before).toBe(true);
      expect(dryResult.history.reconciled_with_item).toBe(true);
      const stillDrifted = context.runCli(["history", id, "--verify", "--json"], { expectJson: true });
      expect((stillDrifted.json as { verification: { ok: boolean } }).verification.ok).toBe(false);

      // Real repair clears all drift.
      const repaired = context.runCli(["history-repair", id, "--message", "spec repair", "--json"], { expectJson: true });
      expect(repaired.code).toBe(0);
      const repairResult = repaired.json as {
        changed: boolean;
        history: { reconciled_with_item: boolean; entries_rehashed: number; audit_entry_added: boolean; verify_ok: boolean };
      };
      expect(repairResult.changed).toBe(true);
      expect(repairResult.history.audit_entry_added).toBe(true);
      expect(repairResult.history.verify_ok).toBe(true);

      const verified = context.runCli(["history", id, "--verify", "--json"], { expectJson: true });
      expect((verified.json as { verification: { ok: boolean } }).verification.ok).toBe(true);

      const driftAfter = context.runCli(["validate", "--check-history-drift", "--json"], { expectJson: true });
      const driftAfterCheck = (driftAfter.json as { checks: { name: string; details: { drifted_items_count: number } }[] }).checks.find(
        (c) => c.name === "history_drift",
      );
      expect(driftAfterCheck?.details.drifted_items_count).toBe(0);

      // The on-disk item is never modified; repair reconciles history to it.
      expect(await readFile(item, "utf8")).toContain("HANDEDITED");

      // Re-running on a clean stream is a no-op.
      const again = context.runCli(["history-repair", id, "--json"], { expectJson: true });
      const againResult = again.json as { changed: boolean; warnings: string[] };
      expect(againResult.changed).toBe(false);
      expect(againResult.warnings).toContain("history_repair_no_changes");
    });
  });

  it("errors when the item has no history stream", async () => {
    await withTempPmPath(async (context) => {
      const missing = context.runCli(["history-repair", "pm-zzzz", "--json"]);
      expect(missing.code).not.toBe(0);
      expect(missing.stdout + missing.stderr).toContain("not found");
    });
  });

  it("fails direct repair calls for uninitialized, missing, and empty history streams", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Repair Missing Streams");
      const uninitialized = path.join(context.pmPath, "not-initialized");
      await mkdir(uninitialized, { recursive: true });
      await expect(runHistoryRepair(id, {}, { path: uninitialized })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
        message: expect.stringContaining("Run pm init first"),
      });
      await expect(runHistoryRepairAll({}, { path: uninitialized })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
        message: expect.stringContaining("Run pm init first"),
      });

      await rm(historyPath(context, id), { force: true });
      await expect(runHistoryRepair(id, {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
        message: expect.stringContaining("No history stream exists"),
      });

      await writeFile(historyPath(context, id), "", "utf8");
      await expect(runHistoryRepair(id, {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("nothing to repair"),
      });
    });
  });

  it("repairs history-only subjects and reports null item match state", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Repair History Only");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      await tamperChain(historyPath(context, id));
      await rm(itemPath(context, id), { force: true });

      const repaired = await runHistoryRepair(id, { author: "test-author" }, { path: context.pmPath });
      expect(repaired.changed).toBe(true);
      expect(repaired.item).toMatchObject({
        exists: false,
        path: null,
        matched_chain_before: null,
      });
      expect(repaired.history.reconciled_with_item).toBe(false);
      expect(repaired.history.verify_ok).toBe(true);
    });
  });

  it("surfaces rewritten-chain verification failures", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Repair Verify Failure");
      const verifySpy = vi
        .spyOn(replayModule, "verifyHistoryChain")
        .mockReturnValueOnce({ ok: true, errors: [] })
        .mockReturnValueOnce({ ok: false, errors: ["synthetic_repair_verify_failure"] });

      try {
        await expect(runHistoryRepair(id, { author: "test-author" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.GENERIC_FAILURE,
          message: expect.stringContaining("synthetic_repair_verify_failure"),
        });
      } finally {
        verifySpy.mockRestore();
      }
    });
  });

  it("rolls back history when repair persistence fails", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Repair Rollback");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      await tamperChain(historyPath(context, id));
      const historyFile = historyPath(context, id);
      const historyBefore = await readFile(historyFile, "utf8");
      const originalWriteFileAtomic = fsUtilsModule.writeFileAtomic;
      let failedHistoryWrite = false;
      const driftSpy = vi.spyOn(historyRewriteModule, "verifyHistoryRewriteNoDrift").mockResolvedValue({
        historyRawUnderLock: historyBefore,
      } as Awaited<ReturnType<typeof historyRewriteModule.verifyHistoryRewriteNoDrift>>);
      const writeSpy = vi.spyOn(fsUtilsModule, "writeFileAtomic").mockImplementation(async (target, content) => {
        if (target === historyFile && !failedHistoryWrite) {
          failedHistoryWrite = true;
          throw new Error("synthetic repair write failure");
        }
        return originalWriteFileAtomic(target, content);
      });

      try {
        await expect(runHistoryRepair(id, { author: "test-author" }, { path: context.pmPath })).rejects.toThrow(
          "synthetic repair write failure",
        );
        expect(await readFile(historyFile, "utf8")).toBe(historyBefore);
      } finally {
        driftSpy.mockRestore();
        writeSpy.mockRestore();
      }
    });
  });

  it("falls back to unknown author and synthesized audit message when inputs are blank", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Repair Unknown Author");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      await tamperChain(historyPath(context, id));

      const historyFile = historyPath(context, id);
      const originalAcquireLock = lockModule.acquireLock;
      const lockSpy = vi.spyOn(lockModule, "acquireLock").mockImplementation(async (...args) =>
        originalAcquireLock(...(args as Parameters<typeof lockModule.acquireLock>)),
      );
      const previousPmAuthor = process.env.PM_AUTHOR;
      process.env.PM_AUTHOR = "   ";

      try {
        const repaired = await runHistoryRepair(
          id,
          {
            author: "   ",
            message: "   ",
          },
          { path: context.pmPath },
        );
        expect(repaired.changed).toBe(true);
        expect(lockSpy.mock.calls.at(-1)?.[3]).toBe("unknown");
        const historyLines = (await readFile(historyFile, "utf8")).trim().split(/\n/);
        const auditEntry = JSON.parse(historyLines[historyLines.length - 1]!);
        expect(auditEntry.op).toBe("history_repair");
        expect(auditEntry.message).toContain("history-repair re-anchored");
      } finally {
        lockSpy.mockRestore();
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });

  it("uses settings author default when repair author/env are unset", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Repair Default Author");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      await tamperChain(historyPath(context, id));
      await setSettingsAuthorDefault(context.pmPath, "repair-default-author");

      const previousPmAuthor = process.env.PM_AUTHOR;
      const originalAcquireLock = lockModule.acquireLock;
      const lockSpy = vi.spyOn(lockModule, "acquireLock").mockImplementation(async (...args) =>
        originalAcquireLock(...(args as Parameters<typeof lockModule.acquireLock>)),
      );
      try {
        delete process.env.PM_AUTHOR;
        const repaired = await runHistoryRepair(id, {}, { path: context.pmPath });
        expect(repaired.changed).toBe(true);
        expect(lockSpy.mock.calls.at(-1)?.[3]).toBe("repair-default-author");
      } finally {
        lockSpy.mockRestore();
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });

  it("returns direct no-change warnings for clean streams", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Repair Direct No Changes");
      const repaired = await runHistoryRepair(id, { author: "test-author" }, { path: context.pmPath });
      expect(repaired.changed).toBe(false);
      expect(repaired.warnings).toContain("history_repair_no_changes");
    });
  });

  it("surfaces skipped-op warnings when replay reanchor reports skipped operations", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Repair Skipped Ops Warning");
      const originalReanchor = replayModule.reanchorHistoryEntries;
      const reanchorSpy = vi.spyOn(replayModule, "reanchorHistoryEntries").mockImplementation((entries) => {
        const base = originalReanchor(entries);
        return {
          ...base,
          skippedOps: Math.max(base.skippedOps, 2),
        };
      });

      try {
        const repaired = await runHistoryRepair(id, { author: "test-author" }, { path: context.pmPath });
        expect(repaired.warnings).toContain("history_repair_skipped_unresolvable_ops:2");
      } finally {
        reanchorSpy.mockRestore();
      }
    });
  });

  it("adds reconciliation audit entries when on-disk item differs from replay output", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Repair Reconcile Branch");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);

      const originalReanchor = replayModule.reanchorHistoryEntries;
      const originalReadLocatedItem = itemStoreModule.readLocatedItem;
      const reanchorSpy = vi.spyOn(replayModule, "reanchorHistoryEntries").mockImplementation((entries) => {
        const base = originalReanchor(entries);
        return {
          ...base,
          entriesPatchRepaired: Math.max(base.entriesPatchRepaired, 1),
        };
      });
      const readLocatedSpy = vi.spyOn(itemStoreModule, "readLocatedItem").mockImplementation(async (...args) => {
        const loaded = await originalReadLocatedItem(...(args as Parameters<typeof itemStoreModule.readLocatedItem>));
        return {
          ...loaded,
          document: {
            ...loaded.document,
            metadata: {
              ...loaded.document.metadata,
              title: `${loaded.document.metadata.title} (reconciled)`,
            },
          },
        };
      });

      try {
        const repaired = await runHistoryRepair(
          id,
          {
            author: "test-author",
            message: "explicit repair message",
            dryRun: true,
          },
          { path: context.pmPath },
        );
        expect(repaired.changed).toBe(true);
        expect(repaired.history.reconciled_with_item).toBe(true);
        expect(repaired.history.entries_patch_repaired).toBeGreaterThan(0);
        expect(repaired.history.audit_entry_added).toBe(true);
      } finally {
        reanchorSpy.mockRestore();
        readLocatedSpy.mockRestore();
      }
    });
  });

  it("removes history output when rollback snapshot is unavailable", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Repair Missing Snapshot");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      await tamperChain(historyPath(context, id));
      const historyFile = historyPath(context, id);
      const originalWriteFileAtomic = fsUtilsModule.writeFileAtomic;
      const executeSpy = vi.spyOn(historyRewriteModule, "executeHistoryRewrite").mockImplementation(async (params) => {
        await params.applyRewrite({
          historyRawUnderLock: null,
        } as Awaited<ReturnType<typeof historyRewriteModule.verifyHistoryRewriteNoDrift>>);
        return [];
      });
      const writeSpy = vi.spyOn(fsUtilsModule, "writeFileAtomic").mockImplementation(async (target, content) => {
        if (target === historyFile) {
          throw new Error("synthetic repair write failure without snapshot");
        }
        return originalWriteFileAtomic(target, content);
      });

      try {
        await expect(runHistoryRepair(id, { author: "test-author" }, { path: context.pmPath })).rejects.toThrow(
          "synthetic repair write failure without snapshot",
        );
        await expect(readFile(historyFile, "utf8")).rejects.toThrow();
      } finally {
        executeSpy.mockRestore();
        writeSpy.mockRestore();
      }
    });
  });

  it("rejects history-repair when the item changes before lock acquisition", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Repair lock window");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      await tamperChain(historyPath(context, id));

      const itemFile = itemPath(context, id);
      const historyFile = historyPath(context, id);
      const historyRawBefore = await readFile(historyFile, "utf8");
      const originalAcquireLock = lockModule.acquireLock;
      let mutated = false;
      const lockSpy = vi.spyOn(lockModule, "acquireLock").mockImplementation(async (...args) => {
        if (!mutated) {
          mutated = true;
          const raw = await readFile(itemFile, "utf8");
          await writeFile(itemFile, raw.replace("drift target", "drift changed-before-lock"), "utf8");
        }
        return originalAcquireLock(...(args as Parameters<typeof lockModule.acquireLock>));
      });

      try {
        await expect(
          runHistoryRepair(
            id,
            {
              author: "test-author",
            },
            { path: context.pmPath },
          ),
        ).rejects.toMatchObject({
          exitCode: EXIT_CODE.CONFLICT,
          message: expect.stringContaining(`Item ${id} changed while waiting for lock; retry history-repair.`),
        });
        expect(await readFile(historyFile, "utf8")).toBe(historyRawBefore);
        expect(await readFile(itemFile, "utf8")).toContain("drift changed-before-lock");
      } finally {
        lockSpy.mockRestore();
      }
    });
  });

  it("rejects history-repair when history changes before lock acquisition", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Repair history lock window");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      await tamperChain(historyPath(context, id));

      const historyFile = historyPath(context, id);
      const itemFile = itemPath(context, id);
      const itemRawBefore = await readFile(itemFile, "utf8");
      const originalAcquireLock = lockModule.acquireLock;
      let mutated = false;
      const lockSpy = vi.spyOn(lockModule, "acquireLock").mockImplementation(async (...args) => {
        if (!mutated) {
          mutated = true;
          const raw = await readFile(historyFile, "utf8");
          await writeFile(historyFile, `${raw}\n`, "utf8");
        }
        return originalAcquireLock(...(args as Parameters<typeof lockModule.acquireLock>));
      });

      try {
        await expect(
          runHistoryRepair(
            id,
            {
              author: "test-author",
            },
            { path: context.pmPath },
          ),
        ).rejects.toMatchObject({
          exitCode: EXIT_CODE.CONFLICT,
          message: expect.stringContaining(`History for ${id} changed while waiting for lock; retry history-repair.`),
        });
        expect(await readFile(itemFile, "utf8")).toBe(itemRawBefore);
      } finally {
        lockSpy.mockRestore();
      }
    });
  });
});

describe("history-repair --all (bulk drift repair)", () => {
  it("requires exactly one of <id> or --all", () => {
    expect(() => assertHistoryRepairTarget(undefined, false)).toThrowError(
      /provide an item <id> or pass --all/,
    );
    expect(() => assertHistoryRepairTarget("pm-abcd", true)).toThrowError(/mutually exclusive/);
    expect(() => assertHistoryRepairTarget("pm-abcd", false)).not.toThrow();
    expect(() => assertHistoryRepairTarget(undefined, true)).not.toThrow();
  });

  it("rejects ambiguous and missing targets at the CLI with a usage error", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Target contract");
      const both = context.runCli(["history-repair", id, "--all", "--json"]);
      expect(both.code).not.toBe(0);
      expect(both.stdout + both.stderr).toContain("mutually exclusive");

      const neither = context.runCli(["history-repair", "--json"]);
      expect(neither.code).not.toBe(0);
      expect(neither.stdout + neither.stderr).toContain("provide an item <id> or pass --all");
    });
  });

  it("repairs every drifted stream in one audited pass and leaves clean streams alone", async () => {
    await withTempPmPath(async (context) => {
      const driftedA = createItem(context, "Drifted A");
      const driftedB = createItem(context, "Drifted B");
      const clean = createItem(context, "Clean stream");
      expect(context.runCli(["update", driftedA, "--status", "in_progress"]).code).toBe(0);
      expect(context.runCli(["update", driftedB, "--priority", "1"]).code).toBe(0);
      await tamperChain(historyPath(context, driftedA));
      await tamperChain(historyPath(context, driftedB));

      // Dry-run previews the bulk pass without writing.
      const dry = context.runCli(["history-repair", "--all", "--dry-run", "--json"], { expectJson: true });
      expect(dry.code).toBe(0);
      const dryResult = dry.json as HistoryRepairAllResult;
      expect(dryResult.dry_run).toBe(true);
      expect(dryResult.drifted_streams).toBe(2);
      const dryVerify = context.runCli(["history", driftedA, "--verify", "--json"], { expectJson: true });
      expect((dryVerify.json as { verification: { ok: boolean } }).verification.ok).toBe(false);

      const repaired = context.runCli(
        ["history-repair", "--all", "--message", "bulk re-anchor", "--json"],
        { expectJson: true },
      );
      expect(repaired.code).toBe(0);
      const result = repaired.json as HistoryRepairAllResult;
      expect(result.all).toBe(true);
      expect(result.dry_run).toBe(false);
      expect(result.scanned_streams).toBe(3);
      expect(result.drifted_streams).toBe(2);
      expect(result.totals).toEqual({ repaired: 2, skipped_clean: 0, failed: 0 });
      expect(result.streams.map((stream) => stream.id).sort()).toEqual([driftedA, driftedB].sort());
      for (const stream of result.streams) {
        expect(stream.outcome).toBe("repaired");
        expect(stream.error).toBeUndefined();
      }
      // The clean stream gets no row — only drifted streams are listed.
      expect(result.streams.some((stream) => stream.id === clean)).toBe(false);

      // Each repaired stream carries the audit marker and verifies clean.
      for (const id of [driftedA, driftedB]) {
        const verify = context.runCli(["history", id, "--verify", "--json"], { expectJson: true });
        expect((verify.json as { verification: { ok: boolean } }).verification.ok).toBe(true);
      }
      const driftAfter = context.runCli(["validate", "--check-history-drift", "--json"], { expectJson: true });
      const driftCheck = (
        driftAfter.json as { checks: { name: string; details: { drifted_items_count: number } }[] }
      ).checks.find((c) => c.name === "history_drift");
      expect(driftCheck?.details.drifted_items_count).toBe(0);

      // Re-running --all on a fully clean tree is a no-op pass.
      const again = context.runCli(["history-repair", "--all", "--json"], { expectJson: true });
      expect(again.code).toBe(0);
      const againResult = again.json as HistoryRepairAllResult;
      expect(againResult.drifted_streams).toBe(0);
      expect(againResult.streams).toEqual([]);
      expect(againResult.totals).toEqual({ repaired: 0, skipped_clean: 0, failed: 0 });
    });
  });

  it("isolates per-stream failures and exits non-zero only when a stream failed", async () => {
    await withTempPmPath(async (context) => {
      const repairable = createItem(context, "Repairable drift");
      const broken = createItem(context, "Unrepairable drift");
      expect(context.runCli(["update", repairable, "--status", "in_progress"]).code).toBe(0);
      await tamperChain(historyPath(context, repairable));
      // Replace the second stream with a directory: the drift scan classifies it
      // as an unreadable (drifted) stream and the per-stream repair fails on read.
      await rm(historyPath(context, broken), { force: true });
      await mkdir(historyPath(context, broken), { recursive: true });

      const run = context.runCli(["history-repair", "--all", "--json"], { expectJson: true });
      expect(run.code).toBe(EXIT_CODE.GENERIC_FAILURE);
      const result = run.json as HistoryRepairAllResult;
      expect(result.drifted_streams).toBe(2);
      expect(result.totals).toEqual({ repaired: 1, skipped_clean: 0, failed: 1 });

      const repairedRow = result.streams.find((stream) => stream.id === repairable);
      expect(repairedRow?.outcome).toBe("repaired");
      const failedRow = result.streams.find((stream) => stream.id === broken);
      expect(failedRow?.outcome).toBe("failed");
      expect(typeof failedRow?.error).toBe("string");
      expect((failedRow?.error ?? "").length).toBeGreaterThan(0);

      // The failing stream never aborts the rest: the repairable one is clean now.
      const verify = context.runCli(["history", repairable, "--verify", "--json"], { expectJson: true });
      expect((verify.json as { verification: { ok: boolean } }).verification.ok).toBe(true);
    });
  });

  it("honors per-stream lock safety in bulk mode and forwards --force to each stream", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, "Locked by another agent");
      expect(context.runCli(["update", id, "--status", "in_progress"]).code).toBe(0);
      await tamperChain(historyPath(context, id));
      // A stale lock left by another agent: with force_required_for_stale_lock
      // governance enabled (init defaults to the minimal preset, which waives it),
      // the un-forced bulk pass must fail this stream instead of silently
      // overriding the lock.
      expect(
        context.runCli(["config", "set", "governance_force_required_for_stale_lock", "true", "--json"]).code,
      ).toBe(0);
      const locksDir = path.join(context.pmPath, "locks");
      await mkdir(locksDir, { recursive: true });
      const staleLockPath = path.join(locksDir, `${id}.lock`);
      const staleLockPayload = JSON.stringify({
        id,
        pid: 99999,
        owner: "another-agent",
        created_at: new Date(Date.now() - 7200 * 1000).toISOString(),
        ttl_seconds: 60,
      });
      await writeFile(staleLockPath, staleLockPayload, "utf8");

      const result = await runHistoryRepairAll({}, { path: context.pmPath });
      expect(result.totals).toMatchObject({ repaired: 0, failed: 1 });
      expect(result.streams[0]).toMatchObject({ id, outcome: "failed" });
      expect(result.streams[0].error).toContain("--force");

      // --force is honored per stream, mirroring single-stream semantics.
      await writeFile(staleLockPath, staleLockPayload, "utf8");
      const forced = await runHistoryRepairAll({ force: true }, { path: context.pmPath });
      expect(forced.totals).toEqual({ repaired: 1, skipped_clean: 0, failed: 0 });
    });
  });

  it("sorts and deduplicates item read warnings in bulk summary", async () => {
    await withTempPmPath(async (context) => {
      const listSpy = vi.spyOn(itemStoreModule, "listAllFrontMatterWithBody").mockImplementation(async (...args) => {
        const warnings = args[3];
        warnings.push("z-warning", "a-warning", "a-warning");
        return [];
      });
      try {
        const result = await runHistoryRepairAll({}, { path: context.pmPath });
        expect(result.warnings).toEqual(["a-warning", "z-warning"]);
      } finally {
        listSpy.mockRestore();
      }
    });
  });

  it("reports skipped-clean and string-failure rows in bulk repair output", async () => {
    await withTempPmPath(async (context) => {
      const skippedId = createItem(context, "Bulk skipped clean");
      const failedId = createItem(context, "Bulk string failure");

      const driftSpy = vi.spyOn(driftScanModule, "scanHistoryDrift").mockResolvedValue({
        missingStreams: [],
        unreadableStreams: [],
        hashMismatches: [skippedId, failedId],
        chainMismatches: [],
        driftedItems: [skippedId, failedId],
      });
      const originalReadHistoryEntries = historyCommandModule.readHistoryEntries;
      const readSpy = vi.spyOn(historyCommandModule, "readHistoryEntries").mockImplementation(async (historyPath, itemId) => {
        if (itemId === failedId) {
          throw "synthetic_non_error_failure";
        }
        return originalReadHistoryEntries(historyPath, itemId);
      });

      try {
        const result = await runHistoryRepairAll({ dryRun: true }, { path: context.pmPath });
        expect(result.totals).toEqual({ repaired: 0, skipped_clean: 1, failed: 1 });
        expect(result.streams).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: skippedId, outcome: "skipped_clean" }),
            expect.objectContaining({
              id: failedId,
              outcome: "failed",
              error: "synthetic_non_error_failure",
            }),
          ]),
        );
      } finally {
        driftSpy.mockRestore();
        readSpy.mockRestore();
      }
    });
  });
});
