import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWorkspaceTransactionGc } from "../../../src/sdk/index.js";

describe("workspace transaction journal GC", () => {
  it("propagates unexpected journal-directory filesystem failures", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-transaction-gc-fault-"));
    try {
      await mkdir(path.join(pmRoot, "transactions"), { recursive: true });
      await writeFile(path.join(pmRoot, "transactions", "sdk"), "not-a-directory", "utf8");
      await expect(runWorkspaceTransactionGc(pmRoot, {
        dryRun: false,
        retentionDays: 1,
      })).rejects.toMatchObject({ code: "ENOTDIR" });
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("prunes only aged terminal receipts and retains recovery state", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-transaction-gc-"));
    try {
      const journalDir = path.join(pmRoot, "transactions", "sdk");
      await mkdir(journalDir, { recursive: true });
      const old = "2026-07-01T00:00:00.000Z";
      const fresh = "2026-07-19T00:00:00.000Z";
      await Promise.all([
        writeFile(path.join(journalDir, "committed.json"), JSON.stringify({ status: "committed", updatedAt: old }), "utf8"),
        writeFile(path.join(journalDir, "compensated.json"), JSON.stringify({ status: "compensated", updatedAt: fresh }), "utf8"),
        writeFile(path.join(journalDir, "applying.json"), JSON.stringify({ status: "applying", updatedAt: old }), "utf8"),
        writeFile(path.join(journalDir, "broken.json"), "{", "utf8"),
      ]);

      const result = await runWorkspaceTransactionGc(pmRoot, {
        dryRun: true,
        retentionDays: 14,
        now: Date.parse("2026-07-20T00:00:00.000Z"),
      });

      expect(result.removed).toEqual(["transactions/sdk/committed.json"]);
      expect(result.retained).toEqual([
        "transactions/sdk/applying.json",
        "transactions/sdk/broken.json",
        "transactions/sdk/compensated.json",
      ]);
      expect(result.warnings).toEqual(["transaction_journal_unparseable:broken.json"]);
      expect(result.entries.map((entry) => entry.reason ?? "stale")).toEqual([
        "active",
        "unparseable",
        "stale",
        "fresh",
      ]);
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("deletes stale receipts, invokes hooks, and handles absent or malformed journals", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-transaction-gc-"));
    try {
      expect(
        await runWorkspaceTransactionGc(pmRoot, { dryRun: false, retentionDays: 1 }),
      ).toMatchObject({ scanned: 0, removed: [], retained: [] });
      const journalDir = path.join(pmRoot, "transactions", "sdk");
      await mkdir(journalDir, { recursive: true });
      await Promise.all([
        writeFile(path.join(journalDir, "old.json"), JSON.stringify({ status: "committed", updatedAt: "2026-07-01T00:00:00.000Z" }), "utf8"),
        writeFile(path.join(journalDir, "array.json"), "[]", "utf8"),
        writeFile(path.join(journalDir, "missing-fields.json"), "{}", "utf8"),
        writeFile(path.join(journalDir, "ignored.txt"), "ignored", "utf8"),
      ]);
      const reads: string[] = [];
      const writes: string[] = [];
      const result = await runWorkspaceTransactionGc(pmRoot, {
        dryRun: false,
        retentionDays: 1,
        now: Date.parse("2026-07-20T00:00:00.000Z"),
        hooks: {
          onRead: async (file) => {
            reads.push(file);
            return ["read-hook"];
          },
          onWrite: async (file) => {
            writes.push(file);
            return ["write-hook"];
          },
        },
      });
      expect(reads).toHaveLength(3);
      expect(writes).toEqual([path.join(journalDir, "old.json")]);
      expect(result.warnings).toEqual([
        "read-hook",
        "transaction_journal_unparseable:array.json",
        "read-hook",
        "transaction_journal_unparseable:missing-fields.json",
        "read-hook",
        "write-hook",
      ]);
      await expect(readFile(path.join(journalDir, "old.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(
        path.join(journalDir, "old-no-hooks.json"),
        JSON.stringify({ status: "compensated", updatedAt: "2026-07-01T00:00:00.000Z" }),
        "utf8",
      );
      expect((await runWorkspaceTransactionGc(pmRoot, {
        dryRun: false,
        retentionDays: 1,
        now: Date.parse("2026-07-20T00:00:00.000Z"),
      })).removed).toEqual(["transactions/sdk/old-no-hooks.json"]);
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });
});
