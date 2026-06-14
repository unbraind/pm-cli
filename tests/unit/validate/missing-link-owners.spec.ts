import { describe, expect, it } from "vitest";

import {
  buildMissingLinkedPathRows,
  summarizeMissingLinkedPathRows,
  type OwnerItemMetadata,
  type StaleLinkOwnerInput,
} from "../../../src/core/validate/missing-link-owners.js";

const noMetadata = (): OwnerItemMetadata | undefined => undefined;

describe("buildMissingLinkedPathRows", () => {
  it("returns an empty array for empty input", () => {
    expect(buildMissingLinkedPathRows([], noMetadata)).toEqual([]);
  });

  it("attaches owning-item metadata for a single owner", () => {
    const rows: StaleLinkOwnerInput[] = [
      { item_id: "pm-1", path: "docs/a.md", link_kind: "docs", classification: "deleted" },
    ];
    const lookup = (id: string): OwnerItemMetadata | undefined =>
      id === "pm-1" ? { type: "Task", title: "Alpha", status: "open" } : undefined;

    expect(buildMissingLinkedPathRows(rows, lookup)).toEqual([
      {
        path: "docs/a.md",
        classification: "deleted",
        items: [{ id: "pm-1", type: "Task", title: "Alpha", status: "open", field: "docs" }],
      },
    ]);
  });

  it("groups multiple distinct owners under one path sorted by id then field", () => {
    const rows: StaleLinkOwnerInput[] = [
      { item_id: "pm-2", path: "x/f.txt", link_kind: "files", classification: "deleted" },
      { item_id: "pm-1", path: "x/f.txt", link_kind: "docs", classification: "deleted" },
      { item_id: "pm-1", path: "x/f.txt", link_kind: "files", classification: "deleted" },
    ];
    const lookup = (id: string): OwnerItemMetadata => ({ type: "Task", title: id, status: "open" });

    const result = buildMissingLinkedPathRows(rows, lookup);
    expect(result).toHaveLength(1);
    expect(result[0].items.map((o) => `${o.id}:${o.field}`)).toEqual([
      "pm-1:docs",
      "pm-1:files",
      "pm-2:files",
    ]);
  });

  it("de-duplicates identical (id, field) owners for the same path", () => {
    const rows: StaleLinkOwnerInput[] = [
      { item_id: "pm-1", path: "a", link_kind: "files", classification: "deleted" },
      { item_id: "pm-1", path: "a", link_kind: "files", classification: "deleted" },
    ];
    const result = buildMissingLinkedPathRows(rows, () => ({ type: "Task", title: "t", status: "open" }));
    expect(result[0].items).toHaveLength(1);
  });

  it("prefers moved over deleted when a path's classifications disagree (existing then new)", () => {
    const rows: StaleLinkOwnerInput[] = [
      { item_id: "pm-1", path: "a", link_kind: "files", classification: "moved" },
      { item_id: "pm-2", path: "a", link_kind: "files", classification: "deleted" },
    ];
    expect(buildMissingLinkedPathRows(rows, noMetadata)[0].classification).toBe("moved");
  });

  it("prefers moved over deleted regardless of arrival order (new is moved)", () => {
    const rows: StaleLinkOwnerInput[] = [
      { item_id: "pm-1", path: "a", link_kind: "files", classification: "deleted" },
      { item_id: "pm-2", path: "a", link_kind: "files", classification: "moved" },
    ];
    expect(buildMissingLinkedPathRows(rows, noMetadata)[0].classification).toBe("moved");
  });

  it("keeps deleted when no row for the path is moved", () => {
    const rows: StaleLinkOwnerInput[] = [
      { item_id: "pm-1", path: "a", link_kind: "files", classification: "deleted" },
      { item_id: "pm-2", path: "a", link_kind: "files", classification: "deleted" },
    ];
    expect(buildMissingLinkedPathRows(rows, noMetadata)[0].classification).toBe("deleted");
  });

  it("falls back to Unknown/empty metadata when lookup returns undefined or partials", () => {
    const rows: StaleLinkOwnerInput[] = [
      { item_id: "pm-missing", path: "a", link_kind: "files", classification: "deleted" },
      { item_id: "pm-partial", path: "b", link_kind: "docs", classification: "deleted" },
    ];
    const lookup = (id: string): OwnerItemMetadata | undefined =>
      id === "pm-partial" ? { title: "only-title" } : undefined;

    const result = buildMissingLinkedPathRows(rows, lookup);
    expect(result[0].items[0]).toEqual({
      id: "pm-missing",
      type: "Unknown",
      title: "",
      status: "",
      field: "files",
    });
    expect(result[1].items[0]).toEqual({
      id: "pm-partial",
      type: "Unknown",
      title: "only-title",
      status: "",
      field: "docs",
    });
  });

  it("sorts paths ascending by localeCompare", () => {
    const rows: StaleLinkOwnerInput[] = [
      { item_id: "pm-1", path: "z/last", link_kind: "files", classification: "deleted" },
      { item_id: "pm-1", path: "a/first", link_kind: "files", classification: "deleted" },
      { item_id: "pm-1", path: "m/mid", link_kind: "files", classification: "deleted" },
    ];
    expect(buildMissingLinkedPathRows(rows, noMetadata).map((r) => r.path)).toEqual([
      "a/first",
      "m/mid",
      "z/last",
    ]);
  });
});

describe("summarizeMissingLinkedPathRows", () => {
  it("renders one line per owner in output order", () => {
    const rows: StaleLinkOwnerInput[] = [
      { item_id: "pm-2", path: "a", link_kind: "files", classification: "deleted" },
      { item_id: "pm-1", path: "a", link_kind: "docs", classification: "deleted" },
    ];
    const lookup = (id: string): OwnerItemMetadata => ({ type: "Task", title: id, status: "open" });

    expect(summarizeMissingLinkedPathRows(buildMissingLinkedPathRows(rows, lookup))).toEqual([
      'a:deleted owner=pm-1 status=open field=docs title="pm-1"',
      'a:deleted owner=pm-2 status=open field=files title="pm-2"',
    ]);
  });

  it("escapes backslashes and quotes in titles and renders empty status/title", () => {
    const rows: StaleLinkOwnerInput[] = [
      { item_id: "pm-1", path: "p", link_kind: "files", classification: "moved" },
    ];
    const lookup = (): OwnerItemMetadata => ({ type: "Task", title: 'a\\b "c"', status: "" });

    expect(summarizeMissingLinkedPathRows(buildMissingLinkedPathRows(rows, lookup))).toEqual([
      'p:moved owner=pm-1 status= field=files title="a\\\\b \\"c\\""',
    ]);
  });

  it("returns an empty array for no rows", () => {
    expect(summarizeMissingLinkedPathRows([])).toEqual([]);
  });
});
