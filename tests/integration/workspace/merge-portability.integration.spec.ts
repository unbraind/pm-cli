/** Real Git regressions for visible identity refusals and portable reconciliation evidence. */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHealth } from "../../../src/sdk/governance/health.js";
import { runMergeReconcile } from "../../../src/sdk/merge/reconcile.js";
import { inspectMergeReceiptEvidence } from "../../../src/sdk/merge/receipts.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import type { TempPmContext } from "../../helpers/withTempPmPath.js";

/** Create the real Git boundary shared by these preservation regressions. */
function initializeGitTracker(context: TempPmContext) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: context.tempRoot, env: context.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Merge Test");
  git("config", "user.email", "merge@example.invalid");
  expect(context.runCli(["merge", "install"], { cwd: context.tempRoot }).code).toBe(0);
  return git;
}

describe("portable Git merge recovery", () => {
  it("keeps both add/add snapshots visible when a copied creation prefix cannot prove ancestry", async () => {
    await withTempPmPath(async (context) => {
      const git = initializeGitTracker(context);
      git("add", "."); git("commit", "-qm", "Initialize tracker");
      git("switch", "-qc", "plan");
      const id = createTestItemId(context, { title: "Copied creation" });
      git("add", ".agents"); git("commit", "-qm", "Create shared plan");
      const seed = git("rev-parse", "HEAD");
      git("switch", "-q", "main"); git("switch", "-qc", "a"); git("cherry-pick", seed); git("commit", "--amend", "-qm", "Agent a planning ancestry");
      expect(context.runCli(["comments", id, "from agent a"]).code).toBe(0);
      git("add", ".agents"); git("commit", "-qm", "Agent a context");
      git("switch", "-q", "main"); git("switch", "-qc", "b"); git("cherry-pick", seed); git("commit", "--amend", "-qm", "Agent b planning ancestry");
      expect(context.runCli(["comments", id, "from agent b"]).code).toBe(0);
      git("add", ".agents"); git("commit", "-qm", "Agent b context");
      const merged = spawnSync("git", ["merge", "--no-edit", "a"], { cwd: context.tempRoot, env: context.env, encoding: "utf8" });
      expect(merged.status).toBe(1);
      for (const relative of [`tasks/${id}.toon`, `history/${id}.jsonl`]) {
        const repositoryPath = `.agents/pm/${relative}`;
        const ours = git("show", `:2:${repositoryPath}`);
        const theirs = git("show", `:3:${repositoryPath}`);
        const raw = await readFile(path.join(context.pmPath, relative), "utf8");
        expect(raw).toContain("<<<<<<< pm ours");
        expect(raw).toContain(ours);
        expect(raw).toContain(theirs);
        expect(raw).toContain(">>>>>>> pm theirs");
      }
      git("add", ".agents");
      const health = await runHealth({ path: context.pmPath }, { checkOnly: true, full: true });
      expect(health.ok).toBe(false);
      expect(JSON.stringify(health)).toContain("conflict_marker");
    });
  });

  it("refuses clone-local-only receipts before any audit write, including forced reconciliation", async () => {
    await withTempPmPath(async (context) => {
      const git = initializeGitTracker(context);
      const id = createTestItemId(context, { title: "Portable proof" });
      git("add", "."); git("commit", "-qm", "Seed tracker"); git("branch", "other");
      expect(context.runCli(["comments", id, "main context"]).code).toBe(0);
      git("add", ".agents"); git("commit", "-qm", "Main context");
      git("switch", "-q", "other");
      expect(context.runCli(["comments", id, "other context"]).code).toBe(0);
      git("add", ".agents"); git("commit", "-qm", "Other context");
      git("switch", "-q", "main"); git("merge", "--no-edit", "other");
      const receipt = (await inspectMergeReceiptEvidence(context.tempRoot)).receipts[0]!;
      const durablePath = path.join(context.pmPath, "merge-receipts", `${receipt.id}.json`);
      const durable = await readFile(durablePath, "utf8");
      const localDirectory = git("rev-parse", "--path-format=absolute", "--git-path", "pm-merge-receipts");
      const stalePath = path.join(localDirectory, `${randomUUID()}.json`);
      const staleId = path.basename(stalePath, ".json");
      const localReceipt = JSON.parse(await readFile(path.join(localDirectory, `${receipt.id}.json`), "utf8"));
      delete localReceipt.operation;
      await writeFile(stalePath, JSON.stringify({ ...localReceipt, id: staleId }));
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const before = await readFile(historyPath, "utf8");
      for (const options of [{ dryRun: true }, {}, { force: true }]) {
        await expect(runMergeReconcile(options, { path: context.pmPath })).rejects.toMatchObject({ context: { code: "merge_receipt_not_portable" } });
        expect(await readFile(historyPath, "utf8")).toBe(before);
      }
      expect(await readFile(durablePath, "utf8")).toBe(durable);
      await rm(stalePath);
      expect((await runMergeReconcile({}, { path: context.pmPath })).ok).toBe(true);
      const settled = await readFile(historyPath, "utf8");
      await rm(durablePath);
      const health = await runHealth({ path: context.pmPath }, { checkOnly: true, full: true });
      expect(health.ok).toBe(false);
      expect(JSON.stringify(health)).toContain("merge_receipt_history_reference_missing:1");
      expect(await readFile(historyPath, "utf8")).toBe(settled);
    });
  });

  it("settles an opted-in lossless merge in its original commit with portable audit evidence", async () => {
    await withTempPmPath(async (context) => {
      const git = initializeGitTracker(context);
      const hookPath = git("rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit");
      await expect(access(hookPath)).rejects.toMatchObject({ code: "ENOENT" });
      const preview = context.runCli(["merge", "install", "--pre-commit-hook", "--dry-run"], { cwd: context.tempRoot });
      expect(preview.code, preview.stdout).toBe(0);
      await expect(access(hookPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(context.runCli(["merge", "install", "--pre-commit-hook"], { cwd: context.tempRoot }).code).toBe(0);
      const id = createTestItemId(context, { title: "One commit settlement" });
      git("add", "."); git("commit", "-qm", "Seed tracker"); git("branch", "other");
      expect(context.runCli(["comments", id, "retained main comment"]).code).toBe(0);
      git("add", ".agents"); git("commit", "-qm", "Main context");
      git("switch", "-q", "other");
      expect(context.runCli(["update", id, "--description", "retained other description"]).code).toBe(0);
      git("add", ".agents"); git("commit", "-qm", "Other context"); git("switch", "-q", "main");
      const merged = spawnSync("git", ["merge", "--no-commit", "--no-ff", "other"], { cwd: context.tempRoot, env: context.env, encoding: "utf8" });
      expect(merged.status, merged.stdout + merged.stderr).toBe(0);
      git("commit", "--no-edit");
      expect(git("status", "--porcelain")).toBe("");
      expect(git("rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
      const raw = await readFile(path.join(context.pmPath, "history", `${id}.jsonl`), "utf8");
      expect(raw).toContain('"op":"merge_reconcile"');
      expect((await inspectMergeReceiptEvidence(context.tempRoot)).receipts).toEqual([]);
      const clone = path.join(context.tempRoot, "fresh-clone");
      git("clone", "-q", "--no-local", context.tempRoot, clone);
      const clonedPmRoot = path.join(clone, ".agents", "pm");
      const freshHealth = await runHealth({ path: clonedPmRoot }, { checkOnly: true, full: true });
      expect(freshHealth.ok, JSON.stringify(freshHealth)).toBe(true);
      expect(await readFile(path.join(clonedPmRoot, "history", `${id}.jsonl`), "utf8")).toBe(raw);
    });
  });
});
