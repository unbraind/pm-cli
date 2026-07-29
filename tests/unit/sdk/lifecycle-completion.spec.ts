import { describe, expect, it } from "vitest";
import {
  planCompletedAtBackfill,
  resolveCompletionTimestamp,
} from "../../../src/sdk/lifecycle-completion.js";
import type { HistoryEntry, ItemMetadata } from "../../../src/types/index.js";

function item(
  id: string,
  overrides: Partial<ItemMetadata> = {},
): ItemMetadata {
  return {
    id,
    title: id,
    description: "",
    type: "Task",
    status: "closed",
    priority: 1,
    tags: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-03T00:00:00.000Z",
    ...overrides,
  };
}

function history(
  ts: string,
  status: string,
  path = "/metadata/status",
): HistoryEntry {
  return {
    ts,
    author: "test",
    op: "close",
    patch: [{ op: "replace", path, value: status }],
    before_hash: "before",
    after_hash: "after",
  };
}

describe("lifecycle completion SDK primitives", () => {
  it("discloses actual completion and both compatibility fallback sources", () => {
    expect(
      resolveCompletionTimestamp(
        item("pm-actual", {
          completed_at: "2026-01-02T00:00:00.000Z",
          closed_at: "2026-01-03T00:00:00.000Z",
        }),
      ),
    ).toEqual({
      resolved: true,
      timestamp: "2026-01-02T00:00:00.000Z",
      source: "completed_at",
      fallback: false,
    });
    expect(
      resolveCompletionTimestamp(
        item("pm-closed", {
          closed_at: "2026-01-02T00:00:00.000Z",
        }),
      ),
    ).toMatchObject({ source: "closed_at", fallback: true });
    expect(resolveCompletionTimestamp(item("pm-updated"))).toMatchObject({
      resolved: true,
      source: "updated_at",
      fallback: true,
    });
    expect(resolveCompletionTimestamp({})).toEqual({ resolved: false });
  });

  it("plans only evidence-backed terminal backfills and keeps absence explicit", () => {
    const items = [
      item("pm-a"),
      item("pm-b"),
      item("pm-c", { status: "open" }),
      item("pm-d", { completed_at: "2026-01-02T00:00:00.000Z" }),
      item("pm-e"),
      item("pm-f"),
      item("pm-g"),
      item("pm-h"),
    ];
    const histories = new Map<string, readonly HistoryEntry[]>([
      [
        "pm-a",
        [
          history("2026-01-02T00:00:00.000Z", "closed"),
          history("2026-01-04T00:00:00.000Z", "open"),
          history("2026-01-05T00:00:00.000Z", "closed"),
        ],
      ],
      [
        "pm-b",
        [
          {
            ...history("2026-01-06T00:00:00.000Z", "closed", ""),
            op: "create",
            patch: [
              {
                op: "replace",
                path: "",
                value: { front_matter: { status: "closed" } },
              },
            ],
          },
        ],
      ],
      [
        "pm-e",
        [
          history("not-a-time", "closed"),
          {
            ...history("2026-01-01T00:00:00.000Z", "closed"),
            patch: [
              {
                op: "replace",
                path: "/front_matter/status",
                value: 42,
              },
            ],
          },
          {
            ...history("2026-01-01T00:00:00.000Z", "closed", ""),
            patch: [{ op: "replace", path: "", value: "closed" }],
          },
        ],
      ],
      [
        "pm-f",
        [
          {
            ...history("2026-01-02T00:00:00.000Z", "closed", ""),
            op: "create",
            patch: [
              {
                op: "replace",
                path: "",
                value: { metadata: { status: "closed" } },
              },
            ],
          },
          history("2026-01-07T00:00:00.000Z", "closed"),
        ],
      ],
      ["pm-g", [history("2026-01-08T00:00:00.000Z", "closed")]],
    ]);

    expect(
      planCompletedAtBackfill(
        items,
        histories,
        new Set(["closed", "canceled"]),
      ),
    ).toEqual([
      {
        id: "pm-a",
        completed_at: "2026-01-05T00:00:00.000Z",
        history_op: "close",
      },
      {
        id: "pm-b",
        completed_at: "2026-01-06T00:00:00.000Z",
        history_op: "create",
      },
      {
        id: "pm-f",
        completed_at: "2026-01-02T00:00:00.000Z",
        history_op: "create",
      },
    ]);
  });
});
