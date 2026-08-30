import { describe, expect, it } from "vitest";
import { normalizeAddStatusInput } from "../../../../src/core/schema/status-defs-file.js";

describe("status role registration", () => {
  it("rejects explicit empty or blank-only role lists", () => {
    expect(() => normalizeAddStatusInput({ id: "review", roles: [] })).toThrow(
      "Status role must include at least one lifecycle role",
    );
    expect(() =>
      normalizeAddStatusInput({ id: "review", roles: [" "] }),
    ).toThrow("Status role must include at least one lifecycle role");
  });

  it("normalizes and deduplicates valid lifecycle roles", () => {
    expect(
      normalizeAddStatusInput({
        id: "Review Queue",
        roles: [" ACTIVE ", "active", "default_open"],
      }),
    ).toMatchObject({
      id: "review_queue",
      roles: ["active", "default_open"],
    });
  });
});
