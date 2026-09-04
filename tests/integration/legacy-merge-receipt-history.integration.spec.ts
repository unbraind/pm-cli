/**
 * @module tests/integration/legacy-merge-receipt-history
 *
 * Proves preferred-era receipt summaries already committed to history remain
 * accepted without an impossible clone-local evidence migration.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHealth } from "../../src/sdk/governance/health.js";
import { runMergeReconcile } from "../../src/sdk/merge/reconcile.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("legacy merge receipt history compatibility", () => {
  it("does not misclassify a present preferred-era summary as missing", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--id",
          "pm-legacy-receipt",
          "--title",
          "Legacy receipt",
          "--description",
          "Keep supported receipt epochs readable",
          "--type",
          "Task",
        ],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(created.code).toBe(0);
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-legacy-receipt.jsonl",
      );
      const entries = (await fs.readFile(historyPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const entry = entries.at(-1)!;
      delete entry.record_hash;
      delete entry.record_hash_version;
      entry.context = {
        merge: {
          receipts: [
            {
              receipt_id: "legacy-receipt-id",
              item_id: "pm-legacy-receipt",
              item_path: ".agents/pm/tasks/pm-legacy-receipt.toon",
              conflict_fields: ["title"],
              fields_from_theirs: [],
              union_fields: ["comments"],
              preferred: "ours",
              decisions: [
                {
                  field: "title",
                  retained_hash: "a".repeat(64),
                  discarded_hash: "b".repeat(64),
                },
              ],
            },
          ],
        },
      };
      await fs.writeFile(
        historyPath,
        `${entries.map((historyEntry) => JSON.stringify(historyEntry)).join("\n")}\n`,
        "utf8",
      );

      const health = await runHealth(
        { path: context.pmPath },
        { full: true, skipVectors: true },
      );
      expect(
        health.warnings.filter((warning) =>
          warning.startsWith("merge_receipt_history_reference_missing:"),
        ),
      ).toEqual([]);
      expect(
        health.checks.find((check) => check.name === "integrity")?.details,
      ).toMatchObject({
        counts: { accepted_legacy_merge_receipt_references: 1 },
      });
    });
  });

  it("accepts legacy rows in mixed history while current or malformed references still fail closed", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--id",
          "pm-mixed-receipts",
          "--title",
          "Mixed receipts",
          "--description",
          "Keep legacy compatibility narrower than modern validation",
          "--type",
          "Task",
        ],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(created.code).toBe(0);
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-mixed-receipts.jsonl",
      );
      const entries = (await fs.readFile(historyPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const entry = entries.at(-1)!;
      delete entry.record_hash;
      delete entry.record_hash_version;
      entry.context = {
        merge: {
          receipts: [
            {
              receipt_id: "legacy-mixed-id",
              item_id: "pm-mixed-receipts",
              item_path: ".agents/pm/tasks/pm-mixed-receipts.toon",
              conflict_fields: ["title"],
              fields_from_theirs: [],
              union_fields: [],
              preferred: "ours",
              decisions: [
                {
                  field: "title",
                  retained_hash: "c".repeat(64),
                  discarded_hash: "d".repeat(64),
                },
              ],
            },
            {
              receipt_id: "modern-missing-id",
              item_id: "pm-mixed-receipts",
              item_path: ".agents/pm/tasks/pm-mixed-receipts.toon",
              conflict_fields: ["title"],
              fields_from_theirs: [],
              union_fields: [],
              requested_preference: "ours",
              conflict_resolution: "stable_value_order",
              decisions: [],
            },
            {
              receipt_id: "legacy-wrong-item",
              item_id: "pm-other-item",
              item_path: ".agents/pm/tasks/pm-other-item.toon",
              conflict_fields: [],
              fields_from_theirs: [],
              union_fields: [],
              preferred: "ours",
              decisions: [],
            },
          ],
        },
      };
      await fs.writeFile(
        historyPath,
        `${entries.map((historyEntry) => JSON.stringify(historyEntry)).join("\n")}\n`,
        "utf8",
      );

      const health = await runHealth(
        { path: context.pmPath },
        { full: true, skipVectors: true },
      );
      expect(
        health.checks.find((check) => check.name === "integrity")?.details,
      ).toMatchObject({
        counts: { accepted_legacy_merge_receipt_references: 1 },
      });
      expect(
        health.warnings.filter((warning) =>
          warning.startsWith("merge_receipt_history_reference_missing:"),
        ),
      ).toEqual(["merge_receipt_history_reference_missing:2"]);
      const strict = context.runCli(
        ["health", "--full", "--skip-vectors", "--strict-exit", "--json"],
        { expectJson: true },
      );
      expect(strict.code).not.toBe(0);
      expect((strict.json as { warnings: string[] }).warnings).toContain(
        "merge_receipt_history_reference_missing:2",
      );
    });
  });

  it("records an explicit disposition for a pre-durable clone-local-only reference", async () => {
    await withTempPmPath(async (context) => {
      expect(
        context.runCli(
          [
            "create",
            "--json",
            "--id",
            "pm-pre-durable-receipt",
            "--title",
            "Pre-durable receipt",
            "--type",
            "Task",
          ],
          { cwd: context.tempRoot, expectJson: true },
        ).code,
      ).toBe(0);
      const historyPath = path.join(
        context.pmPath,
        "history",
        "pm-pre-durable-receipt.jsonl",
      );
      const entries = (await fs.readFile(historyPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const entry = entries.at(-1)!;
      entry.ts = "2026-08-06T22:21:21.734Z";
      delete entry.record_hash;
      delete entry.record_hash_version;
      entry.context = {
        merge: {
          receipts: [
            {
              receipt_id: "lost-clone-local-receipt",
              item_id: "pm-pre-durable-receipt",
              item_path: ".agents/pm/tasks/pm-pre-durable-receipt.toon",
              conflict_fields: ["title"],
              fields_from_theirs: [],
              union_fields: [],
              requested_preference: "ours",
              conflict_resolution: "stable_value_order",
              decisions: [
                {
                  field: "title",
                  retained_hash: "a".repeat(64),
                  discarded_hash: "b".repeat(64),
                },
              ],
            },
          ],
        },
      };
      await fs.writeFile(
        historyPath,
        `${entries.map((historyEntry) => JSON.stringify(historyEntry)).join("\n")}\n`,
        "utf8",
      );

      const preview = await runMergeReconcile(
        { dryRun: true, force: true },
        { path: context.pmPath },
      );
      expect(preview).toMatchObject({
        ok: false,
        receipts: {
          missing_history_references_before: 1,
          legacy_disposition_eligible: 1,
          legacy_disposition_recorded: 0,
          missing_history_references_after: 1,
        },
      });

      const applied = await runMergeReconcile(
        { force: true },
        { path: context.pmPath },
      );
      expect(applied).toMatchObject({
        ok: true,
        receipts: {
          missing_history_references_before: 1,
          legacy_disposition_eligible: 1,
          legacy_disposition_recorded: 1,
          missing_history_references_after: 0,
        },
      });
      const health = await runHealth(
        { path: context.pmPath },
        { full: true, skipVectors: true },
      );
      expect(
        health.checks.find((check) => check.name === "integrity")?.details,
      ).toMatchObject({
        counts: {
          missing_merge_receipt_history_references: 0,
          accepted_missing_merge_receipt_dispositions: 1,
        },
      });
    });
  });
});
