import { describe, expect, it } from "vitest";
import { analyzeGraphImpact } from "../../../src/sdk/relationship-analytics.js";
import { RelationshipGraph } from "../../../src/sdk/relationships.js";
import {
  createQueryFingerprint,
  encodeQueryCursor,
} from "../../../src/sdk/pagination.js";

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

  it("keeps storage-direction impact branches separate for associative edges", () => {
    const graph = new RelationshipGraph(
      ["epic-1", "epic-2", "request-a", "request-b", "shared"],
      [
        { source: "request-a", target: "epic-1", kind: "related_to" },
        { source: "request-b", target: "epic-2", kind: "related_to" },
        { source: "shared", target: "epic-1", kind: "related_to" },
        { source: "shared", target: "epic-2", kind: "related_to" },
      ],
    );

    expect(
      analyzeGraphImpact(graph, "epic-1", { direction: "incoming" }).affected,
    ).toEqual([
      { id: "request-a", distance: 1, path: ["epic-1", "request-a"] },
      { id: "shared", distance: 1, path: ["epic-1", "shared"] },
    ]);
    expect(
      analyzeGraphImpact(graph, "epic-1", { direction: "outgoing" }).affected,
    ).toEqual([]);
    expect(
      analyzeGraphImpact(graph, "epic-1", { direction: "both" }).affected,
    ).toEqual([
      { id: "request-a", distance: 1, path: ["epic-1", "request-a"] },
      { id: "shared", distance: 1, path: ["epic-1", "shared"] },
    ]);

    const firstBothPage = analyzeGraphImpact(graph, "epic-1", {
      direction: "both",
      limit: 1,
    });
    expect(firstBothPage).toMatchObject({
      affected: [{ id: "request-a" }],
      truncated: true,
      nextCursor: expect.any(String),
    });
    expect(
      analyzeGraphImpact(graph, "epic-1", {
        direction: "both",
        limit: 0,
      }),
    ).toMatchObject({
      affected: [],
      truncated: true,
      nextCursor: expect.any(String),
    });
    expect(
      analyzeGraphImpact(graph, "epic-1", {
        direction: "both",
        after: firstBothPage.nextCursor,
      }).affected,
    ).toEqual([{ id: "shared", distance: 1, path: ["epic-1", "shared"] }]);
    expect(() =>
      analyzeGraphImpact(graph, "epic-1", {
        direction: "both",
        after: encodeQueryCursor(
          createQueryFingerprint("graph impact", {
            root: "epic-1",
            direction: "both",
            kinds: [],
            max_depth: "unbounded",
          }),
          "unknown",
        ),
      }),
    ).toThrow("Unknown impact cursor item: unknown");
    expect(() =>
      analyzeGraphImpact(graph, "epic-1", {
        direction: "incoming",
        after: encodeQueryCursor(
          createQueryFingerprint("graph impact", {
            root: "epic-1",
            direction: "incoming",
            kinds: [],
            max_depth: "unbounded",
          }),
          "unknown",
        ),
      }),
    ).toThrow("Unknown impact cursor item: unknown");
    expect(
      analyzeGraphImpact(graph, "epic-1", {
        direction: "incoming",
        kinds: ["discovered_from"],
      }).affected,
    ).toEqual([]);

    const overlap = new RelationshipGraph(
      ["root", "outgoing-step", "shared-deep", "shared-peer"],
      [
        {
          source: "root",
          target: "outgoing-step",
          kind: "discovered_from",
        },
        {
          source: "outgoing-step",
          target: "shared-deep",
          kind: "discovered_from",
        },
        {
          source: "shared-deep",
          target: "root",
          kind: "discovered_from",
        },
        {
          source: "root",
          target: "shared-peer",
          kind: "discovered_from",
        },
        {
          source: "shared-peer",
          target: "root",
          kind: "discovered_from",
        },
      ],
    );
    expect(
      analyzeGraphImpact(overlap, "root", { direction: "both" }).affected,
    ).toEqual([
      { id: "outgoing-step", distance: 1, path: ["root", "outgoing-step"] },
      { id: "shared-deep", distance: 1, path: ["root", "shared-deep"] },
      { id: "shared-peer", distance: 1, path: ["root", "shared-peer"] },
    ]);
    expect(
      analyzeGraphImpact(
        new RelationshipGraph(
          ["root", "outgoing-only"],
          [
            {
              source: "root",
              target: "outgoing-only",
              kind: "discovered_from",
            },
          ],
        ),
        "root",
        { direction: "both", maxDepth: 0 },
      ).truncated,
    ).toBe(true);
  });
});
