import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hashHistoryPatch,
  sealHistoryRecord,
  verifyHistoryRecordHash,
  verifyHistoryRewriteEvidence,
} from "../../src/core/history/history.js";
import { verifyHistoryChain } from "../../src/core/history/replay.js";
import { runHealth } from "../../src/sdk/governance/health.js";
import { runHistoryRedact } from "../../src/sdk/history-redact.js";
import type { HistoryEntry } from "../../src/types.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("history redaction record integrity", () => {
  it("reseals rewritten records and retains only digest evidence for sensitive patches", async () => {
    await withTempPmPath(async (context) => {
      const secret = "private-redaction-probe";
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          secret,
          "--description",
          "record integrity redaction fixture",
          "--type",
          "Task",
        ],
        { expectJson: true },
      );
      const id = (created.json as { item: { id: string } }).item.id;
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const original = JSON.parse(
        (await readFile(historyPath, "utf8")).trim(),
      ) as HistoryEntry;
      const retainedPatch = [
        {
          op: "add" as const,
          path: "/metadata/private_rewrite_evidence",
          value: secret,
        },
      ];
      const retainedSafePatch = [
        {
          op: "add" as const,
          path: "/metadata/public_rewrite_evidence",
          value: "public-value",
        },
      ];
      const priorRecord = sealHistoryRecord({
        ...original,
        patch: retainedSafePatch,
        message: secret,
      });
      const withPriorRewriteEvidence = sealHistoryRecord({
        ...original,
        reanchor_evidence: [
          {
            before_hash: original.before_hash,
            after_hash: original.after_hash,
            item_hash_version: original.item_hash_version,
            patch_hash: hashHistoryPatch(retainedSafePatch),
            patch: retainedSafePatch,
            record_hash_version: priorRecord.record_hash_version,
            record_hash: priorRecord.record_hash,
            record: priorRecord,
          },
          {
            before_hash: original.before_hash,
            after_hash: original.after_hash,
            item_hash_version: original.item_hash_version,
            patch_hash: hashHistoryPatch(retainedPatch),
            patch: retainedPatch,
          },
        ],
      });
      await writeFile(
        historyPath,
        `${JSON.stringify(withPriorRewriteEvidence)}\n`,
        "utf8",
      );

      const result = await runHistoryRedact(
        id,
        { literal: secret, replacement: "[scrubbed]" },
        { path: context.pmPath },
      );
      expect(result.changed).toBe(true);
      const historyRaw = await readFile(historyPath, "utf8");
      expect(historyRaw).not.toContain(secret);
      const entries = historyRaw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as HistoryEntry);
      expect(verifyHistoryChain(entries).ok).toBe(true);
      expect(entries.every((entry) => verifyHistoryRecordHash(entry).ok)).toBe(
        true,
      );
      expect(entries[0]?.reanchor_evidence).toHaveLength(3);
      expect(entries[0]?.reanchor_evidence?.[0]?.patch).toEqual(
        retainedSafePatch,
      );
      expect(entries[0]?.reanchor_evidence?.[0]?.record).toBeUndefined();
      expect(
        entries[0]?.reanchor_evidence
          ?.slice(1)
          .every(
            (evidence) =>
              typeof evidence.patch_hash === "string" &&
              evidence.patch === undefined &&
              evidence.record_hash === undefined,
          ),
      ).toBe(true);
      expect(verifyHistoryRewriteEvidence(entries[0]!)).toEqual({
        ok: true,
        coverage: "digest_only",
      });
    });
  });

  it("reports and refuses attribution tampering instead of blessing it during maintenance", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "immutable-author-probe",
          "--description",
          "record integrity tamper fixture",
          "--type",
          "Task",
        ],
        { expectJson: true },
      );
      const id = (created.json as { item: { id: string } }).item.id;
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const entries = (await readFile(historyPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as HistoryEntry);
      entries[0] = { ...entries[0]!, author: "tampered-author" };
      await writeFile(
        historyPath,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8",
      );

      const health = await runHealth(
        { path: context.pmPath },
        { full: true, skipVectors: true },
      );
      expect(health.warnings).toContain(`history_drift_chain_mismatch:${id}`);
      await expect(
        runHistoryRedact(
          id,
          { literal: "immutable-author-probe" },
          { path: context.pmPath },
        ),
      ).rejects.toThrow("refuses invalid immutable record 1");
    });
  });
});
