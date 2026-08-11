import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { outputTestOnly } from "../../../src/core/output/output.js";
import { attachReadOutputContracts } from "../../../src/sdk/context-intent-contracts.js";
import { _testOnly as activityInternals } from "../../../src/sdk/query/activity.js";
import { _testOnly as statsInternals } from "../../../src/sdk/stats.js";

describe("context-efficient read primitives", () => {
  it("encodes uniform flat object arrays as strict round-trippable TOON tables", () => {
    const value = {
      items: [
        { id: "pm-1", title: "comma, quote \" and\nnewline", status: "open" },
        { id: "pm-2", title: "plain", status: "closed" },
      ],
    };

    const rendered = outputTestOnly.renderToonValue(value, 0);

    expect(rendered).toContain("items[2]{id,title,status}:");
    expect(decode(rendered)).toEqual(value);
  });

  it("keeps mixed and nested arrays on the expanded legacy renderer path", () => {
    expect(
      outputTestOnly.renderToonValue(
        { items: [{ id: "pm-1" }, { id: "pm-2", nested: [1] }] },
        0,
      ),
    ).toBe(
      'items:\n  - id: "pm-1"\n  - id: "pm-2"\n    nested:\n      - 1',
    );
  });

  it("suppresses row contracts by default and restores an encoding-aware contract explicitly", () => {
    const result = { items: [{ id: "pm-1", title: "One" }] };

    expect(attachReadOutputContracts("list", {}, result)).toEqual(result);
    expect(
      attachReadOutputContracts(
        "list",
        { outputRowContract: true },
        result,
      ),
    ).toMatchObject({
      row_contract: {
        command: "list",
        row_keys: ["items"],
        toon_encoding: "tabular_when_uniform",
      },
    });
  });

  it("projects lifecycle-aware non-empty stats rows and reports suppressed schema buckets", () => {
    const projected = statsInternals.projectStatsDistributions(
      [
        { type: "Task", status: "open" },
        { type: "Task", status: "closed" },
        { type: "Issue", status: "blocked" },
      ],
      ["Task", "Issue", "Event"],
      ["open", "in_progress", "blocked", "closed", "canceled"],
      {
        classify(status: string) {
          return status === "closed"
            ? "closed"
            : status === "blocked"
              ? "blocked"
              : "open";
        },
        isTerminal(status: string) {
          return status === "closed";
        },
      },
      false,
    );

    expect(projected).toEqual({
      byType: [
          {
            type: "Task",
            total: 2,
            open: 1,
            in_progress: 0,
            blocked: 0,
            draft: 0,
            closed: 1,
            canceled: 0,
            other: 0,
          },
          {
            type: "Issue",
            total: 1,
            open: 0,
            in_progress: 0,
            blocked: 1,
            draft: 0,
            closed: 0,
            canceled: 0,
            other: 0,
          },
        ],
      byStatus: { open: 1, blocked: 1, closed: 1 },
      omitted: 3,
    });
  });

  it("folds bursty history rows into one actionable item activity digest", () => {
    const rows = activityInternals.buildActivityDigest(
      [
        { id: "pm-1", op: "update", ts: "2026-08-11T02:00:00.000Z", author: "a", patch: [], before_hash: "", after_hash: "" },
        { id: "pm-1", op: "comment_add", ts: "2026-08-11T01:00:00.000Z", author: "a", patch: [], before_hash: "", after_hash: "" },
        { id: "pm-2", op: "create", ts: "2026-08-11T00:30:00.000Z", author: "b", patch: [], before_hash: "", after_hash: "" },
      ],
      new Map([
        ["pm-1", { title: "First item", type: "Task", status: "open" }],
        ["pm-2", { title: "Second item", type: "Issue", status: "closed" }],
      ]),
    );

    expect(rows).toEqual([
      {
        id: "pm-1",
        type: "Task",
        status: "open",
        title: "First item",
        event_count: 2,
        first_ts: "2026-08-11T01:00:00.000Z",
        last_ts: "2026-08-11T02:00:00.000Z",
        operations: "comment_add:1,update:1",
      },
      {
        id: "pm-2",
        type: "Issue",
        status: "closed",
        title: "Second item",
        event_count: 1,
        first_ts: "2026-08-11T00:30:00.000Z",
        last_ts: "2026-08-11T00:30:00.000Z",
        operations: "create:1",
      },
    ]);
  });
});
