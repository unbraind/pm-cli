/** Generated complete-document conformance for the declared item merge policies. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { serializeItemDocument } from "../../src/core/item/item-format.js";
import {
  ITEM_LATEST_TIMESTAMP_FIELDS,
  ITEM_UNION_COLLECTION_FIELDS,
  mergeItemDocuments,
  type ItemScalarConflictResolution,
} from "../../src/sdk/merge/three-way.js";
import type { ItemDocument } from "../../src/types/index.js";

const base: ItemDocument = {
  metadata: {
    id: "pm-merge-property", title: "Original", description: "Original description",
    type: "Task", status: "open", priority: 2, tags: [],
    created_at: "2026-09-11T00:00:00.000Z", updated_at: "2026-09-11T00:00:00.000Z",
  },
  body: "Original body",
};
const baseRaw = serializeItemDocument(base);
const policies: Record<ItemScalarConflictResolution, boolean> = {
  preferred_side: false, stable_value_order: true, latest_document_update: true,
};

describe("whole-document item merge conformance", () => {
  it("pins collection and freshness classes so new policies require conformance cases", () => {
    expect(ITEM_UNION_COLLECTION_FIELDS).toEqual([
      "tags", "dependencies", "comments", "notes", "learnings", "files", "tests",
      "test_runs", "docs", "reminders", "events",
    ]);
    expect(ITEM_LATEST_TIMESTAMP_FIELDS).toEqual(["updated_at"]);
  });

  it("compares scalar, body, union, and timestamp results across fixed N-branch permutations", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.stringMatching(/^[a-z]{1,12}$/), { minLength: 2, maxLength: 8 }),
      fc.boolean(),
      (values, equalTimestamps) => {
        // Construct branches once: changing their timestamps with fold position
        // would compare different histories rather than different merge orders.
        const branches = values.map((value, index) => {
          const branch = structuredClone(base);
          branch.metadata.title = value;
          branch.metadata.description = `Description ${value}`;
          branch.metadata.assignee = value;
          branch.metadata.tags = [value];
          branch.metadata.updated_at = new Date(Date.UTC(2026, 8, 11, 0, 0,
            equalTimestamps ? 1 : index + 1)).toISOString();
          branch.body = `Body ${value}`;
          return serializeItemDocument(branch);
        });
        for (const conflictResolution of ["stable_value_order", "latest_document_update"] as const) {
          const fold = (order: string[], reverse: boolean): string => order.reduce(
            (current, branch) => mergeItemDocuments(baseRaw,
              reverse ? branch : current, reverse ? current : branch,
              { conflictResolution }).merged,
            baseRaw,
          );
          const expected = fold(branches, false);
          for (const order of [branches, [...branches].reverse(), [...branches.slice(1), branches[0]]]) {
            expect(fold(order, false)).toBe(expected);
            expect(fold(order, true)).toBe(expected);
          }
        }
      },
    ), { numRuns: 100, seed: 11092026 });
  });

  it("checks declared directionality with independent scalar and body oracles", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.stringMatching(/^[a-z]{1,12}$/), { minLength: 2, maxLength: 2 }),
      (values) => {
        const branches = values.map((value, index) => {
          const branch = structuredClone(base);
          branch.metadata.title = value;
          branch.metadata.tags = [value];
          branch.body = value;
          branch.metadata.updated_at = new Date(Date.UTC(2026, 8, 11, 0, 0, index + 1)).toISOString();
          return branch;
        });
        for (const [policy, directionIndependent] of Object.entries(policies)) {
          const conflictResolution = policy as ItemScalarConflictResolution;
          const forward = mergeItemDocuments(baseRaw, serializeItemDocument(branches[0]),
            serializeItemDocument(branches[1]), { conflictResolution });
          const reversed = mergeItemDocuments(baseRaw, serializeItemDocument(branches[1]),
            serializeItemDocument(branches[0]), { conflictResolution });
          expect(forward.merged === reversed.merged).toBe(directionIndependent);
          const expected = structuredClone(base);
          const retained = policy === "preferred_side" ? values[0]
            : policy === "latest_document_update" ? values[1]
              : [...values].sort((left, right) => left.localeCompare(right))[0];
          expected.metadata.title = retained;
          expected.metadata.tags = values;
          expected.metadata.updated_at = branches[1].metadata.updated_at;
          expected.body = retained;
          expect(forward.merged).toBe(serializeItemDocument(expected));
          expect(forward.conflict_fields).toEqual(["title", "body"]);
        }
      },
    ), { numRuns: 100, seed: 11092026 });
  });

  it("preserves disjoint scalar edits, optional-field deletion, and body edits in both directions", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 80 }), (value) => {
      const ancestor = structuredClone(base);
      ancestor.metadata.assignee = "original-owner";
      const left = structuredClone(ancestor);
      const right = structuredClone(ancestor);
      left.metadata.description = value;
      delete left.metadata.assignee;
      right.body = value;
      right.metadata.updated_at = "2026-09-11T00:00:02.000Z";
      const expected = structuredClone(left);
      expected.body = value;
      expected.metadata.updated_at = right.metadata.updated_at;
      for (const [ours, theirs] of [[left, right], [right, left]]) {
        const result = mergeItemDocuments(serializeItemDocument(ancestor),
          serializeItemDocument(ours), serializeItemDocument(theirs),
          { conflictResolution: "latest_document_update" });
        expect(result.conflict_fields).toEqual([]);
        expect(result.merged).toBe(serializeItemDocument(expected));
      }
    }), { numRuns: 100, seed: 11092026 });
  });
});
