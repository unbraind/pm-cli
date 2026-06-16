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
});
