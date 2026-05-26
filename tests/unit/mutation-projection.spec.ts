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

  it("compacts mutation envelope and update-many row changed_fields only", () => {
    const result = {
      mode: "apply",
      rows: [
        {
          id: "pm-1",
          status: "updated",
          changed_fields: ["status", "priority"],
          item: { metadata: { changed_fields: ["user", "metadata"] } },
        },
        { id: "pm-2", status: "skipped" },
        null,
      ],
    };
    const projected = projectMutationResult(result, { changedFields: "compact" }) as Record<string, unknown>;
    expect(projected).not.toBe(result);
    const rows = projected.rows as Array<Record<string, unknown>>;
    expect(rows).not.toBe(result.rows);
    expect(rows[0].changed_fields).toBeUndefined();
    expect(rows[0].changed_field_count).toBe(2);
    expect((rows[0].item as { metadata: { changed_fields: string[] } }).metadata.changed_fields).toEqual([
      "user",
      "metadata",
    ]);
    expect(rows[1]).toEqual({ id: "pm-2", status: "skipped" });
    expect(rows[2]).toBeNull();
    // Original is not mutated.
    expect(result.rows[0].changed_fields).toEqual(["status", "priority"]);
  });

  it("returns the same reference for nested structures with no changed_fields", () => {
    const result = { mode: "dry_run", rows: [{ id: "pm-1", status: "planned" }] };
    expect(projectMutationResult(result, { changedFields: "compact" })).toBe(result);
  });

  it("returns the same reference for update-many apply rows with no changed_fields", () => {
    const result = { mode: "apply", rows: [{ id: "pm-1", status: "skipped" }] };
    expect(projectMutationResult(result, { changedFields: "compact" })).toBe(result);
  });

  it("reports a zero count for an empty changed_fields array", () => {
    const projected = projectMutationResult({ item: { id: "pm-a1b2" }, changed_fields: [] }, { changedFields: "compact" }) as Record<
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
    const userPayload = { changed_fields: ["metadata"] };
    expect(projectMutationResult(userPayload, { changedFields: "compact" })).toBe(userPayload);
  });

  it("leaves nested user-defined changed_fields metadata untouched", () => {
    const result = {
      item: {
        id: "pm-a1b2",
        changed_fields: ["user-defined", "metadata"],
      },
      changed_fields: ["item"],
    };
    const projected = projectMutationResult(result, { changedFields: "compact" }) as {
      item: { changed_fields: string[] };
      changed_fields?: string[];
      changed_field_count?: number;
    };
    expect(projected.changed_fields).toBeUndefined();
    expect(projected.changed_field_count).toBe(1);
    expect(projected.item.changed_fields).toEqual(["user-defined", "metadata"]);
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

  it("compacts null-prototype objects while preserving their prototype", () => {
    const nullProto = Object.assign(Object.create(null), {
      item: { id: "pm-a1b2" },
      changed_fields: ["x", "y"],
    }) as Record<string, unknown>;
    const projected = projectMutationResult(nullProto, { changedFields: "compact" }) as Record<string, unknown>;
    expect(projected.changed_fields).toBeUndefined();
    expect(projected.changed_field_count).toBe(2);
    expect(Object.getPrototypeOf(projected)).toBeNull();
  });

  it("preserves null-prototype update-many envelopes and rows when rows are compacted", () => {
    const row = Object.assign(Object.create(null), {
      id: "pm-1",
      status: "updated",
      changed_fields: ["status", "priority"],
    }) as Record<string, unknown>;
    const result = Object.assign(Object.create(null), { mode: "apply", rows: [row] }) as Record<string, unknown>;
    const projected = projectMutationResult(result, { changedFields: "compact" }) as Record<string, unknown>;
    const rows = projected.rows as Array<Record<string, unknown>>;

    expect(Object.getPrototypeOf(projected)).toBeNull();
    expect(Object.getPrototypeOf(rows[0])).toBeNull();
    expect(rows[0].changed_fields).toBeUndefined();
    expect(rows[0].changed_field_count).toBe(2);
  });

  it("returns non-object inputs unchanged in compact mode", () => {
    expect(projectMutationResult(null, { changedFields: "compact" })).toBeNull();
    expect(projectMutationResult("text", { changedFields: "compact" })).toBe("text");
    const arr = ["changed_fields"];
    expect(projectMutationResult(arr, { changedFields: "compact" })).toBe(arr);
  });
});
