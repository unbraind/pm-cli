/**
 * Append-only repair planning on hash-epoch edge cases (GH-1715, pm-gh1715).
 */
import * as fsPromises from "node:fs/promises";
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

describe("append-only repair hash surfaces", () => {
  it("anchors on the newest declared epoch, even after an older implicit prefix", () => {
    const created = document("Created", ordered);
    const edited = document("Edited outside pm", ordered);
    const renamed = { ...edited, metadata: { ...edited.metadata, status: "in_progress" } } as ItemDocument;
    const tail = { ...entry(edited, renamed), item_hash_version: 3 as const };
    tail.before_hash = hashDocumentForVersion(edited, 3);
    tail.after_hash = hashDocumentForVersion(renamed, 3);
    const plan = buildAppendOnlyRepairPlan(subject, {}, snapshot([entry(null, created), tail], renamed), helpers);
    expect(plan.rewrittenEntries.at(-1)).toMatchObject({ item_hash_version: 3, after_hash: hashDocumentForVersion(renamed, 3) });
  });

  it("proves a bridged epoch-2 variant from the on-disk item and refuses when nothing proves it", () => {
    const created = document("Created", withProvenance);
    const edited = document("Edited outside pm", withProvenance);
    const renamed = { ...edited, metadata: { ...edited.metadata, priority: 0 } } as ItemDocument;
    // Declared epoch 2: unversioned, the field-frozen variant also reads as epoch 1.
    const entries = [entry(null, created, 1), entry(edited, renamed, 1)].map((value) => ({ ...value, item_hash_version: 2 }));
    const plan = buildAppendOnlyRepairPlan(subject, {}, snapshot(entries, renamed), helpers);
    expect(plan.rewrittenEntries.at(-1)!.after_hash).toBe(hashDocumentVerificationCandidates(renamed, 2)[1]);
    expect(plan.rewrittenEntries.at(-1)!.after_hash).not.toBe(hashDocumentVerificationCandidates(renamed, 2)[0]);
    expect(verifyHistoryChainWithVersion(plan.rewrittenEntries).ok).toBe(true);
    const drifted = { ...renamed, metadata: { ...renamed.metadata, title: "Changed again" } } as ItemDocument;
    expect(() => buildAppendOnlyRepairPlan(subject, {}, snapshot(entries, drifted), helpers)).toThrow(
      /neither replay nor the on-disk item proves/,
    );
  });

  it("takes the epoch an implicit tail proves over its prefix's, and refuses when nothing proves it", () => {
    const created = document("Created", ordered);
    const edited = document("Edited outside pm", ordered);
    const renamed = { ...edited, metadata: { ...edited.metadata, priority: 0 } } as ItemDocument;
    // An epoch-1 prefix, then an unversioned record a transitional epoch-2 writer anchored.
    const legacy = entry(null, created);
    legacy.after_hash = hashDocumentForVersion(created, 1);
    const entries = [legacy, entry(edited, renamed)];
    expect(verifyHistoryChainWithVersion(entries.slice(0, 1))).toMatchObject({ ok: true, item_hash_version: 1 });
    const plan = buildAppendOnlyRepairPlan(subject, {}, snapshot(entries, renamed), helpers);
    expect(plan.rewrittenEntries.at(-1)).toMatchObject({ item_hash_version: 3, after_hash: hashDocumentForVersion(renamed, 3) });
    const drifted = { ...renamed, metadata: { ...renamed.metadata, title: "Changed again" } } as ItemDocument;
    expect(() => buildAppendOnlyRepairPlan(subject, {}, snapshot(entries, drifted), helpers)).toThrow(
      /neither replay nor the on-disk item proves its last record's epoch/,
    );
  });

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
      // A stream replaced while the record was appended loses the record, so the repair refuses.
      const replaced = async () => ({ ino: -1, dev: -1 });
      await expect(
        _testOnly.appendRepairRecord("pm-epoch", file, await readFile(file, "utf8"), record, replaced),
      ).rejects.toMatchObject({ context: { reason: "stream_changed" } });
      const removed = async (): Promise<{ ino: number; dev: number }> => {
        throw new Error("gone");
      };
      await expect(
        _testOnly.appendRepairRecord("pm-epoch", file, await readFile(file, "utf8"), record, removed),
      ).rejects.toMatchObject({ context: { reason: "stream_changed" } });
      // A writer that ignores pm's lock appends between the check and the write.
      const peer = async (target: string) => {
        await fsPromises.appendFile(target, '{"peer":true}\n');
        return fsPromises.stat(target);
      };
      await expect(
        _testOnly.appendRepairRecord("pm-epoch", file, await readFile(file, "utf8"), record, peer),
      ).rejects.toMatchObject({ context: { reason: "stream_changed" } });
      expect(await readFile(file, "utf8")).toContain('{"peer":true}');
      const sameInode = (await fsPromises.stat(file)).ino;
      await expect(
        _testOnly.appendRepairRecord("pm-epoch", file, await readFile(file, "utf8"), record, async () => ({ ino: sameInode, dev: -1 })),
      ).rejects.toMatchObject({ context: { reason: "stream_changed" } });
      // A stream removed after the check stays absent: the append never creates the path.
      const missing = path.join(directory, "removed.jsonl");
      await expect(_testOnly.appendRepairRecord("pm-epoch", missing, "", record)).rejects.toMatchObject({
        context: { reason: "stream_changed" },
      });
      await expect(fsPromises.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(_testOnly.appendRepairRecord("pm-epoch", directory, "", record)).rejects.toThrow();
      await writeFile(file, Buffer.from([0x7b, 0xff, 0x7d]));
      await expect(_testOnly.appendRepairRecord("pm-epoch", file, "{}", record)).rejects.toMatchObject({
        context: { reason: "stream_not_utf8" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
