import { describe, expect, it } from "vitest";
import {
  analyzeHierarchyIntegrity,
  assertHierarchyMutationAllowed,
  type HierarchyIntegrityItem,
} from "../../src/sdk/graph/hierarchy-integrity.js";

describe("hierarchy merge composition conformance", () => {
  it("rejects deterministic randomized branch pairs whose individually sound edge sets compose into a cycle", () => {
    let randomState = 0x5eed1234;
    for (let size = 2; size <= 32; size += 1) {
      const ids = Array.from(
        { length: size },
        (_, index) => `pm-node-${index}`,
      );
      for (let index = ids.length - 1; index > 0; index -= 1) {
        randomState = (randomState * 1_664_525 + 1_013_904_223) >>> 0;
        const swapIndex = randomState % (index + 1);
        [ids[index], ids[swapIndex]] = [ids[swapIndex]!, ids[index]!];
      }
      const base: HierarchyIntegrityItem[] = ids.map((id) => ({
        id,
        status: "open",
      }));
      const branchA = structuredClone(base);
      const branchB = structuredClone(base);
      for (let index = 0; index < ids.length; index += 1) {
        const holder = index % 2 === 0 ? branchA : branchB;
        holder.find((item) => item.id === ids[index])!.dependencies = [
          {
            id: ids[(index + 1) % ids.length]!,
            kind: "child_of",
          },
        ];
      }
      expect(analyzeHierarchyIntegrity(branchA).cycles).toEqual([]);
      expect(analyzeHierarchyIntegrity(branchB).cycles).toEqual([]);

      const merged = base.map((item, index) => ({
        ...item,
        dependencies:
          branchA[index]!.dependencies ?? branchB[index]!.dependencies,
      }));
      expect(analyzeHierarchyIntegrity(merged).cycles).toEqual([
        { item_ids: [...ids].sort(), legacy_terminal: false },
      ]);
      expect(() =>
        assertHierarchyMutationAllowed(branchA, merged, ids.at(-1)!),
      ).toThrow(
        expect.objectContaining({
          code: "hierarchy_cycle_created",
          context: expect.objectContaining({
            verification_errors: [...ids].sort(),
          }),
        }),
      );
    }
  });
});
