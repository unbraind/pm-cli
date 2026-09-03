import { describe, expect, it } from "vitest";
import {
  parseItemDocument,
  serializeItemDocument,
} from "../../../../src/core/item/item-format.js";
import { mergeItemDocuments } from "../../../../src/sdk/merge/three-way.js";
import type { ItemDocument } from "../../../../src/types/index.js";

function document(criteria: string, updatedAt: string): ItemDocument {
  return {
    metadata: {
      id: "pm-criteria-merge",
      title: "Acceptance criteria merge",
      description: "Exercise lossless criteria composition",
      type: "Task",
      status: "open",
      priority: 2,
      tags: [],
      created_at: "2026-09-03T00:00:00.000Z",
      updated_at: updatedAt,
      acceptance_criteria: criteria,
    },
    body: "",
  };
}

function merge(base: ItemDocument, ours: ItemDocument, theirs: ItemDocument) {
  return mergeItemDocuments(
    serializeItemDocument(base, { format: "toon" }),
    serializeItemDocument(ours, { format: "toon" }),
    serializeItemDocument(theirs, { format: "toon" }),
    { format: "toon" },
  );
}

describe("acceptance-criteria item merge", () => {
  it("preserves disjoint additions across arbitrarily many branches", () => {
    const base = document("base criterion", "2026-09-03T00:00:00.000Z");
    const ours = document(
      "base criterion; criterion from A",
      "2026-09-03T00:01:00.000Z",
    );
    const theirs = document(
      "base criterion; criterion from B",
      "2026-09-03T00:02:00.000Z",
    );
    const first = merge(base, ours, theirs);
    const firstDocument = parseItemDocument(first.merged, { format: "toon" });
    const third = document(
      "base criterion; criterion from C",
      "2026-09-03T00:03:00.000Z",
    );
    const second = merge(base, firstDocument, third);
    const parsed = parseItemDocument(second.merged, { format: "toon" });

    expect(parsed.metadata.acceptance_criteria).toBe(
      "base criterion; criterion from A; criterion from B; criterion from C",
    );
    expect(first.conflict_fields).not.toContain("acceptance_criteria");
    expect(first.union_fields).toContain("acceptance_criteria");
    expect(second.conflict_fields).not.toContain("acceptance_criteria");
    expect(second.union_fields).toContain("acceptance_criteria");
  });

  it("honours removals from either side while composing new criteria", () => {
    const base = document(
      "remove on theirs; remove on ours; retain",
      "2026-09-03T00:00:00.000Z",
    );
    const ours = document(
      "remove on theirs; retain; ours addition",
      "2026-09-03T00:01:00.000Z",
    );
    const theirs = document(
      "remove on ours; retain; theirs addition",
      "2026-09-03T00:02:00.000Z",
    );
    const result = merge(base, ours, theirs);

    expect(
      parseItemDocument(result.merged, { format: "toon" }).metadata
        .acceptance_criteria,
    ).toBe("retain; ours addition; theirs addition");
    expect(result.conflict_decisions).toEqual([]);
  });
});
