import { describe, expect, it } from "vitest";
import { projectMutationResult } from "../../src/core/output/mutation-projection.js";

describe("projectMutationResult", () => {
  it("returns the result unchanged in full mode (default)", () => {
    const result = { item: { id: "pm-a1b2" }, changed_fields: ["id", "title"], warnings: [] };
    expect(projectMutationResult(result)).toBe(result);
    expect(projectMutationResult(result, { changedFields: "full" })).toBe(result);
  });

  it("replaces changed_fields with changed_field_count in compact mode", () => {
    const result = { item: { id: "pm-a1b2" }, changed_fields: ["id", "title", "status"], warnings: [] };
    const projected = projectMutationResult(result, { changedFields: "compact" }) as Record<string, unknown>;
    expect(projected).not.toBe(result);
    expect(projected.changed_fields).toBeUndefined();
    expect(projected.changed_field_count).toBe(3);
    expect(projected.item).toEqual({ id: "pm-a1b2" });
    expect(projected.warnings).toEqual([]);
    // Original is not mutated.
    expect(result.changed_fields).toEqual(["id", "title", "status"]);
  });

  it("recursively compacts nested changed_fields (e.g. update-many rows)", () => {
    const result = {
      mode: "apply",
      changed_fields: ["a"],
      rows: [
        { id: "pm-1", status: "updated", changed_fields: ["status", "priority"] },
        { id: "pm-2", status: "skipped" },
      ],
    };
    const projected = projectMutationResult(result, { changedFields: "compact" }) as Record<string, unknown>;
    expect(projected).not.toBe(result);
    expect(projected.changed_fields).toBeUndefined();
    expect(projected.changed_field_count).toBe(1);
    const rows = projected.rows as Array<Record<string, unknown>>;
    expect(rows).not.toBe(result.rows);
    expect(rows[0].changed_fields).toBeUndefined();
    expect(rows[0].changed_field_count).toBe(2);
    expect(rows[1]).toEqual({ id: "pm-2", status: "skipped" });
    // Original is not mutated.
    expect(result.rows[0].changed_fields).toEqual(["status", "priority"]);
  });

  it("returns the same reference for nested structures with no changed_fields", () => {
    const result = { mode: "dry_run", rows: [{ id: "pm-1", status: "planned" }] };
    expect(projectMutationResult(result, { changedFields: "compact" })).toBe(result);
  });

  it("reports a zero count for an empty changed_fields array", () => {
    const projected = projectMutationResult({ changed_fields: [] }, { changedFields: "compact" }) as Record<
      string,
      unknown
    >;
    expect(projected.changed_field_count).toBe(0);
    expect(projected.changed_fields).toBeUndefined();
  });

  it("leaves objects without a changed_fields array untouched in compact mode", () => {
    const noField = { item: { id: "pm-a1b2" } };
    expect(projectMutationResult(noField, { changedFields: "compact" })).toBe(noField);
    const nonArray = { changed_fields: "nope" };
    expect(projectMutationResult(nonArray, { changedFields: "compact" })).toBe(nonArray);
  });

  it("preserves non-plain objects (Date/class instances) instead of mangling them", () => {
    const created = new Date("2026-05-26T00:00:00.000Z");
    const result = { item: { id: "pm-a1b2", created }, changed_fields: ["id", "created"] };
    const projected = projectMutationResult(result, { changedFields: "compact" }) as {
      item: { created: unknown };
      changed_field_count: number;
    };
    expect(projected.changed_field_count).toBe(2);
    expect(projected.item.created).toBe(created);
    expect(projected.item.created).toBeInstanceOf(Date);
  });

  it("treats null-prototype objects as plain and compacts them", () => {
    const nullProto = Object.assign(Object.create(null), { changed_fields: ["x", "y"] }) as Record<string, unknown>;
    const projected = projectMutationResult(nullProto, { changedFields: "compact" }) as Record<string, unknown>;
    expect(projected.changed_fields).toBeUndefined();
    expect(projected.changed_field_count).toBe(2);
  });

  it("returns non-object inputs unchanged in compact mode", () => {
    expect(projectMutationResult(null, { changedFields: "compact" })).toBeNull();
    expect(projectMutationResult("text", { changedFields: "compact" })).toBe("text");
    const arr = ["changed_fields"];
    expect(projectMutationResult(arr, { changedFields: "compact" })).toBe(arr);
  });
});
