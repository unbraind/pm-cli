import { describe, expect, it } from "vitest";
import { projectMutationResult } from "../../../../src/core/output/mutation-projection.js";

describe("compound mutation projection", () => {
  const claim = { item: { id: "pm-a", status: "open", description: "private context" }, changed_fields: ["assignee"], claimed_by: "worker", forced: false };
  const update = { item: { id: "pm-a", status: "in_progress" }, changed_fields: ["status", "assignee"] };
  const result = { id: "pm-a", action: "start_task", claim, update };

  it("counts distinct touched fields and retains per-step evidence without mutating inputs", () => {
    expect(projectMutationResult(result, { compactEnvelope: true })).toEqual({
      id: "pm-a", action: "start_task", status: "in_progress", changed_field_count: 2,
      claim: { id: "pm-a", status: "open", changed_field_count: 1, claimed_by: "worker", forced: false },
      update: { id: "pm-a", status: "in_progress", changed_field_count: 2 },
    });
    expect(projectMutationResult(result)).toBe(result);
    expect(projectMutationResult(result, { idOnly: true })).toEqual({ id: "pm-a", status: "in_progress" });
    expect(projectMutationResult(result, { changedFields: "compact" })).toMatchObject({ claim: { item: claim.item, changed_field_count: 1 } });
    expect(claim.changed_fields).toEqual(["assignee"]);
  });

  it("leaves unrecognized or incomplete envelopes untouched rather than inventing completion", () => {
    for (const candidate of [
      null, [], {}, { ...result, action: "constructor" }, { ...result, id: "" },
      { ...result, update: null }, { ...result, update: { item: null } },
      { ...result, update: { item: { id: "pm-b" } } },
      { ...result, update: { item: update.item } },
      { ...result, update: { ...update, changed_fields: [7] } },
    ]) expect(projectMutationResult(candidate, { compactEnvelope: true })).toBe(candidate);
    expect(projectMutationResult({ ...result, update: { ...update, item: { id: "pm-a" } } }, { idOnly: true })).toEqual({ id: "pm-a" });
  });
});
