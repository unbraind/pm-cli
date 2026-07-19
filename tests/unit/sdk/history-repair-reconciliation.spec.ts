import { describe, expect, it } from "vitest";
import { analyzeReconciliationDiscard } from "../../../src/sdk/history-repair.js";
import type { HistoryEntry } from "../../../src/types/index.js";

function entry(author: string, patch: HistoryEntry["patch"]): HistoryEntry {
  return {
    ts: "2026-07-19T00:00:00.000Z",
    author,
    op: "update",
    patch,
    before_hash: "before",
    after_hash: "after",
  };
}

describe("history repair reconciliation analysis", () => {
  it("returns no report when item and replay agree", () => {
    const replay = { metadata: { title: "same" }, body: "" };
    expect(analyzeReconciliationDiscard([], replay, replay)).toBeUndefined();
  });

  it("attributes every reverted field to the newest writing event and author", () => {
    const report = analyzeReconciliationDiscard(
      [
        entry("agent-a", [{ op: "replace", path: "/metadata/title", value: "new" }]),
        entry("agent-b", [
          { op: "move", from: "/metadata/tags/0", path: "/metadata/tags/1" },
          { op: "replace", path: "/body", value: "new body" },
        ]),
      ],
      { metadata: { title: "new", tags: ["a", "b"] }, body: "new body" },
      { metadata: { title: "old", tags: ["b", "a"] }, body: "old body" },
    );

    expect(report).toMatchObject({
      reverted_field_count: 3,
      reverted_fields: ["body", "tags", "title"],
      discarded_authors: ["agent-a", "agent-b"],
    });
    expect(report?.discarded_events).toEqual([
      expect.objectContaining({ author: "agent-a", fields: ["title"] }),
      expect.objectContaining({ author: "agent-b", fields: ["body", "tags"] }),
    ]);
  });
});
