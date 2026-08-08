import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runMergeReconcile,
  type MergeReconcileResult,
} from "../../../src/sdk/merge/reconcile.js";
import { writeMergeReceipt } from "../../../src/sdk/merge/receipts.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

async function tamperHistoryChain(historyPath: string): Promise<string> {
  const lines = (await readFile(historyPath, "utf8"))
    .split(/\n/)
    .filter(Boolean);
  const entry = JSON.parse(lines[1]!) as Record<string, unknown>;
  entry.before_hash = "0".repeat(64);
  lines[1] = JSON.stringify(entry);
  const tampered = `${lines.join("\n")}\n`;
  await writeFile(historyPath, tampered, "utf8");
  return tampered;
}

describe("merge reconcile command", () => {
  it("previews and then applies audited post-merge history reconciliation", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Merge reconciliation target",
          "--description",
          "History will be drifted after a simulated branch merge",
          "--type",
          "Task",
          "--id",
          "merge-reconcile",
          "--author",
          "merge-spec",
          "--message",
          "Create reconciliation target",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const createdPayload = created.json as {
        id?: string;
        item?: { id?: string };
      };
      const id = createdPayload.id ?? createdPayload.item?.id;
      expect(id).toBeTypeOf("string");
      expect(
        context.runCli([
          "update",
          id!,
          "--priority",
          "1",
          "--author",
          "merge-spec",
          "--message",
          "Add a second history entry",
        ]).code,
      ).toBe(0);

      const historyPath = path.join(context.pmPath, "history", `${id!}.jsonl`);
      const tampered = await tamperHistoryChain(historyPath);

      const preview = context.runCli(
        ["merge", "reconcile", "--dry-run", "--json"],
        { expectJson: true },
      );
      expect(preview.code).not.toBe(0);
      const previewResult = preview.json as MergeReconcileResult;
      expect(previewResult).toMatchObject({
        ok: false,
        dry_run: true,
        repair: { drifted_streams: 1, totals: { failed: 0 } },
      });
      expect(
        previewResult.validation.checks.find(
          (check) => check.name === "history_drift",
        )?.status,
      ).toBe("warn");
      expect(await readFile(historyPath, "utf8")).toBe(tampered);

      const applied = context.runCli(
        [
          "merge",
          "reconcile",
          "--message",
          "Reconcile simulated merge drift",
          "--json",
        ],
        { expectJson: true },
      );
      expect(applied.code).toBe(0);
      const appliedResult = applied.json as MergeReconcileResult;
      expect(appliedResult).toMatchObject({
        ok: true,
        dry_run: false,
        repair: { drifted_streams: 1, totals: { repaired: 1, failed: 0 } },
        validation: { ok: true, has_warnings: false },
      });
      expect(
        appliedResult.validation.checks.every((check) => check.status === "ok"),
      ).toBe(true);

      const cleanPreview = context.runCli(
        ["merge", "reconcile", "--dry-run", "--json"],
        { expectJson: true },
      );
      expect(cleanPreview.code).toBe(0);
      expect(
        (cleanPreview.json as MergeReconcileResult).repair.drifted_streams,
      ).toBe(0);
    });
  });

  it("rejects positional artifacts because reconciliation always scans the tracker", async () => {
    await withTempPmPath(async (context) => {
      const result = context.runCli([
        "merge",
        "reconcile",
        "unexpected-artifact",
        "--json",
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        "merge reconcile takes no positional arguments",
      );
    });
  });

  it("returns a failing envelope when one drifted stream cannot be repaired", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Unrepairable merge stream",
          "--description",
          "Exercises isolated bulk repair failure reporting",
          "--type",
          "Task",
          "--id",
          "merge-reconcile-failure",
          "--author",
          "merge-spec",
          "--message",
          "Create failure target",
        ],
        { expectJson: true },
      );
      const createdPayload = created.json as {
        id?: string;
        item?: { id?: string };
      };
      const id = createdPayload.id ?? createdPayload.item?.id;
      expect(id).toBeTypeOf("string");
      const historyPath = path.join(context.pmPath, "history", `${id!}.jsonl`);
      expect(
        context.runCli([
          "update",
          id!,
          "--priority",
          "1",
          "--author",
          "merge-spec",
          "--message",
          "Add repairable drift target",
        ]).code,
      ).toBe(0);
      await tamperHistoryChain(historyPath);
      expect(
        context.runCli([
          "config",
          "set",
          "governance_force_required_for_stale_lock",
          "true",
          "--json",
        ]).code,
      ).toBe(0);
      const locksDir = path.join(context.pmPath, "locks");
      await mkdir(locksDir, { recursive: true });
      await writeFile(
        path.join(locksDir, `${id!}.lock`),
        JSON.stringify({
          id,
          pid: 99999,
          owner: "another-agent",
          created_at: new Date(Date.now() - 7_200_000).toISOString(),
          ttl_seconds: 60,
        }),
        "utf8",
      );

      const result = context.runCli(["merge", "reconcile", "--json"], {
        expectJson: true,
      });
      expect(result.code).not.toBe(0);
      expect(JSON.parse(result.stdout) as MergeReconcileResult).toMatchObject({
        ok: false,
        dry_run: false,
        repair: { totals: { failed: 1 } },
      });
    });
  });

  it("records privacy-safe receipt context on a clean merge stream", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "-q"], { cwd: context.tempRoot });
      expect(
        context.runCli(["merge", "install", "--json"], {
          cwd: context.tempRoot,
        }).code,
      ).toBe(0);
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Clean receipt merge",
          "--description",
          "Record branch provenance without history drift",
          "--type",
          "Task",
          "--id",
          "merge-clean-receipt",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const createdPayload = created.json as {
        id?: string;
        item?: { id?: string };
      };
      const id = createdPayload.id ?? createdPayload.item?.id;
      expect(id).toBeTypeOf("string");
      const receipt = await writeMergeReceipt({
        cwd: context.tempRoot,
        itemPath: `.agents/pm/tasks/${id!}.toon`,
        preferred: "ours",
        fieldsFromTheirs: ["priority"],
        unionFields: ["comments"],
        decisions: [
          {
            field: "title",
            base: "base",
            ours: "retained",
            theirs: "discarded",
            retained: "retained",
            discarded: "discarded",
          },
        ],
      });
      expect(receipt).not.toBeNull();

      const preview = context.runCli(
        ["merge", "reconcile", "--dry-run", "--json"],
        { expectJson: true, cwd: context.tempRoot },
      );
      expect(preview.code).not.toBe(0);
      expect(preview.json as MergeReconcileResult).toMatchObject({
        ok: false,
        dry_run: true,
        receipts: { pending_before: 1, reconciled: 0 },
        validation: {
          warnings: ["validate_merge_decisions_unreviewed:1"],
        },
      });

      const originalCwd = process.cwd();
      process.chdir(context.tempRoot);
      try {
        await expect(
          runMergeReconcile({ dryRun: false }, { path: context.pmPath }),
        ).rejects.toMatchObject({
          exitCode: 4,
          context: {
            code: "merge_reconcile_discards_require_acceptance",
            nextSteps: [expect.stringContaining(receipt!.id)],
          },
        });
      } finally {
        process.chdir(originalCwd);
      }

      const refused = context.runCli(["merge", "reconcile", "--json"], {
        expectJson: true,
        cwd: context.tempRoot,
      });
      expect(refused.code).toBe(4);
      expect(`${refused.stdout}\n${refused.stderr}`).toContain(
        "merge_reconcile_discards_require_acceptance",
      );

      const reconciled = context.runCli(
        ["merge", "reconcile", "--force", "--json"],
        {
          expectJson: true,
          cwd: context.tempRoot,
        },
      );
      expect(
        reconciled.code,
        `${reconciled.stdout}\n${reconciled.stderr}`,
      ).toBe(0);
      expect(reconciled.json as MergeReconcileResult).toMatchObject({
        ok: true,
        receipts: { pending_before: 1, reconciled: 1 },
      });
      const entries = (
        await readFile(
          path.join(context.pmPath, "history", `${id!}.jsonl`),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries.at(-1)).toMatchObject({
        op: "merge_reconcile",
        context: {
          merge: {
            receipts: [
              {
                receipt_id: receipt!.id,
                decisions: [
                  {
                    retained_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
                    discarded_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
                  },
                ],
              },
            ],
          },
        },
      });
      expect(JSON.stringify(entries.at(-1))).not.toContain(
        '"theirs":"discarded"',
      );
      expect(JSON.stringify(entries.at(-1))).not.toContain('"ours":"retained"');
    });
  });
});
