import { describe, expect, it } from "vitest";
import { formatBuiltInOutput } from "../../../src/core/output/output.js";
import {
  formatCommanderErrorForDisplay,
  formatCommanderErrorForJson,
} from "../../../src/cli/error-guidance.js";
import { attachReadOutputContracts } from "../../../src/sdk/context-intent-contracts.js";

const completeList = {
  items: ["one", "two", "three"].map((title, index) => ({
    id: `pm-${index}`,
    status: "open",
    type: "Task",
    title,
  })),
  count: 3,
  total: 3,
  has_more: false,
  truncated: false,
  next_cursor: null,
  completeness: {
    status: "complete",
    unreadable_item_count: 0,
    unreadable_directory_count: 0,
  },
  filters: { runtime_filters: {} },
  projection: { mode: "brief", fields: ["id", "status", "type", "title"] },
  sorting: { sort: "default", order: "asc" },
  now: "2026-09-13T00:00:00Z",
  omission_receipt: {
    has_omissions: true,
    omitted_field_group_count: 1,
    omitted_field_groups: [
      { name: "full_item_fields", restore_with: "--full" },
    ],
  },
};

describe("compact agent presentation", () => {
  it("renders nested search facts in a declared table without changing JSON", () => {
    const value = {
      query: "test",
      items: Array.from({ length: 10 }, (_, index) => ({
        id: `pm-${index}`,
        title: "Preserve facts",
        matched_fields: ["title", "notes"],
      })),
    };
    expect(formatBuiltInOutput(value, "toon")).toContain(
      "items[10]{id,title,matched_fields}",
    );
    expect(JSON.parse(formatBuiltInOutput(value, "json"))).toEqual(value);
  });

  it.each(["json", "toon"] as const)(
    "enforces the context legacy budget on its complete %s envelope",
    (format) => {
      const value = {
        high_level: [],
        low_level: [{ id: "pm-a", title: "Short" }],
        agenda: {
          events: Array.from({ length: 10 }, (_, i) => ({
            id: `event-${i}`,
            description: "Envelope fact ".repeat(20),
          })),
        },
      };
      const result = attachReadOutputContracts(
        "context",
        { tokenBudget: 800, resolvedOutputFormat: format },
        value,
      );
      const estimated = Math.ceil(
        Buffer.byteLength(formatBuiltInOutput(result, format)) / 4,
      );
      expect(estimated).toBeLessThanOrEqual(800);
      expect(result).toMatchObject({
        read_output: { estimated_tokens: estimated, within_budget: true },
      });
    },
  );
  it("renders complete brief lists in six lines and retains full JSON receipts", () => {
    const text = formatBuiltInOutput(completeList, "toon");
    expect(text.trim().split("\n")).toHaveLength(6);
    expect(text).toContain("--full");
    expect(JSON.parse(formatBuiltInOutput(completeList, "json"))).toEqual(
      completeList,
    );
  });

  it.each([
    { has_more: true, truncated: true, next_cursor: "next" },
    { completeness: { status: "partial", unreadable_item_count: 1 } },
    { projection: { mode: "full", fields: null } },
    {
      completeness: {
        status: "complete",
        unreadable_item_count: 1,
        unreadable_directory_count: 0,
      },
    },
    {
      completeness: {
        status: "complete",
        unreadable_item_count: 0,
        unreadable_directory_count: 1,
      },
    },
    { count: 2 },
    { total: 4 },
    {
      omission_receipt: {
        omitted_field_groups: [{ name: "additional", restore_with: "--full" }],
      },
    },
  ])(
    "retains detailed receipts for non-default or incomplete output %j",
    (changes) => {
      expect(
        formatBuiltInOutput({ ...completeList, ...changes }, "toon"),
      ).toContain("completeness:");
    },
  );

  it("keeps selected filters, sorting, warnings, and extra producer diagnostics", () => {
    const output = formatBuiltInOutput(
      {
        ...completeList,
        filters: { status: "open" },
        sorting: { sort: "title", order: "desc" },
        warnings: ["source warning"],
        evidence: "retained",
      },
      "toon",
    );
    expect(output).toContain('status: "open"');
    expect(output).toContain('sort: "title"');
    expect(output).toContain('evidence: "retained"');
    expect(output).toContain("source warning");
  });

  it("preserves producer-owned details instead of replacing them with a recovery pointer", () => {
    const output = formatBuiltInOutput(
      { ...completeList, details: { provider: "extension diagnostic" } },
      "toon",
    );
    expect(output).toContain("extension diagnostic");
    expect(output).toContain("completeness:");
  });

  it("echoes long missing-id arguments once in text while preserving structured recovery", () => {
    const value = "a long description with meaningful context";
    const context = {
      attemptedCommand: `pm update --description '${value}'`,
      normalizedInvocationArgs: ["update", "--description", value],
    };
    const text = formatCommanderErrorForDisplay(
      "missing required argument 'id'",
      "update",
      "Task",
      context,
    );
    expect(text.split(value)).toHaveLength(2);
    const json = formatCommanderErrorForJson(
      "missing required argument 'id'",
      "update",
      "Task",
      2,
      context,
    );
    expect(json.recovery?.normalized_args).toEqual(
      context.normalizedInvocationArgs,
    );
  });
});
