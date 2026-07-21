import { describe, expect, it } from "vitest";
import {
  isExternalDependencySourceKind,
  normalizeDependencySeedId,
  normalizeDependencySourceKind,
} from "../../../src/sdk/dependency-provenance.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

interface FullItemPayload {
  item: {
    id: string;
    dependencies?: Array<{
      id: string;
      kind: string;
      source_kind?: string;
    }>;
  };
}

describe("dependency provenance contracts", () => {
  it("preserves explicit external ids while retaining local prefix normalization", () => {
    expect(isExternalDependencySourceKind(" GLOBAL ")).toBe(true);
    expect(isExternalDependencySourceKind("imported")).toBe(false);
    expect(normalizeDependencySourceKind(" GLOBAL ")).toBe("global");
    expect(normalizeDependencySourceKind(" imported ")).toBe("imported");
    expect(normalizeDependencySourceKind("   ")).toBeUndefined();
    expect(normalizeDependencySeedId(" foreign-work ", "pm", "global")).toBe(
      "foreign-work",
    );
    expect(normalizeDependencySeedId(" local-work ", "pm", undefined)).toBe(
      "pm-local-work",
    );
  });

  it("round-trips global dependency provenance through create, graph, update, and get", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Cross-workspace consumer",
          "--description",
          "Keeps a dependency owned by another workspace",
          "--type",
          "Task",
          "--id",
          "local-consumer",
          "--dep",
          "id=Foreign-Alpha,kind=related,source_kind=GLOBAL",
          "--author",
          "provenance-spec",
          "--message",
          "Create external relationship",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const createdPayload = created.json as {
        id?: string;
        item?: { id?: string };
      };
      const id = createdPayload.id ?? createdPayload.item?.id;
      expect(id).toBeTypeOf("string");

      const read = context.runCli(["get", id!, "--full", "--json"], {
        expectJson: true,
      });
      expect((read.json as FullItemPayload).item.dependencies).toEqual([
        expect.objectContaining({
          id: "foreign-alpha",
          kind: "related",
          source_kind: "global",
        }),
      ]);

      const duplicate = context.runCli([
        "update",
        id!,
        "--dep",
        "id=foreign-alpha,kind=related,source_kind=global",
        "--author",
        "provenance-spec",
        "--message",
        "Verify case-insensitive external relationship identity",
        "--json",
      ]);
      expect(duplicate.code).toBe(0);
      const afterDuplicate = context.runCli(["get", id!, "--full", "--json"], {
        expectJson: true,
      });
      expect(
        (afterDuplicate.json as FullItemPayload).item.dependencies,
      ).toHaveLength(1);

      const graph = context.runCli(["graph", "audit", "--json"], {
        expectJson: true,
      });
      expect(graph.code).toBe(0);
      expect(
        (graph.json as { profile: { nodes: number; missing_nodes: number } })
          .profile,
      ).toMatchObject({ nodes: 2, missing_nodes: 0 });

      const removed = context.runCli([
        "update",
        id!,
        "--dep-remove",
        "id=FOREIGN-ALPHA,kind=related,source_kind=GlObAl",
        "--author",
        "provenance-spec",
        "--message",
        "Remove external relationship",
        "--json",
      ]);
      expect(removed.code).toBe(0);
      const afterRemoval = context.runCli(["get", id!, "--full", "--json"], {
        expectJson: true,
      });
      expect(
        (afterRemoval.json as FullItemPayload).item.dependencies,
      ).toBeUndefined();

      const added = context.runCli([
        "update",
        id!,
        "--dep",
        "id=foreign-beta,kind=related,source_kind=global",
        "--author",
        "provenance-spec",
        "--message",
        "Add a second external relationship",
        "--json",
      ]);
      expect(added.code).toBe(0);
      const finalRead = context.runCli(["get", id!, "--full", "--json"], {
        expectJson: true,
      });
      expect((finalRead.json as FullItemPayload).item.dependencies).toEqual([
        expect.objectContaining({
          id: "foreign-beta",
          kind: "related",
          source_kind: "global",
        }),
      ]);
    });
  });
});
