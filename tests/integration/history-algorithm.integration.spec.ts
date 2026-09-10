/** @module tests/integration/history-algorithm.integration */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHistoryEntry, hashDocumentForVersion, sealHistoryRecord, verifyHistoryRewriteEvidence } from "../../src/core/history/history.js";
import { scanHistoryDrift } from "../../src/core/history/drift-scan.js";
import { historyEntriesToRaw, verifyHistoryChain } from "../../src/core/history/replay.js";
import { getItemAt } from "../../src/sdk/history-read.js";
import { runHistoryRepair } from "../../src/sdk/history-repair.js";
import { runHistoryRedact } from "../../src/sdk/history-redact.js";
import { runHistoryCompact } from "../../src/sdk/history-compact.js";
import { exportAttestation, verifyAttestation } from "../../src/sdk/history/attestation.js";
import { mergeHistoryStreams } from "../../src/sdk/merge/three-way.js";
import type { HistoryEntry, ItemDocument } from "../../src/types.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("history algorithm maintenance", () => {
  it("preserves SHA-512 across merge, cached drift scans, repair, redaction, compaction and replay", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(["create", "--title", "algorithm integration", "--json"], { expectJson: true });
      const id = (created.json as { item: { id: string } }).item.id;
      const options = { pmRoot: context.pmPath };
      const global = { path: context.pmPath };
      const first = (await getItemAt(id, "1", options)).document;
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const genesis = createHistoryEntry({ nowIso: first.metadata.created_at, author: "test-author", op: "create", before: { metadata: {}, body: "" } as ItemDocument, after: first, hashAlgorithm: "sha512" });
      const oursDocument = { ...first, body: "redaction-probe" };
      const theirsDocument = { ...first, metadata: { ...first.metadata, description: "parallel work" } };
      const ours = createHistoryEntry({ nowIso: "2026-09-10T20:00:00.000Z", author: "test-author", op: "update", before: first, after: oursDocument, hashAlgorithm: "sha512" });
      const theirs = createHistoryEntry({ nowIso: "2026-09-10T20:01:00.000Z", author: "test-author", op: "update", before: first, after: theirsDocument });
      const merged = mergeHistoryStreams(historyEntriesToRaw([genesis]), historyEntriesToRaw([genesis, ours]), historyEntriesToRaw([genesis, theirs]));
      const mergedEntries = merged.merged.trim().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
      expect(verifyHistoryChain(mergedEntries).ok).toBe(true);
      expect(mergedEntries.map((entry) => entry.hash_algorithm)).toEqual(["sha512", "sha512", "sha256"]);
      expect(verifyHistoryRewriteEvidence(mergedEntries[2]!).ok).toBe(true);
      await writeFile(historyPath, historyEntriesToRaw([genesis]));
      for (const cacheHitVerification of ["content_hash", "metadata"] as const) {
        expect((await scanHistoryDrift(context.pmPath, [{ ...first.metadata, body: first.body }], { cacheHitVerification })).driftedItems).toEqual([]);
      }
      let proof = await exportAttestation(options);
      expect((await runHistoryRepair(id, { forceAuditEntry: true }, global)).history.verify_ok).toBe(true);
      expect(await verifyAttestation(proof, options)).toMatchObject({ ok: false, changed_streams: [id], invalid_streams: [], transitions: [{ id, last_maintenance: { op: "history_repair" } }] });
      expect((await getItemAt(id, "2", options)).document).toEqual(first);
      proof = await exportAttestation(options);
      expect((await runHistoryRedact(id, { literal: "algorithm integration", replacement: "redacted title" }, global)).history.verify_ok).toBe(true);
      expect(await verifyAttestation(proof, options)).toMatchObject({ ok: false, changed_streams: [id], invalid_streams: [], transitions: [{ id, last_maintenance: { op: "history_redact" } }] });
      proof = await exportAttestation(options);
      expect((await runHistoryCompact(id, {}, global)).history.verify_ok).toBe(true);
      expect(await verifyAttestation(proof, options)).toMatchObject({ ok: false, changed_streams: [id], invalid_streams: [], transitions: [{ id, last_maintenance: { op: "history_compact" } }] });
      expect(await verifyAttestation(await exportAttestation(options), options)).toMatchObject({ ok: true });
      const compacted = (await readFile(historyPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
      expect(verifyHistoryChain(compacted).ok).toBe(true);
      expect((await getItemAt(id, String(compacted.length + 2), options)).document.metadata.title).toBe("redacted title");
      // A pre-epoch stream keeps its implicit version through compaction.
      const current = (await getItemAt(id, String(compacted.length + 2), options)).document;
      const legacy = { ...genesis, after_hash: hashDocumentForVersion(current, 1), before_hash: hashDocumentForVersion({ metadata: {}, body: "" } as ItemDocument, 1), patch: createHistoryEntry({ nowIso: genesis.ts, author: "fixture", op: "create", before: { metadata: {}, body: "" } as ItemDocument, after: current }).patch };
      delete legacy.item_hash_version;
      delete legacy.hash_algorithm;
      delete legacy.record_hash;
      delete legacy.record_hash_version;
      await writeFile(historyPath, historyEntriesToRaw([sealHistoryRecord(legacy)]));
      expect((await runHistoryCompact(id, { dryRun: true }, global)).history.verify_ok).toBe(true);
    });
  });
});
