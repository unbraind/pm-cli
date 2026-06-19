import { describe, expect, it } from "vitest";
import { renderRowsAsCsv, renderRowsAsTable } from "../../../../src/core/output/tabular.js";

describe("core/output/tabular", () => {
  describe("renderRowsAsCsv", () => {
    it("returns an empty string for no rows", () => {
      expect(renderRowsAsCsv([])).toBe("");
    });

    it("renders a header row plus one row per item", () => {
      const csv = renderRowsAsCsv([
        { id: "pm-1", title: "First", priority: 1 },
        { id: "pm-2", title: "Second", priority: 2 },
      ]);
      expect(csv).toBe("id,title,priority\npm-1,First,1\npm-2,Second,2");
    });

    it("escapes commas, quotes, and newlines per RFC 4180", () => {
      const csv = renderRowsAsCsv([{ title: 'Doc, with "quote"\nand newline' }]);
      expect(csv).toBe('title\n"Doc, with ""quote""\nand newline"');
    });

    it("joins arrays with semicolons and serializes objects as JSON", () => {
      const csv = renderRowsAsCsv([{ tags: ["a", "b"], meta: { k: 1 } }]);
      expect(csv).toBe("tags,meta\na;b,\"{\"\"k\"\":1}\"");
    });

    it("renders null/undefined cells as empty and unions columns across rows", () => {
      const csv = renderRowsAsCsv([
        { id: "pm-1", note: null },
        { id: "pm-2", extra: "x" },
      ]);
      expect(csv).toBe("id,note,extra\npm-1,,\npm-2,,x");
    });
  });

  describe("renderRowsAsTable", () => {
    it("returns an empty string for no rows", () => {
      expect(renderRowsAsTable([])).toBe("");
    });

    it("pads columns to their widest cell and underlines the header", () => {
      const table = renderRowsAsTable([
        { id: "pm-1", title: "Short" },
        { id: "pm-2", title: "A longer title" },
      ]);
      expect(table).toBe(
        ["id   | title         ", "-----+---------------", "pm-1 | Short         ", "pm-2 | A longer title"].join("\n"),
      );
    });

    it("flattens array and missing cells like the CSV renderer", () => {
      const table = renderRowsAsTable([{ tags: ["a", "b"], note: null }]);
      expect(table).toBe(["tags | note", "-----+-----", "a;b  |     "].join("\n"));
    });
  });
});
