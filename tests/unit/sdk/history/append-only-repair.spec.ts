/**
 * Append-only repair planning on hash-epoch edge cases (GH-1715, pm-gh1715).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import jsonPatch from "fast-json-patch";
import { describe, expect, it } from "vitest";
import {
  hashDocumentForVersion,
  hashDocumentVerificationCandidates,
} from "../../../../src/core/history/history.js";
import {
  EMPTY_REPLAY_DOCUMENT,
  toReplayDocument,
  verifyHistoryChainWithVersion,
} from "../../../../src/core/history/replay.js";
import {
  _testOnly,
  buildAppendOnlyRepairPlan,
} from "../../../../src/sdk/history/append-only-repair.js";
import type { HistoryMaintenanceSnapshot } from "../../../../src/sdk/history/maintenance.js";
import { analyzeReconciliationDiscard } from "../../../../src/sdk/history-repair.js";
import type { HistoryEntry, ItemDocument } from "../../../../src/types/index.js";

const helpers = {
  analyzeDiscard: analyzeReconciliationDiscard,
  collectWarnings: () => [],
};
const subject = { id: "pm-epoch", historyPath: "unused.jsonl", located: null };

function document(title: string, tests: ItemDocument["metadata"]["tests"]): ItemDocument {
  return {
    metadata: {
      id: "pm-epoch",
      title,
      type: "Task",
      status: "open",
      priority: 1,
      tags: ["history"],
      created_at: "2026-08-11T00:00:00.000Z",
      updated_at: "2026-08-11T00:00:00.000Z",
      tests,
    },
    body: "",
  };
}

/** One legacy epoch-2 entry without an explicit version label. */
function entry(before: ItemDocument | null, after: ItemDocument, variant = 0): HistoryEntry {
  const beforeReplay = before === null ? structuredClone(EMPTY_REPLAY_DOCUMENT) : toReplayDocument(before);
  return {
    ts: "2026-08-11T00:00:00.000Z",
    author: "fixture",
    op: before === null ? "create" : "update",
    patch: jsonPatch.compare(beforeReplay, toReplayDocument(after)),
    before_hash:
      before === null
        ? hashDocumentForVersion({ metadata: {}, body: "" } as ItemDocument, 2)
        : hashDocumentVerificationCandidates(before, 2)[variant]!,
    after_hash: hashDocumentVerificationCandidates(after, 2)[variant]!,
  };
}

function snapshot(entries: HistoryEntry[], item: ItemDocument): HistoryMaintenanceSnapshot {
  return {
    raw: "",
    entries,
    verification: { ok: false, errors: [] },
    loadedItem: { document: item, raw: "" } as HistoryMaintenanceSnapshot["loadedItem"],
    author: "fixture",
  };
}

// Insertion order differs from sorted order, so epoch 1 and epoch 2 hash it differently.
const ordered = [
  { command: "z-last", scope: "project" as const },
  { command: "a-first", scope: "project" as const },
];

describe("append-only repair hash surfaces", () => {
  it("keeps the epoch an implicit stream's verified prefix proves when bridging it", () => {
    const created = document("Created", ordered);
    const edited = document("Edited outside pm", ordered);
    const renamed = { ...edited, metadata: { ...edited.metadata, status: "in_progress" } } as ItemDocument;
    const entries = [entry(null, created), entry(edited, renamed)];
    expect(verifyHistoryChainWithVersion(entries.slice(0, 1))).toMatchObject({ ok: true, item_hash_version: 2 });
    const plan = buildAppendOnlyRepairPlan(subject, {}, snapshot(entries, renamed), helpers);
    const bridge = plan.rewrittenEntries.at(-1)!;
    expect(bridge).toMatchObject({ item_hash_version: 2, bridge: { breaks: [expect.any(Object)] } });
    expect(bridge.after_hash).toBe(hashDocumentForVersion(renamed, 2));
    expect(verifyHistoryChainWithVersion(plan.rewrittenEntries)).toMatchObject({ ok: true, item_hash_version: 2 });
  });

  it("reconciles a verified tail on the same epoch-2 variant it recorded", () => {
    // Provenance on a linked test is what separates the field-frozen variant from the expanded one.
    const withProvenance = [
      {
        command: "z-last",
        scope: "project" as const,
        workspace_context_mode: "source" as const,
        provenance: {
          author: "fixture",
          created_at: "2026-08-21T00:00:00.000Z",
          source_kind: "local_mutation" as const,
          source_ref: "fixture/v2-writer",
        },
      },
    ];
    const created = document("Created", withProvenance);
    const updated = document("Updated", withProvenance);
    const entries = [entry(null, created), entry(created, updated, 1)];
    expect(entries[1]!.after_hash).not.toBe(hashDocumentVerificationCandidates(updated, 2)[0]);
    expect(verifyHistoryChainWithVersion(entries).ok).toBe(true);
    const onDisk = document("Edited at the end", withProvenance);
    const plan = buildAppendOnlyRepairPlan(subject, {}, snapshot(entries, onDisk), helpers);
    const record = plan.rewrittenEntries.at(-1)!;
    expect(record).not.toHaveProperty("bridge");
    expect(record.after_hash).toBe(hashDocumentVerificationCandidates(onDisk, 2)[1]);
    expect(verifyHistoryChainWithVersion(plan.rewrittenEntries).ok).toBe(true);
  });

  it("appends only to the exact verified bytes and refuses a stream that changed or is not UTF-8", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pm-append-only-"));
    try {
      const file = path.join(directory, "stream.jsonl");
      const record = entry(null, document("Created", ordered));
      await writeFile(file, "first");
      await _testOnly.appendRepairRecord("pm-epoch", file, "first", record);
      expect(await readFile(file, "utf8")).toBe(`first\n${JSON.stringify(record)}\n`);
      await expect(_testOnly.appendRepairRecord("pm-epoch", file, "first", record)).rejects.toMatchObject({
        context: { code: "history_append_only_repair_unavailable", reason: "stream_changed" },
      });
      await writeFile(file, Buffer.from([0x7b, 0xff, 0x7d]));
      await expect(_testOnly.appendRepairRecord("pm-epoch", file, "{}", record)).rejects.toMatchObject({
        context: { reason: "stream_not_utf8" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
