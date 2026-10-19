import { describe, expect, it } from "vitest";
import { formatBuiltInOutput } from "../../../src/core/output/output.js";
import {
  formatCommanderErrorForDisplay,
  formatCommanderErrorForJson,
} from "../../../src/cli/error-guidance.js";
import { attachReadOutputContracts } from "../../../src/sdk/context-intent-contracts.js";
import { projectPmBriefListEnvelope } from "../../../src/sdk/output.js";

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
  it.each([
    null,
    [],
    {},
    { ...completeList, items: null },
    { ...completeList, projection: null },
    {
      ...completeList,
      projection: { mode: "brief", fields: "id,status,type,title" },
    },
    { ...completeList, projection: { mode: "brief", fields: ["id"] } },
    {
      ...completeList,
      projection: { ...completeList.projection, evidence: "keep" },
    },
    { ...completeList, completeness: null },
    {
      ...completeList,
      completeness: {
        ...completeList.completeness,
        status: { toString: () => "complete" },
      },
    },
    {
      ...completeList,
      completeness: { ...completeList.completeness, status: "partial" },
    },
    { ...completeList, has_more: undefined },
    { ...completeList, truncated: true },
    { ...completeList, count: 2 },
    { ...completeList, total: "3" },
    { ...completeList, total: 3.5 },
    { ...completeList, total: 4 },
    { ...completeList, next_cursor: "unexpected" },
    { ...completeList, has_more: true, truncated: true },
    { ...completeList, total: 4, has_more: true, truncated: true },
    {
      ...completeList,
      total: 4,
      has_more: true,
      truncated: true,
      next_cursor: "",
    },
    { ...completeList, omission_receipt: null },
    {
      ...completeList,
      omission_receipt: {
        ...completeList.omission_receipt,
        omitted_field_groups: null,
      },
    },
    {
      ...completeList,
      omission_receipt: {
        ...completeList.omission_receipt,
        omitted_field_groups: [],
      },
    },
    {
      ...completeList,
      omission_receipt: {
        ...completeList.omission_receipt,
        omitted_field_groups: [null],
      },
    },
    {
      ...completeList,
      omission_receipt: {
        ...completeList.omission_receipt,
        omitted_field_groups: [{ name: "full_item_fields" }],
      },
    },
    {
      ...completeList,
      omission_receipt: {
        ...completeList.omission_receipt,
        omitted_field_groups: [
          { name: "full_item_fields", restore_with: "other" },
        ],
      },
    },
    {
      ...completeList,
      omission_receipt: {
        ...completeList.omission_receipt,
        has_omissions: false,
      },
    },
    {
      ...completeList,
      omission_receipt: {
        ...completeList.omission_receipt,
        omitted_field_group_count: 2,
      },
    },
    {
      ...completeList,
      omission_receipt: { ...completeList.omission_receipt, evidence: "keep" },
    },
  ])("leaves unsupported or inconsistent SDK envelopes intact: %j", (value) => {
    expect(projectPmBriefListEnvelope(value)).toBe(value);
  });

  it("preserves producer metadata and does not mutate the input SDK receipt", () => {
    const value = structuredClone(completeList);
    const before = structuredClone(value);
    expect(projectPmBriefListEnvelope(value)).toMatchObject({
      details: "--full",
    });
    expect(value).toEqual(before);
    const source = {
      ...completeList.completeness,
      evidence: "provider evidence",
    };
    const sort = { ...completeList.sorting, evidence: "sort evidence" };
    expect(
      projectPmBriefListEnvelope({
        ...value,
        completeness: source,
        sorting: sort,
      }),
    ).toMatchObject({
      completeness: { status: "complete", evidence: "provider evidence" },
      sorting: sort,
    });
    expect(
      projectPmBriefListEnvelope({ ...value, sorting: null }),
    ).toMatchObject({ sorting: null });
    expect(
      projectPmBriefListEnvelope({
        ...value,
        sorting: { sort: "default", order: "desc" },
      }),
    ).toMatchObject({ sorting: { sort: "default", order: "desc" } });
    expect(
      projectPmBriefListEnvelope({
        ...value,
        items: [],
        count: 0,
        total: 0,
        completeness: { ...value.completeness, status: "unchecked" },
      }),
    ).toMatchObject({
      items: [],
      count: 0,
      total: 0,
      has_more: false,
      completeness: { status: "unchecked" },
    });
    expect(
      projectPmBriefListEnvelope({
        ...value,
        total: 4,
        has_more: true,
        truncated: true,
        next_cursor: "next",
      }),
    ).toMatchObject({
      completeness: { status: "complete" },
      next_cursor: "next",
    });
  });

  it("compacts bounded unchecked brief lists while retaining honest source and continuation evidence", () => {
    const value = {
      ...completeList,
      total: 12,
      applied_limit: 3,
      has_more: true,
      truncated: true,
      next_cursor: "continue-after-three",
      completeness: { ...completeList.completeness, status: "unchecked" },
      filters: { status: "open", limit: "3" },
    };
    const text = formatBuiltInOutput(value, "toon");
    expect(text).toContain('status: "unchecked"');
    expect(text).toContain('next_cursor: "continue-after-three"');
    expect(text).toContain("total: 12");
    expect(text).toContain("has_more: true");
    expect(text).not.toContain("projection:");
    expect(text).not.toContain("sorting:");
    expect(text).not.toContain("now:");
    expect(text).not.toContain("unreadable_item_count: 0");
    expect(text).toContain('details: "--full"');
    expect(JSON.parse(formatBuiltInOutput(value, "json"))).toEqual(value);
  });

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
