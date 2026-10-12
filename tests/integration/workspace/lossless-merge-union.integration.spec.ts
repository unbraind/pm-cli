/** Real Git proof that positional collection patches retain exact merge evidence. */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashDocument } from "../../../src/core/history/history.js";
import { reanchorHistoryEntries, replayToCanonicalItemDocument, verifyHistoryChain } from "../../../src/core/history/replay.js";
import { parseItemDocument } from "../../../src/core/item/item-format.js";
import { runMergeReconcile } from "../../../src/sdk/merge/reconcile.js";
import { inspectMergeReceiptEvidence } from "../../../src/sdk/merge/receipts.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import type { HistoryEntry } from "../../../src/types/index.js";

describe("lossless Git collection union", () => {
  it.each([false, true])("settles reordered comments and branch-local test provenance without force (prior reconciliation: %s)", async (priorReconciliation) => {
    await withTempPmPath(async (context) => {
      const git = (...args: string[]): string => execFileSync("git", args, {
        cwd: context.tempRoot, env: context.env, encoding: "utf8",
      });
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Merge Test");
      git("config", "user.email", "merge@example.invalid");
      expect(context.runCli(["merge", "install"], { cwd: context.tempRoot }).code).toBe(0);
      const created = context.runCli(["create", "--type", "Task", "--title", "Collection union", "--create-mode", "progressive",
        "--comment", "created_at=2026-10-08T00:00:00.000Z,text=Base comment",
        "--json"], { expectJson: true, cwd: context.tempRoot });
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;
      git("add", "."); git("commit", "-qm", "Seed tracker");
      if (priorReconciliation) git("branch", "prior");
      expect(context.runCli(["test", id, "--add", "command=node base-test.mjs"], { cwd: context.tempRoot }).code).toBe(0);
      git("add", ".agents"); git("commit", "-qm", "Record baseline test");
      git("branch", "other");
      const edit = (comment: string, command?: string): void => {
        const changed = context.runCli(["update", id, "--comment", comment, ...(command === undefined ? [] : ["--test", `command=${command}`])], { cwd: context.tempRoot });
        expect(changed.code, changed.stdout).toBe(0);
        git("add", ".agents"); git("commit", "-qm", "Append branch context");
      };
      if (priorReconciliation) {
        expect(context.runCli(["test", id, "--remove", "command=node base-test.mjs"], { cwd: context.tempRoot }).code).toBe(0);
        expect(context.runCli(["test", id, "--add", "command=node base-test.mjs"], { cwd: context.tempRoot }).code).toBe(0);
      }
      edit("created_at=2026-10-07T00:00:00.000Z,text=Earlier main comment", "node main-test.mjs");
      git("switch", "-q", "other");
      edit("created_at=2026-10-09T00:00:00.000Z,text=Later other comment", priorReconciliation ? undefined : "node other-test.mjs");
      if (priorReconciliation) {
        git("switch", "-q", "prior");
        edit("created_at=2026-10-06T00:00:00.000Z,text=Earlier prior comment");
        git("merge", "--no-edit", "other");
        expect((await runMergeReconcile({}, { path: context.pmPath })).ok).toBe(true);
        git("add", ".agents"); git("commit", "-qm", "Settle prior union");
        git("switch", "-q", "other"); git("merge", "--ff-only", "prior");
      }
      git("switch", "-q", "main");
      git("merge", "--no-edit", "other");
      const itemPath = path.join(context.pmPath, "tasks", `${id}.toon`);
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const itemRaw = await readFile(itemPath, "utf8");
      const document = parseItemDocument(itemRaw);
      expect(document.metadata.comments?.map((comment) => comment.text)).toEqual([
        ...(priorReconciliation ? ["Earlier prior comment"] : []),
        "Earlier main comment", "Base comment", "Later other comment",
      ]);
      expect(document.metadata.tests?.map((test) => test.command)).toEqual([
        "node base-test.mjs", "node main-test.mjs", ...(priorReconciliation ? [] : ["node other-test.mjs"]),
      ]);
      const pending = await inspectMergeReceiptEvidence(context.tempRoot);
      expect(pending.invalid_evidence_count).toBe(0);
      expect(pending.receipts).toHaveLength(1);
      const settled = await runMergeReconcile({}, { path: context.pmPath });
      expect(settled.ok, JSON.stringify(settled)).toBe(true);
      const raw = await readFile(historyPath, "utf8");
      const entries = raw.trim().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
      expect(verifyHistoryChain(entries)).toEqual({ ok: true, errors: [] });
      const replayed = replayToCanonicalItemDocument(reanchorHistoryEntries(entries).finalDocument);
      expect(hashDocument(replayed)).toBe(hashDocument(document));
      expect(replayed.metadata.comments).toEqual(document.metadata.comments);
      expect(replayed.metadata.tests).toEqual(document.metadata.tests);
      expect(await readFile(itemPath, "utf8")).toBe(itemRaw);
      expect((await runMergeReconcile({}, { path: context.pmPath })).ok).toBe(true);
      expect(await readFile(historyPath, "utf8")).toBe(raw);
    });
  });
});
