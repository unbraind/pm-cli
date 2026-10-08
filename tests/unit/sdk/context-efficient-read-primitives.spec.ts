import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { outputTestOnly } from "../../../src/core/output/output.js";
import {
  applyContextIntentProjection,
  attachReadOutputContracts,
} from "../../../src/sdk/context-intent-contracts.js";
import { applyReadOutputDimensions } from "../../../src/sdk/read-output-contracts.js";
import { _testOnly as activityInternals } from "../../../src/sdk/query/activity.js";
import { _testOnly as statsInternals } from "../../../src/sdk/stats.js";

describe("context-efficient read primitives", () => {
  it("encodes uniform flat object arrays as strict round-trippable TOON tables", () => {
    const value = {
      items: [
        { id: "pm-1", title: 'comma, quote " and\nnewline', status: "open" },
        { id: "pm-2", title: "plain", status: "closed" },
      ],
    };

    const rendered = outputTestOnly.renderToonValue(value, 0);

    expect(rendered).toContain("items[2]{id,title,status}:");
    expect(decode(rendered)).toEqual(value);
  });

  it("keeps short mixed and nested arrays on the standard expanded TOON path", () => {
    const value = { items: [{ id: "pm-1" }, { id: "pm-2", nested: [1] }] };
    const rendered = outputTestOnly.renderToonValue(value, 0);
    expect(rendered).not.toContain("items_encoding");
    expect(decode(rendered)).toEqual(value);
    expect(decode(outputTestOnly.renderToonValue(value.items, 0))).toEqual(
      value.items,
    );
  });

  it("suppresses row contracts by default and restores an encoding-aware contract explicitly", () => {
    const result = { items: [{ id: "pm-1", title: "One" }] };

    expect(attachReadOutputContracts("list", {}, result)).toEqual(result);
    expect(
      attachReadOutputContracts("list", { outputRowContract: true }, result),
    ).toMatchObject({
      row_contract: {
        command: "list",
        row_keys: ["items"],
        toon_encoding: "tabular_when_uniform",
      },
    });
  });

  it("reuses the enforced context intent ceiling without duplicating budget receipts", () => {
    const source = { low_level: [{ id: "pm-one", title: "One" }] };
    const result = attachReadOutputContracts(
      "context",
      applyContextIntentProjection("context", { for: "orient" }),
      source,
    );
    expect(result.context_intent).toMatchObject({
      command: "context",
      token_budget: 3000,
      within_budget: true,
    });
    expect(result.read_output).toBeUndefined();
    const session = attachReadOutputContracts(
      "context",
      applyContextIntentProjection("context", {
        for: "orient",
        outputSession: {
          version: 1,
          id: "orientation",
          token_budget: 20000,
          spent_tokens: 0,
          seen_item_ids: [],
        },
      }),
      source,
    );
    expect(session.read_output).not.toHaveProperty("budget_source");
    expect(session.read_output).not.toHaveProperty("budget_tokens");
    expect(session.read_output?.estimated_tokens).toBe(
      Math.ceil(Buffer.byteLength(JSON.stringify(session)) / 4),
    );
  });

  it("keeps compatibility budget evidence when an existing intent receipt differs or is unenforced", () => {
    for (const receipt of [
      null,
      { command: "search", token_budget: 800, within_budget: true },
      { command: "context", token_budget: 900, within_budget: true },
      { command: "context", token_budget: 800, within_budget: false },
    ]) {
      const result = applyReadOutputDimensions(
        "context",
        { tokenBudget: 800 },
        {
          low_level: [{ id: "pm-one", title: "One" }],
          context_intent: receipt,
        },
      );
      expect(result.read_output).toMatchObject({
        budget_source: "legacy",
        budget_tokens: 800,
        within_budget: true,
      });
      expect(result.low_level).toEqual([{ id: "pm-one", title: "One" }]);
    }
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
        {
          id: "pm-1",
          op: "update",
          ts: "2026-08-11T02:00:00.000Z",
          author: "a",
          patch: [],
          before_hash: "",
          after_hash: "",
        },
        {
          id: "pm-1",
          op: "comment_add",
          ts: "2026-08-11T01:00:00.000Z",
          author: "a",
          patch: [],
          before_hash: "",
          after_hash: "",
        },
        {
          id: "pm-2",
          op: "create",
          ts: "2026-08-11T00:30:00.000Z",
          author: "b",
          patch: [],
          before_hash: "",
          after_hash: "",
        },
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

  it("discloses operation-count truncation and the omitted event count", () => {
    expect(
      activityInternals.activityOperationCounts([
        { op: "a" },
        { op: "a" },
        { op: "b" },
        { op: "c" },
        { op: "d" },
        { op: "e" },
        { op: "f" },
        { op: "g" },
        { op: "h" },
        { op: "i" },
        { op: "i" },
        { op: "j" },
      ]),
    ).toEqual({
      a: 2,
      i: 2,
      b: 1,
      c: 1,
      d: 1,
      e: 1,
      f: 1,
      g: 1,
      "+2": 2,
    });
  });
});
