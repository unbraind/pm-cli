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
        entry("agent-a", [
          { op: "replace", path: "/metadata/title", value: "new" },
        ]),
        entry("agent-b", [
          { op: "move", from: "/metadata/tags/0", path: "/metadata/tags/1" },
          { op: "replace", path: "/body", value: "new body" },
        ]),
      ],
      { metadata: { title: "new", tags: ["a", "b"] }, body: "new body" },
      { metadata: { title: "old", tags: ["b", "a"] }, body: "old body" },
    );

    expect(report).toMatchObject({
      reverted_field_count: 2,
      reverted_fields: ["body", "title"],
      preserved_field_count: 1,
      preserved_fields: ["tags"],
      discarded_authors: ["agent-a", "agent-b"],
    });
    expect(report?.discarded_events).toEqual([
      expect.objectContaining({ author: "agent-a", fields: ["title"] }),
      expect.objectContaining({ author: "agent-b", fields: ["body"] }),
    ]);
    expect(report?.preserved_events).toEqual([
      expect.objectContaining({ author: "agent-b", fields: ["tags"] }),
    ]);
    expect(report?.recovery_hint).toEqual(expect.any(String));
  });

  it("classifies append-only union additions as preserved instead of discarded", () => {
    const report = analyzeReconciliationDiscard(
      [
        entry("agent-a", [
          {
            op: "add",
            path: "/metadata/notes/0",
            value: { text: "from agent a", author: "agent-a" },
          },
          {
            op: "add",
            path: "/metadata/comments/0",
            value: { text: "from agent a", author: "agent-a" },
          },
        ]),
        entry("agent-z", [
          {
            op: "add",
            path: "/metadata/learnings/0",
            value: { text: "from agent z", author: "agent-z" },
          },
        ]),
      ],
      {
        metadata: {
          notes: [{ text: "from agent a", author: "agent-a" }],
          comments: [{ text: "from agent a", author: "agent-a" }],
          learnings: [{ text: "from agent z", author: "agent-z" }],
        },
        body: "",
      },
      {
        metadata: {
          notes: [
            { text: "from agent a", author: "agent-a" },
            { text: "from agent b", author: "agent-b" },
          ],
          comments: [
            { text: "from agent b", author: "agent-b" },
            { text: "from agent a", author: "agent-a" },
          ],
          learnings: [
            { text: "from agent z", author: "agent-z" },
            { text: "from agent b", author: "agent-b" },
          ],
        },
        body: "",
      },
    );

    expect(report).toMatchObject({
      reverted_field_count: 0,
      reverted_fields: [],
      preserved_field_count: 3,
      preserved_fields: ["comments", "learnings", "notes"],
      discarded_events: [],
      discarded_authors: [],
      preserved_authors: ["agent-a", "agent-z"],
      recovery_hint: null,
    });
    expect(report?.preserved_events).toEqual([
      expect.objectContaining({
        author: "agent-a",
        fields: ["comments", "notes"],
      }),
      expect.objectContaining({
        author: "agent-z",
        fields: ["learnings"],
      }),
    ]);
  });

  it("keeps array removals and multiplicity loss in the discarded partition", () => {
    const report = analyzeReconciliationDiscard(
      [
        entry("agent-a", [
          { op: "add", path: "/metadata/tags/0", value: "context" },
          {
            op: "add",
            path: "/metadata/notes/0",
            value: { text: "duplicate" },
          },
          {
            op: "add",
            path: "/metadata/notes/1",
            value: { text: "duplicate" },
          },
        ]),
      ],
      {
        metadata: {
          tags: ["context"],
          notes: [{ text: "duplicate" }, { text: "duplicate" }],
        },
        body: "",
      },
      {
        metadata: {
          tags: "context",
          notes: [{ text: "duplicate" }],
        },
        body: "",
      },
    );

    expect(report).toMatchObject({
      reverted_field_count: 2,
      reverted_fields: ["notes", "tags"],
      preserved_field_count: 0,
    });
  });
});
