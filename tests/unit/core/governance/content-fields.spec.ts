import { describe, expect, it } from "vitest";

import {
  CONTENT_FIELD_ORDER,
  computeContentFieldUtilization,
  contentFiltersNeedBody,
  contentFiltersNeedCollections,
  filterByContentFields,
  hasContentFieldFilter,
  isContentFieldPresent,
  itemMatchesContentFilters,
  type ContentField,
  type ContentFieldItem,
} from "../../../../src/core/governance/content-fields.js";

function item(overrides: Partial<ContentFieldItem> = {}): ContentFieldItem {
  return { ...overrides };
}

describe("CONTENT_FIELD_ORDER", () => {
  it("exposes the stable field order including derived fields", () => {
    expect(CONTENT_FIELD_ORDER).toEqual([
      "notes",
      "learnings",
      "files",
      "docs",
      "tests",
      "comments",
      "deps",
      "body",
      "linked_command",
    ]);
  });
});

describe("isContentFieldPresent", () => {
  const collectionFields: { field: ContentField; key: keyof ContentFieldItem }[] = [
    { field: "notes", key: "notes" },
    { field: "learnings", key: "learnings" },
    { field: "files", key: "files" },
    { field: "docs", key: "docs" },
    { field: "tests", key: "tests" },
    { field: "comments", key: "comments" },
    { field: "deps", key: "dependencies" },
  ];

  for (const { field, key } of collectionFields) {
    it(`reports ${field} present only for a non-empty array`, () => {
      expect(isContentFieldPresent(item(), field)).toBe(false);
      expect(isContentFieldPresent(item({ [key]: [] }), field)).toBe(false);
      expect(isContentFieldPresent(item({ [key]: ["x"] }), field)).toBe(true);
    });
  }

  it("maps deps to the dependencies array", () => {
    expect(isContentFieldPresent(item({ dependencies: [{ id: "pm-1" }] }), "deps")).toBe(true);
    expect(isContentFieldPresent(item({ dependencies: [] }), "deps")).toBe(false);
  });

  it("treats body as present only with non-whitespace content", () => {
    expect(isContentFieldPresent(item(), "body")).toBe(false);
    expect(isContentFieldPresent(item({ body: "" }), "body")).toBe(false);
    expect(isContentFieldPresent(item({ body: "   \n\t " }), "body")).toBe(false);
    expect(isContentFieldPresent(item({ body: "real" }), "body")).toBe(true);
  });

  it("detects linked_command from a non-empty test command", () => {
    expect(isContentFieldPresent(item(), "linked_command")).toBe(false);
    expect(isContentFieldPresent(item({ tests: [] }), "linked_command")).toBe(false);
    expect(isContentFieldPresent(item({ tests: [{ name: "t" }] }), "linked_command")).toBe(false);
    expect(isContentFieldPresent(item({ tests: [{ command: "" }] }), "linked_command")).toBe(false);
    expect(isContentFieldPresent(item({ tests: [{ command: "   " }] }), "linked_command")).toBe(false);
    expect(isContentFieldPresent(item({ tests: [{ command: "npm test" }] }), "linked_command")).toBe(true);
  });

  it("is tolerant of malformed test entries when reading linked_command", () => {
    expect(isContentFieldPresent(item({ tests: [null, 42, "str"] }), "linked_command")).toBe(false);
    expect(isContentFieldPresent(item({ tests: [{ command: 7 }] }), "linked_command")).toBe(false);
    expect(
      isContentFieldPresent(item({ tests: [{ name: "a" }, { command: "go test" }] }), "linked_command"),
    ).toBe(true);
  });
});

describe("hasContentFieldFilter / itemMatchesContentFilters", () => {
  it("reports no filter requested for an empty set", () => {
    expect(hasContentFieldFilter({})).toBe(false);
    expect(hasContentFieldFilter({ notes: "present" })).toBe(true);
    expect(hasContentFieldFilter({ body: "absent" })).toBe(true);
  });

  it("passes everything when no filter is requested", () => {
    expect(itemMatchesContentFilters(item(), {})).toBe(true);
    expect(itemMatchesContentFilters(item({ notes: ["n"] }), {})).toBe(true);
  });

  it("enforces present selections", () => {
    expect(itemMatchesContentFilters(item({ notes: ["n"] }), { notes: "present" })).toBe(true);
    expect(itemMatchesContentFilters(item(), { notes: "present" })).toBe(false);
  });

  it("enforces absent selections", () => {
    expect(itemMatchesContentFilters(item(), { notes: "absent" })).toBe(true);
    expect(itemMatchesContentFilters(item({ notes: ["n"] }), { notes: "absent" })).toBe(false);
  });

  it("ANDs across multiple requested fields", () => {
    const populated = item({ notes: ["n"], files: ["f"] });
    expect(itemMatchesContentFilters(populated, { notes: "present", files: "present" })).toBe(true);
    expect(itemMatchesContentFilters(populated, { notes: "present", body: "present" })).toBe(false);
    // mixed present/absent
    expect(
      itemMatchesContentFilters(item({ notes: ["n"] }), { notes: "present", files: "absent" }),
    ).toBe(true);
    expect(
      itemMatchesContentFilters(item({ notes: ["n"], files: ["f"] }), { notes: "present", files: "absent" }),
    ).toBe(false);
  });
});

describe("filterByContentFields", () => {
  it("returns a copy when no filter is requested", () => {
    const items = [item({ notes: ["n"] }), item()];
    const result = filterByContentFields(items, {});
    expect(result).toEqual(items);
    expect(result).not.toBe(items);
  });

  it("filters by content-field selections", () => {
    const items = [item({ notes: ["n"] }), item(), item({ notes: ["m"], files: ["f"] })];
    expect(filterByContentFields(items, { notes: "present" })).toHaveLength(2);
    expect(filterByContentFields(items, { notes: "absent" })).toHaveLength(1);
    expect(filterByContentFields(items, { notes: "present", files: "present" })).toHaveLength(1);
  });
});

describe("contentFiltersNeedCollections / contentFiltersNeedBody", () => {
  it("flags collection needs for any non-body field", () => {
    expect(contentFiltersNeedCollections({})).toBe(false);
    expect(contentFiltersNeedCollections({ body: "present" })).toBe(false);
    expect(contentFiltersNeedCollections({ notes: "present" })).toBe(true);
    expect(contentFiltersNeedCollections({ linked_command: "absent" })).toBe(true);
    expect(contentFiltersNeedCollections({ body: "present", deps: "absent" })).toBe(true);
  });

  it("flags body needs only when body is requested", () => {
    expect(contentFiltersNeedBody({})).toBe(false);
    expect(contentFiltersNeedBody({ notes: "present" })).toBe(false);
    expect(contentFiltersNeedBody({ body: "absent" })).toBe(true);
  });
});

describe("computeContentFieldUtilization", () => {
  it("reports 100% for every field when there are no items", () => {
    const report = computeContentFieldUtilization([]);
    expect(report.total_items).toBe(0);
    for (const field of CONTENT_FIELD_ORDER) {
      expect(report.fields[field]).toEqual({ present: 0, total: 0, percent: 100 });
    }
    expect(report.body_populated).toEqual({ present: 0, total: 0, percent: 100 });
    expect(report.empty_body).toEqual({ present: 0, total: 0, percent: 100 });
  });

  it("computes mixed utilization with rounded percentages", () => {
    const items: ContentFieldItem[] = [
      item({ notes: ["n"], body: "x", tests: [{ command: "npm t" }] }),
      item({ notes: ["m"], dependencies: [{ id: "pm-1" }] }),
      item(),
    ];
    const report = computeContentFieldUtilization(items);
    expect(report.total_items).toBe(3);
    expect(report.fields.notes).toEqual({ present: 2, total: 3, percent: 66.7 });
    expect(report.fields.deps).toEqual({ present: 1, total: 3, percent: 33.3 });
    expect(report.fields.body).toEqual({ present: 1, total: 3, percent: 33.3 });
    expect(report.fields.linked_command).toEqual({ present: 1, total: 3, percent: 33.3 });
    expect(report.fields.files).toEqual({ present: 0, total: 3, percent: 0 });
  });

  it("derives body_populated and empty_body aliases", () => {
    const items: ContentFieldItem[] = [item({ body: "x" }), item(), item({ body: "  " })];
    const report = computeContentFieldUtilization(items);
    expect(report.body_populated).toBe(report.fields.body);
    expect(report.body_populated).toEqual({ present: 1, total: 3, percent: 33.3 });
    // empty body: 2 of 3 (the blank-bodied and the missing-body items).
    expect(report.empty_body).toEqual({ present: 2, total: 3, percent: 66.7 });
  });
});
