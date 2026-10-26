/** Keep Git-backed receipt authority attached to copied tracker context, including refusal controls. */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sealHistoryRecord } from "../../../src/core/history/history.js";
import { writeMergeReceipt } from "../../../src/sdk/merge/receipts.js";
import { runLinkedTests } from "../../../src/sdk/test/execution.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import type { HistoryEntry } from "../../../src/types/index.js";

const cli = path.resolve("dist/cli.js");

describe("linked-test receipt authority", () => {
  it("agrees in source and snapshot modes, refuses missing or corrupted proof, and preserves both trackers", async () => {
    await withTempPmPath(async (context) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
      const git = (...args: string[]) => execFileSync("git", args, { cwd: context.tempRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      git("init", "-q");
      const id = createTestItemId(context, { title: "Portable receipt", createMode: "progressive" });
      const receipt = (await writeMergeReceipt({ cwd: context.tempRoot, itemPath: `.agents/pm/tasks/${id}.toon`, preferred: "ours", fieldsFromTheirs: [], unionFields: [], decisions: [] }))!;
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const entries = (await readFile(historyPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
      const last = entries.at(-1)!;
      last.context = { merge: { receipts: [{ receipt_id: receipt.id }] } };
      entries[entries.length - 1] = sealHistoryRecord(last);
      await writeFile(historyPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      git("add", ".agents/pm");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Receipt identity");
      const receiptPath = path.join(context.pmPath, "merge-receipts", `${receipt.id}.json`);
      const originalReceipt = await readFile(receiptPath, "utf8");
      const originalHistory = await readFile(historyPath, "utf8");
      const index = git("ls-files", "--stage");
      await writeFile(path.join(context.tempRoot, "receipt-check.cjs"), [
        "const fs = require('node:fs'); const path = require('node:path');",
        "const { execFileSync } = require('node:child_process');",
        `const paths = [${JSON.stringify(`history/${id}.jsonl`)}, ${JSON.stringify(`merge-receipts/${receipt.id}.json`)}].map(p => path.join(process.env.PM_PATH, p));`,
        "const before = paths.map(p => fs.readFileSync(p, 'utf8'));",
        `const health = JSON.parse(execFileSync(process.execPath, [${JSON.stringify(cli)}, 'health', '--check-only', '--full', '--json'], {encoding: 'utf8'}));`,
        "const unchanged = paths.every((p, i) => fs.readFileSync(p, 'utf8') === before[i]);",
        "console.log(JSON.stringify({health, unchanged}));",
      ].join("\n"));
      vi.stubEnv("PM_SOURCE_WORKSPACE_ROOT", context.tempRoot);
      vi.stubEnv("PM_SOURCE_PM_PATH", context.pmPath);
      try {
        for (const condition of ["valid", "missing", "corrupted"] as const) {
          if (condition === "missing") git("rm", "--cached", "--", `.agents/pm/merge-receipts/${receipt.id}.json`);
          if (condition === "corrupted") {
            git("add", ".agents/pm/merge-receipts");
            await writeFile(receiptPath, "{broken receipt\n");
          }
          // Commit only the index change in the missing case so snapshot and source have identical authority.
          if (condition === "missing") git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Missing authority control");
          const selectedReceipt = await readFile(receiptPath, "utf8");
          const results = await runLinkedTests(["source", "snapshot"].map((mode) => ({ command: "node receipt-check.cjs", pm_context_mode: "tracker", workspace_context_mode: mode as "source" | "snapshot" })), 60, {
            pmContext: "tracker", sourceRoots: { projectPmRoot: context.pmPath, globalPmRoot: context.env.PM_GLOBAL_PATH! }, allowUntrustedLinkedTests: true,
          });
          for (const result of results) {
            expect(result.status, result.stderr ?? result.error).toBe("passed");
            const proof = JSON.parse(result.stdout!) as { unchanged: boolean; health: { checks: { name: string; details: { counts: Record<string, number> } }[] } };
            expect(proof.unchanged).toBe(true);
            const health = proof.health;
            const counts = health.checks.find((check) => check.name === "integrity")!.details.counts;
            expect(counts.missing_merge_receipt_history_references).toBe(condition === "valid" ? 0 : 1);
            expect(counts.invalid_merge_receipt_evidence).toBe(condition === "corrupted" ? 1 : 0);
          }
          expect(await readFile(receiptPath, "utf8")).toBe(selectedReceipt);
          expect(await readFile(historyPath, "utf8")).toBe(originalHistory);
        }
        await writeFile(receiptPath, originalReceipt);
        git("add", ".agents/pm/merge-receipts");
        expect(git("ls-files", "--stage")).toBe(index);
      } finally { vi.unstubAllEnvs(); }
    });
  }, 90_000);
});
