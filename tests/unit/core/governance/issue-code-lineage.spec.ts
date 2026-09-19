import { describe, expect, it } from "vitest";
import { findDuplicateIssueCodes } from "../../../../src/core/governance/issue-codes.js";

describe("issue-code derivation lineage", () => {
  it.each(["discovered_from", "supersedes", "incident_from"])("accepts %s within the same code group", (kind) => {
    expect(findDuplicateIssueCodes([
      { id: "pm-first", title: "GH-209: first" },
      { id: "pm-next", title: "GH-209: next", dependencies: [{ id: " PM-FIRST ", kind }] },
    ])).toEqual([]);
  });

  it.each(["related", "implements", "blocks"])("does not mistake %s for derivation", (kind) => {
    expect(findDuplicateIssueCodes([
      { id: "pm-first", title: "GH-209: first" },
      { id: "pm-next", title: "GH-209: next", dependencies: [{ id: "pm-first", kind }] },
    ])[0]?.count).toBe(2);
  });

  it("retains self references and references outside the same-code group as collisions", () => {
    expect(findDuplicateIssueCodes([
      { id: "pm-first", title: "GH-209: first", dependencies: [{ id: "pm-first", kind: "discovered_from" }] },
      { id: "pm-next", title: "GH-209: next", dependencies: [{ id: "pm-other", kind: "discovered_from" }] },
      { id: "pm-other", title: "GH-210: other" },
    ])[0]?.ids).toEqual(["pm-first", "pm-next"]);
  });

  it("preserves an independent collision alongside a derived follow-up", () => {
    expect(findDuplicateIssueCodes([
      { id: "pm-first", title: "GH-209: first" },
      { id: "pm-next", title: "GH-209: next", dependencies: [{ id: "pm-first", kind: "discovered_from" }] },
      { id: "pm-other", title: "GH-209: independent" },
    ])[0]?.ids).toEqual(["pm-first", "pm-other"]);
  });
});

it("does not let cyclic derivation hide collisions beside an unrelated root", () => {
  expect(findDuplicateIssueCodes([
    { id: "pm-a", title: "GH-1: a", dependencies: [{ id: "pm-b", kind: "discovered_from" }] },
    { id: "pm-b", title: "GH-1: b", dependencies: [{ id: "pm-a", kind: "discovered_from" }] },
    { id: "pm-c", title: "GH-1: c" },
  ])[0]?.count).toBe(3);
});

it("resolves every predecessor before exempting a multi-source follow-up", () => {
  expect(findDuplicateIssueCodes([
    { id: "pm-a", title: "GH-1: a" },
    { id: "pm-b", title: "GH-1: b", dependencies: [{ id: "pm-a", kind: "discovered_from" }] },
    { id: "pm-c", title: "GH-1: c", dependencies: [{ id: "pm-a", kind: "discovered_from" }, { id: "pm-b", kind: "supersedes" }] },
  ])).toEqual([]);
});
