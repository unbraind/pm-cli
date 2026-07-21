import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MergeReconcileResult } from "../../../src/sdk/merge/reconcile.js";
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

      const historyPath = path.join(
        context.pmPath,
        "history",
        `${id!}.jsonl`,
      );
      const tampered = await tamperHistoryChain(historyPath);

      const preview = context.runCli(
        ["merge", "reconcile", "--dry-run", "--json"],
        { expectJson: true },
      );
      expect(preview.code).toBe(0);
      const previewResult = preview.json as MergeReconcileResult;
      expect(previewResult).toMatchObject({
        ok: true,
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
        appliedResult.validation.checks.every(
          (check) => check.status === "ok",
        ),
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
      const historyPath = path.join(
        context.pmPath,
        "history",
        `${id!}.jsonl`,
      );
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

      const result = context.runCli(
        ["merge", "reconcile", "--json"],
        { expectJson: true },
      );
      expect(result.code).not.toBe(0);
      expect(JSON.parse(result.stdout) as MergeReconcileResult).toMatchObject({
        ok: false,
        dry_run: false,
        repair: { totals: { failed: 1 } },
      });
    });
  });
});
