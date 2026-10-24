/** Real Git regressions for visible identity refusals and portable reconciliation evidence. */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHealth } from "../../../src/sdk/governance/health.js";
import { runMergeReconcile } from "../../../src/sdk/merge/reconcile.js";
import { inspectMergeReceiptEvidence } from "../../../src/sdk/merge/receipts.js";
import { stageLosslessMergeReconciliation } from "../../../src/sdk/merge/stage.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import type { TempPmContext } from "../../helpers/withTempPmPath.js";

/** Create the real Git boundary shared by these preservation regressions. */
function initializeGitTracker(context: TempPmContext, autocrlf: boolean) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: context.tempRoot, env: context.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", String(autocrlf));
  git("config", "user.name", "Merge Test");
  git("config", "user.email", "merge@example.invalid");
  expect(context.runCli(["merge", "install"], { cwd: context.tempRoot }).code).toBe(0);
  return git;
}

describe.each([false, true])("portable Git merge recovery (autocrlf: %s)", (autocrlf) => {
  it("keeps both add/add snapshots visible when a copied creation prefix cannot prove ancestry", async () => {
    await withTempPmPath(async (context) => {
      const git = initializeGitTracker(context, autocrlf);
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
        // Git may check out CRLF on Windows while its staged blobs use LF.
        expect(raw.replaceAll("\r\n", "\n")).toContain(ours.replaceAll("\r\n", "\n"));
        expect(raw.replaceAll("\r\n", "\n")).toContain(theirs.replaceAll("\r\n", "\n"));
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
      const git = initializeGitTracker(context, autocrlf);
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
      expect((await runMergeReconcile({ stage: true }, { path: context.pmPath })).ok).toBe(true);
      const settled = await readFile(historyPath, "utf8");
      await rm(durablePath);
      const health = await runHealth({ path: context.pmPath }, { checkOnly: true, full: true });
      expect(health.ok).toBe(false);
      expect(JSON.stringify(health)).toContain("merge_receipt_history_reference_missing:1");
      expect(await readFile(historyPath, "utf8")).toBe(settled);
    });
  });

  it("refuses ordinary audit writes until indexed proof matches and rolls back prepared receipts on failure", async () => {
    await withTempPmPath(async (context) => {
      const git = initializeGitTracker(context, autocrlf);
      const id = createTestItemId(context, { title: "Indexed portable proof" });
      git("add", "."); git("commit", "-qm", "Seed tracker"); git("branch", "other");
      expect(context.runCli(["comments", id, "main context"]).code).toBe(0);
      git("add", ".agents"); git("commit", "-qm", "Main context");
      git("switch", "-q", "other");
      expect(context.runCli(["comments", id, "other context"]).code).toBe(0);
      git("add", ".agents"); git("commit", "-qm", "Other context");
      git("switch", "-q", "main"); git("merge", "--no-edit", "other");
      const scan = await inspectMergeReceiptEvidence(context.tempRoot);
      const receipt = scan.receipts[0]!;
      const relative = `.agents/pm/merge-receipts/${receipt.id}.json`;
      const receiptPath = path.join(context.tempRoot, relative);
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const before = await readFile(historyPath, "utf8");
      expect(scan.durable_receipt_ids).not.toContain(receipt.id);
      expect(scan.unstaged_durable_receipt_ids).toContain(receipt.id);
      for (const options of [{}, { force: true }]) {
        await expect(runMergeReconcile(options, { path: context.pmPath })).rejects.toMatchObject({ context: { code: "merge_receipt_not_portable" } });
        expect(await readFile(historyPath, "utf8")).toBe(before);
      }
      const preview = await runMergeReconcile({ dryRun: true }, { path: context.pmPath });
      expect(preview.receipts.unstaged_durable_receipt_ids).toContain(receipt.id);
      expect(await readFile(historyPath, "utf8")).toBe(before);

      const valid = await readFile(receiptPath, "utf8");
      for (const invalidIndex of ["not a receipt\n", "{}", JSON.stringify({ ...JSON.parse(valid), id: randomUUID() }), JSON.stringify({ ...JSON.parse(valid), created_at: "2026-01-01T00:00:00.000Z" })]) {
        await writeFile(receiptPath, invalidIndex); git("add", relative);
        await writeFile(receiptPath, valid);
        expect((await inspectMergeReceiptEvidence(context.tempRoot)).durable_receipt_ids).not.toContain(receipt.id);
        await expect(runMergeReconcile({}, { path: context.pmPath })).rejects.toMatchObject({ context: { code: "merge_receipt_not_portable" } });
        expect(await readFile(historyPath, "utf8")).toBe(before);
      }
      await expect(runMergeReconcile({ stage: true }, { path: context.pmPath })).rejects.toMatchObject({ context: { code: "merge_settlement_review_required" } });
      git("reset", "--quiet", "--", relative);

      await writeFile(path.join(context.tempRoot, "preserve.txt"), "Unrelated staged work\n"); git("add", "preserve.txt");
      const priorIndex = git("diff", "--cached", "--raw", "-z");
      await writeFile(path.join(context.tempRoot, ".gitignore"), ".agents/pm/merge-receipts/\n");
      for (const dryRun of [true, false]) {
        await expect(runMergeReconcile({ stage: true, dryRun }, { path: context.pmPath })).rejects.toMatchObject({
          context: { code: "merge_settlement_review_required", paths: [relative], reason: "ignored_merge_artifacts" },
          message: expect.stringContaining(".gitignore:1: .agents/pm/merge-receipts/"),
        });
        expect(git("diff", "--cached", "--raw", "-z")).toBe(priorIndex);
        expect(await readFile(historyPath, "utf8")).toBe(before);
        expect(await readFile(receiptPath, "utf8")).toBe(valid);
      }
      const ignoredHealth = await runHealth({ path: context.pmPath }, { checkOnly: true, full: true });
      expect(ignoredHealth.warnings).toContain("merge_artifacts_ignored:1");
      expect(ignoredHealth.checks.find((check) => check.name === "integrity")?.details).toMatchObject({
        ignored_merge_artifacts: [expect.objectContaining({ source: ".gitignore", line: 1, pattern: ".agents/pm/merge-receipts/" })],
      });
      await writeFile(path.join(context.tempRoot, ".gitignore"), "");
      await expect(stageLosslessMergeReconciliation({ preview, dryRun: false, global: { path: context.pmPath }, apply: async () => { throw new Error("blocked audit"); } })).rejects.toThrow("blocked audit");
      expect(git("diff", "--cached", "--raw", "-z")).toBe(priorIndex);
      expect(git("ls-files", "--", relative)).toBe("");
      expect(await readFile(historyPath, "utf8")).toBe(before);

      git("add", relative);
      expect((await inspectMergeReceiptEvidence(context.tempRoot)).durable_receipt_ids).toContain(receipt.id);
      const alias = path.join(context.tempRoot, ".git", "tracker-alias");
      await symlink(context.pmPath, alias, "junction");
      expect((await runMergeReconcile({ stage: true }, { path: alias })).ok).toBe(true);
      expect(git("diff", "--cached", "--name-only")).toContain("preserve.txt");
    });
  });

  it("settles an opted-in lossless merge in its original commit with portable audit evidence", async () => {
    await withTempPmPath(async (context) => {
      const git = initializeGitTracker(context, autocrlf);
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
      git("clone", "--config", `core.autocrlf=${autocrlf}`, "-q", "--no-local", context.tempRoot, clone);
      const clonedPmRoot = path.join(clone, ".agents", "pm");
      const freshHealth = await runHealth({ path: clonedPmRoot }, { checkOnly: true, full: true });
      expect(freshHealth.ok, JSON.stringify(freshHealth)).toBe(true);
      const clonedHistory = await readFile(path.join(clonedPmRoot, "history", `${id}.jsonl`), "utf8");
      expect(clonedHistory.includes("\r\n")).toBe(autocrlf);
      expect(clonedHistory.replaceAll("\r\n", "\n")).toBe(raw.replaceAll("\r\n", "\n"));
    });
  });
});
