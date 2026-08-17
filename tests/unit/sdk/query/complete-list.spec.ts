import { describe, expect, it } from "vitest";
import {
  PmCompleteListValidationError,
  assertCompleteListResult,
  certifyCompleteListResult,
  createCompleteListOptions,
  inspectCompleteListResult,
} from "../../../../src/sdk/query/complete-list.js";

const completeResult = () => ({
  items: [
    {
      id: "pm-open",
      title: "Open item",
      description: "",
      type: "Task",
      status: "open",
      priority: 2,
      tags: [],
      created_at: "2026-08-17T00:00:00.000Z",
      updated_at: "2026-08-17T00:00:00.000Z",
      author: "test",
    },
    {
      id: "pm-closed",
      title: "Closed item",
      description: "",
      type: "Task",
      status: "closed",
      priority: 2,
      tags: [],
      created_at: "2026-08-17T00:00:00.000Z",
      updated_at: "2026-08-17T00:00:00.000Z",
      author: "test",
    },
  ],
  count: 2,
  total: 2,
  has_more: false,
  next_cursor: null,
  truncated: false,
  completeness: {
    status: "complete" as const,
    unreadable_item_count: 0,
    unreadable_directory_count: 0,
  },
  filters: { status: "all", no_truncate: true, strict_read: true, runtime_filters: {} },
  projection: { mode: "full" as const, fields: null },
  sorting: { sort: "default" as const, order: "asc" as const },
  now: "2026-08-17T00:00:00.000Z",
});

describe("complete list SDK contract", () => {
  it("builds the canonical all-status, strict, unbounded request", () => {
    expect(createCompleteListOptions({ includeBody: true })).toEqual({
      excludeTerminal: false,
      full: true,
      includeBody: true,
      noTruncate: true,
      outputBudget: "unbounded",
      outputLimit: "unbounded",
      strictRead: true,
    });
    expect(createCompleteListOptions()).not.toHaveProperty("includeBody");
  });

  it("certifies a complete corpus with a typed proof", () => {
    const candidate = completeResult();
    assertCompleteListResult(candidate);
    const certified = certifyCompleteListResult(candidate);

    expect(certified.complete_list).toEqual({
      contract_version: 1,
      item_count: 2,
      unique_item_id_count: 2,
      terminal_items_included: true,
      source_complete: true,
      full_projection: true,
      no_omissions: true,
      unbounded: true,
    });
    expect(certified.items.map((item) => item.id)).toEqual([
      "pm-open",
      "pm-closed",
    ]);
  });

  it.each([
    ["invalid_envelope", null],
    ["source_incomplete", { completeness: { status: "partial", unreadable_item_count: 1, unreadable_directory_count: 0 } }],
    ["source_unchecked", { completeness: { status: "unchecked", unreadable_item_count: 0, unreadable_directory_count: 0 } }],
    ["source_unchecked", { completeness: undefined }],
    ["filtered_corpus", { filters: { status: "open", no_truncate: true, strict_read: true, runtime_filters: {} } }],
    ["filtered_corpus", { filters: null }],
    ["filtered_corpus", { filters: { status: "all", no_truncate: true, strict_read: true, runtime_filters: { severity: "critical" } } }],
    ["filtered_corpus", { filters: { status: "all", no_truncate: true, strict_read: true, runtime_filters: {}, priority: "1" } }],
    ["terminal_items_excluded", { filters: { status: "all", exclude_terminal: true, no_truncate: true, strict_read: true, runtime_filters: {} } }],
    ["strict_read_unproven", { filters: { status: "all", no_truncate: true, runtime_filters: {} } }],
    ["page_incomplete", { has_more: true, next_cursor: "cursor", truncated: true }],
    ["page_incomplete", { applied_limit: 20 }],
    ["count_mismatch", { count: 1 }],
    ["count_mismatch", { total: 3 }],
    ["projection_incomplete", { projection: { mode: "brief", fields: ["id"] } }],
    ["projection_incomplete", { projection: null }],
    ["field_omission", { omission_receipt: { has_omissions: true, omitted_field_group_count: 1, omitted_field_groups: [{ name: "full_item_fields", restore_with: "--full" }] } }],
    ["budget_compaction", { read_output: { within_budget: true, strings_compacted: false, rows_compacted: true, result_omitted: false } }],
    ["budget_compaction", { output_budget_truncation: { reason: "output_budget_reached" } }],
    ["budget_omission", { output_budget_exceeded: { omitted_result: true } }],
    ["session_projection", { read_session: { version: 1 } }],
    ["invalid_item_id", { items: [{ ...completeResult().items[0], id: " " }, completeResult().items[1]] }],
    ["invalid_item_id", { items: [null, completeResult().items[1]] }],
    ["duplicate_item_id", { items: [completeResult().items[0], { ...completeResult().items[1], id: "pm-open" }] }],
  ])("fails closed for %s", (code, override) => {
    const candidate =
      override === null
        ? override
        : { ...completeResult(), ...override };
    const report = inspectCompleteListResult(candidate);

    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain(code);
    expect(() => certifyCompleteListResult(candidate)).toThrow(
      PmCompleteListValidationError,
    );
    try {
      certifyCompleteListResult(candidate);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PmCompleteListValidationError);
      if (error instanceof PmCompleteListValidationError) {
        expect(error.receipt.recovery.suggested_retry).toContain(
          "pm list-all",
        );
      }
    }
  });
});
