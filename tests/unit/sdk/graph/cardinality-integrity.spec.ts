/** @module tests/unit/sdk/graph/cardinality-integrity */
import { describe, expect, it } from "vitest";
import { assertNonHierarchyCardinalityMutationAllowed, RelationshipKindRegistry, type RelationshipCardinalityItem } from "../../../../src/sdk/graph.js";

import { relationshipKindNeedsIntegrityLock } from "../../../../src/sdk/graph/cardinality-integrity.js";

const registry = new RelationshipKindRegistry();
registry.register({ kind: "assigned_once", aliases: ["one_assignment"], direction: "directed", ordering: false, hierarchy: false,
  outgoing: "one", incoming: "one", lifecycle: "persistent", compatibilityVersion: 1, allowSelf: false });

/** Construct a minimal item projection, independent of persistence and provenance. */
function holder(targets: string[]): RelationshipCardinalityItem {
  return { id: "holder", dependencies: targets.map((id) => ({ id, kind: "one_assignment" })) };
}

describe("non-hierarchy cardinality comparison", () => {
  it("allows unchanged legacy debt, strict repairs and duplicate provenance rows", () => {
    const before = [holder(["a", "b", "c"])];
    expect(() => assertNonHierarchyCardinalityMutationAllowed(before, before, registry)).not.toThrow();
    expect(() => assertNonHierarchyCardinalityMutationAllowed(before, [holder(["a", "b"])], registry)).not.toThrow();
    expect(() => assertNonHierarchyCardinalityMutationAllowed([], [holder(["a", "a"])], registry)).not.toThrow();
    expect(() => assertNonHierarchyCardinalityMutationAllowed(before, [holder(["a", "new"])], registry)).toThrowError(
      expect.objectContaining({ code: "dependency_cardinality_created", context: expect.objectContaining({ relationship_cardinality: { kind: "assigned_once", direction: "outgoing", node_id: "holder", endpoint_ids: ["a", "new"] } }) }),
    );
  });

  it("rejects entirely new conflicting groups and leaves other semantics to their validators", () => {
    expect(() => assertNonHierarchyCardinalityMutationAllowed([], [holder(["a", "b"])], registry)).toThrowError(
      expect.objectContaining({ code: "dependency_cardinality_created" }),
    );
    expect(() => assertNonHierarchyCardinalityMutationAllowed([], [{ id: "holder", dependencies: [
      { id: "a", kind: "parent" }, { id: "b", kind: "parent" }, { id: "c", kind: "inactive_kind" },
    ] }], registry)).not.toThrow();
    expect(() => assertNonHierarchyCardinalityMutationAllowed([], [], registry)).not.toThrow();
    expect(relationshipKindNeedsIntegrityLock("inactive_kind", registry)).toBe(false);
    expect(relationshipKindNeedsIntegrityLock("parent", registry)).toBe(true);
  });
});
