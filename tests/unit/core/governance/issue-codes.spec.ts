import { describe, expect, it } from "vitest";
import {
  extractIssueCode,
  findDuplicateIssueCodes,
  type IssueCodeItem,
} from "../../../../src/core/governance/issue-codes.js";

describe("extractIssueCode", () => {
  it("extracts a conventional leading code with various separators", () => {
    expect(extractIssueCode("ISSUE-004: fix the bug")).toBe("ISSUE-004");
    expect(extractIssueCode("BUG-12 something")).toBe("BUG-12");
    expect(extractIssueCode("TASK-7 — do it")).toBe("TASK-7");
    expect(extractIssueCode("ADR-001")).toBe("ADR-001");
    expect(extractIssueCode("RFC-9: proposal")).toBe("RFC-9");
    expect(extractIssueCode("GH-235 detect dupes")).toBe("GH-235");
    expect(extractIssueCode("PM2-14: alphanumeric prefix")).toBe("PM2-14");
  });

  it("normalizes case and surrounding whitespace to an upper-case code", () => {
    expect(extractIssueCode("  issue-004: lowercase ")).toBe("ISSUE-004");
    expect(extractIssueCode("Bug-12")).toBe("BUG-12");
  });

  it("respects the trailing word boundary after the digit run", () => {
    // A letter directly after the digits is NOT a word boundary, so no match.
    expect(extractIssueCode("ISSUE-004foo")).toBeNull();
    // A separator after the digits IS a boundary, so the code prefix extracts.
    expect(extractIssueCode("ISSUE-004-extra")).toBe("ISSUE-004");
  });

  it("returns null when no leading code is present", () => {
    expect(extractIssueCode("just a plain title")).toBeNull();
    expect(extractIssueCode("fix ISSUE-004 later")).toBeNull(); // not at start
    expect(extractIssueCode("ISSUE: no number")).toBeNull();
    expect(extractIssueCode("123-456 starts with digit")).toBeNull();
    expect(extractIssueCode("-9 leading separator")).toBeNull();
  });

  it("returns null for empty, whitespace-only, or non-string input", () => {
    expect(extractIssueCode("")).toBeNull();
    expect(extractIssueCode("   ")).toBeNull();
    expect(extractIssueCode(null)).toBeNull();
    expect(extractIssueCode(undefined)).toBeNull();
    expect(extractIssueCode(42 as unknown as string)).toBeNull();
  });
});

describe("findDuplicateIssueCodes", () => {
  it("flags codes shared by two or more items, sorted with sorted ids/titles", () => {
    const items: IssueCodeItem[] = [
      { id: "pm-bbb", title: "ISSUE-004: second" },
      { id: "pm-aaa", title: "issue-004: first (lowercase)" },
      { id: "pm-ccc", title: "BUG-12: only one" },
      { id: "pm-ddd", title: "ADR-1: duplicate adr" },
      { id: "pm-eee", title: "ADR-1: another adr" },
    ];
    const result = findDuplicateIssueCodes(items);
    expect(result).toEqual([
      {
        code: "ADR-1",
        count: 2,
        ids: ["pm-ddd", "pm-eee"],
        titles: ["ADR-1: duplicate adr", "ADR-1: another adr"],
      },
      {
        code: "ISSUE-004",
        count: 2,
        ids: ["pm-aaa", "pm-bbb"],
        titles: ["issue-004: first (lowercase)", "ISSUE-004: second"],
      },
    ]);
  });

  it("returns an empty array when every code is unique or absent", () => {
    expect(
      findDuplicateIssueCodes([
        { id: "pm-1", title: "ISSUE-1" },
        { id: "pm-2", title: "ISSUE-2" },
        { id: "pm-3", title: "no code here" },
      ]),
    ).toEqual([]);
    expect(findDuplicateIssueCodes([])).toEqual([]);
  });

  it("does not let a repeated id inflate its own code count, and tolerates missing titles", () => {
    const items: IssueCodeItem[] = [
      { id: "pm-dup", title: "ISSUE-5: a" },
      { id: "pm-dup", title: "ISSUE-5: a-again-same-id" },
      { id: "pm-other", title: null },
    ];
    expect(findDuplicateIssueCodes(items)).toEqual([]);
  });

  it("flags codes across different items regardless of status (status is not considered)", () => {
    const items: IssueCodeItem[] = [
      { id: "pm-open", title: "TASK-9: open work" },
      { id: "pm-closed", title: "TASK-9: closed dup" },
    ];
    const result = findDuplicateIssueCodes(items);
    expect(result).toEqual([
      {
        code: "TASK-9",
        count: 2,
        ids: ["pm-closed", "pm-open"],
        titles: ["TASK-9: closed dup", "TASK-9: open work"],
      },
    ]);
  });

  it("backfills an empty title string when a contributing item has a non-string title", () => {
    const items: IssueCodeItem[] = [
      { id: "pm-a", title: "RFC-3: real title" },
      // undefined title cannot contribute a code, so add a second real one:
      { id: "pm-b", title: "RFC-3: second" },
    ];
    const result = findDuplicateIssueCodes(items);
    expect(result[0].titles).toEqual(["RFC-3: real title", "RFC-3: second"]);
  });

  // GH-278: a closed-as-duplicate item is already adjudicated and must not collide.
  it("excludes an item with a non-empty duplicate_of so its code no longer collides", () => {
    const items: IssueCodeItem[] = [
      { id: "pm-keep", title: "BUG-7: canonical" },
      { id: "pm-dup", title: "BUG-7: closed as dup", duplicate_of: "pm-keep" },
    ];
    expect(findDuplicateIssueCodes(items)).toEqual([]);
  });

  it("does NOT exclude an item whose duplicate_of is empty or whitespace (still collides)", () => {
    const items: IssueCodeItem[] = [
      { id: "pm-a", title: "BUG-8: first", duplicate_of: "" },
      { id: "pm-b", title: "BUG-8: second", duplicate_of: "   " },
    ];
    const result = findDuplicateIssueCodes(items);
    expect(result).toEqual([
      {
        code: "BUG-8",
        count: 2,
        ids: ["pm-a", "pm-b"],
        titles: ["BUG-8: first", "BUG-8: second"],
      },
    ]);
  });

  // GH-275: PARENT + PARENT-T0n breakdown convention is intentional, not a collision.
  it("does not flag a child whose parent is another item sharing the same code", () => {
    const items: IssueCodeItem[] = [
      { id: "pm-parent", title: "TASK-3: parent epic" },
      { id: "pm-child", title: "TASK-3: child breakdown", parent: "pm-parent" },
    ];
    expect(findDuplicateIssueCodes(items)).toEqual([]);
  });

  it("does not flag a parent with several children all carrying the shared code", () => {
    const items: IssueCodeItem[] = [
      { id: "pm-parent", title: "TASK-4: parent" },
      { id: "pm-c1", title: "TASK-4: child one", parent: "pm-parent" },
      { id: "pm-c2", title: "TASK-4: child two", parent: "pm-parent" },
      { id: "pm-c3", title: "TASK-4: child three", parent: "pm-parent" },
    ];
    expect(findDuplicateIssueCodes(items)).toEqual([]);
  });

  it("still flags a genuine collision when neither item is the parent of the other", () => {
    const items: IssueCodeItem[] = [
      { id: "pm-x", title: "TASK-5: independent one", parent: null },
      { id: "pm-y", title: "TASK-5: independent two", parent: "pm-outside" },
    ];
    const result = findDuplicateIssueCodes(items);
    expect(result).toEqual([
      {
        code: "TASK-5",
        count: 2,
        ids: ["pm-x", "pm-y"],
        titles: ["TASK-5: independent one", "TASK-5: independent two"],
      },
    ]);
  });

  it("counts a child whose parent points to an id not in the group (parent outside)", () => {
    const items: IssueCodeItem[] = [
      { id: "pm-a", title: "TASK-6: first" },
      { id: "pm-b", title: "TASK-6: second", parent: "pm-elsewhere" },
    ];
    const result = findDuplicateIssueCodes(items);
    expect(result).toEqual([
      {
        code: "TASK-6",
        count: 2,
        ids: ["pm-a", "pm-b"],
        titles: ["TASK-6: first", "TASK-6: second"],
      },
    ]);
  });

  it("treats an empty/whitespace parent string as no parent (still collides)", () => {
    const items: IssueCodeItem[] = [
      { id: "pm-a", title: "TASK-7: first", parent: "" },
      { id: "pm-b", title: "TASK-7: second", parent: "   " },
    ];
    const result = findDuplicateIssueCodes(items);
    expect(result).toEqual([
      {
        code: "TASK-7",
        count: 2,
        ids: ["pm-a", "pm-b"],
        titles: ["TASK-7: first", "TASK-7: second"],
      },
    ]);
  });

  it("trims a padded parent reference before comparing it to group ids", () => {
    const items: IssueCodeItem[] = [
      { id: "pm-parent", title: "TASK-8: parent" },
      { id: "pm-child", title: "TASK-8: child", parent: "  pm-parent  " },
    ];
    expect(findDuplicateIssueCodes(items)).toEqual([]);
  });

  it("resolves a mixed group: closed-dup excluded, child collapsed, two genuine dups survive", () => {
    const items: IssueCodeItem[] = [
      { id: "pm-parent", title: "TASK-10: parent epic" },
      { id: "pm-child", title: "TASK-10: child breakdown", parent: "pm-parent" },
      { id: "pm-closeddup", title: "TASK-10: closed as dup", duplicate_of: "pm-parent" },
      { id: "pm-indep", title: "TASK-10: independent dup", parent: null },
    ];
    const result = findDuplicateIssueCodes(items);
    expect(result).toEqual([
      {
        code: "TASK-10",
        count: 2,
        ids: ["pm-indep", "pm-parent"],
        titles: ["TASK-10: independent dup", "TASK-10: parent epic"],
      },
    ]);
  });
});
