import { describe, expect, it } from "vitest";
import {
  computeHistoryDiff,
  patchPathToChangedField,
  type HistoryDiffValueEntry,
  type HistoryFieldChange,
} from "../../../../src/core/history/history-diff.js";
import type { HistoryEntry, HistoryPatchOp } from "../../../../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  patch: HistoryPatchOp[],
  overrides: Partial<Omit<HistoryEntry, "patch">> = {},
): HistoryEntry {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    op: "update",
    author: "tester",
    before_hash: "aaa",
    after_hash: "bbb",
    patch,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// patchPathToChangedField
// ---------------------------------------------------------------------------

describe("patchPathToChangedField", () => {
  it("maps /body to 'body'", () => {
    expect(patchPathToChangedField("/body")).toBe("body");
  });

  it("maps /body/nested to 'body'", () => {
    expect(patchPathToChangedField("/body/section")).toBe("body");
  });

  it("maps /metadata to 'metadata' (bare prefix, no sub-key)", () => {
    expect(patchPathToChangedField("/metadata")).toBe("metadata");
  });

  it("maps /metadata/ (trailing slash) to 'metadata'", () => {
    // The regex strips /metadata/ and the empty first segment triggers the !segment branch.
    expect(patchPathToChangedField("/metadata/")).toBe("metadata");
  });

  it("maps /metadata/status to 'status'", () => {
    expect(patchPathToChangedField("/metadata/status")).toBe("status");
  });

  it("maps /metadata/status/sub to 'status' (only first segment)", () => {
    expect(patchPathToChangedField("/metadata/status/sub")).toBe("status");
  });

  it("maps /front_matter to 'metadata'", () => {
    expect(patchPathToChangedField("/front_matter")).toBe("metadata");
  });

  it("maps /front_matter/ (trailing slash) to 'metadata'", () => {
    expect(patchPathToChangedField("/front_matter/")).toBe("metadata");
  });

  it("maps /front_matter/assignee to 'assignee'", () => {
    expect(patchPathToChangedField("/front_matter/assignee")).toBe("assignee");
  });

  it("decodes ~1 (JSON-Pointer escape for '/') in metadata field name", () => {
    expect(patchPathToChangedField("/metadata/a~1b")).toBe("a/b");
  });

  it("decodes ~0 (JSON-Pointer escape for '~') in metadata field name", () => {
    expect(patchPathToChangedField("/metadata/a~0b")).toBe("a~b");
  });

  it("decodes ~1~0 combined escapes in metadata field name", () => {
    expect(patchPathToChangedField("/metadata/a~1~0b")).toBe("a/~b");
  });

  it("decodes ~1 in top-level path segment", () => {
    expect(patchPathToChangedField("/some~1field")).toBe("some/field");
  });

  it("maps / (root pointer — empty segment) to 'root'", () => {
    expect(patchPathToChangedField("/")).toBe("root");
  });

  it("maps a plain top-level path to that segment", () => {
    expect(patchPathToChangedField("/title")).toBe("title");
  });
});

// ---------------------------------------------------------------------------
// computeHistoryDiff — empty / boundary cases
// ---------------------------------------------------------------------------

describe("computeHistoryDiff — empty and boundary", () => {
  it("returns [] for empty entries array", () => {
    expect(computeHistoryDiff([])).toEqual([]);
  });

  it("returns [] when windowStartIndex equals entries length", () => {
    const entries = [makeEntry([{ op: "add", path: "/metadata/status", value: "open" }])];
    expect(computeHistoryDiff(entries, { windowStartIndex: 1 })).toEqual([]);
  });

  it("returns [] when windowStartIndex exceeds entries length", () => {
    const entries = [makeEntry([{ op: "add", path: "/metadata/status", value: "open" }])];
    expect(computeHistoryDiff(entries, { windowStartIndex: 99 })).toEqual([]);
  });

  it("defaults windowStartIndex to 0 (all entries emitted)", () => {
    const entries = [makeEntry([{ op: "add", path: "/metadata/status", value: "open" }])];
    const result = computeHistoryDiff(entries);
    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeHistoryDiff — basic before/after value tracking
// ---------------------------------------------------------------------------

describe("computeHistoryDiff — before/after values", () => {
  it("captures before=undefined and after=value for an 'add' on a new field", () => {
    const entries = [makeEntry([{ op: "add", path: "/metadata/status", value: "open" }])];
    const result = computeHistoryDiff(entries);

    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.index).toBe(1);
    expect(entry.patch_ops).toBe(1);
    expect(entry.changed_fields).toEqual(["status"]);
    expect(entry.changes).toHaveLength(1);
    expect(entry.changes[0]).toEqual<HistoryFieldChange>({
      field: "status",
      before: undefined,
      after: "open",
    });
  });

  it("captures correct before and after for a 'replace'", () => {
    // First entry establishes status=open, second replaces it.
    const entries = [
      makeEntry([{ op: "add", path: "/metadata/status", value: "open" }]),
      makeEntry([{ op: "replace", path: "/metadata/status", value: "in_progress" }]),
    ];
    const result = computeHistoryDiff(entries);

    expect(result).toHaveLength(2);
    // First entry: before=undefined, after="open"
    expect(result[0].changes[0]).toMatchObject({ field: "status", before: undefined, after: "open" });
    // Second entry: before="open", after="in_progress"
    expect(result[1].changes[0]).toMatchObject({ field: "status", before: "open", after: "in_progress" });
  });

  it("captures body changes", () => {
    const entries = [makeEntry([{ op: "add", path: "/body", value: "hello world" }])];
    const result = computeHistoryDiff(entries);

    expect(result[0].changed_fields).toEqual(["body"]);
    expect(result[0].changes[0]).toMatchObject({ field: "body", before: "", after: "hello world" });
  });

  it("captures before=value and after=undefined for a 'remove'", () => {
    // Seed then remove assignee.
    const entries = [
      makeEntry([{ op: "add", path: "/metadata/assignee", value: "alice" }]),
      makeEntry([{ op: "remove", path: "/metadata/assignee" }]),
    ];
    const result = computeHistoryDiff(entries);

    expect(result).toHaveLength(2);
    expect(result[1].changes[0]).toMatchObject({ field: "assignee", before: "alice", after: undefined });
  });

  it("captures whole-metadata replace (bare /metadata path)", () => {
    const newMeta = { id: "x", status: "closed" };
    const entries = [makeEntry([{ op: "add", path: "/metadata", value: newMeta }])];
    const result = computeHistoryDiff(entries);

    expect(result[0].changed_fields).toEqual(["metadata"]);
    expect(result[0].changes[0]).toMatchObject({ field: "metadata", before: {}, after: newMeta });
  });

  it("maps /front_matter/tag path and captures value", () => {
    const entries = [makeEntry([{ op: "add", path: "/front_matter/tag", value: "v1" }])];
    const result = computeHistoryDiff(entries);
    expect(result[0].changed_fields).toEqual(["tag"]);
    expect(result[0].changes[0]).toMatchObject({ field: "tag", before: undefined, after: "v1" });
  });
});

// ---------------------------------------------------------------------------
// computeHistoryDiff — op.from branch (move/copy)
// ---------------------------------------------------------------------------

describe("computeHistoryDiff — op.from (move/copy)", () => {
  it("includes both 'from' and 'path' field names for a move op", () => {
    // Seed metadata.a first, then move it to metadata.b.
    const entries = [
      makeEntry([{ op: "add", path: "/metadata/a", value: 1 }]),
      makeEntry([{ op: "move", from: "/metadata/a", path: "/metadata/b" }]),
    ];
    const result = computeHistoryDiff(entries);

    // Second entry should show both "a" and "b" as changed fields.
    expect(result[1].changed_fields).toEqual(["a", "b"]);
    // "a" was 1 before; undefined after (moved away). "b" was undefined before; 1 after.
    const aChange = result[1].changes.find((c) => c.field === "a");
    const bChange = result[1].changes.find((c) => c.field === "b");
    expect(aChange).toMatchObject({ field: "a", before: 1, after: undefined });
    expect(bChange).toMatchObject({ field: "b", before: undefined, after: 1 });
  });
});

// ---------------------------------------------------------------------------
// computeHistoryDiff — failed patch (after = before)
// ---------------------------------------------------------------------------

describe("computeHistoryDiff — failed patch application", () => {
  it("uses before state as after when patch cannot apply, and does not advance replay", () => {
    // Replace on a path that does not exist yet → strict apply fails.
    const failingPatch: HistoryPatchOp[] = [
      { op: "replace", path: "/metadata/nonexistent", value: "boom" },
    ];
    const entries = [
      makeEntry(failingPatch, { op: "create" }),
      makeEntry([{ op: "add", path: "/metadata/status", value: "open" }]),
    ];
    const result = computeHistoryDiff(entries);

    expect(result).toHaveLength(2);
    // First entry: patch fails → before and after are both the empty doc.
    // 'nonexistent' field: before = undefined (not in empty doc), after = undefined (same doc).
    expect(result[0].changes[0]).toMatchObject({
      field: "nonexistent",
      before: undefined,
      after: undefined,
    });

    // The replay was NOT advanced by the failed first entry, so the second entry
    // still starts from the empty document → before=undefined for 'status'.
    expect(result[1].changes[0]).toMatchObject({ field: "status", before: undefined, after: "open" });
  });
});

// ---------------------------------------------------------------------------
// computeHistoryDiff — windowStartIndex slicing
// ---------------------------------------------------------------------------

describe("computeHistoryDiff — windowStartIndex", () => {
  it("still replays all entries for correct state but only emits from the window", () => {
    const entries = [
      makeEntry([{ op: "add", path: "/metadata/status", value: "open" }]),
      makeEntry([{ op: "replace", path: "/metadata/status", value: "in_progress" }]),
      makeEntry([{ op: "replace", path: "/metadata/status", value: "closed" }]),
    ];

    // Window starts at index 1 (0-based) → entries at positions 1 and 2 are emitted.
    const result = computeHistoryDiff(entries, { windowStartIndex: 1 });

    expect(result).toHaveLength(2);
    // index is 1-based full-stream position.
    expect(result[0].index).toBe(2);
    expect(result[1].index).toBe(3);

    // Because the replay DID process entry 0, the state at entry 1 is "open"→"in_progress".
    expect(result[0].changes[0]).toMatchObject({
      field: "status",
      before: "open",
      after: "in_progress",
    });
    expect(result[1].changes[0]).toMatchObject({
      field: "status",
      before: "in_progress",
      after: "closed",
    });
  });
});

// ---------------------------------------------------------------------------
// computeHistoryDiff — field filter
// ---------------------------------------------------------------------------

describe("computeHistoryDiff — field filter", () => {
  it("only emits entries that touch the requested field", () => {
    const entries = [
      makeEntry([{ op: "add", path: "/metadata/status", value: "open" }]),
      makeEntry([{ op: "add", path: "/body", value: "text" }]), // body change only
      makeEntry([{ op: "replace", path: "/metadata/status", value: "closed" }]),
    ];

    const result = computeHistoryDiff(entries, { field: "status" });

    // Entry 2 (body-only) should be filtered out.
    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(1);
    expect(result[1].index).toBe(3);
  });

  it("restricts changes and changed_fields to the single filtered field", () => {
    const entries = [
      makeEntry([
        { op: "add", path: "/metadata/status", value: "open" },
        { op: "add", path: "/metadata/priority", value: 1 },
      ]),
    ];
    const result = computeHistoryDiff(entries, { field: "status" });

    expect(result).toHaveLength(1);
    expect(result[0].changed_fields).toEqual(["status"]);
    expect(result[0].changes).toHaveLength(1);
    expect(result[0].changes[0].field).toBe("status");
    // priority is NOT included.
    const priorityChange = result[0].changes.find((c) => c.field === "priority");
    expect(priorityChange).toBeUndefined();
  });

  it("returns [] when no entries touch the requested field", () => {
    const entries = [makeEntry([{ op: "add", path: "/body", value: "text" }])];
    const result = computeHistoryDiff(entries, { field: "status" });
    expect(result).toEqual([]);
  });

  it("field filter still respects windowStartIndex", () => {
    const entries = [
      makeEntry([{ op: "add", path: "/metadata/status", value: "open" }]),
      makeEntry([{ op: "replace", path: "/metadata/status", value: "in_progress" }]),
    ];
    // windowStartIndex=1 skips entry 0; field=status; only entry 1 emitted.
    const result = computeHistoryDiff(entries, { windowStartIndex: 1, field: "status" });
    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(2);
    expect(result[0].changes[0]).toMatchObject({
      field: "status",
      before: "open",
      after: "in_progress",
    });
  });
});

// ---------------------------------------------------------------------------
// computeHistoryDiff — changed_fields deduplication and sorting
// ---------------------------------------------------------------------------

describe("computeHistoryDiff — changed_fields dedup + sort", () => {
  it("deduplicates fields when multiple patch ops touch the same field", () => {
    const entries = [
      makeEntry([
        { op: "add", path: "/metadata/status", value: "a" },
        { op: "replace", path: "/metadata/status", value: "b" },
      ]),
    ];
    const result = computeHistoryDiff(entries);
    expect(result[0].changed_fields).toEqual(["status"]);
  });

  it("sorts changed_fields alphabetically", () => {
    const entries = [
      makeEntry([
        { op: "add", path: "/metadata/zzz", value: 1 },
        { op: "add", path: "/metadata/aaa", value: 2 },
        { op: "add", path: "/metadata/mmm", value: 3 },
      ]),
    ];
    const result = computeHistoryDiff(entries);
    expect(result[0].changed_fields).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("sorts changes by field name", () => {
    const entries = [
      makeEntry([
        { op: "add", path: "/metadata/zzz", value: 1 },
        { op: "add", path: "/metadata/aaa", value: 2 },
      ]),
    ];
    const result = computeHistoryDiff(entries);
    const fields = result[0].changes.map((c: HistoryFieldChange) => c.field);
    expect(fields).toEqual(["aaa", "zzz"]);
  });
});

// ---------------------------------------------------------------------------
// computeHistoryDiff — multi-entry metadata including author/ts/op passthrough
// ---------------------------------------------------------------------------

describe("computeHistoryDiff — entry metadata passthrough", () => {
  it("passes through ts, op, author from each HistoryEntry", () => {
    const entries = [
      makeEntry([{ op: "add", path: "/metadata/status", value: "open" }], {
        ts: "2026-03-01T10:00:00.000Z",
        op: "create",
        author: "alice",
      }),
    ];
    const result = computeHistoryDiff(entries);
    expect(result[0].ts).toBe("2026-03-01T10:00:00.000Z");
    expect(result[0].op).toBe("create");
    expect(result[0].author).toBe("alice");
  });

  it("reports patch_ops correctly for multi-op entries", () => {
    const patch: HistoryPatchOp[] = [
      { op: "add", path: "/metadata/status", value: "open" },
      { op: "add", path: "/metadata/priority", value: 2 },
      { op: "add", path: "/body", value: "text" },
    ];
    const entries = [makeEntry(patch)];
    const result = computeHistoryDiff(entries);
    expect(result[0].patch_ops).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// computeHistoryDiff — root ("/" path) and escaped pointer in top-level segment
// ---------------------------------------------------------------------------

describe("computeHistoryDiff — root and escaped pointer edge cases", () => {
  it("handles a patch op with path='/' mapped to 'root'", () => {
    // A bare "/" patch is non-standard but the path mapper must handle it.
    const entries = [makeEntry([{ op: "add", path: "/", value: "x" }])];
    const result = computeHistoryDiff(entries);
    expect(result[0].changed_fields).toEqual(["root"]);
  });

  it("decodes ~1 in metadata key names from patch paths", () => {
    const entries = [makeEntry([{ op: "add", path: "/metadata/a~1b", value: 42 }])];
    const result = computeHistoryDiff(entries);
    expect(result[0].changed_fields).toEqual(["a/b"]);
  });

  it("decodes ~0 in metadata key names from patch paths", () => {
    const entries = [makeEntry([{ op: "add", path: "/metadata/a~0b", value: 99 }])];
    const result = computeHistoryDiff(entries);
    expect(result[0].changed_fields).toEqual(["a~b"]);
  });
});
