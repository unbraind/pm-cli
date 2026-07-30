import { describe, expect, it } from "vitest";
import { analyzeGraphImpact } from "../../../src/sdk/relationship-analytics.js";
import { RelationshipGraph } from "../../../src/sdk/relationships.js";

describe("relationship impact zero-row pagination", () => {
  it("returns a resumable cursor when a zero limit truncates the first page", () => {
    const graph = new RelationshipGraph(
      ["root", "child"],
      [{ source: "root", target: "child", kind: "related_to" }],
    );
    const emptyPage = analyzeGraphImpact(graph, "root", { limit: 0 });

    expect(emptyPage).toMatchObject({
      affected: [],
      truncated: true,
      nextCursor: expect.any(String),
    });
    expect(
      analyzeGraphImpact(graph, "root", {
        limit: 1,
        after: emptyPage.nextCursor,
      }),
    ).toMatchObject({
      affected: [{ id: "child", path: ["root", "child"] }],
    });
  });
});
