/**
 * @module tests/integration/merge-receipt-health-classification
 *
 * Proves health and validation distinguish lossless merge provenance from a
 * scalar decision that discarded a competing value.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  sha256Hex,
  stableStringify,
} from "../../src/core/shared/serialization.js";
import { parseItemDocument } from "../../src/core/item/item-format.js";
import { sealHistoryRecord } from "../../src/core/history/history.js";
import {
  listMergeReceipts,
  markMergeReceiptReconciled,
  writeMergeReceipt,
} from "../../src/sdk/merge/receipts.js";
import { runHealth } from "../../src/sdk/governance/health.js";
import {
  runHistoryRepair,
  runHistoryRepairAll,
} from "../../src/sdk/history-repair.js";
import type { HistoryEntry } from "../../src/types/index.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

interface DiagnosticEnvelope {
  ok: boolean;
  warnings: string[];
  checks: Array<{
    name: string;
    details: Record<string, unknown>;
  }>;
}

function checkDetails(
  result: DiagnosticEnvelope,
  name: string,
): Record<string, unknown> {
  return result.checks.find((check) => check.name === name)?.details ?? {};
}

async function locateItemPath(root: string, id: string): Promise<string> {
  const pmRoot = path.join(root, ".agents", "pm");
  const itemEntry = (await fs.readdir(pmRoot, { recursive: true })).find(
    (entry) =>
      !entry.startsWith(`history${path.sep}`) &&
      path.basename(entry, path.extname(entry)) === id,
  );
  expect(itemEntry).toBeDefined();
  return path.join(pmRoot, itemEntry as string);
}

async function rewriteItemTitle(params: {
  root: string;
  id: string;
  from: string;
  to: string;
}): Promise<string> {
  const itemPath = await locateItemPath(params.root, params.id);
  const before = await fs.readFile(itemPath, "utf8");
  expect(before).toContain(params.from);
  await fs.writeFile(itemPath, before.replace(params.from, params.to), "utf8");
  return itemPath;
}

async function removeReceiptCopies(
  root: string,
  receiptId: string,
): Promise<void> {
  const gitDirectory = execFileSync("git", ["rev-parse", "--git-dir"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  await Promise.all([
    fs.rm(
      path.resolve(
        root,
        gitDirectory,
        "pm-merge-receipts",
        `${receiptId}.json`,
      ),
      {
        force: true,
      },
    ),
    fs.rm(
      path.join(root, ".agents", "pm", "merge-receipts", `${receiptId}.json`),
      { force: true },
    ),
  ]);
}

describe("merge receipt health classification", () => {
  it("fails health closed when malformed receipt evidence is the only candidate", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "--quiet"], { cwd: context.tempRoot });
      const receiptDirectory = execFileSync(
        "git",
        [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "pm-merge-receipts",
        ],
        { cwd: context.tempRoot, encoding: "utf8" },
      ).trim();
      await fs.mkdir(receiptDirectory, { recursive: true });
      await fs.writeFile(
        path.join(receiptDirectory, "malformed.json"),
        '{"version":1,"id":"malformed"',
        "utf8",
      );

      const health = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(health.code).toBe(0);
      const healthResult = health.json as DiagnosticEnvelope;
      expect(healthResult.ok).toBe(false);
      expect(healthResult.warnings).toContain(
        "merge_receipt_evidence_invalid:1",
      );
      expect(checkDetails(healthResult, "integrity")).toMatchObject({
        counts: {
          pending_merge_decisions: 0,
          lossless_merge_receipts: 0,
          invalid_merge_receipt_evidence: 1,
        },
        invalid_merge_receipt_evidence_details: [
          {
            evidence_source: "clone_local",
            reason: "candidate_invalid_json",
            receipt_id: "malformed",
          },
        ],
        invalid_merge_receipt_evidence_details_truncated: false,
        remediation_map: {
          merge_receipt_evidence_invalid:
            "pm merge report --include-reconciled --json",
        },
      });
      const sdkHealth = await runHealth(
        { path: path.join(context.tempRoot, ".agents", "pm") },
        { full: true },
      );
      expect(sdkHealth.ok).toBe(false);
      expect(sdkHealth.warnings).toContain("merge_receipt_evidence_invalid:1");
      const validation = context.runCli(
        ["validate", "--check-storage-integrity", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(validation.code).toBe(0);
      expect(validation.json).toMatchObject({ ok: true, has_warnings: true });
      expect((validation.json as DiagnosticEnvelope).warnings).toContain(
        "merge_receipt_evidence_invalid:1",
      );
      expect(
        checkDetails(
          validation.json as DiagnosticEnvelope,
          "storage_integrity",
        ),
      ).toMatchObject({
        invalid_merge_receipt_evidence_count: 1,
        invalid_merge_receipt_evidence_details: [
          {
            evidence_source: "clone_local",
            reason: "candidate_invalid_json",
            receipt_id: "malformed",
          },
        ],
        invalid_merge_receipt_evidence_details_truncated: false,
      });
      expect(
        (validation.json as DiagnosticEnvelope).checks.find(
          (check) => check.name === "storage_integrity",
        ),
      ).toMatchObject({ status: "warn" });
      const reconcile = context.runCli(
        ["merge", "reconcile", "--dry-run", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(reconcile.code).toBe(4);
      expect(`${reconcile.stdout}\n${reconcile.stderr}`).toContain(
        "merge_receipt_evidence_invalid",
      );
    });
  });

  it("reports missing history-referenced receipts without exposing unsafe identifiers", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "--quiet"], { cwd: context.tempRoot });
      expect(
        context.runCli(
          [
            "create",
            "--json",
            "--id",
            "pm-history-receipt-reference",
            "--title",
            "History receipt reference",
            "--description",
            "Diagnose missing evidence without rewriting append-only history",
            "--type",
            "Task",
          ],
          { cwd: context.tempRoot },
        ).code,
      ).toBe(0);
      const itemPath = await locateItemPath(
        context.tempRoot,
        "pm-history-receipt-reference",
      );
      const availableReceipt = await writeMergeReceipt({
        cwd: context.tempRoot,
        itemPath: path
          .relative(context.tempRoot, itemPath)
          .replaceAll(path.sep, "/"),
        preferred: "ours",
        fieldsFromTheirs: [],
        unionFields: [],
        decisions: [],
      });
      expect(availableReceipt).not.toBeNull();
      const historyPath = path.join(
        context.tempRoot,
        ".agents",
        "pm",
        "history",
        "pm-history-receipt-reference.jsonl",
      );
      const historyLines = (await fs.readFile(historyPath, "utf8"))
        .trimEnd()
        .split(/\r?\n/u);
      const lastEntry = JSON.parse(historyLines.at(-1) ?? "null") as Record<
        string,
        unknown
      >;
      lastEntry.context = {
        merge: {
          receipts: [
            null,
            { receipt_id: "" },
            { receipt_id: availableReceipt?.id },
            { receipt_id: "missing-history-receipt" },
            { receipt_id: "unsafe receipt identity" },
            ...Array.from({ length: 99 }, (_, index) => ({
              receipt_id: `missing-history-${String(index).padStart(3, "0")}`,
            })),
          ],
        },
      };
      historyLines[historyLines.length - 1] = JSON.stringify(
        sealHistoryRecord(lastEntry as HistoryEntry),
      );
      await fs.writeFile(historyPath, `${historyLines.join("\n")}\n`, "utf8");

      const health = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(health.code).toBe(0);
      const result = health.json as DiagnosticEnvelope;
      expect(result.warnings).toContain(
        "merge_receipt_history_reference_missing:101",
      );
      const integrityDetails = checkDetails(result, "integrity");
      expect(integrityDetails).toMatchObject({
        counts: { missing_merge_receipt_history_references: 101 },
        missing_merge_receipt_history_reference_details_truncated: true,
        remediation_map: {
          merge_receipt_history_reference_missing:
            "pm health --check-only --full --json",
        },
      });
      expect(
        integrityDetails.missing_merge_receipt_history_reference_details,
      ).toHaveLength(100);
      expect(
        integrityDetails.missing_merge_receipt_history_reference_details,
      ).toEqual(
        expect.arrayContaining([
          {
            item_id: "pm-history-receipt-reference",
            history_line: historyLines.length,
            receipt_id: "missing-history-receipt",
          },
          {
            item_id: "pm-history-receipt-reference",
            history_line: historyLines.length,
            receipt_reference_hash: sha256Hex("unsafe receipt identity"),
          },
        ]),
      );
      const sdkHealth = await runHealth(
        { path: path.join(context.tempRoot, ".agents", "pm") },
        { full: true },
      );
      expect(sdkHealth.warnings).toContain(
        "merge_receipt_history_reference_missing:101",
      );
      expect(
        sdkHealth.checks.find((check) => check.name === "integrity")?.details,
      ).toMatchObject({
        counts: { missing_merge_receipt_history_references: 101 },
        missing_merge_receipt_history_reference_details_truncated: true,
      });
    });
  });

  it("ignores parseable non-receipt history shapes during reference discovery", async () => {
    await withTempPmPath(async (context) => {
      expect(
        context.runCli(
          [
            "create",
            "--json",
            "--id",
            "pm-non-receipt-history",
            "--title",
            "Non-receipt history",
            "--description",
            "Keep defensive history context shapes out of receipt diagnostics",
            "--type",
            "Task",
          ],
          { cwd: context.tempRoot },
        ).code,
      ).toBe(0);
      await fs.writeFile(
        path.join(
          context.tempRoot,
          ".agents",
          "pm",
          "history",
          "pm-non-receipt-history.jsonl",
        ),
        [
          "null",
          '{"context":null}',
          '{"context":{}}',
          '{"context":{"merge":null}}',
          '{"context":{"merge":{"receipts":null}}}',
          '{"context":{"merge":{"receipts":[[],{}, {"receipt_id":0}]}}}',
          "",
        ].join("\n"),
        "utf8",
      );

      const health = await runHealth(
        { path: path.join(context.tempRoot, ".agents", "pm") },
        { full: true },
      );
      expect(
        health.warnings.some((warning) =>
          warning.startsWith("merge_receipt_history_reference_missing:"),
        ),
      ).toBe(false);
    });
  });

  it("refuses divergent same-id receipt copies before mutating history", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "--quiet"], { cwd: context.tempRoot });
      expect(
        context.runCli(["merge", "install", "--json"], {
          cwd: context.tempRoot,
        }).code,
      ).toBe(0);
      expect(
        context.runCli(
          [
            "create",
            "--json",
            "--id",
            "pm-cross-copy",
            "--title",
            "Cross-copy receipt",
            "--description",
            "Reject divergent durable and clone-local provenance",
            "--type",
            "Task",
          ],
          { cwd: context.tempRoot },
        ).code,
      ).toBe(0);
      const itemPath = await rewriteItemTitle({
        root: context.tempRoot,
        id: "pm-cross-copy",
        from: "Cross-copy receipt",
        to: "Changed cross-copy receipt",
      });
      const receipt = await writeMergeReceipt({
        cwd: context.tempRoot,
        itemPath: path
          .relative(context.tempRoot, itemPath)
          .replaceAll(path.sep, "/"),
        preferred: "ours",
        fieldsFromTheirs: ["title"],
        unionFields: [],
        mergedFieldHashes: {
          title: sha256Hex(stableStringify("Changed cross-copy receipt")),
        },
        decisions: [],
      });
      expect(receipt).not.toBeNull();
      const durablePath = path.join(
        context.tempRoot,
        ".agents",
        "pm",
        "merge-receipts",
        `${receipt?.id}.json`,
      );
      const durableBefore = JSON.parse(
        await fs.readFile(durablePath, "utf8"),
      ) as Record<string, unknown>;
      const divergentDurable = structuredClone(durableBefore);
      divergentDurable.item_id = "pm-cross-copy-forged";
      divergentDurable.item_path = ".agents/pm/tasks/pm-cross-copy-forged.toon";
      divergentDurable.state = "reconciled";
      divergentDurable.reconciled_at = "2026-08-24T00:00:00.000Z";
      await fs.writeFile(
        durablePath,
        `${JSON.stringify(divergentDurable, null, 2)}\n`,
        "utf8",
      );
      const historyPath = path.join(
        context.tempRoot,
        ".agents",
        "pm",
        "history",
        "pm-cross-copy.jsonl",
      );
      const historyBefore = await fs.readFile(historyPath, "utf8");

      const reconcile = context.runCli(["merge", "reconcile", "--json"], {
        cwd: context.tempRoot,
        expectJson: true,
      });

      expect(reconcile.code).toBe(4);
      expect(`${reconcile.stdout}\n${reconcile.stderr}`).toContain(
        "merge_receipt_evidence_invalid",
      );
      expect(await fs.readFile(historyPath, "utf8")).toBe(historyBefore);
      expect(
        context.runCli(["health", "--check-only", "--full", "--json"], {
          cwd: context.tempRoot,
          expectJson: true,
        }).json,
      ).toMatchObject({
        ok: false,
        warnings: expect.arrayContaining(["merge_receipt_evidence_invalid:1"]),
      });

      const receiptDirectory = execFileSync(
        "git",
        [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "pm-merge-receipts",
        ],
        { cwd: context.tempRoot, encoding: "utf8" },
      ).trim();
      const localPath = path.join(receiptDirectory, `${receipt?.id}.json`);
      const reconciledLocal = JSON.parse(
        await fs.readFile(localPath, "utf8"),
      ) as Record<string, unknown>;
      reconciledLocal.state = "reconciled";
      reconciledLocal.reconciled_at = "2026-08-24T00:01:00.000Z";
      await fs.writeFile(
        localPath,
        `${JSON.stringify(reconciledLocal, null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(
        durablePath,
        `${JSON.stringify(durableBefore, null, 2)}\n`,
        "utf8",
      );
      expect(
        await listMergeReceipts(context.tempRoot, {
          pmRoot: path.join(context.tempRoot, ".agents", "pm"),
        }),
      ).toMatchObject([{ id: receipt?.id, state: "pending" }]);

      expect(
        context.runCli(["merge", "reconcile", "--json"], {
          cwd: context.tempRoot,
        }).code,
      ).toBe(0);
      expect(JSON.parse(await fs.readFile(durablePath, "utf8"))).toMatchObject({
        id: receipt?.id,
        state: "reconciled",
      });
    });
  });

  it("keeps lossless receipt settlement distinct from lossy review", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "--quiet"], { cwd: context.tempRoot });
      expect(
        context.runCli(["merge", "install", "--json"], {
          cwd: context.tempRoot,
        }).code,
      ).toBe(0);
      expect(
        context.runCli(
          [
            "create",
            "--json",
            "--id",
            "pm-merge-lossless",
            "--title",
            "Lossless merge receipt",
            "--description",
            "Exercise pending receipt health classification",
            "--type",
            "Task",
          ],
          { cwd: context.tempRoot },
        ).code,
      ).toBe(0);

      const mergedItemPath = await rewriteItemTitle({
        root: context.tempRoot,
        id: "pm-merge-lossless",
        from: "Lossless merge receipt",
        to: "Merged lossless receipt",
      });
      const losslessReceipt = await writeMergeReceipt({
        cwd: context.tempRoot,
        itemPath: path
          .relative(context.tempRoot, mergedItemPath)
          .replaceAll(path.sep, "/"),
        preferred: "ours",
        fieldsFromTheirs: ["title"],
        unionFields: [],
        mergedFieldHashes: {
          title: sha256Hex(stableStringify("Merged lossless receipt")),
        },
        decisions: [],
      });
      expect(losslessReceipt).not.toBeNull();
      const nonGitRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "pm-receipt-strict-settlement-"),
      );
      await expect(
        markMergeReceiptReconciled(
          nonGitRoot,
          losslessReceipt as NonNullable<typeof losslessReceipt>,
          { requireExisting: true },
        ),
      ).rejects.toThrow(/disappeared before settlement/);
      await fs.rm(nonGitRoot, { recursive: true, force: true });
      const losslessDurablePath = path.join(
        context.tempRoot,
        ".agents",
        "pm",
        "merge-receipts",
        `${losslessReceipt?.id}.json`,
      );
      const losslessDurableBefore = await fs.readFile(
        losslessDurablePath,
        "utf8",
      );
      await fs.writeFile(losslessDurablePath, "{malformed", "utf8");
      await expect(
        markMergeReceiptReconciled(
          context.tempRoot,
          losslessReceipt as NonNullable<typeof losslessReceipt>,
        ),
      ).rejects.toThrow(/settlement source is not valid JSON/);
      const gitDirectory = execFileSync("git", ["rev-parse", "--git-dir"], {
        cwd: context.tempRoot,
        encoding: "utf8",
      }).trim();
      expect(
        JSON.parse(
          await fs.readFile(
            path.resolve(
              context.tempRoot,
              gitDirectory,
              "pm-merge-receipts",
              `${losslessReceipt?.id}.json`,
            ),
            "utf8",
          ),
        ),
      ).toMatchObject({ state: "pending" });
      await fs.writeFile(losslessDurablePath, losslessDurableBefore, "utf8");
      const mismatchedDurable = JSON.parse(losslessDurableBefore) as Record<
        string,
        unknown
      >;
      mismatchedDurable.item_id = "pm-different-item";
      mismatchedDurable.item_path = ".agents/pm/tasks/pm-different-item.toon";
      await fs.writeFile(
        losslessDurablePath,
        `${JSON.stringify(mismatchedDurable)}\n`,
        "utf8",
      );
      await expect(
        markMergeReceiptReconciled(
          context.tempRoot,
          losslessReceipt as NonNullable<typeof losslessReceipt>,
        ),
      ).rejects.toThrow(/copies disagree on immutable merge provenance/);
      expect(
        JSON.parse(
          await fs.readFile(
            path.resolve(
              context.tempRoot,
              gitDirectory,
              "pm-merge-receipts",
              `${losslessReceipt?.id}.json`,
            ),
            "utf8",
          ),
        ),
      ).toMatchObject({ state: "pending" });
      await fs.writeFile(losslessDurablePath, losslessDurableBefore, "utf8");
      const timestampMismatchedDurable = JSON.parse(
        losslessDurableBefore,
      ) as Record<string, unknown>;
      timestampMismatchedDurable.created_at = "2026-08-24T00:00:01.000Z";
      await fs.writeFile(
        losslessDurablePath,
        `${JSON.stringify(timestampMismatchedDurable)}\n`,
        "utf8",
      );
      await expect(
        markMergeReceiptReconciled(
          context.tempRoot,
          losslessReceipt as NonNullable<typeof losslessReceipt>,
        ),
      ).rejects.toThrow(/copies disagree on immutable merge provenance/);
      await fs.writeFile(losslessDurablePath, losslessDurableBefore, "utf8");

      const losslessLocalPath = path.resolve(
        context.tempRoot,
        gitDirectory,
        "pm-merge-receipts",
        `${losslessReceipt?.id}.json`,
      );
      const losslessLocalBefore = await fs.readFile(losslessLocalPath, "utf8");
      const replacedLocal = JSON.parse(losslessLocalBefore) as Record<
        string,
        unknown
      >;
      const replacedDurable = JSON.parse(losslessDurableBefore) as Record<
        string,
        unknown
      >;
      for (const replacement of [replacedLocal, replacedDurable]) {
        replacement.item_id = "pm-replaced-item";
        replacement.item_path = ".agents/pm/tasks/pm-replaced-item.toon";
      }
      await Promise.all([
        fs.writeFile(
          losslessLocalPath,
          `${JSON.stringify(replacedLocal)}\n`,
          "utf8",
        ),
        fs.writeFile(
          losslessDurablePath,
          `${JSON.stringify(replacedDurable)}\n`,
          "utf8",
        ),
      ]);
      await expect(
        markMergeReceiptReconciled(
          context.tempRoot,
          losslessReceipt as NonNullable<typeof losslessReceipt>,
        ),
      ).rejects.toThrow(/copies disagree on immutable merge provenance/);
      expect(
        JSON.parse(await fs.readFile(losslessLocalPath, "utf8")),
      ).toMatchObject({ state: "pending" });
      await Promise.all([
        fs.writeFile(losslessLocalPath, losslessLocalBefore, "utf8"),
        fs.writeFile(losslessDurablePath, losslessDurableBefore, "utf8"),
      ]);
      await Promise.all([
        fs.rm(losslessLocalPath, { force: true }),
        fs.rm(losslessDurablePath, { force: true }),
      ]);
      await expect(
        markMergeReceiptReconciled(
          context.tempRoot,
          losslessReceipt as NonNullable<typeof losslessReceipt>,
          { requireExisting: true },
        ),
      ).rejects.toThrow(/disappeared before settlement/);
      await Promise.all([
        fs.writeFile(losslessLocalPath, losslessLocalBefore, "utf8"),
        fs.writeFile(losslessDurablePath, losslessDurableBefore, "utf8"),
      ]);
      const invalidDurableSchema = JSON.parse(losslessDurableBefore) as Record<
        string,
        unknown
      >;
      invalidDurableSchema.extra = "rejected";
      await fs.writeFile(
        losslessDurablePath,
        `${JSON.stringify(invalidDurableSchema)}\n`,
        "utf8",
      );
      await expect(
        markMergeReceiptReconciled(
          context.tempRoot,
          losslessReceipt as NonNullable<typeof losslessReceipt>,
        ),
      ).rejects.toThrow(/failed schema or identity validation/);
      await fs.writeFile(losslessDurablePath, losslessDurableBefore, "utf8");
      await fs.rm(losslessLocalPath, { force: true });
      await fs.mkdir(losslessLocalPath);
      await expect(
        markMergeReceiptReconciled(
          context.tempRoot,
          losslessReceipt as NonNullable<typeof losslessReceipt>,
        ),
      ).rejects.toThrow(/not a bounded regular file/);
      await fs.rm(losslessLocalPath, { recursive: true, force: true });
      await fs.writeFile(losslessLocalPath, losslessLocalBefore, "utf8");
      await expect(
        markMergeReceiptReconciled(context.tempRoot, {
          ...(losslessReceipt as NonNullable<typeof losslessReceipt>),
          item_path: "../pm-merge-lossless.toon",
        }),
      ).rejects.toThrow(/trusted settlement input failed schema validation/);

      expect(
        context.runCli(
          [
            "create",
            "--json",
            "--id",
            "pm-unrelated-drift",
            "--title",
            "Unrelated drift",
            "--description",
            "Prove receipt precedence is per finding",
            "--type",
            "Task",
          ],
          { cwd: context.tempRoot },
        ).code,
      ).toBe(0);
      const unrelatedItemPath = await rewriteItemTitle({
        root: context.tempRoot,
        id: "pm-unrelated-drift",
        from: "Unrelated drift",
        to: "Changed unrelated drift",
      });

      const health = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(health.code).toBe(0);
      const healthResult = health.json as DiagnosticEnvelope;
      expect(healthResult.ok).toBe(false);
      expect(healthResult.warnings).toContain("merge_receipts_pending:1");
      expect(healthResult.warnings).toContain(
        "history_drift_merge_receipt:pm-merge-lossless",
      );
      expect(healthResult.warnings).toContain(
        "history_drift_hash_mismatch:pm-unrelated-drift",
      );
      expect(checkDetails(healthResult, "integrity").counts).toMatchObject({
        pending_merge_decisions: 0,
        lossless_merge_receipts: 1,
      });
      expect(checkDetails(healthResult, "history_drift")).toMatchObject({
        merge_receipt_attributed_items: ["pm-merge-lossless"],
        remediation_map: {
          history_drift_merge_receipt: "pm merge reconcile",
          history_drift_hash_mismatch: "pm history-repair --all",
        },
      });
      expect(
        checkDetails(healthResult, "integrity").remediation_map,
      ).toMatchObject({
        merge_receipts_pending: "pm merge reconcile",
      });
      const sdkHealth = await runHealth(
        { path: path.join(context.tempRoot, ".agents", "pm") },
        { full: true },
      );
      expect(sdkHealth.warnings).toEqual(
        expect.arrayContaining([
          "history_drift_merge_receipt:pm-merge-lossless",
          "history_drift_hash_mismatch:pm-unrelated-drift",
        ]),
      );
      const unrelatedReceipt = await writeMergeReceipt({
        cwd: context.tempRoot,
        itemPath: path
          .relative(context.tempRoot, unrelatedItemPath)
          .replaceAll(path.sep, "/"),
        preferred: "ours",
        fieldsFromTheirs: ["title"],
        unionFields: [],
        mergedFieldHashes: {
          title: sha256Hex(stableStringify("Changed unrelated drift")),
        },
        decisions: [],
      });
      expect(unrelatedReceipt).not.toBeNull();
      const twoReceiptHealth = await runHealth(
        { path: path.join(context.tempRoot, ".agents", "pm") },
        { full: true },
      );
      expect(twoReceiptHealth.warnings).toEqual(
        expect.arrayContaining([
          "history_drift_merge_receipt:pm-merge-lossless",
          "history_drift_merge_receipt:pm-unrelated-drift",
        ]),
      );
      await removeReceiptCopies(
        context.tempRoot,
        unrelatedReceipt?.id as string,
      );
      const sdkGlobal = {
        path: path.join(context.tempRoot, ".agents", "pm"),
      };
      const cloneLocalReceipt = {
        ...(losslessReceipt as NonNullable<typeof losslessReceipt>),
        evidence_source: "clone_local" as const,
      };
      const proofResult = async (
        receipt: NonNullable<typeof losslessReceipt>,
        gitWorkspaceRoot: string | null = context.tempRoot,
      ) =>
        runHistoryRepair(
          "pm-merge-lossless",
          {
            dryRun: true,
            mergeReceiptProof: { gitWorkspaceRoot, receipts: [receipt] },
          },
          sdkGlobal,
        );
      const proveAuthoritativeDurableVariant = async (
        overrides: Partial<NonNullable<typeof losslessReceipt>>,
      ) => {
        const receipt = {
          ...(losslessReceipt as NonNullable<typeof losslessReceipt>),
          id: randomUUID(),
          value_availability: "hash_only" as const,
          ...overrides,
          evidence_source: "durable" as const,
        };
        const { evidence_source: _evidenceSource, ...persistedReceipt } =
          receipt;
        await fs.writeFile(
          path.join(sdkGlobal.path, "merge-receipts", `${receipt.id}.json`),
          `${JSON.stringify(persistedReceipt, null, 2)}\n`,
          "utf8",
        );
        try {
          return await proofResult(receipt);
        } finally {
          await removeReceiptCopies(context.tempRoot, receipt.id);
        }
      };
      await expect(proofResult(cloneLocalReceipt, null)).resolves.toMatchObject(
        {
          merge_receipt_proof: { reason: "git_workspace_unavailable" },
        },
      );
      await expect(
        runHistoryRepair(
          "pm-merge-lossless",
          {
            dryRun: true,
            mergeReceiptProof: {
              gitWorkspaceRoot: context.tempRoot,
              receipts: [],
            },
          },
          sdkGlobal,
        ),
      ).resolves.toMatchObject({
        merge_receipt_proof: { reason: "no_item_receipts" },
      });
      for (const callerModifiedReceipt of [
        { ...cloneLocalReceipt, evidence_source: undefined },
        {
          ...cloneLocalReceipt,
          item_path: ".agents/pm/tasks/pm-missing.toon",
        },
        { ...cloneLocalReceipt, merged_field_hashes: undefined },
        {
          ...cloneLocalReceipt,
          merged_field_hashes: {
            title: "0".repeat(64),
          },
        },
        {
          ...cloneLocalReceipt,
          fields_from_theirs: [],
          decisions: [
            {
              field: "description",
              base: null,
              ours: "Merged lossless receipt",
              theirs: "Merged lossless receipt",
              retained: "Merged lossless receipt",
              discarded: "Merged lossless receipt",
            },
          ],
        },
      ]) {
        await expect(
          proofResult(
            callerModifiedReceipt as NonNullable<typeof losslessReceipt>,
          ),
        ).resolves.toMatchObject({
          merge_receipt_proof: {
            trusted: true,
            reason: "trusted_merge_driver_hash_evidence",
          },
        });
      }
      const currentItem = parseItemDocument(
        await fs.readFile(mergedItemPath, "utf8"),
        { format: "toon" },
      );
      await Promise.all(
        [
          { item_path: ".agents/pm/missing/pm-merge-lossless.toon" },
          { merged_field_hashes: undefined },
          {
            fields_from_theirs: [],
            union_fields: [],
            decisions: [],
          },
          { merged_field_hashes: { unexpected: "0".repeat(64) } },
          { merged_field_hashes: { title: "0".repeat(64) } },
        ].map(async (overrides) => {
          await expect(
            proveAuthoritativeDurableVariant(overrides),
          ).resolves.toMatchObject({
            merge_receipt_proof: {
              trusted: false,
              reason: "no_receipt_set_proves_snapshot",
            },
          });
        }),
      );
      await expect(
        proveAuthoritativeDurableVariant({
          fields_from_theirs: ["body"],
          merged_field_hashes: {
            body: sha256Hex(stableStringify(currentItem.body)),
          },
        }),
      ).resolves.toMatchObject({
        merge_receipt_proof: {
          trusted: false,
          reason: "no_receipt_set_proves_snapshot",
        },
      });
      await expect(
        proofResult({
          ...cloneLocalReceipt,
          fields_from_theirs: ["body"],
          merged_field_hashes: {
            body: sha256Hex(stableStringify(currentItem.body)),
          },
        }),
      ).resolves.toMatchObject({
        merge_receipt_proof: {
          trusted: true,
          reason: "trusted_merge_driver_hash_evidence",
        },
      });
      await expect(
        proofResult({
          ...cloneLocalReceipt,
          fields_from_theirs: ["title", "body"],
          merged_field_hashes: {
            title: sha256Hex(stableStringify("Merged lossless receipt")),
            body: sha256Hex(stableStringify(currentItem.body)),
          },
        }),
      ).resolves.toMatchObject({
        merge_receipt_proof: { trusted: true },
      });
      await expect(
        proofResult({
          ...cloneLocalReceipt,
          merged_field_hashes: { title: "0".repeat(64) },
        }),
      ).resolves.toMatchObject({
        merge_receipt_proof: {
          trusted: true,
          reason: "trusted_merge_driver_hash_evidence",
        },
      });
      await expect(proofResult(cloneLocalReceipt)).resolves.toMatchObject({
        merge_receipt_proof: {
          trusted: true,
          reason: "trusted_merge_driver_hash_evidence",
        },
      });
      await expect(
        proofResult({
          ...cloneLocalReceipt,
          evidence_source: "durable",
          value_availability: "hash_only",
        }),
      ).resolves.toMatchObject({
        merge_receipt_proof: {
          trusted: true,
          reason: "trusted_merge_driver_hash_evidence",
        },
      });
      await expect(
        runHistoryRepairAll(
          {
            dryRun: true,
            mergeReceiptProofById: {
              "pm-merge-lossless": {
                gitWorkspaceRoot: context.tempRoot,
                receipts: [cloneLocalReceipt],
              },
            },
          },
          sdkGlobal,
        ),
      ).resolves.toMatchObject({
        streams: expect.arrayContaining([
          expect.objectContaining({
            id: "pm-merge-lossless",
            merge_receipt_proof: {
              trusted: true,
              reason: "trusted_merge_driver_hash_evidence",
              receipt_ids: [losslessReceipt?.id],
            },
          }),
        ]),
      });

      expect(
        context.runCli(
          [
            "create",
            "--json",
            "--id",
            "pm-field-forgery",
            "--title",
            "Field forgery",
            "--description",
            "Reject hashes outside the receipt declared field set",
            "--type",
            "Task",
          ],
          { cwd: context.tempRoot },
        ).code,
      ).toBe(0);
      const forgedItemPath = await rewriteItemTitle({
        root: context.tempRoot,
        id: "pm-field-forgery",
        from: "Field forgery",
        to: "Changed field forgery",
      });
      const fieldForgery = await writeMergeReceipt({
        cwd: context.tempRoot,
        itemPath: path
          .relative(context.tempRoot, forgedItemPath)
          .replaceAll(path.sep, "/"),
        preferred: "ours",
        fieldsFromTheirs: ["status"],
        unionFields: [],
        mergedFieldHashes: {
          title: sha256Hex(stableStringify("Changed field forgery")),
        },
        decisions: [],
      });
      expect(fieldForgery).not.toBeNull();
      const forgedHealth = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(
        checkDetails(forgedHealth.json as DiagnosticEnvelope, "history_drift")
          .merge_receipt_attributed_items,
      ).not.toContain("pm-field-forgery");
      expect((forgedHealth.json as DiagnosticEnvelope).warnings).toContain(
        "history_drift_hash_mismatch:pm-field-forgery",
      );
      expect(
        (
          await runHealth(
            { path: path.join(context.tempRoot, ".agents", "pm") },
            { full: true },
          )
        ).warnings,
      ).toContain("history_drift_hash_mismatch:pm-field-forgery");
      const forgedHistoryPath = path.join(
        context.tempRoot,
        ".agents",
        "pm",
        "history",
        "pm-field-forgery.jsonl",
      );
      const forgedHistoryBefore = await fs.readFile(forgedHistoryPath, "utf8");
      const forgedHistoryEntries = forgedHistoryBefore
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      forgedHistoryEntries[0] = {
        ...forgedHistoryEntries[0],
        after_hash: "0".repeat(64),
      };
      await fs.writeFile(
        forgedHistoryPath,
        `${forgedHistoryEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8",
      );
      expect(
        (
          await runHealth(
            { path: path.join(context.tempRoot, ".agents", "pm") },
            { full: true },
          )
        ).warnings,
      ).not.toContain("history_drift_merge_receipt:pm-field-forgery");
      await fs.writeFile(forgedHistoryPath, forgedHistoryBefore, "utf8");
      await removeReceiptCopies(context.tempRoot, fieldForgery?.id as string);
      expect(
        context.runCli(["history-repair", "pm-field-forgery", "--json"], {
          cwd: context.tempRoot,
        }).code,
      ).toBe(0);

      expect(
        context.runCli(
          [
            "create",
            "--json",
            "--id",
            "pm-subset-forgery",
            "--title",
            "Subset forgery",
            "--description",
            "Reject a receipt whose non-reconciled declared field hash is false",
            "--type",
            "Task",
          ],
          { cwd: context.tempRoot },
        ).code,
      ).toBe(0);
      const subsetForgeryPath = await rewriteItemTitle({
        root: context.tempRoot,
        id: "pm-subset-forgery",
        from: "Subset forgery",
        to: "Changed subset forgery",
      });
      const subsetForgery = await writeMergeReceipt({
        cwd: context.tempRoot,
        itemPath: path
          .relative(context.tempRoot, subsetForgeryPath)
          .replaceAll(path.sep, "/"),
        preferred: "ours",
        fieldsFromTheirs: ["description", "title"],
        unionFields: [],
        mergedFieldHashes: {
          description: sha256Hex(stableStringify("forged description")),
          title: sha256Hex(stableStringify("Changed subset forgery")),
        },
        decisions: [],
      });
      expect(subsetForgery).not.toBeNull();
      const subsetForgeryHealth = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(
        checkDetails(
          subsetForgeryHealth.json as DiagnosticEnvelope,
          "history_drift",
        ).merge_receipt_attributed_items,
      ).not.toContain("pm-subset-forgery");
      expect(
        (subsetForgeryHealth.json as DiagnosticEnvelope).warnings,
      ).toContain("history_drift_hash_mismatch:pm-subset-forgery");
      await removeReceiptCopies(context.tempRoot, subsetForgery?.id as string);
      expect(
        context.runCli(["history-repair", "pm-subset-forgery", "--json"], {
          cwd: context.tempRoot,
        }).code,
      ).toBe(0);

      expect(
        context.runCli(
          [
            "create",
            "--json",
            "--id",
            "pm-durable-forgery",
            "--title",
            "Durable forgery",
            "--description",
            "Reject committed durable-only receipt evidence",
            "--type",
            "Task",
          ],
          { cwd: context.tempRoot },
        ).code,
      ).toBe(0);
      const durableItemPath = await rewriteItemTitle({
        root: context.tempRoot,
        id: "pm-durable-forgery",
        from: "Durable forgery",
        to: "Changed durable forgery",
      });
      const durableDirectory = path.join(
        context.tempRoot,
        ".agents",
        "pm",
        "merge-receipts",
      );
      await fs.mkdir(durableDirectory, { recursive: true });
      const durableForgeryPath = path.join(
        durableDirectory,
        "forged-durable.json",
      );
      await fs.writeFile(
        durableForgeryPath,
        `${JSON.stringify({
          version: 1,
          id: "forged-durable",
          item_path: path
            .relative(context.tempRoot, durableItemPath)
            .replaceAll(path.sep, "/"),
          item_id: "pm-durable-forgery",
          requested_preference: "ours",
          conflict_resolution: "stable_value_order",
          fields_from_theirs: ["title"],
          union_fields: [],
          merged_field_hashes: {
            title: sha256Hex(stableStringify("Changed durable forgery")),
          },
          decisions: [],
          state: "pending",
          created_at: "2026-08-24T00:00:00.000Z",
          value_availability: "hash_only",
          evidence_source: "clone_local",
        })}\n`,
        "utf8",
      );
      const durableForgeryHealth = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(
        checkDetails(
          durableForgeryHealth.json as DiagnosticEnvelope,
          "history_drift",
        ).merge_receipt_attributed_items,
      ).not.toContain("pm-durable-forgery");
      expect(
        (
          await runHealth(
            { path: path.join(context.tempRoot, ".agents", "pm") },
            { full: true },
          )
        ).warnings,
      ).toContain("history_drift_hash_mismatch:pm-durable-forgery");
      await fs.rm(durableForgeryPath, { force: true });
      expect(
        context.runCli(["history-repair", "pm-durable-forgery", "--json"], {
          cwd: context.tempRoot,
        }).code,
      ).toBe(0);

      const validation = context.runCli(
        ["validate", "--check-storage-integrity", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(validation.code).toBe(0);
      expect(
        checkDetails(
          validation.json as DiagnosticEnvelope,
          "storage_integrity",
        ),
      ).toMatchObject({
        pending_merge_decision_count: 0,
        lossless_merge_receipt_count: 1,
      });

      await rewriteItemTitle({
        root: context.tempRoot,
        id: "pm-merge-lossless",
        from: "Merged lossless receipt",
        to: "Tampered lossless receipt",
      });
      const tamperedReceiptHealth = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(
        checkDetails(
          tamperedReceiptHealth.json as DiagnosticEnvelope,
          "history_drift",
        ),
      ).toMatchObject({
        merge_receipt_attributed_items: [],
        remediation_map: {
          history_drift_hash_mismatch: "pm history-repair --all",
        },
      });
      expect(
        (tamperedReceiptHealth.json as DiagnosticEnvelope).warnings,
      ).not.toContain("history_drift_merge_receipt:pm-merge-lossless");
      const rejectedReconcile = context.runCli(
        ["merge", "reconcile", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(rejectedReconcile.code).not.toBe(0);
      expect(
        (rejectedReconcile.json as { repair: { totals: { failed: number } } })
          .repair.totals.failed,
      ).toBeGreaterThan(0);
      expect(
        context.runCli(["health", "--check-only", "--full", "--json"], {
          cwd: context.tempRoot,
          expectJson: true,
        }).json,
      ).toMatchObject({
        warnings: expect.arrayContaining(["merge_receipts_pending:1"]),
      });
      await rewriteItemTitle({
        root: context.tempRoot,
        id: "pm-merge-lossless",
        from: "Tampered lossless receipt",
        to: "Merged lossless receipt",
      });

      expect(
        context.runCli(["history-repair", "pm-merge-lossless", "--json"], {
          cwd: context.tempRoot,
        }).code,
      ).toBe(0);
      const healthAfterHistoryRepair = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(
        (healthAfterHistoryRepair.json as DiagnosticEnvelope).warnings,
      ).toContain("merge_receipts_pending:1");
      expect(
        checkDetails(
          healthAfterHistoryRepair.json as DiagnosticEnvelope,
          "history_drift",
        ).merge_receipt_attributed_items,
      ).toEqual([]);

      expect(
        context.runCli(["history-repair", "pm-unrelated-drift", "--json"], {
          cwd: context.tempRoot,
        }).code,
      ).toBe(0);

      const forgedSiblingPath = path.join(
        durableDirectory,
        "forged-sibling.json",
      );
      await fs.writeFile(
        forgedSiblingPath,
        `${JSON.stringify({
          version: 1,
          id: "forged-sibling",
          item_path: path
            .relative(context.tempRoot, mergedItemPath)
            .replaceAll(path.sep, "/"),
          item_id: "pm-merge-lossless",
          requested_preference: "ours",
          conflict_resolution: "stable_value_order",
          fields_from_theirs: ["title"],
          union_fields: [],
          merged_field_hashes: {
            title: sha256Hex(stableStringify("Merged lossless receipt")),
          },
          decisions: [],
          state: "pending",
          created_at: "2026-08-24T00:00:00.000Z",
          value_availability: "hash_only",
          evidence_source: "clone_local",
        })}\n`,
        "utf8",
      );
      const forgedPrototypePath = path.join(
        durableDirectory,
        "forged-prototype.json",
      );
      await fs.writeFile(
        forgedPrototypePath,
        `${JSON.stringify({
          version: 1,
          id: "forged-prototype",
          item_path: ".agents/pm/tasks/pm-merge-lossless.toon",
          item_id: "__proto__",
          requested_preference: "ours",
          conflict_resolution: "stable_value_order",
          fields_from_theirs: ["title"],
          union_fields: [],
          merged_field_hashes: {
            title: sha256Hex(stableStringify("Merged lossless receipt")),
          },
          decisions: [],
          state: "pending",
          created_at: "2026-08-24T00:00:00.000Z",
          value_availability: "hash_only",
        })}\n`,
        "utf8",
      );
      const malformedMissingDecisionsPath = path.join(
        durableDirectory,
        "malformed-missing-decisions.json",
      );
      await fs.writeFile(
        malformedMissingDecisionsPath,
        `${JSON.stringify({
          version: 1,
          id: "malformed-missing-decisions",
          item_path: ".agents/pm/tasks/pm-merge-lossless.toon",
          item_id: "pm-merge-lossless",
          conflict_resolution: "stable_value_order",
          fields_from_theirs: ["title"],
          union_fields: [],
          state: "pending",
          created_at: "2026-08-24T00:00:00.000Z",
        })}\n`,
        "utf8",
      );
      const malformedTimestampPath = path.join(
        durableDirectory,
        "malformed-timestamp.json",
      );
      await fs.writeFile(
        malformedTimestampPath,
        `${JSON.stringify({
          version: 1,
          id: "malformed-timestamp",
          item_path: ".agents/pm/tasks/pm-merge-lossless.toon",
          item_id: "pm-merge-lossless",
          conflict_resolution: "stable_value_order",
          fields_from_theirs: ["title"],
          union_fields: [],
          decisions: [],
          state: "pending",
          created_at: 42,
        })}\n`,
        "utf8",
      );
      let deeplyNestedValue: unknown = "leaf";
      for (let depth = 0; depth < 80; depth += 1) {
        deeplyNestedValue = [deeplyNestedValue];
      }
      const malformedDeepDecisionPath = path.join(
        durableDirectory,
        "malformed-deep-decision.json",
      );
      await fs.writeFile(
        malformedDeepDecisionPath,
        `${JSON.stringify({
          version: 1,
          id: "malformed-deep-decision",
          item_path: ".agents/pm/tasks/pm-merge-lossless.toon",
          item_id: "pm-merge-lossless",
          conflict_resolution: "stable_value_order",
          fields_from_theirs: [],
          union_fields: [],
          decisions: [
            {
              field: "title",
              base: null,
              ours: null,
              theirs: null,
              retained: deeplyNestedValue,
              discarded: { pm_value_hash: "0".repeat(64) },
            },
          ],
          state: "pending",
          created_at: "2026-08-24T00:00:00.000Z",
        })}\n`,
        "utf8",
      );
      const oversizedReceiptPath = path.join(
        durableDirectory,
        "oversized-receipt.json",
      );
      await fs.writeFile(oversizedReceiptPath, "", "utf8");
      await fs.truncate(oversizedReceiptPath, 16 * 1024 * 1024 + 1);
      const aliasedReceiptPath = path.join(
        durableDirectory,
        "aliased-receipt.json",
      );
      await fs.writeFile(
        aliasedReceiptPath,
        `${JSON.stringify({
          version: 1,
          id: "different-receipt-id",
          item_path: ".agents/pm/tasks/pm-merge-lossless.toon",
          item_id: "pm-merge-lossless",
          conflict_resolution: "stable_value_order",
          fields_from_theirs: ["title"],
          union_fields: [],
          decisions: [],
          state: "pending",
          created_at: "2026-08-24T00:00:00.000Z",
          value_availability: "hash_only",
        })}\n`,
        "utf8",
      );
      const malformedCleartextDurablePath = path.join(
        durableDirectory,
        "malformed-cleartext-durable.json",
      );
      await fs.writeFile(
        malformedCleartextDurablePath,
        `${JSON.stringify({
          version: 1,
          id: "malformed-cleartext-durable",
          item_path: ".agents/pm/tasks/pm-merge-lossless.toon",
          item_id: "pm-merge-lossless",
          conflict_resolution: "stable_value_order",
          fields_from_theirs: [],
          union_fields: [],
          decisions: [
            {
              field: "title",
              base: "secret-base",
              ours: "secret-ours",
              theirs: null,
              retained: {
                pm_value_hash: "0".repeat(64),
                cleartext: "secret-retained",
              },
              discarded: { pm_value_hash: "1".repeat(64) },
            },
          ],
          state: "pending",
          created_at: "2026-08-24T00:00:00.000Z",
          value_availability: "hash_only",
        })}\n`,
        "utf8",
      );
      const malformedUnknownPropertyPath = path.join(
        durableDirectory,
        "malformed-unknown-property.json",
      );
      await fs.writeFile(
        malformedUnknownPropertyPath,
        `${JSON.stringify({
          version: 1,
          id: "malformed-unknown-property",
          item_path: ".agents/pm/tasks/pm-merge-lossless.toon",
          item_id: "pm-merge-lossless",
          conflict_resolution: "stable_value_order",
          fields_from_theirs: [],
          union_fields: [],
          decisions: [
            {
              field: "title",
              base: null,
              ours: null,
              theirs: null,
              retained: { pm_value_hash: "0".repeat(64) },
              discarded: { pm_value_hash: "1".repeat(64) },
              extra: { cleartext: "secret-decision-extra" },
            },
          ],
          state: "pending",
          created_at: "2026-08-24T00:00:00.000Z",
          value_availability: "hash_only",
          extra: { cleartext: "secret-receipt-extra" },
        })}\n`,
        "utf8",
      );
      const malformedHashesPath = path.join(
        durableDirectory,
        "malformed-hashes.json",
      );
      const malformedPathPath = path.join(
        durableDirectory,
        "malformed-path.json",
      );
      const malformedReceipt = (params: {
        id: string;
        itemPath: string;
        mergedFieldHashes: unknown;
      }) =>
        `${JSON.stringify({
          version: 1,
          id: params.id,
          item_path: params.itemPath,
          item_id: "pm-merge-lossless",
          conflict_resolution: "stable_value_order",
          fields_from_theirs: [],
          union_fields: [],
          merged_field_hashes: params.mergedFieldHashes,
          decisions: [],
          state: "pending",
          created_at: "2026-08-24T00:00:00.000Z",
          value_availability: "hash_only",
        })}\n`;
      await Promise.all([
        fs.writeFile(
          malformedHashesPath,
          malformedReceipt({
            id: "malformed-hashes",
            itemPath: ".agents/pm/tasks/pm-merge-lossless.toon",
            mergedFieldHashes: [],
          }),
          "utf8",
        ),
        fs.writeFile(
          malformedPathPath,
          malformedReceipt({
            id: "malformed-path",
            itemPath: "/tmp/pm-merge-lossless.toon",
            mergedFieldHashes: {},
          }),
          "utf8",
        ),
      ]);
      const symlinkReceiptPath = path.join(
        durableDirectory,
        "symlink-receipt.json",
      );
      if (process.platform !== "win32") {
        await fs.symlink(forgedSiblingPath, symlinkReceiptPath);
      }
      const boundedReceipts = await listMergeReceipts(context.tempRoot, {
        includeLossless: true,
        pmRoot: path.join(context.tempRoot, ".agents", "pm"),
      });
      expect(boundedReceipts.map((receipt) => receipt.id)).not.toEqual(
        expect.arrayContaining([
          "different-receipt-id",
          "malformed-cleartext-durable",
          "malformed-deep-decision",
          "malformed-missing-decisions",
          "malformed-hashes",
          "malformed-path",
          "malformed-timestamp",
          "malformed-unknown-property",
        ]),
      );

      const reconciled = context.runCli(["merge", "reconcile", "--json"], {
        cwd: context.tempRoot,
        expectJson: true,
      });
      expect(reconciled.code).not.toBe(0);
      expect(`${reconciled.stdout}\n${reconciled.stderr}`).toContain(
        "merge_receipt_evidence_invalid",
      );
      expect(
        JSON.parse(await fs.readFile(forgedSiblingPath, "utf8")),
      ).toMatchObject({ state: "pending" });
      await Promise.all([
        fs.rm(forgedSiblingPath, { force: true }),
        fs.rm(forgedPrototypePath, { force: true }),
        fs.rm(malformedMissingDecisionsPath, { force: true }),
        fs.rm(malformedTimestampPath, { force: true }),
        fs.rm(malformedDeepDecisionPath, { force: true }),
        fs.rm(oversizedReceiptPath, { force: true }),
        fs.rm(aliasedReceiptPath, { force: true }),
        fs.rm(malformedCleartextDurablePath, { force: true }),
        fs.rm(malformedUnknownPropertyPath, { force: true }),
        fs.rm(malformedHashesPath, { force: true }),
        fs.rm(malformedPathPath, { force: true }),
        fs.rm(symlinkReceiptPath, { force: true }),
      ]);
      const validAfterCleanup = await listMergeReceipts(context.tempRoot, {
        includeLossless: true,
        pmRoot: path.join(context.tempRoot, ".agents", "pm"),
      });
      const cleanReconcile = context.runCli(["merge", "reconcile", "--json"], {
        cwd: context.tempRoot,
        expectJson: true,
      });
      expect(cleanReconcile.code).toBe(0);
      expect(cleanReconcile.json).toMatchObject({
        ok: true,
        receipts: {
          pending_before: validAfterCleanup.length,
          reconciled: validAfterCleanup.length,
        },
      });
      const historyEntries = (
        await fs.readFile(
          path.join(
            context.tempRoot,
            ".agents",
            "pm",
            "history",
            "pm-merge-lossless.jsonl",
          ),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const reconcileAudit = JSON.stringify(historyEntries.at(-1));
      expect(reconcileAudit).toContain(losslessReceipt?.id as string);
      expect(reconcileAudit).not.toContain("forged-sibling");
      const healthAfterReconcile = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(
        (healthAfterReconcile.json as DiagnosticEnvelope).warnings,
      ).not.toContain("merge_receipts_pending:1");

      expect(
        context.runCli(
          [
            "create",
            "--json",
            "--id",
            "pm-constructor",
            "--title",
            "Normalized alias target",
            "--description",
            "Reject receipt ids that normalize to a different subject",
            "--type",
            "Task",
          ],
          { cwd: context.tempRoot },
        ).code,
      ).toBe(0);
      const normalizedAliasHistoryPath = path.join(
        context.tempRoot,
        ".agents",
        "pm",
        "history",
        "pm-constructor.jsonl",
      );
      const normalizedAliasHistoryBefore = await fs.readFile(
        normalizedAliasHistoryPath,
        "utf8",
      );
      const normalizedAliasReceiptPath = path.join(
        durableDirectory,
        "normalized-alias.json",
      );
      await fs.writeFile(
        normalizedAliasReceiptPath,
        `${JSON.stringify({
          version: 1,
          id: "normalized-alias",
          item_path: ".agents/pm/tasks/constructor.toon",
          item_id: "constructor",
          conflict_resolution: "stable_value_order",
          fields_from_theirs: ["title"],
          union_fields: [],
          merged_field_hashes: {
            title: sha256Hex(stableStringify("Normalized alias target")),
          },
          decisions: [],
          state: "pending",
          created_at: "2026-08-24T00:00:00.000Z",
          value_availability: "hash_only",
        })}\n`,
        "utf8",
      );
      const normalizedAliasReconcile = context.runCli(
        ["merge", "reconcile", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(normalizedAliasReconcile.code).not.toBe(0);
      expect(normalizedAliasReconcile.json).toMatchObject({
        ok: false,
        repair: { totals: { failed: 1 } },
        receipts: { pending_before: 1, reconciled: 0 },
      });
      expect(await fs.readFile(normalizedAliasHistoryPath, "utf8")).toBe(
        normalizedAliasHistoryBefore,
      );
      await fs.rm(normalizedAliasReceiptPath, { force: true });

      expect(
        context.runCli(
          [
            "create",
            "--json",
            "--id",
            "pm-disjoint-receipts",
            "--title",
            "Disjoint receipt title",
            "--description",
            "Disjoint receipt description",
            "--type",
            "Task",
          ],
          { cwd: context.tempRoot },
        ).code,
      ).toBe(0);
      const disjointItemPath = await locateItemPath(
        context.tempRoot,
        "pm-disjoint-receipts",
      );
      const disjointBefore = await fs.readFile(disjointItemPath, "utf8");
      await fs.writeFile(
        disjointItemPath,
        disjointBefore
          .replace("Disjoint receipt title", "Merged disjoint title")
          .replace(
            "Disjoint receipt description",
            "Merged disjoint description",
          ),
        "utf8",
      );
      const disjointTitleReceipt = await writeMergeReceipt({
        cwd: context.tempRoot,
        itemPath: path
          .relative(context.tempRoot, disjointItemPath)
          .replaceAll(path.sep, "/"),
        preferred: "ours",
        fieldsFromTheirs: ["title"],
        unionFields: [],
        mergedFieldHashes: {
          title: sha256Hex(stableStringify("Merged disjoint title")),
        },
        decisions: [],
      });
      const disjointDescriptionReceipt = await writeMergeReceipt({
        cwd: context.tempRoot,
        itemPath: path
          .relative(context.tempRoot, disjointItemPath)
          .replaceAll(path.sep, "/"),
        preferred: "ours",
        fieldsFromTheirs: ["description"],
        unionFields: [],
        mergedFieldHashes: {
          description: sha256Hex(
            stableStringify("Merged disjoint description"),
          ),
        },
        decisions: [],
      });
      expect(disjointTitleReceipt).not.toBeNull();
      expect(disjointDescriptionReceipt).not.toBeNull();
      const disjointHealth = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(
        checkDetails(disjointHealth.json as DiagnosticEnvelope, "history_drift")
          .merge_receipt_attributed_items,
      ).toContain("pm-disjoint-receipts");
      expect(
        (
          await runHealth(
            { path: path.join(context.tempRoot, ".agents", "pm") },
            { full: true },
          )
        ).warnings,
      ).toContain("history_drift_merge_receipt:pm-disjoint-receipts");
      const disjointReconcile = context.runCli(
        ["merge", "reconcile", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(disjointReconcile.code).toBe(0);
      expect(disjointReconcile.json).toMatchObject({
        ok: true,
        receipts: { pending_before: 2, reconciled: 2 },
      });
      const disjointAuditRaw = await fs.readFile(
        path.join(
          context.tempRoot,
          ".agents",
          "pm",
          "history",
          "pm-disjoint-receipts.jsonl",
        ),
        "utf8",
      );
      expect(disjointAuditRaw).toContain(disjointTitleReceipt?.id as string);
      expect(disjointAuditRaw).toContain(
        disjointDescriptionReceipt?.id as string,
      );

      await writeMergeReceipt({
        cwd: context.tempRoot,
        itemPath: ".agents/pm/tasks/pm-lossy.toon",
        preferred: "ours",
        fieldsFromTheirs: [],
        unionFields: [],
        decisions: [
          {
            field: "title",
            base: "base",
            ours: "alpha",
            theirs: "zeta",
            retained: "alpha",
            discarded: "zeta",
          },
        ],
      });

      const lossyHealth = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(lossyHealth.code).toBe(0);
      const lossyHealthResult = lossyHealth.json as DiagnosticEnvelope;
      expect(lossyHealthResult.ok).toBe(false);
      expect(lossyHealthResult.warnings).toContain(
        "merge_decisions_unreviewed:1",
      );
      expect(lossyHealthResult.warnings).not.toContain(
        "merge_receipts_pending:1",
      );

      const lossyValidation = context.runCli(
        ["validate", "--check-storage-integrity", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(lossyValidation.code).toBe(0);
      const lossyValidationResult = lossyValidation.json as DiagnosticEnvelope;
      expect(lossyValidationResult.warnings).toContain(
        "validate_merge_decisions_unreviewed:1",
      );
      expect(
        checkDetails(lossyValidationResult, "storage_integrity"),
      ).toMatchObject({
        pending_merge_decision_count: 1,
        lossless_merge_receipt_count: 0,
      });

      expect(
        context.runCli(
          [
            "create",
            "--json",
            "--id",
            "pm-proof-missing-item",
            "--title",
            "Missing proof item",
            "--description",
            "Cover fail-closed proof for a history-only subject",
            "--type",
            "Task",
          ],
          { cwd: context.tempRoot },
        ).code,
      ).toBe(0);
      const missingProofItemPath = await locateItemPath(
        context.tempRoot,
        "pm-proof-missing-item",
      );
      await fs.rm(missingProofItemPath);
      await expect(
        runHistoryRepair(
          "pm-proof-missing-item",
          {
            dryRun: true,
            mergeReceiptProof: {
              gitWorkspaceRoot: context.tempRoot,
              receipts: [
                {
                  ...(losslessReceipt as NonNullable<typeof losslessReceipt>),
                  item_id: "pm-proof-missing-item",
                  item_path: path
                    .relative(context.tempRoot, missingProofItemPath)
                    .replaceAll(path.sep, "/"),
                },
              ],
            },
          },
          { path: path.join(context.tempRoot, ".agents", "pm") },
        ),
      ).resolves.toMatchObject({
        merge_receipt_proof: { reason: "item_path_unavailable" },
      });
    });
  }, 60_000);
});
