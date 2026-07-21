import { describe, expect, it } from "vitest";
import {
  assembleWorkspaceRelationshipGraph,
  collectExternalDependencyTargetIds,
} from "../../../src/sdk/graph/assembly.js";

describe("external dependency graph assembly", () => {
  it("deduplicates external endpoints and materializes them without dangling findings", () => {
    const items = [
      {
        id: "pm-local",
        title: "Local consumer",
        status: "open" as const,
        dependencies: [
          null,
          { id: "", kind: "related", source_kind: "global" },
          { id: "Foreign-Z", kind: "related", source_kind: "global" },
          { id: "foreign-z", kind: "blocks", source_kind: "global" },
          { id: "foreign-a", kind: "related", source_kind: "global" },
          { id: "pm-local-missing", kind: "related" },
        ],
      },
    ];

    expect(collectExternalDependencyTargetIds(items as never)).toEqual([
      "foreign-a",
      "Foreign-Z",
    ]);
    const assembled = assembleWorkspaceRelationshipGraph(items as never);
    expect(assembled.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "Foreign-Z", status: "external" }),
        expect.objectContaining({ id: "foreign-a", status: "external" }),
        expect.objectContaining({
          id: "pm-local-missing",
          status: "missing",
        }),
      ]),
    );
    expect(assembled.dangling.active).toHaveLength(1);
    expect(assembled.graph.hasNode("Foreign-Z")).toBe(true);
  });

  it("keeps colliding local, missing, and external identities distinct", () => {
    const items = [
      {
        id: "pm-local",
        title: "Local consumer",
        status: "open" as const,
        dependencies: [
          { id: "pm-existing", kind: "related", source_kind: "global" },
          { id: "shared-target", kind: "related" },
          { id: "SHARED-TARGET", kind: "blocks", source_kind: "global" },
        ],
      },
      {
        id: "pm-existing",
        title: "Existing local target",
        status: "open" as const,
      },
    ];

    const assembled = assembleWorkspaceRelationshipGraph(items as never);
    expect(
      assembled.details.filter((detail) => detail.id === "pm-existing"),
    ).toHaveLength(1);
    expect(assembled.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "external:pm-existing",
          status: "external",
        }),
        expect.objectContaining({ id: "shared-target", status: "missing" }),
        expect.objectContaining({
          id: "external:SHARED-TARGET",
          status: "external",
        }),
      ]),
    );
    expect(new Set(assembled.graph.nodes()).size).toBe(
      assembled.graph.nodes().length,
    );
  });
});
