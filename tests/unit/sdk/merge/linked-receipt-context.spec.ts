/** Authenticate copied tracker receipts only through a bound source or independent snapshot index. */
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inspectMergeReceiptEvidence, writeMergeReceipt } from "../../../../src/sdk/merge/receipts.js";
import { seedLinkedTestWorkspaceSnapshot } from "../../../../src/sdk/test/workspace-snapshot.js";

describe("bound linked receipt context", () => {
  it("keeps valid proof portable and refuses absent, mismatched or unrelated source coordinates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pm-linked-receipt-authority-"));
    const source = path.join(root, "source");
    const tracker = path.join(source, ".agents/pm");
    const sandbox = path.join(root, "sandbox");
    const snapshot = path.join(root, "snapshot");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: source, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      await mkdir(tracker, { recursive: true });
      await writeFile(path.join(tracker, "settings.json"), "{}\n");
      git("init", "-q");
      const receipt = (await writeMergeReceipt({ cwd: source, itemPath: ".agents/pm/tasks/pm-proof.toon", preferred: "ours", fieldsFromTheirs: [], unionFields: [], decisions: [] }))!;
      git("add", ".agents/pm");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Bound receipt proof");
      await cp(tracker, sandbox, { recursive: true });
      const receiptPath = path.join(sandbox, "merge-receipts", `${receipt.id}.json`);
      const bytes = await readFile(receiptPath, "utf8");
      const inspect = () => inspectMergeReceiptEvidence(sandbox, { pmRoot: sandbox, includeReconciled: true });
      const bound = { PM_PATH: sandbox, PM_SOURCE_CONTEXT_ACCESS: "read_only", PM_SOURCE_WORKSPACE_ROOT: source, PM_SOURCE_PM_PATH: tracker };
      const refused = [
        { PM_SOURCE_WORKSPACE_ROOT: "" }, { PM_PATH: tracker }, { PM_PATH: "" },
        { PM_SOURCE_PM_PATH: path.join(root, "missing") },
        { PM_SOURCE_WORKSPACE_ROOT: path.join(root, "missing") },
        { PM_SOURCE_PM_PATH: "" }, { PM_SOURCE_WORKSPACE_ROOT: sandbox },
      ];
      for (const changed of refused) {
        for (const [key, value] of Object.entries({ ...bound, ...changed })) vi.stubEnv(key, value);
        expect((await inspect()).durable_receipt_ids).toEqual([]);
      }
      vi.stubEnv("PM_PATH", sandbox);
      vi.stubEnv("PM_SOURCE_WORKSPACE_ROOT", source);
      vi.stubEnv("PM_SOURCE_PM_PATH", tracker);
      vi.stubEnv("GIT_DIR", path.join(root, "unrelated"));
      vi.stubEnv("GIT_INDEX_FILE", path.join(root, "unrelated-index"));
      expect((await inspect()).durable_receipt_ids).toEqual([receipt.id]);
      await seedLinkedTestWorkspaceSnapshot(source, snapshot);
      await mkdir(path.join(snapshot, ".agents"));
      await symlink(sandbox, path.join(snapshot, ".agents/pm"), process.platform === "win32" ? "junction" : "dir");
      vi.stubEnv("PM_SOURCE_WORKSPACE_ROOT", snapshot);
      vi.stubEnv("PM_SOURCE_PM_PATH", sandbox);
      expect((await inspect()).durable_receipt_ids).toEqual([receipt.id]);
      // A present but unrelated bound path cannot borrow the source receipt namespace.
      const unrelated = path.join(root, "unrelated-tracker");
      await cp(tracker, unrelated, { recursive: true });
      vi.stubEnv("PM_SOURCE_PM_PATH", unrelated);
      expect((await inspect()).durable_receipt_ids).toEqual([]);
      expect(await readFile(receiptPath, "utf8")).toBe(bytes);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
});
