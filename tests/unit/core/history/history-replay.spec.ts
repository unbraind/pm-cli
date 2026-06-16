import jsonPatch from "fast-json-patch";
import { describe, expect, it } from "vitest";
import {
  EMPTY_REPLAY_DOCUMENT,
  cloneEmptyReplayDocument,
  historyEntriesToRaw,
  lenientApplyReplayPatch,
  normalizeReplayPatchOps,
  normalizeReplayPatchPath,
  reanchorHistoryEntries,
  replayHash,
  replayToItemDocument,
  toReplayDocument,
  tryApplyReplayPatch,
  verifyHistoryChain,
  type ReplayDocument,
} from "../../../../src/core/history/replay.js";
import type { HistoryEntry, HistoryPatchOp, ItemDocument, ItemMetadata } from "../../../../src/types/index.js";

function fullMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pm-x",
    title: "title",
    description: "description",
    type: "Task",
    status: "open",
    priority: 2,
    tags: [],
    dependencies: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// replayHash (via canonicalDocument) requires a complete metadata object, exactly as a
// real `create` history entry establishes before any later entry mutates the item.
const DOC0 = cloneEmptyReplayDocument();
const DOC1: ReplayDocument = { metadata: fullMetadata(), body: "a" };
const DOC2: ReplayDocument = { metadata: fullMetadata({ status: "in_progress" }), body: "b" };

function buildEntry(before: ReplayDocument, after: ReplayDocument, op = "update"): HistoryEntry {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    author: "tester",
    op,
    patch: jsonPatch.compare(before, after) as HistoryPatchOp[],
    before_hash: replayHash(before),
    after_hash: replayHash(after),
  };
}

describe("history replay helpers", () => {
  it("clones the empty replay document without aliasing the shared constant", () => {
    const clone = cloneEmptyReplayDocument();
    expect(clone).toEqual({ metadata: {}, body: "" });
    expect(clone).not.toBe(EMPTY_REPLAY_DOCUMENT);
    clone.metadata.touched = true;
    expect(EMPTY_REPLAY_DOCUMENT.metadata).toEqual({});
  });

  it("converts replay documents to item documents", () => {
    const document = replayToItemDocument({ metadata: { id: "pm-x" }, body: "b" });
    const expected: ItemDocument = { metadata: { id: "pm-x" } as unknown as ItemMetadata, body: "b" };
    expect(document).toEqual(expected);
  });

  it("normalizes an empty item document to an empty replay document", () => {
    expect(toReplayDocument({ metadata: {} as ItemMetadata, body: "keep" })).toEqual({
      metadata: {},
      body: "keep",
    });
    expect(
      toReplayDocument({ metadata: undefined as unknown as ItemMetadata, body: undefined as unknown as string }),
    ).toEqual({ metadata: {}, body: "" });
  });

  it("canonicalizes a populated item document into ordered replay form", () => {
    const replay = toReplayDocument({ metadata: fullMetadata() as unknown as ItemMetadata, body: "body" });
    expect(replay.body).toBe("body");
    expect((replay.metadata as { id: string }).id).toBe("pm-x");
  });

  it("falls back to a deterministic structural hash for un-canonicalizable replay states", () => {
    // A partial metadata document (no tags array) cannot be canonicalized; replayHash
    // must still return a stable hash rather than throwing.
    const partial: ReplayDocument = { metadata: { status: "open" }, body: "x" };
    const first = replayHash(partial);
    const second = replayHash({ metadata: { status: "open" }, body: "x" });
    expect(typeof first).toBe("string");
    expect(first).toBe(second);
    expect(first).not.toBe(replayHash({ metadata: { status: "closed" }, body: "x" }));
  });

  it("maps front_matter patch paths to metadata", () => {
    expect(normalizeReplayPatchPath("/front_matter")).toBe("/metadata");
    expect(normalizeReplayPatchPath("/front_matter/status")).toBe("/metadata/status");
    expect(normalizeReplayPatchPath("/body")).toBe("/body");
  });

  it("normalizes patch ops including from references", () => {
    const ops: HistoryPatchOp[] = [
      { op: "move", path: "/front_matter/a", from: "/front_matter/b" },
      { op: "add", path: "/body", value: "x" },
    ];
    expect(normalizeReplayPatchOps(ops)).toEqual([
      { op: "move", path: "/metadata/a", from: "/metadata/b" },
      { op: "add", path: "/body", value: "x", from: undefined },
    ]);
  });

  it("drops malformed patch payloads before replay normalization", () => {
    expect(normalizeReplayPatchOps(undefined)).toEqual([]);
    expect(normalizeReplayPatchOps({ op: "add", path: "/body" })).toEqual([]);
    expect(
      normalizeReplayPatchOps([
        undefined,
        { op: "add" },
        { op: "add", path: "/front_matter/status", value: "open" },
      ]),
    ).toEqual([{ op: "add", path: "/metadata/status", value: "open", from: undefined }]);
  });

  it("applies a valid patch and returns the new document", () => {
    const result = tryApplyReplayPatch({ metadata: {}, body: "" }, [
      { op: "add", path: "/metadata/id", value: "pm-x" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.metadata.id).toBe("pm-x");
    }
  });

  it("reports a failed apply when a patch op cannot resolve", () => {
    const result = tryApplyReplayPatch({ metadata: {}, body: "" }, [
      { op: "replace", path: "/metadata/missing", value: 1 },
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects patches that produce an invalid document shape", () => {
    const result = tryApplyReplayPatch({ metadata: { keep: 1 }, body: "" }, [
      { op: "remove", path: "/metadata" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(String((result.error as Error).message)).toContain("invalid_document_shape");
    }
  });

  it("verifies a clean chain", () => {
    const chain = [buildEntry(DOC0, DOC1, "create"), buildEntry(DOC1, DOC2)];
    expect(verifyHistoryChain(chain)).toEqual({ ok: true, errors: [] });
  });

  it("flags before/after/patch mismatches", () => {
    const badBefore = buildEntry(DOC0, DOC1, "create");
    badBefore.before_hash = "0".repeat(64);
    expect(verifyHistoryChain([badBefore]).errors[0]).toContain("before_hash_mismatch");

    const badAfter = buildEntry(DOC0, DOC1, "create");
    badAfter.after_hash = "0".repeat(64);
    expect(verifyHistoryChain([badAfter]).errors[0]).toContain("after_hash_mismatch");

    const badPatch = buildEntry(DOC0, DOC1, "create");
    badPatch.patch = [{ op: "replace", path: "/metadata/missing", value: 1 }];
    expect(verifyHistoryChain([badPatch]).errors[0]).toContain("patch_apply_failed");
  });

  it("leniently applies legacy patches: direct, replace->add, and skip", () => {
    const direct = lenientApplyReplayPatch({ metadata: {}, body: "" }, [
      { op: "add", path: "/metadata/id", value: "pm-x" },
    ]);
    expect(direct.document.metadata.id).toBe("pm-x");
    expect(direct.convertedReplaceToAdd).toBe(0);
    expect(direct.skippedOps).toBe(0);

    const converted = lenientApplyReplayPatch({ metadata: {}, body: "" }, [
      { op: "replace", path: "/metadata/status", value: "open" },
    ]);
    expect(converted.document.metadata.status).toBe("open");
    expect(converted.convertedReplaceToAdd).toBe(1);

    const skipped = lenientApplyReplayPatch({ metadata: {}, body: "" }, [
      { op: "remove", path: "/metadata/missing" },
      { op: "replace", path: "/metadata/items/4/x", value: 1 },
    ]);
    expect(skipped.skippedOps).toBe(2);
  });

  it("falls back to safe defaults when lenient apply removes metadata or breaks body", () => {
    const removed = lenientApplyReplayPatch({ metadata: { keep: 1 }, body: "keep" }, [
      { op: "remove", path: "/metadata" },
    ]);
    expect(removed.document.metadata).toEqual({});
    expect(removed.document.body).toBe("keep");

    const numericBody = lenientApplyReplayPatch({ metadata: { keep: 1 }, body: "orig" }, [
      { op: "replace", path: "/body", value: 5 },
    ]);
    expect(numericBody.document.body).toBe("orig");
  });

  it("re-anchors a clean chain by keeping patches and only recomputing stale hashes", () => {
    const entry = buildEntry(DOC0, DOC1, "create");
    const drifted = { ...entry, before_hash: "0".repeat(64), after_hash: "1".repeat(64) };

    const result = reanchorHistoryEntries([drifted]);
    expect(result.entriesRehashed).toBe(1);
    expect(result.entriesPatchRepaired).toBe(0);
    expect(result.entries[0].patch).toEqual(entry.patch);
    expect(verifyHistoryChain(result.entries)).toEqual({ ok: true, errors: [] });
    expect(result.details[0]).toMatchObject({ index: 1, rehashed: true, patch_repaired: false });
  });

  it("re-anchors with no changes when the chain is already valid", () => {
    const result = reanchorHistoryEntries([buildEntry(DOC0, DOC1, "create")]);
    expect(result.entriesRehashed).toBe(0);
    expect(result.details[0].rehashed).toBe(false);
  });

  it("repairs legacy patch ops that no longer strictly apply", () => {
    const create = buildEntry(DOC0, DOC1, "create");
    const legacy: HistoryEntry = {
      ts: "2026-01-02T00:00:00.000Z",
      author: "legacy",
      op: "update",
      // replace on a first-write field is invalid for strict replay but recoverable as add
      patch: [{ op: "replace", path: "/front_matter/assignee", value: "bob" }],
      before_hash: "0".repeat(64),
      after_hash: "1".repeat(64),
    };
    const result = reanchorHistoryEntries([create, legacy]);
    expect(result.entriesPatchRepaired).toBe(1);
    expect(result.convertedReplaceToAdd).toBe(1);
    expect(verifyHistoryChain(result.entries)).toEqual({ ok: true, errors: [] });
    expect((result.finalDocument.metadata as { assignee: string }).assignee).toBe("bob");
  });

  it("serializes history entries to JSONL and handles the empty case", () => {
    expect(historyEntriesToRaw([])).toBe("");
    const raw = historyEntriesToRaw([buildEntry(DOC0, DOC1, "create")]);
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw.trim()).op).toBe("create");
  });
});
