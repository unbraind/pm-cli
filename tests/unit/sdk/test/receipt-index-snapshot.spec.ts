/** Source-index receipts remain authoritative across staged and custom-root snapshots. */
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inspectMergeReceiptEvidence, writeMergeReceipt } from "../../../../src/sdk/merge/receipts.js";
import { readIndexedReceiptBlobs } from "../../../../src/sdk/merge/indexed-receipt-blobs.js";
import { seedSnapshotReceiptIndex } from "../../../../src/sdk/test/receipt-index-snapshot.js";
import { seedLinkedTestWorkspaceSnapshot } from "../../../../src/sdk/test/workspace-snapshot.js";

describe("snapshot receipt index", () => {
  it.each(["corrupt index", "missing object", "invalid repository", "missing Git metadata", "missing workspace"])("preserves snapshot authority on a source %s read failure", async (condition) => {
    // Linked index coordinates use Git's physical root, including native temp aliases.
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "pm-snapshot-read-failure-")));
    const source = path.join(root, "source");
    const tracker = path.join(source, ".agents/pm");
    const directory = path.join(tracker, "merge-receipts");
    const snapshot = path.join(root, "snapshot");
    const relativeReceipt = ".agents/pm/merge-receipts/one.json";
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      for (const workspace of [source, snapshot]) {
        await mkdir(path.join(workspace, ".agents/pm/merge-receipts"), { recursive: true });
        git(workspace, "init", "-q");
        await writeFile(path.join(workspace, relativeReceipt), `${JSON.stringify({ workspace })}\n`);
        git(workspace, "add", relativeReceipt);
      }
      expect((await readIndexedReceiptBlobs(source, directory, ["one.json"], 4096, directory)).size).toBe(1);
      const snapshotIndex = await readFile(path.join(snapshot, ".git/index"));
      const snapshotListing = git(snapshot, "ls-files", "--stage");
      if (condition === "corrupt index") await writeFile(path.join(source, ".git/index"), "invalid-index");
      if (condition === "missing object") {
        const id = git(source, "rev-parse", `:${relativeReceipt}`);
        await rm(path.join(source, ".git/objects", id.slice(0, 2), id.slice(2)));
      }
      if (condition === "invalid repository") {
        await rm(path.join(source, ".git"), { recursive: true });
        await writeFile(path.join(source, ".git"), "gitdir: /invalid/missing-repository\n");
      }
      if (condition === "missing Git metadata") await rm(path.join(source, ".git/HEAD"));
      const cwd = condition === "missing workspace" ? path.join(root, "absent") : source;
      const sourceIndex = condition === "invalid repository" ? null : await readFile(path.join(source, ".git/index"));
      expect(await readIndexedReceiptBlobs(cwd, directory, ["one.json"], 4096, directory)).toEqual(new Map());
      await expect(seedSnapshotReceiptIndex(cwd, snapshot, tracker)).rejects.toThrow();
      expect(await readFile(path.join(snapshot, ".git/index"))).toEqual(snapshotIndex);
      expect(git(snapshot, "ls-files", "--stage")).toBe(snapshotListing);
      if (sourceIndex !== null) expect(await readFile(path.join(source, ".git/index"))).toEqual(sourceIndex);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("supports a snapshot source without Git authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-snapshot-no-git-"));
    const source = path.join(root, "source");
    const tracker = path.join(source, ".agents/pm");
    const snapshot = path.join(root, "snapshot");
    const relativeReceipt = ".agents/pm/merge-receipts/one.json";
    try {
      await mkdir(path.join(source, ".agents/pm/merge-receipts"), { recursive: true });
      await writeFile(path.join(source, relativeReceipt), "{}\n");
      await seedLinkedTestWorkspaceSnapshot(source, snapshot, tracker);
      await expect(readFile(path.join(snapshot, ".git/HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(source, relativeReceipt), "utf8")).toBe("{}\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([".agents/pm", "project-state"])("preserves staged %s receipts without importing untracked or conflicting authority", async (relativeTracker) => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-snapshot-receipt-index-"));
    const source = path.join(root, "source");
    const tracker = path.join(source, relativeTracker);
    const sandbox = path.join(root, "sandbox");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    // Native fixture inventories exceed one MiB; production Git limits stay unchanged.
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      await mkdir(tracker, { recursive: true });
      await writeFile(path.join(tracker, "settings.json"), "{}\n");
      git(source, "init", "-q"); git(source, "add", relativeTracker);
      git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Base");
      const receipt = (await writeMergeReceipt({ cwd: source, itemPath: `${relativeTracker}/tasks/pm-staged.toon`, preferred: "ours", fieldsFromTheirs: [], unionFields: [], decisions: [] }))!;
      const relativeReceipt = `${relativeTracker}/merge-receipts/${receipt.id}.json`;
      const raw = await readFile(path.join(source, relativeReceipt), "utf8");
      if (relativeTracker === "project-state") {
        const oldNamespace = path.join(source, ".agents/pm/merge-receipts");
        await mkdir(oldNamespace, { recursive: true });
        await writeFile(path.join(oldNamespace, `${receipt.id}.json`), raw);
        git(source, "add", ".agents/pm/merge-receipts");
        const objectId = git(source, "rev-parse", `:.agents/pm/merge-receipts/${receipt.id}.json`);
        const inherited = Array.from({ length: 8000 }, (_, index) => `.agents/pm/merge-receipts/inherited-${index}-${"x".repeat(100)}.json`);
        expect(Buffer.byteLength(inherited.join("\n"))).toBeGreaterThan(1024 * 1024);
        execFileSync("git", ["update-index", "--index-info"], { cwd: source, env, input: inherited.map((file) => `100644 ${objectId}\t${file}\n`).join("") });
        git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Unrelated receipt namespace");
      }
      git(source, "add", relativeReceipt);
      const tracked = git(source, "ls-files", "--stage");
      expect(git(source, "ls-tree", "-r", "HEAD", "--", relativeReceipt)).toBe("");
      const schemaSnapshot = path.join(root, "schema-snapshot");
      await seedLinkedTestWorkspaceSnapshot(source, schemaSnapshot, tracker, false);
      expect(git(schemaSnapshot, "ls-files", "--", ".agents/pm/merge-receipts")).toBe(git(source, "ls-tree", "-r", "--name-only", "HEAD", "--", ".agents/pm/merge-receipts"));
      await cp(tracker, sandbox, { recursive: true });
      vi.stubEnv("PM_PATH", sandbox); vi.stubEnv("PM_SOURCE_CONTEXT_ACCESS", "read_only");
      for (const [position, condition] of ["staged", "untracked", "conflicted", "divergent"].entries()) {
        if (condition === "untracked") git(source, "rm", "--cached", relativeReceipt);
        if (condition === "conflicted") {
          git(source, "add", relativeReceipt);
          const objectId = git(source, "rev-parse", `:${relativeReceipt}`);
          git(source, "update-index", "--force-remove", relativeReceipt);
          execFileSync("git", ["update-index", "--index-info"], { cwd: source, env, input: `100644 ${objectId} 2\t${relativeReceipt}\n` });
        }
        if (condition === "divergent") {
          git(source, "add", relativeReceipt);
          const modified = JSON.parse(raw) as { union_fields: string[] };
          modified.union_fields = ["notes"];
          await writeFile(path.join(sandbox, "merge-receipts", `${receipt.id}.json`), `${JSON.stringify(modified)}\n`);
        }
        const indexBefore = git(source, "ls-files", "--stage");
        const snapshot = path.join(root, `snapshot-${position}`);
        await seedLinkedTestWorkspaceSnapshot(source, snapshot, tracker);
        await mkdir(path.join(snapshot, ".agents"), { recursive: true });
        await symlink(sandbox, path.join(snapshot, ".agents/pm"), process.platform === "win32" ? "junction" : "dir");
        vi.stubEnv("PM_SOURCE_WORKSPACE_ROOT", snapshot); vi.stubEnv("PM_SOURCE_PM_PATH", sandbox);
        const evidence = await inspectMergeReceiptEvidence(sandbox, { pmRoot: sandbox });
        expect(evidence.durable_receipt_ids, condition).toEqual(condition === "staged" ? [receipt.id] : []);
        expect(git(source, "ls-files", "--stage")).toBe(indexBefore);
        expect(await readFile(path.join(source, relativeReceipt), "utf8")).toBe(raw);
      }
      expect(tracked).toContain(receipt.id);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
});
